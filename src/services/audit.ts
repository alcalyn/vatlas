import { insertAuditLookup, type AuditLookupEntry } from '../db/companyRepository.js';
import { getPrisma } from '../db/prisma.js';
import type { AuditLookup } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import type { Preference } from '../api/countries/pick.js';
import type { AllLookupReport } from '../api/resolveAll.js';
import type { LookupCaller, LookupOutcome } from '../api/resolve.js';

/**
 * The audit trail: what the API answered, kept so it can be shown again.
 *
 * Answers "your API said this number was valid in June, show me". `log_lookup` cannot: it holds no
 * response and is purged after 90 days. `user_audit` stores the envelope with searchable columns,
 * and has its own retention (see `services/retention.ts`).
 *
 * Written from the API layer, since the HTTP status and envelope only exist there.
 */

const auditLogger = logger.child({ component: 'audit' });

/** Not awaited: an audit write must not add latency. A failure is logged. */
export function recordAudit(entry: AuditLookupEntry): void {
  insertAuditLookup(entry).catch((error) => {
    auditLogger.error({ err: error }, 'failed to write audit row');
  });
}

/**
 * Builds an audit row from a lookup and its envelope.
 *
 * Pure, so it can be tested without a database. Returns null when there is no account (CLI).
 */
export function auditEntryFrom(
  outcome: LookupOutcome,
  response: unknown,
  httpStatus: number,
  caller: LookupCaller,
  options: { prefer?: Preference } = {},
): AuditLookupEntry | null {
  if (caller.userId === undefined) return null;

  const common = {
    userId: caller.userId,
    secretKeyId: caller.secretKeyId ?? null,
    vatNumber: outcome.vat.formatted,
    httpStatus,
    // Tagged so the customer can see which calls were made with `?prefer=proof`.
    kind: options.prefer === 'proof' ? ('proof' as const) : ('single' as const),
    sources: sourcesOf(outcome),
    response,
  };

  if (outcome.status === 'found') {
    return {
      ...common,
      errorCode: null,
      companyName: outcome.statement.name,
      source: outcome.statement.source,
      sourceDate: outcome.statement.dateEnd,
      proof: outcome.statement.proof,
    };
  }

  return {
    ...common,
    errorCode: ERROR_CODES[outcome.status],
    companyName: null,
    // A "not registered" answer keeps its provenance: it is the most likely to be questioned later.
    ...(outcome.status === 'not-registered'
      ? { source: outcome.statement.source, sourceDate: outcome.statement.dateEnd, proof: outcome.statement.proof }
      : { source: null, sourceDate: null, proof: null }),
  };
}

/**
 * The audit row of a `/v1/lookup-all/:vatNumber` answer.
 *
 * There is no single verdict: `errorCode` and provenance columns stay null, and `response` holds the
 * whole report. The flat columns keep the name and the VIES verification code for searching.
 *
 * Always 200: the report was produced.
 */
export function allAuditEntryFrom(
  report: AllLookupReport,
  response: unknown,
  caller: LookupCaller,
): AuditLookupEntry | null {
  if (caller.userId === undefined) return null;

  // The latest statement of each source, newest last, so the name and proof come from what the report
  // shows.
  const latest = report.sources.flatMap((source) => source.history.at(-1) ?? []);

  return {
    userId: caller.userId,
    secretKeyId: caller.secretKeyId ?? null,
    vatNumber: report.vat.formatted,
    httpStatus: 200,
    kind: 'all',
    errorCode: null,
    companyName: latest.find((statement) => statement.name)?.name ?? null,
    source: null,
    sourceDate: null,
    proof: latest.find((statement) => statement.proof)?.proof ?? null,
    sources: report.sources.map((source) => source.source),
    response,
  };
}

/**
 * Every register that contributed to the answer, for the console's provenance labels.
 *
 * The answering register first, then the others consulted. Not just `consulted`, which only lists
 * calls made: an answer served from storage made none.
 */
