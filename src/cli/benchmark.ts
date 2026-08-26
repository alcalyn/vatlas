import { readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { delay } from '../lib/http.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import {
  ENDPOINT as VIES_ENDPOINT,
  SOURCE as VIES_SOURCE,
  checkVatRaw,
  toCompanyRecord as viesToCompanyRecord,
  vies as viesSource,
} from '../api/sources/live/europe-vies.js';
import { SourceTrace } from '../api/trace.js';
import { decodeXmlEntities } from '../lib/xml.js';
import { parseVatNumber } from '../vat/parse.js';
import { COMPARED, VERDICTS, verdictFor, type Compared, type Verdict } from './agreement.js';
import {
  type Entry,
  type ListStats,
  countBy,
  describe,
  listReport,
  listStats,
  numberOption,
  optionValue,
  parseArgs,
  percent,
  readEntries,
  suffixed,
} from './vatList.js';

/**
 * Measures the real endpoint over HTTP rather than calling `lookupVat()` in process, so the whole
 * path is measured, Express and metering included.
 *
 * A run writes four files next to the list:
 * - the summary, as shown in the terminal;
 * - the same summary as JSON, unrounded, so runs can be compared by `compare`;
 * - the details, one line per number;
 * - the debug file, with everything each side replied for each number.
 * This command is only a client of the service and never touches the database.
 *
 * `--vies-only` measures the baseline instead: VIES called directly, in process, over the same
 * list and into the same report. It cannot go through the endpoint, which serves stored answers
 * first. Calling a source directly is always a live call.
 *
 * Cleaning a list is `npm run sanitize`: a benchmark measures the list it was given.
 */

function usage(): string {
  return [
    'Usage: npm run benchmark -- <file> [options]',
    '',
    'Reads a list of intra-community VAT numbers (one per line; blank lines and # comments',
    'are ignored), reports how many there are per country, then looks every one of them up',
    'through the API and measures the response time and how complete the answer is.',
    '',
    'Options:',
    `  --url <url>        API base URL (default: API_BASE_URL, currently ${config.apiBaseUrl})`,
    '  --key <key>        Secret key (default: the VATLAS_KEY environment variable)',
    '  --concurrency <n>  Requests in flight (default: 1, the honest figure for one caller)',
    '  --limit <n>        Stop after the first n numbers of the file',
    '  --timeout <ms>     Give up on a request after this long (default: 30000)',
    '  --out <path>       Where to write the summary (default: <file>.bench-summary.txt).',
    '                     The same summary as JSON goes beside it, as <file>.bench-summary.json,',
    '                     the details as <file>.bench-details.txt, and everything each side',
    '                     replied, unreduced, as <file>.bench-debug.json',
    '  --stats-only       Describe the list and stop there: no request, no key needed',
    '  --paired           Ask both sides about every number within the same second, alternating',
    '                     which goes first. The baseline is a bare VIES call - one attempt, no',
    '                     cache, no retry - so the comparison is against calling VIES yourself.',
    '                     Concurrency is forced to 1. Use a list of numbers never looked up',
    '                     before, or vatlas answers half of it from its own cache',
    '  --vies-only        Measure VIES alone: no API, no database, no national register.',
    '                     Calls the service in process, so no key and no running server are',
    '                     needed; --url, --key and --timeout do not apply (VIES_TIMEOUT_MS does).',
    '                     vies_cache is never read nor written, so every number is a live call:',
    '                     slow, and rate limited by VIES - keep the concurrency low',
    '  --help             This text',
    '',
    'Examples:',
    '  npm run benchmark -- data/vats.txt',
    '  npm run benchmark -- data/vats.txt --concurrency 8',
    '  npm run benchmark -- data/vats.txt --limit 500',
    '  npm run benchmark -- data/vats.txt --stats-only',
    '  npm run benchmark -- data/vats.txt --vies-only --limit 200',
    '  npm run benchmark -- data/fresh.txt --paired --key vtl_live_...',
    '',
    'Every lookup is metered against the key, so a run over n numbers costs n calls of quota.',
    '--vies-only is metered by nobody, since it never reaches the API.',
    'To clean a list rather than measure it, use npm run sanitize.',
  ].join('\n');
}

/** The fields used on an invoice. Completeness is measured on these. */
const FIELDS = ['name', 'legalForm', 'address', 'postalCode', 'city', 'source'] as const;
type Field = (typeof FIELDS)[number];

/** Short column headers. */
const FIELD_COLUMNS: Record<Field, string> = {
  name: 'name',
  legalForm: 'form',
  address: 'addr',
  postalCode: 'post',
  city: 'city',
  source: 'src',
};

const FIELD_LABELS: Record<Field, string> = {
  name: 'name',
  legalForm: 'legal form',
  address: 'address',
  postalCode: 'postal code',
  city: 'city',
  source: 'source',
};

interface Result {
  vatNumber: string;
  countryCode: string;
  ms: number;
  httpStatus: number | null;
  /** found | not-registered | unavailable | not-found | rejected | timeout | error */
  outcome: string;
  origin: string | null;
  source: string | null;
  /** For a request that never came back: what fetch threw, at the end of the details line. */
  note: string | null;
  filled: Record<Field, boolean>;
  /**
   * The four values compared by the paired mode. Kept during the run only: the report holds a
   * verdict per field, not the payloads.
   */
  values?: Record<Compared, string | null>;
  /**
   * What the side replied, as is: the JSON envelope for vatlas, the SOAP tags for VIES. Only written
   * to `.bench-debug.json`. No report figure is computed from it.
   */
  raw?: unknown;
}

/**
 * `TypeError: fetch failed` says nothing alone. The reason is in undici's `cause` (`ECONNRESET`,
 * `ETIMEDOUT`, TLS error).
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as { code?: unknown }).code;
  const causeText = typeof code === 'string' ? `${cause.message} (${code})` : cause.message;
  return error.message.includes(cause.message) ? error.message : `${error.message}: ${causeText}`;
}

/**
 * Completeness per record, as two questions: can the company be named (name or legal form), and
 * can it be located (street, city or postal code).
 *
 * It cannot be derived from the per-field totals: two totals of 40 out of 50 can mean anywhere
 * between 40 and 50 records with one or the other.
 *
 * The vs-VIES comparison uses these two buckets, since VIES puts the legal form in the name and the
 * address in one block, which would score zero on separate fields.
 */
