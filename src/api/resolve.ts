import { config } from '../config.js';
import { historyBySource } from '../db/companyHistory.js';
import { insertLookupLog, type LookupLogEntry } from '../db/companyRepository.js';
import { logger } from '../lib/logger.js';
import { InvalidVatError, normalizeVatInput, parseVatNumber, type ParsedVat } from '../vat/parse.js';
import { resolveCountry } from './countries/registry.js';
import type { SourceFailure } from './sources/types.js';
import { SourceTrace, round } from './trace.js';
import type { Preference } from './countries/pick.js';
import type { CompanyStatement, StoredStatement } from './types.js';

/**
 * The single-answer lookup: `GET /v1/lookup/:vatNumber`.
 *
 * Parses the number, hands it to its country, and writes the monitoring row. The resolution order
 * (which sources, which are fresh, which to ask, which answer wins) belongs to the country adapter.
 */

const lookupLogger = logger.child({ component: 'lookup' });

/**
 * Three kinds of miss: a number reported as unregistered is final, an outage is worth retrying,
 * and a number nothing holds is neither.
 */
export type LookupOutcome =
  /** `history` only with `?history`: everything the answering source has said. */
  | { status: 'found'; vat: ParsedVat; statement: CompanyStatement; consulted: string[]; history?: StoredStatement[] }
  /** `checkedAt` only when this request made the call, see `CountryVerdict`. */
  | {
      status: 'not-registered';
      vat: ParsedVat;
      statement: CompanyStatement;
      checkedAt?: Date;
      consulted: string[];
      history?: StoredStatement[];
    }
  | { status: 'unavailable'; vat: ParsedVat; consulted: string[]; failure: SourceFailure }
  | { status: 'not-found'; vat: ParsedVat; consulted: string[] };

/**
 * Which key made the call, stored in `log_lookup` for per-key usage. Empty for the CLI and for
 * requests rejected before authentication.
 */
export interface LookupCaller {
  userId?: bigint;
  secretKeyId?: bigint;
}

/** What the caller asked beyond the number. */
export interface LookupOptions {
  /**
   * What to favour when sources disagree (`?prefer`), `completeness` by default.
   *
   * `completeness`: every source of the country, and the most complete answer wins.
   *
   * `proof`: only answers with a proof. Storage and sources that issue no verification code are
   * skipped, and an answer without one is reported as unavailable.
   *
   * The caller asks for "a proof" and reads `meta.proof.type` to know which kind.
   */
  prefer?: Preference;
  /**
   * Return everything the answering source has said (`?history`).
   *
   * Off by default since it costs a second query. Only the winning source's history is read; use
   * `GET /v1/lookup-all/:vatNumber` for every source.
   */
  history?: boolean;
}

export async function lookupVat(
  input: string,
  caller: LookupCaller = {},
  options: LookupOptions = {},
): Promise<LookupOutcome> {
  const startedAt = performance.now();
  const trace = new SourceTrace();
  const prefer = options.prefer ?? 'completeness';
  // A proof lookup gets its own `kind`: it skips the national registers, so it would skew the
  // coverage statistics, which read `kind = 'single'`.
  const kind = prefer === 'proof' ? ('proof' as const) : ('single' as const);

  try {
    const outcome = await withHistory(await resolve(input, trace, prefer), options.history === true);
    record({
      vatNumber: outcome.vat.formatted,
      status: outcome.status,
      success: outcome.status === 'found',
      durationMs: round(performance.now() - startedAt),
      timings: trace.snapshot(),
      // Only an answer with a company has a provenance.
      ...(outcome.status === 'found' || outcome.status === 'not-registered'
        ? { source: outcome.statement.source, sourceDate: outcome.statement.dateEnd }
        : {}),
      // Only an unavailable lookup has a fault. It tells an outage from a throttle.
      fault: outcome.status === 'unavailable' ? outcome.failure.fault : null,
      attempts: outcome.status === 'unavailable' ? outcome.failure.attempts : null,
      kind,
      ...caller,
    });
    return outcome;
  } catch (error) {
    // Invalid numbers never reach a source, but are still counted.
    const invalid = error instanceof InvalidVatError;
    if (!invalid) lookupLogger.error({ err: error }, 'vat lookup failed');
    record({
      vatNumber: normalizeVatInput(input ?? '') || null,
      status: invalid ? 'invalid' : 'error',
      success: false,
      durationMs: round(performance.now() - startedAt),
      timings: trace.snapshot(),
      fault: null,
      attempts: null,
      kind,
      ...caller,
    });
    throw error;
  }
}

/**
 * The winning source's history, when asked.
 *
 * Read here because the winner is only known now.
 *
 * A read failure is logged and the answer still returned.
 */
async function withHistory(outcome: LookupOutcome, wanted: boolean): Promise<LookupOutcome> {
  if (!wanted || (outcome.status !== 'found' && outcome.status !== 'not-registered')) return outcome;
  const { source } = outcome.statement;
  const history = await historyBySource(outcome.vat.formatted, [source]).catch((error: unknown) => {
    lookupLogger.error({ err: error, source, vatNumber: outcome.vat.formatted }, 'failed to read the history');
    return new Map<string, StoredStatement[]>();
  });
  return { ...outcome, history: history.get(source) ?? [] };
}

async function resolve(input: string, trace: SourceTrace, prefer: Preference): Promise<LookupOutcome> {
  const vat = parseVatNumber(input);
  // One time budget for the whole lookup, rather than one timeout per source.
  const deadline = Date.now() + config.lookup.deadlineMs;

  const verdict = await resolveCountry(vat.countryCode).resolve(vat, { deadline, trace, prefer, history: false });
  return { ...verdict, vat };
}

/**
 * One row per lookup in `log_lookup`. Not awaited, so it adds no latency. A write failure is only
 * logged.
 */
function record(entry: LookupLogEntry): void {
  insertLookupLog(entry).catch((error) => {
    lookupLogger.error({ err: error }, 'failed to write lookup log');
  });
}
