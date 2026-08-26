import { getPrisma } from './prisma.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * The log tables and import runs. Company data is in `./companyHistory.ts`, the bulk write path in
 * `./bulkWrites.ts`.
 */

export interface LookupLogEntry {
  /** The full VAT number, null when the input did not parse. */
  vatNumber: string | null;
  status: string;
  success: boolean;
  durationMs: number;
  /** Time spent per source. */
  timings: Record<string, number>;
  /** Which register answered and the date of its statement. Null when no company was found. */
  source?: string | null;
  sourceDate?: Date | null;
  /**
   * `single` (plain lookup), `proof` (`?prefer=proof`) or `all` (`/v1/lookup-all`). Defaults to
   * `single` for the CLI and tests.
   *
   * Older rows say `full` instead of `all` and are not rewritten, so aggregations read both.
   */
  kind?: 'single' | 'proof' | 'all';
  /** The source's fault when the lookup ended unavailable, null otherwise. */
  fault?: string | null;
  /** How many live calls that failure cost, retries included. */
  attempts?: number | null;
  /** Null for requests rejected before authentication, and for the CLI. */
  userId?: bigint | null;
  secretKeyId?: bigint | null;
}

export async function insertLookupLog(entry: LookupLogEntry): Promise<void> {
  await getPrisma().lookupLog.create({
    data: {
      vatNumber: entry.vatNumber,
      status: entry.status,
      success: entry.success,
      durationMs: entry.durationMs,
      timings: entry.timings as Prisma.InputJsonValue,
      source: entry.source ?? null,
      sourceDate: entry.sourceDate ?? null,
      kind: entry.kind ?? 'single',
      fault: entry.fault ?? null,
      attempts: entry.attempts ?? null,
      userId: entry.userId ?? null,
      secretKeyId: entry.secretKeyId ?? null,
    },
  });
}

/** One request to a live source, in `log_source_call`. See `prisma/schema.prisma` for the columns. */
export interface SourceCallLogEntry {
  /** The register called, matching `company.source`. */
  source: string;
  /** The full number, prefix included. */
  vatNumber: string;
  /** The operation, for sources that have several. */
  operation?: string | null;
  /** Attempt number, starting at 1. */
  attempt: number;
  calledAt: Date;
  durationMs: number;
  /** `valid` | `not-registered` | `not-found` | `fault` | `timeout` | `network-error` | `malformed`. */
  outcome: string;
  /** False when the source answered, true otherwise. */
  error: boolean;
  fault?: string | null;
  httpStatus?: number | null;
  /** Completeness of the answer. All null when there was no answer. */
  hasName?: boolean | null;
  hasAddress?: boolean | null;
  hasProof?: boolean | null;
}

/**
 * `log_source_call` writes started and not finished.
 *
 * The CLI disconnects Prisma right after its last lookup, and servers do the same on SIGTERM, so
 * unawaited writes would be lost. {@link flushSourceCalls} waits for them at shutdown without
 * delaying responses.
 */
const pendingCallLogs = new Set<Promise<void>>();

/** Starts a call log write and tracks it. The caller does not wait. Failures go to `onError`. */
export function trackSourceCallLog(entry: SourceCallLogEntry, onError: (error: unknown) => void): void {
  const write = insertSourceCallLog(entry)
    .catch(onError)
    .finally(() => {
      pendingCallLogs.delete(write);
    });

  pendingCallLogs.add(write);
}

/** Waits for every pending call log. Called before closing the database. */
export async function flushSourceCalls(): Promise<void> {
  await Promise.all(pendingCallLogs);
}

export async function insertSourceCallLog(entry: SourceCallLogEntry): Promise<void> {
  await getPrisma().sourceCallLog.create({
    data: {
      source: entry.source,
      vatNumber: entry.vatNumber,
      operation: entry.operation ?? null,
      attempt: entry.attempt,
      calledAt: entry.calledAt,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      error: entry.error,
      fault: entry.fault ?? null,
      httpStatus: entry.httpStatus ?? null,
      hasName: entry.hasName ?? null,
      hasAddress: entry.hasAddress ?? null,
      hasProof: entry.hasProof ?? null,
    },
  });
}

/**
 * One row of the audit trail (`user_audit`). Unlike {@link LookupLogEntry} this is the answer
 * itself, kept so the customer can see it later. Only written for calls that answered about a
 * number.
 */
export interface AuditLookupEntry {
  userId: bigint;
  secretKeyId?: bigint | null;
  /** The normalized number, prefix included. */
  vatNumber: string;
  httpStatus: number;
  errorCode?: string | null;
  companyName?: string | null;
  source?: string | null;
  sourceDate?: Date | null;
  /** Every source the answer was built from. */
  sources: string[];
  /** The verification code of the answer, null when the source issues none. */
  proof?: string | null;
  /** `single`, `proof` or `all`. */
  kind?: 'single' | 'proof' | 'all';
  /** The response envelope exactly as sent. */
  response: unknown;
}

export async function insertAuditLookup(entry: AuditLookupEntry): Promise<void> {
  await getPrisma().auditLookup.create({
    data: {
      userId: entry.userId,
      secretKeyId: entry.secretKeyId ?? null,
      vatNumber: entry.vatNumber,
      httpStatus: entry.httpStatus,
      errorCode: entry.errorCode ?? null,
      companyName: entry.companyName ?? null,
      source: entry.source ?? null,
      sourceDate: entry.sourceDate ?? null,
      sources: entry.sources as Prisma.InputJsonValue,
      proof: entry.proof ?? null,
      kind: entry.kind ?? 'single',
      response: entry.response as Prisma.InputJsonValue,
    },
  });
}

export type ImportRunStatus = 'running' | 'success' | 'failed';

export async function startImportRun(countryCode: string, source: string): Promise<number> {
  const run = await getPrisma().importRun.create({
    data: { countryCode, source, startedAt: new Date(), status: 'running' },
    select: { id: true },
  });
  // BIGINT UNSIGNED column, hence bigint.
  return Number(run.id);
}

/**
 * Records the file a running import is reading, as soon as it is known.
 *
 * Called for every file the run opens, so the row ends up naming the last (newest) one. Awaited,
 * since a scheduler reads this column.
 */
export async function noteImportArtefact(id: number, fileName: string, fileDate: Date): Promise<void> {
  await getPrisma().importRun.update({
    where: { id: BigInt(id) },
    data: { fileName: fileName.slice(0, 255), fileDate },
  });
}

export async function finishImportRun(
  id: number,
  status: Exclude<ImportRunStatus, 'running'>,
  counters: unknown,
  error?: string,
): Promise<void> {
  await getPrisma().importRun.update({
    where: { id: BigInt(id) },
    data: {
      finishedAt: new Date(),
      status,
      counters: counters === undefined || counters === null ? Prisma.DbNull : (counters as Prisma.InputJsonValue),
      error: error ?? null,
    },
  });
}
