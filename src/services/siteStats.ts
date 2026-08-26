import { readFile } from 'node:fs/promises';
import { COUNTRIES } from '../api/countries/registry.js';
import { getPrisma } from '../db/prisma.js';

/**
 * The five figures of the home page stats strip, written to a JSON file by `npm run stats` and read
 * by site/src/js/stats.js.
 *
 * Two come from the database, two from the last published benchmark, and one from the country
 * registry. The site is static, so nothing is computed per request.
 */
export interface SiteStats {
  generatedAt: string;
  /** Rows in `company`. */
  vatNumbers: number;
  /**
   * Rows in `log_lookup`, plus {@link LOOKUP_COUNT_OFFSET} for lookups made before that table existed.
   * Retention purges `log_lookup`, so this is not an exact lifetime total, but close enough for a
   * headline figure.
   */
  lookups: number;
  /** Countries in the registry. */
  countries: number;
  /** Median latency of the last benchmark run. */
  latencyP50Ms: number | null;
  /** Share of that run's lookups that got an answer, as a percentage. */
  answeredPct: number | null;
}

/**
 * Outcomes that count as an answer: found, or not registered. Same definition as the benchmarks
 * page (site/src/js/benchmarks.js). Keep them in sync.
 */
const ANSWERED = ['found', 'not-registered'];

/** The fields read from `benchmark.json`. */
export interface BenchmarkSummary {
  lookups?: {
    measured?: number;
    outcomes?: Record<string, number>;
    latencyMs?: { p50?: number };
  };
}

/**
 * Extracts the two figures from a benchmark summary. Null when the run measured nothing, so the site
 * keeps its fallback values.
 */
export function summarizeBenchmark(benchmark: BenchmarkSummary): Pick<SiteStats, 'latencyP50Ms' | 'answeredPct'> {
  const lookups = benchmark.lookups ?? {};
  const measured = lookups.measured ?? 0;
  const outcomes = lookups.outcomes ?? {};
  const answered = ANSWERED.reduce((count, outcome) => count + (outcomes[outcome] ?? 0), 0);
  const p50 = lookups.latencyMs?.p50;

  return {
    latencyP50Ms: typeof p50 === 'number' && Number.isFinite(p50) ? Math.round(p50) : null,
    answeredPct: measured > 0 ? (answered / measured) * 100 : null,
  };
}

export interface CollectOptions {
  /** The `benchmark.json` the site serves. */
  benchmarkPath: string;
}

/** Lookups made before `log_lookup` existed, added to the total. */
export const LOOKUP_COUNT_OFFSET = 23456;

/**
 * Counts the two tables and adds the benchmark figures. `company` has one row per number per source
 * per plateau, so a plain count slightly overstates the number of companies. But
 * `COUNT(DISTINCT vat_number)` on a table of over a hundred million rows can make MySQL fill its
 * temp directory and fail. A plain `count()` cannot fail.
 */
export async function collectSiteStats({ benchmarkPath }: CollectOptions): Promise<SiteStats> {
  const prisma = getPrisma();
  const [vatNumbers, lookups, benchmark] = await Promise.all([
    prisma.company.count(),
    prisma.lookupLog.count(),
    readFile(benchmarkPath, 'utf8').then((raw) => JSON.parse(raw) as BenchmarkSummary),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    vatNumbers,
    lookups: lookups + LOOKUP_COUNT_OFFSET,
    countries: COUNTRIES.length,
    ...summarizeBenchmark(benchmark),
  };
}
