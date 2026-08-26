import { readFile, writeFile } from 'node:fs/promises';
import { optionValue, percent, suffixed } from './vatList.js';

/**
 * Compares two benchmark runs over the same list: vatlas, and VIES alone.
 *
 * Reads the two `*.bench-summary.json` files and writes a third with the differences. Countries are
 * sorted by largest difference first.
 *
 * Sign convention: `savedMs` and `deltaPoints` are what vatlas gains over VIES. Positive means
 * vatlas is ahead (faster or more complete), negative means behind.
 *
 * Nothing is recomputed: every figure comes from the runs, which is why they are written unrounded.
 */

function usage(): string {
  return [
    'Usage: npm run compare -- <vatlas.json> <vies-only.json> [options]',
    '',
    'Compares two benchmark summaries over the same list - the API run first, the',
    '--vies-only run second - and writes the differences as a third JSON: overall, then',
    'per country, biggest difference first.',
    '',
    'Options:',
    `  --sort <key>   Which difference orders the countries: ${SORT_KEYS.join(' | ')}`,
    `                 (default ${DEFAULT_SORT}). Always by absolute value: a country that got`,
    '                 slower is as interesting as one that got faster',
    '  --out <path>   Where to write the comparison (default: <vatlas.json> as *.compare.json)',
    '  --help         This text',
    '',
    'Examples:',
    '  npm run compare -- benchmarks/bench-50.bench-summary.json benchmarks/bench-50-vies-only.bench-summary.json',
    '  npm run compare -- a.json b.json --sort total --out benchmarks/50.compare.json',
    '',
    'Both files come from npm run benchmark; the second one from a --vies-only run.',
  ].join('\n');
}

/** A benchmark summary, reduced to what the comparison reads. */
interface Summary {
  file?: string;
  startedAt?: string;
  input?: { vatNumbers?: number; usable?: number };
  lookups: Lookups | null;
}

interface Lookups {
  baseUrl: string;
  /** Absent on runs made before `--vies-only` existed, which were API runs. */
  mode?: 'api' | 'vies';
  /**
   * Only present on old summaries from when the benchmark had `--no-cache`. Kept so old runs can still
   * be compared and warned about.
   */
  cacheBypassed?: boolean | null;
  concurrency: number;
  elapsedMs: number;
  planned: number;
  measured: number;
  stoppedEarly: string | null;
  outcomes: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number; avg: number; total: number };
  found: number;
  completeness: Record<string, number>;
  origins: Record<string, number>;
  sources: Record<string, number>;
  countries: Country[];
}

interface Country {
  code: string;
  n: number;
  found: number;
  latencyMs: { p50: number; p95: number; total: number };
  completeness: Record<string, number>;
  outcomes: Record<string, number>;
  origins: Record<string, number>;
}

/** The completeness fields, in print order. */
const FIELDS = ['name', 'legalForm', 'address', 'postalCode', 'city', 'source'] as const;

const SORT_KEYS = ['p50', 'p95', 'total', 'found', 'name'] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT: SortKey = 'p50';

/** One latency figure on both sides. */
interface Compared {
  vatlas: number;
  viesOnly: number;
  /** VIES minus vatlas: time saved per lookup. */
  savedMs: number;
  /** How many times faster vatlas is. Null when vatlas is zero. */
  speedup: number | null;
}

function compare(vatlas: number, viesOnly: number): Compared {
  return {
    vatlas,
    viesOnly,
    savedMs: viesOnly - vatlas,
    speedup: vatlas > 0 ? viesOnly / vatlas : null,
  };
}

/** A rate on both sides, with the difference in percentage points. */
interface ComparedRate {
  vatlas: { count: number; of: number; rate: number | null };
  viesOnly: { count: number; of: number; rate: number | null };
  /** vatlas minus VIES, in points. Null when either side has nothing to rate. */
  deltaPoints: number | null;
}

function rate(count: number, of: number): { count: number; of: number; rate: number | null } {
  return { count, of, rate: of > 0 ? count / of : null };
}

function compareRate(a: { count: number; of: number }, b: { count: number; of: number }): ComparedRate {
  const left = rate(a.count, a.of);
  const right = rate(b.count, b.of);
  return {
    vatlas: left,
    viesOnly: right,
    deltaPoints: left.rate === null || right.rate === null ? null : (left.rate - right.rate) * 100,
  };
}

