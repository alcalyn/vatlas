import { config } from '../config.js';
import { insertLookupLog } from '../db/companyRepository.js';
import { logger } from '../lib/logger.js';
import { InvalidVatError, normalizeVatInput, parseVatNumber, type ParsedVat } from '../vat/parse.js';
import { resolveCountry } from './countries/registry.js';
import type { SourceHistory } from './countries/types.js';
import type { LookupCaller } from './resolve.js';
import { SourceTrace, round } from './trace.js';

/**
 * Every source's answer: `GET /v1/lookup-all/:vatNumber`.
 *
 * Unlike `lookupVat`, nothing stops early and nothing is skipped. A failing source is reported, not
 * dropped.
 *
 * It does not decide which source is right: answers are published side by side with their dates.
 */

const allLogger = logger.child({ component: 'lookup-all' });

export interface AllLookupReport {
  /** Whether the history was read (`?history`). */
  history: boolean;
  vat: ParsedVat;
  /**
   * One entry per source the country declares and this deployment can reach, with its history
   * (oldest first) and the call made now if storage was stale.
   */
  sources: SourceHistory[];
}

/** What the caller asked beyond the number. */
export interface AllLookupOptions {
  /**
   * Every statement of every source, not only the current one (`?history`, on by default here).
   *
   * `?history=false` skips the query and keeps only the current plateau of each source.
   */
  history?: boolean;
}

export async function lookupVatAll(
  input: string,
  caller: LookupCaller = {},
  options: AllLookupOptions = {},
): Promise<AllLookupReport> {
  const startedAt = performance.now();
  const trace = new SourceTrace();

  let vat: ParsedVat;
  try {
    vat = parseVatNumber(input);
  } catch (error) {
    // Same as `lookupVat`: invalid numbers never reach a source but are counted.
    const invalid = error instanceof InvalidVatError;
    if (!invalid) allLogger.error({ err: error }, 'vat lookup-all failed');
    record({
      vatNumber: normalizeVatInput(input ?? '') || null,
      status: invalid ? 'invalid' : 'error',
      durationMs: round(performance.now() - startedAt),
      timings: {},
      caller,
    });
    throw error;
  }

  const deadline = Date.now() + config.lookup.deadlineMs;
  // Never `prefer: 'proof'`, which skips sources. VIES is asked anyway, so its proof is in the
  // report.
  const report = await resolveCountry(vat.countryCode)
    .resolveAll(vat, { deadline, trace, prefer: 'completeness', history: options.history !== false })
    // Sources report their own failures, so this is an unexpected error. An empty report is still a
    // valid 200.
    .catch((error: unknown) => {
      allLogger.error({ err: error, vatNumber: vat.formatted }, 'resolveAll failed');
      return { sources: [] as SourceHistory[] };
    });

  record({
    vatNumber: vat.formatted,
    status: report.sources.some((source) => source.history.length > 0) ? 'found' : 'not-found',
    durationMs: round(performance.now() - startedAt),
    timings: trace.snapshot(),
    caller,
  });

  return { vat, history: options.history !== false, sources: report.sources };
}

/**
 * One row in `log_lookup` for the whole report, with `kind = 'all'` so coverage statistics (which
 * read `single`) are not skewed.
 *
 * Provenance columns stay null: several sources answered. The full report is in `user_audit`.
 */
function record(entry: {
  vatNumber: string | null;
  status: string;
  durationMs: number;
  timings: Record<string, number>;
  caller: LookupCaller;
}): void {
  insertLookupLog({
    vatNumber: entry.vatNumber,
    status: entry.status,
    success: entry.status === 'found',
    durationMs: entry.durationMs,
    timings: entry.timings,
    kind: 'all',
    fault: null,
    attempts: null,
    ...entry.caller,
  }).catch((error) => {
    allLogger.error({ err: error }, 'failed to write lookup log');
  });
}
