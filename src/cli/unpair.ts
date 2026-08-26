import { readFile, writeFile } from 'node:fs/promises';
import { optionValue, percent, suffixed } from './vatList.js';

/**
 * Rewrites the vatlas leg of a `--paired` run as a plain benchmark summary.
 *
 * The benchmarks page reads a summary with `lookups`, the vs-VIES page a paired run. Publishing
 * both from one run keeps their figures consistent.
 *
 * Nothing is recomputed. `sources` and per-country `origins` are not recorded by the paired mode,
 * so they are left out rather than filled with zeros. The benchmarks page does not use them.
 */

function usage(): string {
  return [
    'Usage: npm run unpair -- <paired.json> [options]',
    '',
    'Rewrites the vatlas leg of a --paired benchmark run as a plain benchmark summary,',
    'in the shape the /benchmarks/ page reads, so that both pages can publish one run.',
    '',
    'Options:',
    '  --out <path>   Where to write the summary (default: <paired.json> as *.vatlas.json)',
    '  --help         This text',
    '',
    'Examples:',
    '  npm run unpair -- benchmarks/bench-50-paired.bench-summary.json',
    '  npm run unpair -- site/public/data/benchmark.bench-compare.json --out site/public/data/benchmark.json',
    '',
    'The input comes from npm run benchmark -- <list> --paired.',
  ].join('\n');
}

/** The completeness fields, in print order. */
const FIELDS = ['name', 'legalForm', 'address', 'postalCode', 'city', 'source'] as const;

interface Latency {
  p50: number;
  p95: number;
  max: number;
  avg: number;
  total: number;
}

/** One leg of a pair, as `pairedJson` writes it. */
interface Side {
  found: number;
  latencyMs: Latency;
  outcomes: Record<string, number>;
  completeness: Record<string, number>;
  /** Absent on runs made before `usable` was recorded. */
  usable?: { name: number; address: number; of: number };
}

interface PairedCountry {
  code: string;
  n: number;
  vatlas: Side;
  viesOnly: Side;
}

interface Paired {
  mode: string;
  baseUrl: string;
  viesEndpoint: string;
  concurrency: number;
  elapsedMs: number;
  planned: number;
  measured: number;
  stoppedEarly: string | null;
  invalid: boolean;
  invalidReason: string | null;
  overall: { n: number; vatlas: Side; viesOnly: Side };
  vatlasOrigins: Record<string, number>;
  countries: PairedCountry[];
}

/** A paired summary, reduced to what is reshaped. The rest is passed through. */
interface Summary {
  title?: string;
  file?: string;
  startedAt?: string;
  input?: Record<string, unknown>;
  perCountry?: Record<string, number>;
  unknownPrefix?: number;
  paired: Paired;
}

/**
 * The vatlas leg in the `measurementJson` shape. `elapsedMs` is the wall clock of the paired run,
 * both legs included. Per-lookup latencies are vatlas's own.
 */
function lookups(summary: Summary, source: string): Record<string, unknown> {
  const { paired } = summary;
  const { vatlas } = paired.overall;

  return {
    baseUrl: paired.baseUrl,
    mode: 'api',
    // Stated in the file: these figures were measured alongside a plain VIES call for the same number.
    derivedFrom: {
      mode: 'paired',
      path: source,
      viesEndpoint: paired.viesEndpoint,
      note:
        'the vatlas leg of a --paired run; elapsedMs covers both legs, and sources and ' +
        'per-country origins were not recorded per pair',
    },
    concurrency: paired.concurrency,
    elapsedMs: paired.elapsedMs,
    planned: paired.planned,
    measured: paired.measured,
    stoppedEarly: paired.stoppedEarly,
    outcomes: vatlas.outcomes,
    latencyMs: vatlas.latencyMs,
    found: vatlas.found,
    completeness: vatlas.completeness,
    ...(vatlas.usable ? { usable: vatlas.usable } : {}),
    origins: paired.vatlasOrigins,
    countries: paired.countries.map((country) => ({
      code: country.code,
      n: country.n,
      found: country.vatlas.found,
      // The three figures the plain mode keeps per country (paired also has max and avg).
      latencyMs: {
        p50: country.vatlas.latencyMs.p50,
        p95: country.vatlas.latencyMs.p95,
        total: country.vatlas.latencyMs.total,
      },
      completeness: country.vatlas.completeness,
      ...(country.vatlas.usable ? { usable: country.vatlas.usable } : {}),
      outcomes: country.vatlas.outcomes,
    })),
  };
}

/** Fields about the list are kept as is. */
function summaryJson(summary: Summary, source: string): Record<string, unknown> {
  return {
    title: summary.title ?? 'Benchmark',
    file: summary.file ?? null,
    startedAt: summary.startedAt ?? null,
    input: summary.input ?? {},
    perCountry: summary.perCountry ?? {},
    unknownPrefix: summary.unknownPrefix ?? 0,
    lookups: lookups(summary, source),
  };
}

/** Terminal summary: what was reshaped and what is missing. */
function report(summary: Summary, source: string, out: string): string {
  const { paired } = summary;
  const { vatlas } = paired.overall;
  const lines: string[] = [];
  const add = (line = ''): number => lines.push(line);

  add(`Unpaired - ${source}`);
  add(`  ${summary.file ?? '?'}, run ${summary.startedAt ?? '?'}, against ${paired.baseUrl}`);
  if (paired.invalid || paired.stoppedEarly) {
    // A partial paired run is invalid as a comparison, and its vatlas leg is still partial. Refuse to
    // publish it as a full run.
    add();
    add(`  WARNING - the paired run stopped early: ${paired.invalidReason ?? paired.stoppedEarly}`);
    add(`  ${paired.measured} of ${paired.planned} numbers were measured. Do not publish this.`);
  }
  add();
  add(`  measured    ${String(paired.measured).padStart(8)}`);
  add(`  found       ${String(vatlas.found).padStart(8)}  ${percent(vatlas.found, paired.measured)}`);
  add(`  p50         ${`${Math.round(vatlas.latencyMs.p50)} ms`.padStart(8)}`);
  add(`  p95         ${`${Math.round(vatlas.latencyMs.p95)} ms`.padStart(8)}`);
  add(
    `  completeness ${FIELDS.map((field) => `${field} ${percent(vatlas.completeness[field] ?? 0, vatlas.found)}`).join(', ')}`,
  );
  add();
  add('  Not carried over: sources, and origins per country - the paired run records');
  add('  neither per pair. Overall origins come from vatlasOrigins.');
  add();
  add(`  Written to ${out}`);

  return `${lines.join('\n')}\n`;
}

async function readPaired(path: string): Promise<Summary> {
  let parsed: Summary;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Summary;
  } catch (error) {
    throw new Error(
      `${path} could not be read as a benchmark summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed?.paired?.countries || !parsed.paired.overall?.vatlas) {
    throw new Error(
      `${path} holds no paired run: it is a plain summary, or not a benchmark summary at all. ` +
        'This command reads the output of npm run benchmark -- <list> --paired.',
    );
  }
  return parsed;
}

const VALUE_OPTIONS = ['--out'];

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

  if (files.length !== 1) {
    process.stderr.write(`One paired summary is needed.\n\n${usage()}\n`);
    return 1;
  }

  const source = files[0] as string;
  const summary = await readPaired(source);
  const out = optionValue(args, '--out') ?? suffixed(source, '.vatlas');

  await writeFile(out, `${JSON.stringify(summaryJson(summary, source), null, 2)}\n`, 'utf8');
  process.stdout.write(`\n${report(summary, source, out)}`);

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
