import { config } from '../config.js';
import { resolveCountry } from '../api/countries/registry.js';
import { getLiveSource, LIVE_SOURCES } from '../api/sources/registry.js';
import type { LiveAnswer, LiveSourceAdapterInterface } from '../api/sources/types.js';
import { checkVatRaw, flushSourceCalls } from '../api/sources/live/europe-vies.js';
import { SourceTrace } from '../api/trace.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { indentXml } from '../lib/xml.js';
import { InvalidVatError, parseVatNumber, type ParsedVat } from '../vat/parse.js';

/**
 * Asks a live source directly, bypassing storage, freshness and the choice between sources. Shows
 * what a register actually answers for a number.
 */

function usage(): string {
  const width = Math.max(...LIVE_SOURCES.map((source) => source.id.length));
  const sources = LIVE_SOURCES.map(
    (source) => `  ${source.id.padEnd(width)}  ${source.name}${source.available ? '' : '  (not configured here)'}`,
  );
  return [
    'Usage: npm run source -- <vatNumber> [<vatNumber>...] [options]',
    '',
    "Asks the live sources of a number's country, one call each, and prints what they answer.",
    'Nothing is read from the stored history; everything that comes back is written to it, the',
    'same way a lookup would.',
    '',
    'Sources:',
    ...sources,
    '',
    'Options:',
    '  --source=<id>        Ask only this source, whatever country the number belongs to',
    '  --json               Print one JSON object per number instead of a readable report',
    '  --raw                Print the SOAP response as VIES sent it, faults included, indented.',
    '                       VIES only, and always a live call.',
    '  --requester=<vat>    Ask VIES as this trader instead of the configured VIES_REQUESTER_VAT.',
    '                       The requester is what makes VIES issue a consultation number: the',
    '                       proof of the check a tax authority accepts.',
    '',
    'Examples:',
    '  npm run source -- DE811907980',
    '  npm run source -- PL7342867148 --source=MF_WL',
    '  npm run source -- IT00743110157 --raw',
    '',
    'Exit code is 1 as soon as one number is malformed, or no source answered that it is valid,',
    'so the command can be used as a check in a script.',
  ].join('\n');
}

interface Outcome {
  input: string;
  vatNumber: string | null;
  ok: boolean;
  /** One entry per source asked, in the country's order. */
  answers: { source: string; answer: LiveAnswer; durationMs: number }[];
  reason?: string;
}

/** The sources to ask: the one named, or every live source of the country. */
function sourcesFor(vat: ParsedVat, named: string | undefined): LiveSourceAdapterInterface[] {
  if (named === undefined) return resolveCountry(vat.countryCode).liveSources.filter((source) => source.available);

  const source = getLiveSource(named);
  if (!source) throw new Error(`Unknown source "${named}"\n\n${usage()}`);
  return [source];
}

async function check(input: string, named: string | undefined): Promise<Outcome> {
  let vat: ParsedVat;
  try {
    vat = parseVatNumber(input);
  } catch (error) {
    if (error instanceof InvalidVatError) {
      return { input, vatNumber: null, ok: false, answers: [], reason: error.message };
    }
    throw error;
  }

  const context = { deadline: Date.now() + config.lookup.deadlineMs, trace: new SourceTrace() };
  const answers: Outcome['answers'] = [];

  for (const source of sourcesFor(vat, named)) {
    const startedAt = performance.now();
    const answer = await source.fetch(vat, context);
    answers.push({ source: source.id, answer, durationMs: Math.round(performance.now() - startedAt) });
  }

  return {
    input,
    vatNumber: vat.formatted,
    ok: answers.some((entry) => entry.answer.status === 'found'),
    answers,
  };
}

/** Prints the raw SOAP body, to see what a member state returns (address layouts differ). VIES only. */
async function dumpRaw(
  input: string,
  requester: { countryCode: string; vatNumber: string } | undefined,
): Promise<boolean> {
  let vat: ParsedVat;
  try {
    vat = parseVatNumber(input);
  } catch (error) {
    if (error instanceof InvalidVatError) {
      process.stdout.write(`${input}\n  malformed: ${error.message}\n\n`);
      return false;
    }
    throw error;
  }

  const result = await checkVatRaw(vat.countryCode, vat.nationalNumber, { requester });
  if (!result) {
    process.stdout.write(`${vat.formatted}\n  VIES did not answer\n\n`);
    return false;
  }

  // Indented: VIES sends the envelope on one line.
  process.stdout.write(`${vat.formatted} (${result.attempts} attempt(s))\n${indentXml(result.body)}\n\n`);
  return result.parsed.kind === 'answer' && result.parsed.valid;
}