/** Completeness over the answers each side found. */
function completeness(side: {
  completeness: Record<string, number>;
  found: number;
}): Record<string, { count: number; of: number }> {
  return Object.fromEntries(FIELDS.map((field) => [field, { count: side.completeness[field] ?? 0, of: side.found }]));
}

function comparedCompleteness(a: Lookups | Country, b: Lookups | Country): Record<string, ComparedRate> {
  const left = completeness(a);
  const right = completeness(b);
  return Object.fromEntries(FIELDS.map((field) => [field, compareRate(left[field]!, right[field]!)]));
}

interface CountryDiff {
  code: string;
  /** Both counts, since comparing different lists is meaningless. */
  n: { vatlas: number; viesOnly: number };
  latencyMs: { p50: Compared; p95: Compared; total: Compared };
  found: ComparedRate;
  completeness: Record<string, ComparedRate>;
  /** Kept as is: where vatlas answered from explains its row. */
  origins: { vatlas: Record<string, number>; viesOnly: Record<string, number> };
  outcomes: { vatlas: Record<string, number>; viesOnly: Record<string, number> };
}

/** The figure a row is ranked on. */
function sortValue(diff: CountryDiff, key: SortKey): number {
  switch (key) {
    case 'p95':
      return diff.latencyMs.p95.savedMs;
    case 'total':
      return diff.latencyMs.total.savedMs;
    case 'found':
      return diff.found.deltaPoints ?? 0;
    case 'name':
      return diff.completeness.name?.deltaPoints ?? 0;
    default:
      return diff.latencyMs.p50.savedMs;
  }
}

/** A country present in one run only still gets a row, against zeros. */
const EMPTY_COUNTRY: Omit<Country, 'code'> = {
  n: 0,
  found: 0,
  latencyMs: { p50: 0, p95: 0, total: 0 },
  completeness: {},
  outcomes: {},
  origins: {},
};

function countryDiffs(a: Lookups, b: Lookups, sort: SortKey): CountryDiff[] {
  const left = new Map(a.countries.map((country) => [country.code, country]));
  const right = new Map(b.countries.map((country) => [country.code, country]));

  const diffs = [...new Set([...left.keys(), ...right.keys()])].sort().map((code): CountryDiff => {
    const vatlas = left.get(code) ?? { code, ...EMPTY_COUNTRY };
    const viesOnly = right.get(code) ?? { code, ...EMPTY_COUNTRY };
    return {
      code,
      n: { vatlas: vatlas.n, viesOnly: viesOnly.n },
      latencyMs: {
        p50: compare(vatlas.latencyMs.p50, viesOnly.latencyMs.p50),
        p95: compare(vatlas.latencyMs.p95, viesOnly.latencyMs.p95),
        total: compare(vatlas.latencyMs.total, viesOnly.latencyMs.total),
      },
      found: compareRate({ count: vatlas.found, of: vatlas.n }, { count: viesOnly.found, of: viesOnly.n }),
      completeness: comparedCompleteness(vatlas, viesOnly),
      origins: { vatlas: vatlas.origins, viesOnly: viesOnly.origins },
      outcomes: { vatlas: vatlas.outcomes, viesOnly: viesOnly.outcomes },
    };
  });

  // Largest difference first, by magnitude, so countries where vatlas is slower are visible too.
  // Ties are broken by code so the output is stable.
  return diffs.sort(
    (x, y) => Math.abs(sortValue(y, sort)) - Math.abs(sortValue(x, sort)) || x.code.localeCompare(y.code),
  );
}

/**
 * Anything that makes the two runs less comparable is reported as a warning. The comparison is
 * still written.
 */
function warnings(a: Summary, b: Summary): string[] {
  const notes: string[] = [];
  const left = a.lookups!;
  const right = b.lookups!;

  if ((left.mode ?? 'api') !== 'api') {
    notes.push('The first file is a --vies-only run; the arguments are probably the wrong way round.');
  }
  if ((right.mode ?? 'api') !== 'vies') {
    notes.push('The second file is not a --vies-only run, so this compares the service with itself.');
  }
  if (right.mode === 'vies' && right.cacheBypassed === false) {
    notes.push(
      'The VIES run used vies_cache, so its latencies are partly MariaDB, not VIES. ' +
        'It predates the removal of --no-cache; re-run it to get a live baseline.',
    );
  }
  if (a.input?.vatNumbers !== b.input?.vatNumbers) {
    notes.push(
      `The two runs read different lists: ${a.input?.vatNumbers ?? '?'} numbers against ${b.input?.vatNumbers ?? '?'}.`,
    );
  }
  if (left.measured !== right.measured) {
    notes.push(`Different numbers of lookups: ${left.measured} against ${right.measured}.`);
  }
  if (left.stoppedEarly || right.stoppedEarly) {
    notes.push('At least one run stopped early, so it covers part of its list only.');
  }
  if (left.concurrency !== right.concurrency) {
    notes.push(
      `Different concurrencies: ${left.concurrency} against ${right.concurrency}; latencies are not comparable.`,
    );
  }
  return notes;
}

