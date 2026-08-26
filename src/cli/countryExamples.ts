import { readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { delay } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { optionValue } from './vatList.js';

/**
 * One example per country (a real VAT number and the full API answer for it) written to a JSON
 * file read by the home page map and the country pages.
 *
 * The numbers come from the test fixtures. The answers are recorded from the real API with a key.
 *
 * The file is generated, do not edit it. A run merges: countries not asked keep their answer, so
 * `--only SG` only refreshes Singapore.
 *
 * Keys are VAT prefixes (`EL` for Greece, not `GR`).
 */

/** The fixtures, in the order they are tried: member states first. */
const FIXTURES = ['test/fixtures/valid-vat-numbers.txt', 'test/fixtures/valid-tax-numbers-non-eu.txt'];

/** The output file, at the repository root like `locales/`. */
const DEFAULT_OUT = 'data/country-examples.json';

/** How many numbers to try per country before giving up. */
const DEFAULT_TRIES = 4;

/** Pause between two calls, to spare the registers behind the API. */
const DEFAULT_PAUSE_MS = 400;

/** The part of an answer this command looks at. The whole answer is written. */
interface Answer {
  data?: { name?: string | null; status?: string };
}

/** One country's example: the number, when it was asked, and the answer. */
interface Example {
  vat: string;
  fetchedAt: string;
  response: Answer;
}

interface ExampleFile {
  /** What generated the file and how to run it again. */
  generated: string;
  endpoint: string;
  countries: Record<string, Example>;
}

function usage(): string {
  return [
    `Usage: VATLAS_KEY=… npm run country-examples [-- --only SG] [--out ${DEFAULT_OUT}]`,
    '',
    'Asks the API for one real company per country and records the whole answer in a shared',
    'JSON file - the examples the home page map shows, and anything else that wants one.',
    '',
    'The numbers come from the test fixtures, so this only asks about numbers the repository',
    'already holds. It spends one lookup per country against the key it is given, and merges:',
    'a country it did not ask about keeps the answer it had.',
    '',
    'Options:',
    '  --key         API key (default $VATLAS_KEY)',
    `  --base        API base URL (default ${config.apiBaseUrl})`,
    `  --out         Where to write the file (default ${DEFAULT_OUT})`,
    '  --only        Comma-separated prefixes, to refresh or add a few countries',
    `  --tries       Numbers to try per country before giving up (default ${DEFAULT_TRIES})`,
    '  --offset      Skip the first N numbers of each country, to land on another example',
    `  --pause       Milliseconds between two calls (default ${DEFAULT_PAUSE_MS})`,
    '  --help        This text',
  ].join('\n');
}

/** Every fixture number, grouped by prefix, in file order. */
async function readFixtures(): Promise<Map<string, string[]>> {
  const byPrefix = new Map<string, string[]>();
  for (const path of FIXTURES) {
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const number of lines) {
      const prefix = number.slice(0, 2).toUpperCase();
      const list = byPrefix.get(prefix) ?? [];
      list.push(number);
      byPrefix.set(prefix, list);
    }
  }
  return byPrefix;
}

/**
 * One lookup. A 404 or an unknown number means trying the next one. Answers without a name are
 * returned too, `example()` decides.
 *
 * `inactive` companies are refused. `unknown` is kept because Nigeria's register never publishes a
 * status.
 */
async function lookup(base: string, key: string, vat: string): Promise<Answer | null> {
  const response = await fetch(`${base}/v1/lookup/${encodeURIComponent(vat)}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    logger.warn({ vat, status: response.status }, 'country-examples: lookup refused');
    return null;
  }
  const payload = (await response.json()) as Answer;
  return payload.data?.status === 'inactive' ? null : payload;
}

/**
 * The example for one country: the first number answered with a name, otherwise the first answered
 * at all.
 *
 * Spain needs the fallback: VIES confirms Spanish numbers without a name.
 */
async function example(base: string, key: string, numbers: string[], pause: number): Promise<Example | null> {
  let nameless: Example | null = null;
  for (const vat of numbers) {
    const response = await lookup(base, key, vat);
    await delay(pause);
    if (!response) continue;
    const found = { vat, fetchedAt: new Date().toISOString(), response };
    if (response.data?.name?.trim()) return found;
    nameless ??= found;
  }
  return nameless;
}

/** The current file, or an empty one on the first run. */
async function readExisting(out: string, endpoint: string): Promise<ExampleFile> {
  const raw = await readFile(out, 'utf8').catch(() => null);
  if (!raw) return { generated: '', endpoint, countries: {} };
  return JSON.parse(raw) as ExampleFile;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const key = optionValue(args, '--key') ?? process.env.VATLAS_KEY?.trim();
  if (!key) throw new Error('no API key: pass --key or set VATLAS_KEY');

  const base = (optionValue(args, '--base') ?? config.apiBaseUrl).replace(/\/$/, '');
  const out = optionValue(args, '--out') ?? DEFAULT_OUT;
  const tries = Number(optionValue(args, '--tries') ?? DEFAULT_TRIES);
  const offset = Number(optionValue(args, '--offset') ?? 0);
  const pause = Number(optionValue(args, '--pause') ?? DEFAULT_PAUSE_MS);
  const only = optionValue(args, '--only')
    ?.split(',')
    .map((prefix) => prefix.trim().toUpperCase())
    .filter(Boolean);

  const endpoint = `${base}/v1/lookup/{vatNumber}`;
  const file = await readExisting(out, endpoint);
  const byPrefix = await readFixtures();
  const prefixes = [...byPrefix.keys()].filter((prefix) => !only || only.includes(prefix)).sort();

  const missing: string[] = [];
  for (const prefix of prefixes) {
    const numbers = (byPrefix.get(prefix) ?? []).slice(offset, offset + tries);
    const found = await example(base, key, numbers, pause);
    // A country with no answer keeps what it had, so a bad run never empties the file.
    if (!found) {
      missing.push(prefix);
      process.stdout.write(`${prefix} - \n`);
      continue;
    }
    file.countries[prefix] = found;
    process.stdout.write(`${prefix}  ${found.vat}  ${found.response.data?.name ?? '(no name published)'}\n`);
  }

  file.generated = `npm run country-examples - generated, do not edit. Last run ${new Date().toISOString()}`;
  file.endpoint = endpoint;
  file.countries = Object.fromEntries(Object.entries(file.countries).sort(([a], [b]) => a.localeCompare(b)));

  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  const count = Object.keys(file.countries).length;
  process.stdout.write(
    `\n${count} countr${count === 1 ? 'y' : 'ies'} in ${out}` +
      `${missing.length ? `, no answer for ${missing.join(', ')}` : ''}\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error({ err: error }, 'country-examples command failed');
    process.exit(1);
  });