function usable(rows: Result[]): { name: number; address: number; of: number } {
  return {
    name: rows.filter((row) => row.filled.name || row.filled.legalForm).length,
    address: rows.filter((row) => row.filled.address || row.filled.city || row.filled.postalCode).length,
    of: rows.length,
  };
}

/** An empty string is not a filled field: VIES answers `name: ""` for Germany. */
function isFilled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

const NOTHING_FILLED: Record<Field, boolean> = {
  name: false,
  legalForm: false,
  address: false,
  postalCode: false,
  city: false,
  source: false,
};

async function lookup(entry: Entry, base: string, key: string, timeoutMs: number): Promise<Result> {
  const url = `${base}/v1/lookup/${encodeURIComponent(entry.vatNumber)}`;

  // The timer includes reading the body.
  const started = performance.now();
  let response: Response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read from the API
  let body: Record<string, any>;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read from the API
    body = (await response.json()) as Record<string, any>;
  } catch (error) {
    return {
      vatNumber: entry.vatNumber,
      countryCode: entry.countryCode,
      ms: performance.now() - started,
      httpStatus: null,
      outcome: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error',
      origin: null,
      source: null,
      note: describeError(error),
      filled: NOTHING_FILLED,
      raw: null,
    };
  }
  const ms = performance.now() - started;

  const data = body?.data;
  const meta = body?.meta;
  const code: string | undefined = body?.error?.code;

  return {
    vatNumber: entry.vatNumber,
    countryCode: entry.countryCode,
    ms,
    httpStatus: response.status,
    outcome: response.ok ? 'found' : (OUTCOMES[code ?? ''] ?? code ?? `HTTP ${response.status}`),
    origin: meta?.origin ?? null,
    source: meta?.source ?? null,
    note: response.ok ? null : typeof body?.error?.message === 'string' ? body.error.message : null,
    filled: response.ok
      ? {
          name: isFilled(data?.name),
          legalForm: isFilled(data?.legalForm),
          address: isFilled(data?.address?.line1),
          postalCode: isFilled(data?.address?.postalCode),
          city: isFilled(data?.address?.city),
          source: isFilled(meta?.source),
        }
      : NOTHING_FILLED,
    values: response.ok
      ? {
          name: text(data?.name),
          address: text(data?.address?.line1),
          postalCode: text(data?.address?.postalCode),
          city: text(data?.address?.city),
        }
      : undefined,
    // The whole envelope, error envelopes included.
    raw: body ?? null,
  };
}

/** The value as a string or nothing. The JSON is not trusted. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Every leaf tag of a SOAP body, without namespace prefix, in the order sent. Generic so the debug
 * file shows what the parser drops. Line breaks are kept (`traderAddress` is two lines).
 */
function soapFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of xml.matchAll(/<(?:\w+:)?([\w.-]+)>([^<]*)<\/(?:\w+:)?\1>/g)) {
    fields[match[1] as string] = decodeXmlEntities((match[2] ?? '').trim());
  }
  return fields;
}

/**
 * `--vies-only`: VIES is asked directly, and the answer is mapped with the service's own code, so
 * completeness means the same in both modes.
 *
 * `origin` is always `vies` here: a source is always a live call.
 *
 * No HTTP status and no `--timeout`: the source uses `VIES_TIMEOUT_MS` per attempt and its own
 * retries.
 */