function comparison(
  files: { vatlas: string; viesOnly: string },
  a: Summary,
  b: Summary,
  sort: SortKey,
): Record<string, unknown> {
  const left = a.lookups!;
  const right = b.lookups!;

  return {
    title: 'Benchmark comparison',
    generatedAt: new Date().toISOString(),
    // Positive means vatlas is ahead. Written in the file, since the sign cannot be guessed.
    convention: 'savedMs and deltaPoints are vatlas minus VIES: positive means vatlas is faster or more complete',
    sortedBy: sort,
    runs: {
      vatlas: {
        path: files.vatlas,
        file: a.file ?? null,
        startedAt: a.startedAt ?? null,
        baseUrl: left.baseUrl,
        mode: left.mode ?? 'api',
        concurrency: left.concurrency,
        measured: left.measured,
      },
      viesOnly: {
        path: files.viesOnly,
        file: b.file ?? null,
        startedAt: b.startedAt ?? null,
        baseUrl: right.baseUrl,
        mode: right.mode ?? 'api',
        cacheBypassed: right.cacheBypassed ?? null,
        concurrency: right.concurrency,
        measured: right.measured,
      },
    },
    warnings: warnings(a, b),
    overall: {
      measured: { vatlas: left.measured, viesOnly: right.measured },
      elapsedMs: compare(left.elapsedMs, right.elapsedMs),
      latencyMs: {
        p50: compare(left.latencyMs.p50, right.latencyMs.p50),
        p95: compare(left.latencyMs.p95, right.latencyMs.p95),
        max: compare(left.latencyMs.max, right.latencyMs.max),
        avg: compare(left.latencyMs.avg, right.latencyMs.avg),
        total: compare(left.latencyMs.total, right.latencyMs.total),
      },
      found: compareRate({ count: left.found, of: left.measured }, { count: right.found, of: right.measured }),
      completeness: comparedCompleteness(left, right),
      outcomes: { vatlas: left.outcomes, viesOnly: right.outcomes },
      origins: { vatlas: left.origins, viesOnly: right.origins },
      sources: { vatlas: left.sources, viesOnly: right.sources },
    },
    countries: countryDiffs(left, right, sort),
  };
}