function report(outcome: Outcome): string {
  const lines = [outcome.vatNumber ?? outcome.input];
  const pad = (label: string): string => `  ${label.padEnd(14)}`;

  if (outcome.answers.length === 0) {
    // Two cases: a number the parser refused has no country, and a valid number may have no source
    // available because every one needs missing credentials (only outside Europe, where there is no
    // VIES).
    if (outcome.vatNumber === null) {
      lines.push(`${pad('malformed')}${outcome.reason ?? ''}`);
    } else {
      lines.push(`${pad('unavailable')}no source is configured for this country`);
    }
    return lines.join('\n');
  }

  for (const { source, answer, durationMs } of outcome.answers) {
    lines.push(`  ${source} (${durationMs} ms)`);
    switch (answer.status) {
      case 'found': {
        const { record } = answer;
        lines.push(`${pad('name')}${record.name ?? '(not disclosed)'}`);
        lines.push(`${pad('status')}${record.status}`);
        const address = [record.addressLine1, record.addressLine2, record.postalCode, record.city]
          .filter(Boolean)
          .join(', ');
        lines.push(`${pad('address')}${address || '(not disclosed)'}`);
        if (answer.proof) lines.push(`${pad('proof')}${answer.proof}`);
        break;
      }
      case 'not-registered':
        lines.push(`${pad('valid')}no - the source reports this number as not registered`);
        if (answer.proof) lines.push(`${pad('proof')}${answer.proof}`);
        break;
      case 'not-found':
        lines.push(`${pad('found')}no record of this number`);
        break;
      case 'unavailable':
        // The fault tells the problem: MS_UNAVAILABLE is the member state being down,
        // MS_MAX_CONCURRENT_REQ is this caller being throttled.
        lines.push(`${pad('unavailable')}${answer.failure.fault} after ${answer.failure.attempts} attempt(s)`);
        break;
    }
  }

  return lines.join('\n');
}

/**
 * The requester for VIES: `--requester=<vat>`, or `VIES_REQUESTER_VAT` like the API.
 *
 * Parsed here, so a typo fails fast instead of a slow INVALID_REQUESTER_INFO.
 */
function readRequester(args: string[]): { countryCode: string; vatNumber: string } | undefined {
  const flag = args.find((arg) => arg.startsWith('--requester'));
  if (!flag) return config.vies.requester;

  const parsed = parseVatNumber(flag.split('=')[1] ?? '');
  return { countryCode: parsed.countryCode, vatNumber: parsed.nationalNumber };
}

function readSource(args: string[]): string | undefined {
  const flag = args.find((arg) => arg.startsWith('--source='));
  return flag ? flag.slice('--source='.length) : undefined;
}

async function main(): Promise<boolean> {
  const args = process.argv.slice(2);
  const numbers = args.filter((arg) => !arg.startsWith('--'));

  if (numbers.length === 0 || args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return true;
  }

  const asJson = args.includes('--json');
  const asRaw = args.includes('--raw');
  const named = readSource(args);

  let requester;
  try {
    requester = readRequester(args);
  } catch (error) {
    if (!(error instanceof InvalidVatError)) throw error;
    process.stdout.write(`--requester: ${error.message}\n`);
    return false;
  }

  let allOk = true;

  for (const number of numbers) {
    if (asRaw) {
      allOk &&= await dumpRaw(number, requester);
      continue;
    }

    const outcome = await check(number, named);
    allOk &&= outcome.ok;

    if (asJson) {
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    } else {
      process.stdout.write(`${report(outcome)}\n\n`);
    }
  }

  return allOk;
}

async function shutdown(): Promise<void> {
  // Calls do not wait for their `log_source_call` row, so flush before exiting.
  await flushSourceCalls();
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(async (allOk) => {
    await shutdown();
    process.exit(allOk ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'source command failed');
    await shutdown();
    process.exit(1);
  });