function sourcesOf(outcome: LookupOutcome): string[] {
  const answered = outcome.status === 'found' || outcome.status === 'not-registered' ? [outcome.statement.source] : [];
  return [...new Set([...answered, ...outcome.consulted])];
}

/** Same mapping as `toApiError`. */
const ERROR_CODES: Record<Exclude<LookupOutcome['status'], 'found'>, string> = {
  'not-registered': 'VAT_NOT_REGISTERED',
  unavailable: 'SOURCE_UNAVAILABLE',
  'not-found': 'COMPANY_NOT_FOUND',
};

/**
 * One audit entry, as the console and the API see it.
 *
 * Has `publicId` but not the internal `id`, so the id cannot leak by accident.
 */
export interface AuditRow {
  publicId: string;
  vatNumber: string;
  /** `single`, `proof` or `all` (`full` on old rows), shown as a tag. */
  kind: string;
  httpStatus: number;
  errorCode: string | null;
  companyName: string | null;
  /** The answering register and the date of its statement. Null on a lookup-all. */
  source: string | null;
  sourceDate: Date | null;
  /** Every source the answer was built from. */
  sources: string[];
  /** The verification code of the answer, when the source issues one. */
  proof: string | null;
  response: unknown;
  fetchedAt: Date;
}

export interface AuditQuery {
  /** Normalized, prefix included. Omitted for the recent calls listing. */
  vatNumber?: string;
  /**
   * Keyset cursor: only rows older than this internal id. Callers hold a `publicId` and convert it
   * with {@link resolveCursor}, which also rejects other accounts' cursors.
   */
  before?: bigint;
  limit?: number;
}

/**
 * Turns the public cursor into the internal id.
 *
 * Scoped to the account: another account's `publicId` resolves to null like a missing one.
 */
export async function resolveCursor(userId: bigint, publicId: string): Promise<bigint | null> {
  const row = await getPrisma().auditLookup.findFirst({
    where: { userId, publicId },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** A page of history, with the cursor to the next one. */
export interface AuditPage {
  rows: AuditRow[];
  /** The `publicId` to pass as `before`, absent on the last page. */
  nextBefore?: string;
}

/** One page with its cursor. Fetches one extra row to know whether there is a next page. */
export async function pageAudit(userId: bigint, query: AuditQuery = {}): Promise<AuditPage> {
  const limit = query.limit ?? 25;
  const rows = await searchAudit(userId, { ...query, limit: limit + 1 });
  if (rows.length <= limit) return { rows };

  const page = rows.slice(0, limit);
  return { rows: page, nextBefore: page[page.length - 1]?.publicId };
}

/** Always scoped to one account. */
export async function searchAudit(userId: bigint, query: AuditQuery = {}): Promise<AuditRow[]> {
  const rows = await getPrisma().auditLookup.findMany({
    where: {
      userId,
      ...(query.vatNumber ? { vatNumber: query.vatNumber } : {}),
      ...(query.before ? { id: { lt: query.before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: query.limit ?? 25,
  });

  return rows.map(toAuditRow);
}

/** One recorded answer by public id, scoped to the account: null for another account's id. */
export async function getAuditRow(userId: bigint, publicId: string): Promise<AuditRow | null> {
  const row = await getPrisma().auditLookup.findFirst({ where: { userId, publicId } });
  return row ? toAuditRow(row) : null;
}

/** The stored row as the console and the API see it. */
function toAuditRow(row: AuditLookup): AuditRow {
  return {
    publicId: row.publicId,
    vatNumber: row.vatNumber,
    kind: row.kind,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    companyName: row.companyName,
    source: row.source,
    sourceDate: row.sourceDate,
    // A JSON column, `unknown` for Prisma, written as an array of strings.
    sources: Array.isArray(row.sources) ? (row.sources as string[]) : [],
    proof: row.proof,
    response: row.response,
    fetchedAt: row.fetchedAt,
  };
}