function ms(value: number): string {
  return Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

/** `x2.4`, or `-` when there is nothing to divide. Two decimals below 1. */
function speedup(value: number | null): string {
  if (value === null) return '-';
  return `x${value < 1 ? value.toFixed(2) : value.toFixed(1)}`;
}

/** Signed points: `+12.0`. */
function points(value: number | null): string {
  return value === null ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

/** The terminal summary of the comparison. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read from disk
function report(diff: Record<string, any>, sort: SortKey): string {
  const out: string[] = [];
  const add = (line = ''): number => out.push(line);
  const { overall, runs } = diff;

  add(`Comparison - ${runs.vatlas.path}`);
  add(`             against ${runs.viesOnly.path}`);
  add(`  ${overall.measured.vatlas} lookups against ${overall.measured.viesOnly}, ordered by ${sort}`);
  add();
  for (const warning of diff.warnings as string[]) add(`  WARNING - ${warning}`);
  if ((diff.warnings as string[]).length > 0) add();

  add('Overall - latency (ms), vatlas / VIES only / saved / speedup');
  for (const key of ['p50', 'p95', 'avg', 'max'] as const) {
    const value = overall.latencyMs[key];
    add(
      `  ${key.padEnd(6)}${ms(value.vatlas).padStart(9)}${ms(value.viesOnly).padStart(10)}` +
        `${ms(value.savedMs).padStart(10)}${speedup(value.speedup).padStart(9)}`,
    );
  }
  add(
    `  ${'total'.padEnd(6)}${`${(overall.latencyMs.total.vatlas / 1000).toFixed(1)}s`.padStart(9)}` +
      `${`${(overall.latencyMs.total.viesOnly / 1000).toFixed(1)}s`.padStart(10)}` +
      `${`${(overall.latencyMs.total.savedMs / 1000).toFixed(1)}s`.padStart(10)}` +
      `${speedup(overall.latencyMs.total.speedup).padStart(9)}`,
  );
  add();

  add('Overall - what came back, vatlas / VIES only / difference in points');
  add(
    `  ${'found'.padEnd(12)}${percent(overall.found.vatlas.count, overall.found.vatlas.of).padStart(9)}` +
      `${percent(overall.found.viesOnly.count, overall.found.viesOnly.of).padStart(10)}` +
      `${points(overall.found.deltaPoints).padStart(10)}`,
  );
  for (const field of FIELDS) {
    const value = overall.completeness[field] as ComparedRate;
    add(
      `  ${field.padEnd(12)}${percent(value.vatlas.count, value.vatlas.of).padStart(9)}` +
        `${percent(value.viesOnly.count, value.viesOnly.of).padStart(10)}` +
        `${points(value.deltaPoints).padStart(10)}`,
    );
  }
  add();

  add(`Per country - biggest difference first, by ${sort}`);
  add(
    `  ${'code'.padEnd(6)}${'n'.padStart(6)}${'p50'.padStart(9)}${'p50 VIES'.padStart(10)}` +
      `${'saved'.padStart(10)}${'speedup'.padStart(9)}${'found'.padStart(9)}${'name'.padStart(9)}` +
      // The total duration column, used by `--sort total`.
      `${'saved tot'.padStart(11)}`,
  );
  for (const country of diff.countries as CountryDiff[]) {
    const { p50 } = country.latencyMs;
    add(
      `  ${country.code.padEnd(6)}${String(country.n.vatlas).padStart(6)}${ms(p50.vatlas).padStart(9)}` +
        `${ms(p50.viesOnly).padStart(10)}${ms(p50.savedMs).padStart(10)}${speedup(p50.speedup).padStart(9)}` +
        `${points(country.found.deltaPoints).padStart(9)}` +
        `${points(country.completeness.name?.deltaPoints ?? null).padStart(9)}` +
        `${`${(country.latencyMs.total.savedMs / 1000).toFixed(1)}s`.padStart(11)}`,
    );
  }

  return `${out.join('\n')}\n`;
}

/** A summary without `lookups` is a `--stats-only` run with nothing to compare. */
async function readSummary(path: string): Promise<Summary> {
  let parsed: Summary;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Summary;
  } catch (error) {
    throw new Error(
      `${path} could not be read as a benchmark summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed?.lookups?.countries) {
    throw new Error(`${path} holds no lookups: it is a --stats-only summary, or not a benchmark summary at all.`);
  }
  return parsed;
}

function readSort(args: string[]): SortKey {
  const raw = optionValue(args, '--sort');
  if (raw === undefined) return DEFAULT_SORT;
  if (!(SORT_KEYS as readonly string[]).includes(raw)) {
    throw new Error(`--sort expects one of ${SORT_KEYS.join(', ')}, got "${raw}"`);
  }
  return raw as SortKey;
}

const VALUE_OPTIONS = ['--sort', '--out'];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('-')) {
      if (!VALUE_OPTIONS.includes(arg)) {
        process.stderr.write(`Unknown option "${arg}"\n\n${usage()}\n`);
        return 1;
      }
      if (args[index + 1] === undefined) {
        process.stderr.write(`${arg} expects a value\n\n${usage()}\n`);
        return 1;
      }
      index += 1;
      continue;
    }
    files.push(arg);
  }

  if (files.length !== 2) {
    process.stderr.write(`Two summaries are needed: the vatlas run first, the --vies-only run second.\n\n${usage()}\n`);
    return 1;
  }

  const sort = readSort(args);
  const [vatlasPath, viesPath] = files as [string, string];
  const [vatlas, viesOnly] = await Promise.all([readSummary(vatlasPath), readSummary(viesPath)]);

  const diff = comparison({ vatlas: vatlasPath, viesOnly: viesPath }, vatlas, viesOnly, sort);
  process.stdout.write(`\n${report(diff, sort)}`);

  // Named after the vatlas run: `bench-50.bench-summary.json` gives `bench-50.bench-compare.json`.
  const outPath =
    optionValue(args, '--out') ?? suffixed(vatlasPath.replace(/\.bench-summary\.json$/, '.json'), '.bench-compare');
  await writeFile(outPath, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nComparison written to ${outPath}\n`);

  // The exit code tells a script the two summaries had warnings.
  return (diff.warnings as string[]).length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