async function lookupDirect(entry: Entry): Promise<Result> {
  const base = { vatNumber: entry.vatNumber, countryCode: entry.countryCode, httpStatus: null };

  const started = performance.now();
  try {
    const vat = parseVatNumber(entry.vatNumber);
    const answer = await viesSource.fetch(vat, {
      deadline: Date.now() + config.lookup.deadlineMs,
      trace: new SourceTrace(),
    });
    const ms = performance.now() - started;

    if (answer.status === 'unavailable') {
      const { fault, attempts } = answer.failure;
      return {
        ...base,
        ms,
        outcome: 'unavailable',
        origin: null,
        source: null,
        note: `${fault} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
        filled: NOTHING_FILLED,
        // The source returns a verdict, not the body, so this mode shows the failure as the source saw it.
        raw: { fault, attempts },
      };
    }

    if (answer.status !== 'found') {
      return {
        ...base,
        ms,
        outcome: 'not-registered',
        origin: null,
        source: null,
        note: null,
        filled: NOTHING_FILLED,
        raw: { answer, company: null },
      };
    }

    const company = answer.record;
    return {
      ...base,
      ms,
      outcome: 'found',
      origin: 'vies',
      source: VIES_SOURCE,
      note: null,
      filled: {
        name: isFilled(company.name),
        legalForm: isFilled(company.legalForm),
        address: isFilled(company.addressLine1),
        postalCode: isFilled(company.postalCode),
        city: isFilled(company.city),
        source: true,
      },
      values: {
        name: text(company.name),
        address: text(company.addressLine1),
        postalCode: text(company.postalCode),
        city: text(company.city),
      },
      // The verdict and its record: the closest to raw this mode gets.
      raw: { answer, company },
    };
  } catch (error) {
    // Malformed numbers are filtered before the run, so this is a database or parser error, reported
    // rather than fatal.
    return {
      ...base,
      ms: performance.now() - started,
      outcome: 'error',
      origin: null,
      source: null,
      note: describeError(error),
      filled: NOTHING_FILLED,
      raw: null,
    };
  }
}

/**
 * The baseline leg of a paired run: one plain `checkVat` from this machine, no cache and no retries.
 *
 * `checkVatRaw` rather than `lookupVies`, since the retries are what vatlas adds. Giving them to
 * the baseline would compare vatlas with vatlas. `PAIRED_BASELINE_NOTE` states this in the report.
 *
 * It names the same requester as vatlas, so both legs call `checkVatApprox` and time the same
 * operation.
 */
async function lookupViesBare(entry: Entry): Promise<Result> {
  const base = { vatNumber: entry.vatNumber, countryCode: entry.countryCode, httpStatus: null };
  const started = performance.now();

  try {
    const vat = parseVatNumber(entry.vatNumber);
    const raw = await checkVatRaw(vat.countryCode, vat.nationalNumber, {
      requester: config.vies.requester,
      maxRetries: 0,
    });
    const ms = performance.now() - started;

    if (!raw || raw.parsed.kind !== 'answer') {
      const fault = raw?.parsed.kind === 'fault' ? raw.parsed.fault : 'NO_RESPONSE';
      return {
        ...base,
        ms,
        outcome: 'unavailable',
        origin: null,
        source: null,
        note: `${fault} on a single attempt`,
        filled: NOTHING_FILLED,
        raw: raw ? soapFields(raw.body) : null,
      };
    }

    if (!raw.parsed.valid) {
      return {
        ...base,
        ms,
        outcome: 'not-registered',
        origin: null,
        source: null,
        note: null,
        filled: NOTHING_FILLED,
        raw: soapFields(raw.body),
      };
    }

    const company = viesToCompanyRecord(vat, raw.parsed.name, raw.parsed.address);

    return {
      ...base,
      ms,
      outcome: 'found',
      origin: 'vies',
      source: VIES_SOURCE,
      note: null,
      filled: {
        name: isFilled(company.name),
        legalForm: isFilled(company.legalForm),
        address: isFilled(company.addressLine1),
        postalCode: isFilled(company.postalCode),
        city: isFilled(company.city),
        source: true,
      },
      values: {
        name: text(company.name),
        address: text(company.addressLine1),
        postalCode: text(company.postalCode),
        city: text(company.city),
      },
      // Every tag VIES sent, including requestDate and traderCompanyType which nothing else keeps.
      raw: soapFields(raw.body),
    };
  } catch (error) {
    return {
      ...base,
      ms: performance.now() - started,
      outcome: 'error',
      origin: null,
      source: null,
      note: describeError(error),
      filled: NOTHING_FILLED,
      raw: null,
    };
  }
}

/** One number, asked of both sides within the same second. */
interface Pair {
  vatNumber: string;
  countryCode: string;
  vatlas: Result;
  vies: Result;
  /** Which side went first, to check for an order effect. */
  viesFirst: boolean;
}

/**
 * Pause between the two legs of a pair: short enough that both see the same VIES, long enough not
 * to be our own concurrent request.
 */
const PAIR_GAP_MS = 150;

/**
 * Both legs for one number, in an order alternating with the index, so the cost of going second is
 * shared equally.
 */
async function lookupPaired(entry: Entry, index: number, base: string, key: string, timeoutMs: number): Promise<Pair> {
  const viesFirst = index % 2 === 0;
  const askVatlas = (): Promise<Result> => lookup(entry, base, key, timeoutMs);
  const askVies = (): Promise<Result> => lookupViesBare(entry);

  let vatlas: Result;
  let vies: Result;
  if (viesFirst) {
    vies = await askVies();
    await delay(PAIR_GAP_MS);
    vatlas = await askVatlas();
  } else {
    vatlas = await askVatlas();
    await delay(PAIR_GAP_MS);
    vies = await askVies();
  }

  return { vatNumber: entry.vatNumber, countryCode: entry.countryCode, vatlas, vies, viesFirst };
}

/** Short names for the misses. Anything else is shown as is. */
const OUTCOMES: Record<string, string> = {
  VAT_NOT_REGISTERED: 'not-registered',
  SOURCE_UNAVAILABLE: 'unavailable',
  COMPANY_NOT_FOUND: 'not-found',
  INVALID_VAT_FORMAT: 'rejected',
  QUOTA_EXCEEDED: 'quota-exceeded',
};

/** Why a run ended before the end of the list. */
type Stop = 'quota' | 'interrupt';

/**
 * A fixed pool of workers pulling from one cursor (a chunk would wait on its slowest number).
 * Results are stored at their index, so the details keep the list order.
 *
 * Two things stop it early:
 *
 * - a spent quota: the 429s are dropped, and what was measured is reported;
 * - Ctrl+C: workers stop, in-flight requests finish, and the report is printed. A second Ctrl+C
 *   kills the process.
 */
async function runAll<T>(
  entries: Entry[],
  concurrency: number,
  run: (entry: Entry, index: number) => Promise<T>,
  onProgress: (done: number, current: string) => void,
  quotaExceeded: (result: T) => boolean = (result) => (result as Result).outcome === 'quota-exceeded',
): Promise<{ results: T[]; stop?: Stop }> {
  const results = new Array<T | undefined>(entries.length);
  let next = 0;
  let done = 0;
  let stop: Stop | undefined;

  const onInterrupt = (): void => {
    if (stop === 'interrupt') {
      process.stderr.write('\nInterrupted twice, stopping now.\n');
      process.exit(130);
    }
    stop = 'interrupt';
    process.stderr.write('\nInterrupted; finishing the requests in flight, then reporting.\n');
  };
  process.on('SIGINT', onInterrupt);

  // Numbers in flight, for the progress line.
  const inFlight = new Set<string>();

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const index = next++;
      const entry = entries[index];
      if (!entry) return;

      inFlight.add(entry.vatNumber);
      onProgress(done, entry.vatNumber);
      const result = await run(entry, index);
      inFlight.delete(entry.vatNumber);

      if (quotaExceeded(result)) {
        stop ??= 'quota';
        return;
      }
      results[index] = result;
      done += 1;
      // Redrawn when a request lands only while others are still running.
      const running = [...inFlight][0];
      if (running) onProgress(done, running);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  } finally {
    process.off('SIGINT', onInterrupt);
  }

  // The array has holes after an early stop. Order is preserved.
  return { results: results.filter((result): result is T => result !== undefined), stop };
}

/** Nearest rank over a sorted array, no interpolation. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

function ms(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

/** Totals are durations, printed in seconds. */
function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

function total(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

interface MeasurementInput {
  /** Where the answers came from: the API base URL, or the VIES endpoint under `--vies-only`. */
  base: string;
  /** Which path was measured. Runs of different modes are not comparable. */
  mode: 'api' | 'vies';
  concurrency: number;
  elapsedMs: number;
  results: Result[];
  /** Size of the list, to show how much a stopped run covered. */
  planned: number;
  stop?: Stop;
}

/** The part of the report that needs the results. */
function measurementReport({ base, mode, concurrency, elapsedMs, results, planned, stop }: MeasurementInput): string {
  const out: string[] = [];
  const add = (line = ''): number => out.push(line);

  const found = results.filter((result) => result.outcome === 'found');
  const times = results.map((result) => result.ms).sort((a, b) => a - b);

  add(`Lookups - ${base} - concurrency ${concurrency} - run took ${(elapsedMs / 1000).toFixed(1)}s`);
  if (mode === 'vies') {
    // Stated first: these are not the figures a customer sees.
    add('  VIES ONLY - the API, the local database and the national registers are out of the path');
    add('  vies_cache neither read nor written: every number is a live call');
  }
  if (stop) {
    // Stated first: everything below only covers part of the list.
    const reason =
      stop === 'quota' ? 'the monthly quota of the key is spent (the 429 itself is not counted below)' : 'interrupted';
    add(`  STOPPED EARLY - ${reason}`);
    add(`  ${results.length} of ${planned} numbers measured; the rest were never sent`);
  }
  add();

  if (results.length === 0) {
    add('  Nothing was measured.');
    add();
    return `${out.join('\n')}\n`;
  }

  add('Outcomes');
  const outcomes = [...countBy(results, (result) => result.outcome).entries()].sort((a, b) => b[1] - a[1]);
  for (const [outcome, count] of outcomes) {
    add(`  ${outcome.padEnd(20)} ${String(count).padStart(6)}  ${percent(count, results.length)}`);
  }
  add();

  add('Latency, every lookup (ms)');
  add(`  p50 ${ms(percentile(times, 50)).padStart(8)}`);
  add(`  p95 ${ms(percentile(times, 95)).padStart(8)}`);
  add(`  max ${ms(times[times.length - 1] ?? 0).padStart(8)}`);
  add(`  avg ${ms(total(times) / (times.length || 1)).padStart(8)}`);
  add();

  add(`Completeness, over the ${found.length} answers found`);
  for (const field of FIELDS) {
    const count = found.filter((result) => result.filled[field]).length;
    add(`  ${FIELD_LABELS[field].padEnd(12)} ${percent(count, found.length).padStart(7)}  (${count}/${found.length})`);
  }
  add();
  add(`  answered by          ${describe(countBy(found, (result) => result.origin ?? '?'))}`);
  add(`  sources              ${describe(countBy(found, (result) => result.source ?? '?'))}`);
  add();

  // Only the countries in the file.
  //
  // `total` is the sum of the country's lookup times. At concurrency 1 the column adds up to the run;
  // above that, lookups overlap. Either way it shows which country the run was spent on.
  add('Per country - latency over every lookup, completeness over the ones found');
  add(
    `  ${'code'.padEnd(6)}${'n'.padStart(6)}${'found'.padStart(8)}${'p50'.padStart(9)}${'p95'.padStart(9)}` +
      `${'total'.padStart(10)}` +
      FIELDS.map((field) => FIELD_COLUMNS[field].padStart(9)).join(''),
  );
  const codes = [...new Set(results.map((result) => result.countryCode))].sort();
  for (const code of codes) {
    const rows = results.filter((result) => result.countryCode === code);
    const ok = rows.filter((result) => result.outcome === 'found');
    const sorted = rows.map((result) => result.ms).sort((a, b) => a - b);
    add(
      `  ${code.padEnd(6)}${String(rows.length).padStart(6)}${percent(ok.length, rows.length).padStart(8)}` +
        `${ms(percentile(sorted, 50)).padStart(9)}${ms(percentile(sorted, 95)).padStart(9)}` +
        `${seconds(total(sorted)).padStart(10)}` +
        FIELDS.map((field) => percent(ok.filter((result) => result.filled[field]).length, ok.length).padStart(9)).join(
          '',
        ),
    );
  }
  add();

  add('Per country - where the answers came from');
  for (const code of codes) {
    const rows = results.filter((result) => result.countryCode === code);
    add(`  ${code.padEnd(6)}${describe(countBy(rows, (result) => result.origin ?? result.outcome))}`);
  }

  return `${out.join('\n')}\n`;
}

/**
 * The measurement as data, built from the same `MeasurementInput` as the text report. Times are
 * unrounded milliseconds.
 */
function measurementJson({
  base,
  mode,
  concurrency,
  elapsedMs,
  results,
  planned,
  stop,
}: MeasurementInput): Record<string, unknown> {
  const found = results.filter((result) => result.outcome === 'found');
  const times = results.map((result) => result.ms).sort((a, b) => a - b);

  const completeness = (rows: Result[]): Record<string, number> =>
    Object.fromEntries(FIELDS.map((field) => [field, rows.filter((result) => result.filled[field]).length]));

  return {
    baseUrl: base,
    mode,
    concurrency,
    elapsedMs,
    planned,
    measured: results.length,
    stoppedEarly: stop ?? null,
    outcomes: Object.fromEntries(countBy(results, (result) => result.outcome)),
    latencyMs: {
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1] ?? 0,
      avg: total(times) / (times.length || 1),
      total: total(times),
    },
    found: found.length,
    completeness: completeness(found),
    usable: usable(found),
    origins: Object.fromEntries(countBy(found, (result) => result.origin ?? '?')),
    sources: Object.fromEntries(countBy(found, (result) => result.source ?? '?')),
    // Only the countries in the list. `totalMs` is unrounded here.
    countries: [...new Set(results.map((result) => result.countryCode))].sort().map((code) => {
      const rows = results.filter((result) => result.countryCode === code);
      const ok = rows.filter((result) => result.outcome === 'found');
      const sorted = rows.map((result) => result.ms).sort((a, b) => a - b);
      return {
        code,
        n: rows.length,
        found: ok.length,
        latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), total: total(sorted) },
        completeness: completeness(ok),
        usable: usable(ok),
        outcomes: Object.fromEntries(countBy(rows, (result) => result.outcome)),
        origins: Object.fromEntries(countBy(rows, (result) => result.origin ?? result.outcome)),
      };
    }),
  };
}

/**
 * What the baseline leg is, stated in the report: a plain VIES call without retries, as an
 * application would make before adding resilience.
 */
const PAIRED_BASELINE_NOTE = [
  '  PAIRED - each number was asked of both sides within the same second, in an order that',
  '  alternates, so neither side is systematically second and neither sees a different VIES.',
  '  The baseline is a BARE VIES CALL: one attempt, no cache, no retry. vatlas retries a',
  '  member state that answers MS_MAX_CONCURRENT_REQ; that is code the caller would otherwise',
  '  write, and it is part of what is being compared, not a thumb on the scale.',
  '  The vatlas leg pays one network hop more (here -> vatlas -> VIES), which counts against it.',
];

interface PairedInput {
  base: string;
  concurrency: number;
  elapsedMs: number;
  pairs: Pair[];
  planned: number;
  stop?: Stop;
}

/** Latency figures for one side over a set of pairs. */
function latency(rows: Result[]): { p50: number; p95: number; max: number; avg: number; total: number } {
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1] ?? 0,
    avg: total(times) / (times.length || 1),
    total: total(times),
  };
}

function emptyVerdicts(): Record<Verdict, number> {
  return { equal: 0, different: 0, onlyVatlas: 0, onlyVies: 0, neither: 0 };
}

/**
 * Verdicts per field, over pairs where both sides answered, so availability does not leak into
 * agreement.
 */
function agreement(pairs: Pair[]): Record<Compared, Record<Verdict, number>> {
  const both = pairs.filter((pair) => pair.vatlas.outcome === 'found' && pair.vies.outcome === 'found');
  const counts = Object.fromEntries(COMPARED.map((field) => [field, emptyVerdicts()])) as Record<
    Compared,
    Record<Verdict, number>
  >;

  for (const pair of both) {
    for (const field of COMPARED) {
      counts[field][verdictFor(pair.vatlas.values?.[field], pair.vies.values?.[field])] += 1;
    }
  }
  return counts;
}

/** How often both sides agreed on whether the number resolves. */
function statusMatrix(pairs: Pair[]): Record<string, number> {
  return Object.fromEntries(countBy(pairs, (pair) => `${pair.vatlas.outcome} / ${pair.vies.outcome}`));
}

function pairedReport({ base, concurrency, elapsedMs, pairs, planned, stop }: PairedInput): string {
  const out: string[] = [];
  const add = (line = ''): number => out.push(line);

  add(`Paired lookups - ${base} against ${VIES_ENDPOINT}`);
  add(`  concurrency ${concurrency} - run took ${(elapsedMs / 1000).toFixed(1)}s`);
  for (const line of PAIRED_BASELINE_NOTE) add(line);
  if (stop) {
    // Stated first: a paired run that ran out of quota only measured one side.
    add();
    add('  *** RUN INVALID ***');
    add(
      stop === 'quota'
        ? '  The monthly quota of the key ran out. Everything below covers part of the list only,'
        : '  Interrupted. Everything below covers part of the list only,',
    );
    add(`  ${pairs.length} of ${planned} numbers were paired. Re-run it; do not publish this.`);
  }
  add();

  if (pairs.length === 0) {
    add('  Nothing was measured.');
    add();
    return `${out.join('\n')}\n`;
  }

  const vatlas = pairs.map((pair) => pair.vatlas);
  const vies = pairs.map((pair) => pair.vies);
  const foundVatlas = vatlas.filter((row) => row.outcome === 'found');
  const foundVies = vies.filter((row) => row.outcome === 'found');

  add('Resolved');
  add(`  vatlas               ${String(foundVatlas.length).padStart(6)}  ${percent(foundVatlas.length, pairs.length)}`);
  add(`  bare VIES            ${String(foundVies.length).padStart(6)}  ${percent(foundVies.length, pairs.length)}`);
  add();

  // Over every lookup (a baseline that fails fast looks fast) and over found answers only (the cost
  // of resolving a number).
  for (const [label, left, right] of [
    ['every lookup', vatlas, vies],
    ['the lookups that found an answer', foundVatlas, foundVies],
  ] as const) {
    const a = latency(left);
    const b = latency(right);
    add(`Latency over ${label} (ms)`);
    add(`  ${'      '.padEnd(10)}${'vatlas'.padStart(10)}${'bare VIES'.padStart(12)}`);
    for (const key of ['p50', 'p95', 'max', 'avg'] as const) {
      add(`  ${key.padEnd(10)}${ms(a[key]).padStart(10)}${ms(b[key]).padStart(12)}`);
    }
    add();
  }

  add(
    `Field agreement, over the ${pairs.filter((p) => p.vatlas.outcome === 'found' && p.vies.outcome === 'found').length} numbers both sides answered`,
  );
  const counts = agreement(pairs);
  add(`  ${'field'.padEnd(12)}${VERDICTS.map((verdict) => verdict.padStart(12)).join('')}`);
  for (const field of COMPARED) {
    add(`  ${field.padEnd(12)}${VERDICTS.map((verdict) => String(counts[field][verdict]).padStart(12)).join('')}`);
  }
  add();

  add('Outcome pairs (vatlas / bare VIES)');
  for (const [pairing, count] of Object.entries(statusMatrix(pairs)).sort((a, b) => b[1] - a[1])) {
    add(`  ${pairing.padEnd(36)}${String(count).padStart(6)}`);
  }
  add();

  // Checks the pairing: if going second had a cost the alternation did not cancel, these diverge.
  const firstHalf = pairs.filter((pair) => pair.viesFirst);
  const secondHalf = pairs.filter((pair) => !pair.viesFirst);
  add('Order effect check - vatlas p50 by which side went first');
  add(
    `  VIES first  ${ms(latency(firstHalf.map((pair) => pair.vatlas)).p50).padStart(10)}  (${firstHalf.length} numbers)`,
  );
  add(
    `  vatlas first${ms(latency(secondHalf.map((pair) => pair.vatlas)).p50).padStart(10)}  (${secondHalf.length} numbers)`,
  );
  add();

  add('Where vatlas answered from');
  add(`  ${describe(countBy(foundVatlas, (row) => row.origin ?? '?'))}`);
  add('  A run on numbers never looked up before shows no "database" for a VIES-served country;');
  add('  anything else means the list was warm and the latencies are not a cold measurement.');
  add();

  add('Per country - resolved, then vatlas p50 against bare VIES p50');
  add(
    `  ${'code'.padEnd(6)}${'n'.padStart(5)}${'vatlas'.padStart(9)}${'VIES'.padStart(8)}${'p50 vatlas'.padStart(12)}${'p50 VIES'.padStart(11)}`,
  );
  for (const code of [...new Set(pairs.map((pair) => pair.countryCode))].sort()) {
    const rows = pairs.filter((pair) => pair.countryCode === code);
    const ok = (side: (pair: Pair) => Result): number => rows.filter((pair) => side(pair).outcome === 'found').length;
    add(
      `  ${code.padEnd(6)}${String(rows.length).padStart(5)}` +
        `${percent(
          ok((pair) => pair.vatlas),
          rows.length,
        ).padStart(9)}${percent(
          ok((pair) => pair.vies),
          rows.length,
        ).padStart(8)}` +
        `${ms(latency(rows.map((pair) => pair.vatlas)).p50).padStart(12)}${ms(latency(rows.map((pair) => pair.vies)).p50).padStart(11)}`,
    );
  }
  add();

  return `${out.join('\n')}\n`;
}

/**
 * The paired measurement as data, in the `bench-compare.json` shape the site reads: `vatlas` and
 * `viesOnly` side by side, `savedMs` positive when vatlas is faster.
 */
function pairedJson({ base, concurrency, elapsedMs, pairs, planned, stop }: PairedInput): Record<string, unknown> {
  const side = (rows: Result[]): Record<string, unknown> => {
    const found = rows.filter((row) => row.outcome === 'found');
    return {
      found: found.length,
      latencyMs: latency(rows),
      outcomes: Object.fromEntries(countBy(rows, (row) => row.outcome)),
      completeness: Object.fromEntries(FIELDS.map((field) => [field, found.filter((row) => row.filled[field]).length])),
      usable: usable(found),
    };
  };

  const both = (rows: Pair[]): Record<string, unknown> => ({
    n: rows.length,
    vatlas: side(rows.map((pair) => pair.vatlas)),
    viesOnly: side(rows.map((pair) => pair.vies)),
  });

  return {
    mode: 'paired',
    baseUrl: base,
    viesEndpoint: VIES_ENDPOINT,
    baseline: 'bare VIES call: one attempt, no cache, no retry',
    concurrency,
    elapsedMs,
    planned,
    measured: pairs.length,
    stoppedEarly: stop ?? null,
    // A partial paired run is not a valid comparison.
    invalid: stop !== undefined,
    invalidReason: stop === 'quota' ? 'the key ran out of quota mid-run' : stop === 'interrupt' ? 'interrupted' : null,
    overall: both(pairs),
    agreement: agreement(pairs),
    statusPairs: statusMatrix(pairs),
    vatlasOrigins: Object.fromEntries(
      countBy(
        pairs.map((pair) => pair.vatlas).filter((row) => row.outcome === 'found'),
        (row) => row.origin ?? '?',
      ),
    ),
    orderEffect: {
      viesFirst: latency(pairs.filter((pair) => pair.viesFirst).map((pair) => pair.vatlas)),
      vatlasFirst: latency(pairs.filter((pair) => !pair.viesFirst).map((pair) => pair.vatlas)),
    },
    countries: [...new Set(pairs.map((pair) => pair.countryCode))].sort().map((code) => ({
      code,
      ...both(pairs.filter((pair) => pair.countryCode === code)),
    })),
  };
}

/** How many disagreeing pairs are written in full. */
const DISAGREEMENT_SAMPLE = 200;

/** One line per pair, then the disagreements in full. Raw values are only kept for disagreeing rows. */
function pairedDetails(pairs: Pair[]): string {
  const width = Math.max(16, ...pairs.map((pair) => pair.vatNumber.length + 2));
  const lines = [
    `${'vat'.padEnd(width)}${'first'.padEnd(8)}${'vatlas'.padEnd(16)}${'ms'.padStart(9)}  ${'vies'.padEnd(16)}${'ms'.padStart(9)}  ` +
      COMPARED.map((field) => field.padEnd(12)).join(''),
  ];

  for (const pair of pairs) {
    const comparable = pair.vatlas.outcome === 'found' && pair.vies.outcome === 'found';
    lines.push(
      `${pair.vatNumber.padEnd(width)}${(pair.viesFirst ? 'vies' : 'vatlas').padEnd(8)}` +
        `${pair.vatlas.outcome.padEnd(16)}${ms(pair.vatlas.ms).padStart(9)}  ` +
        `${pair.vies.outcome.padEnd(16)}${ms(pair.vies.ms).padStart(9)}  ` +
        COMPARED.map((field) =>
          (comparable ? verdictFor(pair.vatlas.values?.[field], pair.vies.values?.[field]) : '-').padEnd(12),
        ).join(''),
    );
  }

  const disagreements = pairs.filter(
    (pair) =>
      pair.vatlas.outcome === 'found' &&
      pair.vies.outcome === 'found' &&
      COMPARED.some((field) => verdictFor(pair.vatlas.values?.[field], pair.vies.values?.[field]) === 'different'),
  );

  if (disagreements.length > 0) {
    lines.push('');
    lines.push(
      `Disagreements, ${Math.min(disagreements.length, DISAGREEMENT_SAMPLE)} of ${disagreements.length} shown in full`,
    );
    for (const pair of disagreements.slice(0, DISAGREEMENT_SAMPLE)) {
      lines.push('');
      lines.push(`  ${pair.vatNumber}`);
      for (const field of COMPARED) {
        if (verdictFor(pair.vatlas.values?.[field], pair.vies.values?.[field]) !== 'different') continue;
        lines.push(`    ${field.padEnd(12)} vatlas: ${pair.vatlas.values?.[field] ?? ''}`);
        lines.push(`    ${''.padEnd(12)} vies:   ${pair.vies.values?.[field] ?? ''}`);
      }
    }
  }

  return `${lines.map((line) => line.trimEnd()).join('\n')}\n`;
}

/** The whole summary: the list, then the lookups. */
function summaryJson(stats: ListStats, measurement: MeasurementInput | undefined): string {
  return `${JSON.stringify({ ...stats, lookups: measurement ? measurementJson(measurement) : null }, null, 2)}\n`;
}

/**
 * One line per number, in list order: the number, its time, the result, and which fields were
 * there. Aligned columns, so `grep -v found` lists the misses and `sort -k2 -n` the slowest.
 */
function detailsReport(results: Result[]): string {
  const vatWidth = Math.max(16, ...results.map((result) => result.vatNumber.length + 2));
  const outcomeWidth = Math.max(16, ...results.map((result) => result.outcome.length + 2));

  const lines = [
    `${'vat'.padEnd(vatWidth)}${'ms'.padStart(8)}  ${'outcome'.padEnd(outcomeWidth)}` +
      `${'origin'.padEnd(10)}${'source'.padEnd(8)}${FIELDS.map((field) => FIELD_COLUMNS[field].padEnd(6)).join('')}`,
  ];

  for (const result of results) {
    const found = result.outcome === 'found';
    lines.push(
      `${result.vatNumber.padEnd(vatWidth)}${ms(result.ms).padStart(8)}  ${result.outcome.padEnd(outcomeWidth)}` +
        `${(result.origin ?? '-').padEnd(10)}${(result.source ?? '-').padEnd(8)}` +
        // A miss has no fields to report.
        FIELDS.map((field) => (found ? (result.filled[field] ? 'yes' : 'no') : '-').padEnd(6)).join('') +
        // Last, when present: why a request never came back.
        (result.note ? `  ${result.note.replace(/\s+/g, ' ')}` : ''),
    );
  }

  return `${lines.map((line) => line.trimEnd()).join('\n')}\n`;
}

/** One side of one number in the debug file: time, outcome, and what it said. */
interface DebugLeg {
  ms: number;
  outcome: string;
  /** The run's definition of success. */
  success: boolean;
  httpStatus: number | null;
  origin: string | null;
  source: string | null;
  note: string | null;
  raw: unknown;
}

function debugLeg(result: Result): DebugLeg {
  return {
    ms: result.ms,
    outcome: result.outcome,
    success: result.outcome === 'found',
    httpStatus: result.httpStatus,
    origin: result.origin,
    source: result.source,
    note: result.note,
    raw: result.raw ?? null,
  };
}

/**
 * Every answer of the run, one entry per number in list order. Nothing reads this file (not the
 * site, not `compare`, not `unpair`): it is for `jq` or reading by hand when a figure looks wrong.
 *
 * A side that was not asked is `null`.
 */
function debugJson(
  mode: 'api' | 'vies' | 'paired',
  base: string,
  planned: number,
  stop: Stop | undefined,
  entries: { vatNumber: string; countryCode: string; viesFirst?: boolean; vatlas?: Result; vies?: Result }[],
): string {
  return `${JSON.stringify(
    {
      mode,
      baseUrl: base,
      viesEndpoint: mode === 'api' ? null : VIES_ENDPOINT,
      generatedAt: new Date().toISOString(),
      planned,
      measured: entries.length,
      stoppedEarly: stop ?? null,
      entries: entries.map((entry) => ({
        vatNumber: entry.vatNumber,
        countryCode: entry.countryCode,
        ...(entry.viesFirst === undefined ? {} : { viesFirst: entry.viesFirst }),
        vatlas: entry.vatlas ? debugLeg(entry.vatlas) : null,
        vies: entry.vies ? debugLeg(entry.vies) : null,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Clears what a longer previous progress line left. */
const CLEAR_TO_END = '\u001b[0J';

const VALUE_OPTIONS = ['--url', '--key', '--concurrency', '--limit', '--timeout', '--out'];
const FLAG_OPTIONS = ['--stats-only', '--vies-only', '--paired'];

/** `vats.bench-summary.txt` gives `vats.bench-details.txt`, and `--out run.txt` gives `run-details.txt`. */
function detailsPath(summaryPath: string): string {
  return summaryPath.includes('summary')
    ? summaryPath.replace('summary', 'details')
    : suffixed(summaryPath, '-details');
}

/** `vats.bench-summary.txt` gives `vats.bench-debug.json`, and `--out run.txt` gives `run-debug.json`. */
function debugPath(summaryPath: string): string {
  const path = summaryPath.includes('summary')
    ? summaryPath.replace('summary', 'debug')
    : suffixed(summaryPath, '-debug');
  return `${path.replace(/\.[^./]*$/, '')}.json`;
}

/** The JSON sits next to the text with the same name: `run.txt` gives `run.json`. */
function jsonPath(summaryPath: string): string {
  const path = `${summaryPath.replace(/\.[^./]*$/, '')}.json`;
  // Otherwise `--out run.json` would write the JSON over the text summary.
  return path === summaryPath ? suffixed(summaryPath, '-summary') : path;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  const { file, error } = parseArgs(args, VALUE_OPTIONS, FLAG_OPTIONS);

  if (error && !wantsHelp) {
    process.stderr.write(`${error}\n\n${usage()}\n`);
    return 1;
  }
  if (wantsHelp || !file) {
    process.stdout.write(`${usage()}\n`);
    return wantsHelp ? 0 : 1;
  }

  const statsOnly = args.includes('--stats-only');
  const viesOnly = args.includes('--vies-only');
  const paired = args.includes('--paired');
  if (paired && viesOnly) {
    process.stderr.write('--paired already measures VIES as its baseline; --vies-only is the other mode.\n');
    return 1;
  }
  if (paired && statsOnly) {
    process.stderr.write('--paired sends requests; --stats-only is the mode that sends none.\n');
    return 1;
  }
  const base = viesOnly ? VIES_ENDPOINT : (optionValue(args, '--url') ?? config.apiBaseUrl).replace(/\/$/, '');
  const key = optionValue(args, '--key') ?? process.env.VATLAS_KEY;
  // Checked before reading the list. `--stats-only` sends nothing and `--vies-only` never calls the
  // API, so neither needs a key.
  if (!statsOnly && !viesOnly && !key) {
    process.stderr.write(
      'A secret key is needed: export VATLAS_KEY=vtl_live_... or pass --key.\n' +
        'Create one in the console (npm run console:dev, then http://localhost:3001).\n' +
        'To read the list without looking anything up, pass --stats-only.\n',
    );
    return 1;
  }

  // Forced to 1 when paired, so pairs never overlap.
  const concurrency = paired ? 1 : numberOption(args, '--concurrency', 1);
  if (paired && numberOption(args, '--concurrency', 1) !== 1) {
    process.stdout.write('\n  --concurrency is ignored under --paired; the run is sequential by design.\n');
  }
  const timeoutMs = numberOption(args, '--timeout', 30_000);
  const limit = args.includes('--limit') ? numberOption(args, '--limit', 0) : undefined;

  const { entries, lines } = readEntries(await readFile(file, 'utf8'), limit);
  if (entries.length === 0) {
    process.stderr.write(`${file} holds no VAT number.\n`);
    return 1;
  }

  // The list report is printed right away, before the requests.
  const startedAt = new Date();
  const stats = listStats('Benchmark', file, startedAt, lines, entries);
  let summary = listReport('Benchmark', file, startedAt, lines, entries);
  process.stdout.write(`\n${summary}`);

  // Malformed numbers are counted but never sent: a 400 would only measure the parser.
  const lookedUp = entries.filter((entry) => !entry.invalid);
  let results: Result[] = [];
  let stop: Stop | undefined;
  let measurement: MeasurementInput | undefined;
  let pairedInput: PairedInput | undefined;

  const progress = (done: number, current: string): void => {
    if (process.stderr.isTTY) {
      process.stderr.write(`\r  ${done}/${lookedUp.length} (lookup ${current})${CLEAR_TO_END}`);
    }
  };

  if (paired) {
    const started = performance.now();
    const run = await runAll<Pair>(
      lookedUp,
      concurrency,
      (entry, index) => lookupPaired(entry, index, base, key as string, timeoutMs),
      progress,
      // A spent quota on either leg ends the run, and that pair is dropped.
      (pair) => pair.vatlas.outcome === 'quota-exceeded' || pair.vies.outcome === 'quota-exceeded',
    );
    if (process.stderr.isTTY) process.stderr.write(`\r${CLEAR_TO_END}`);
    stop = run.stop;

    pairedInput = {
      base,
      concurrency,
      elapsedMs: performance.now() - started,
      pairs: run.results,
      planned: lookedUp.length,
      stop,
    };
    const measured = pairedReport(pairedInput);
    summary += measured;
    process.stdout.write(measured);
  } else if (!statsOnly) {
    const started = performance.now();
    const run = await runAll(
      lookedUp,
      concurrency,
      (entry) => (viesOnly ? lookupDirect(entry) : lookup(entry, base, key as string, timeoutMs)),
      progress,
    );
    if (process.stderr.isTTY) process.stderr.write(`\r${CLEAR_TO_END}`);
    results = run.results;
    stop = run.stop;

    measurement = {
      base,
      mode: viesOnly ? 'vies' : 'api',
      concurrency,
      elapsedMs: performance.now() - started,
      results,
      planned: lookedUp.length,
      stop,
    };
    const measured = measurementReport(measurement);
    summary += measured;
    process.stdout.write(measured);
  }

  // Named after the list: `vats.txt` gives `vats.bench-summary.txt` and `vats.bench-details.txt`. A
  // second run overwrites the first, use `--out` to keep both.
  const summaryPath = optionValue(args, '--out') ?? suffixed(file, '.bench-summary');
  await writeFile(summaryPath, summary, 'utf8');
  process.stdout.write(`Summary written to ${summaryPath}\n`);

  const summaryJsonPath = jsonPath(summaryPath);
  const json = pairedInput
    ? `${JSON.stringify({ ...stats, paired: pairedJson(pairedInput) }, null, 2)}\n`
    : summaryJson(stats, measurement);
  await writeFile(summaryJsonPath, json, 'utf8');
  process.stdout.write(`Summary written to ${summaryJsonPath}\n`);

  if (pairedInput) {
    const path = detailsPath(summaryPath);
    await writeFile(path, pairedDetails(pairedInput.pairs), 'utf8');
    process.stdout.write(`Details written to ${path} (${pairedInput.pairs.length} pairs)\n`);

    const debug = debugPath(summaryPath);
    await writeFile(debug, debugJson('paired', base, lookedUp.length, stop, pairedInput.pairs), 'utf8');
    process.stdout.write(`Debug written to ${debug} (${pairedInput.pairs.length} pairs)\n`);
  } else if (!statsOnly) {
    const path = detailsPath(summaryPath);
    await writeFile(path, detailsReport(results), 'utf8');
    process.stdout.write(`Details written to ${path} (${results.length} numbers)\n`);

    const debug = debugPath(summaryPath);
    // The measured side: the API leg in a plain run, the VIES leg under `--vies-only`. The other is
    // null.
    const entries = results.map((result) =>
      viesOnly
        ? { vatNumber: result.vatNumber, countryCode: result.countryCode, vies: result }
        : { vatNumber: result.vatNumber, countryCode: result.countryCode, vatlas: result },
    );
    await writeFile(debug, debugJson(viesOnly ? 'vies' : 'api', base, lookedUp.length, stop, entries), 'utf8');
    process.stdout.write(`Debug written to ${debug} (${results.length} numbers)\n`);
  }

  // `--vies-only` and `--paired` build a Prisma client on the way to VIES, so they have connections
  // to close. The plain API mode never touches the database.
  if (viesOnly || paired) await Promise.all([closePool(), disconnectPrisma()]);

  // The report is complete either way. The exit code tells a full run from a partial one. 130 is the
  // usual code for Ctrl+C.
  if (stop === 'interrupt') return 130;
  return stop ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
