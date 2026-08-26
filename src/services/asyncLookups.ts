import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { type Prisma } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import { lookupVat, type LookupOutcome } from '../api/resolve.js';
import { lookupVatAll, type AllLookupReport } from '../api/resolveAll.js';
import { serialize, serializeAll, toApiError } from '../api/serialize.js';
import { InvalidVatError, normalizeVatInput, parseVatNumber } from '../vat/parse.js';
import { assertPublicUrl, callbackSecret, deliver, resolveCallbackUrl } from './callbacks.js';
import { peek, refund, type Plan } from './usage.js';

/**
 * Async lookups: a lookup that retries until a source answers.
 *
 * When a source is down (503 SOURCE_UNAVAILABLE), a row is stored with the time of its next
 * attempt, processed every ten minutes, and the answer is posted to a callback URL.
 *
 * Billed at creation, otherwise an account could queue more than its quota. A lookup that gives up
 * after a week is refunded.
 */

const asyncLogger = logger.child({ component: 'asyncLookups' });

/** Which call: same values as `log_lookup.kind`. */
export type AsyncKind = 'single' | 'proof' | 'all';

/** The first retry delay. It doubles from here. */
const BASE_BACKOFF_MS = 10 * 60 * 1000;

/**
 * When the next attempt is allowed.
 *
 * The base doubles after each failure (ten minutes, twenty, forty...) up to
 * `ASYNC_LOOKUP_MAX_BACKOFF_MS`, with a uniform jitter of +/- half the base. Without jitter, every
 * lookup that failed on an outage would retry at the same moment when the service comes back.
 *
 * Pure, with injectable `random`, so tests can check the bounds.
 */
export function nextRetryAt(attempts: number, now: Date = new Date(), random: () => number = Math.random): Date {
  const doublings = Math.max(0, attempts - 1);
  // Capped before shifting: `2 ** 900` is Infinity.
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(doublings, 32), config.asyncLookup.maxBackoffMs);
  const jitter = (random() - 0.5) * base;
  return new Date(now.getTime() + Math.round(base + jitter));
}

/**
 * Whether an attempt produced an answer to deliver.
 *
 * For a plain or proof lookup, this matches what `countsAgainstQuota` bills: `found`,
 * `not-registered` (a real answer) and `not-found` (nothing left to ask).
 *
 * Only `unavailable` is retried, including `PROOF_UNAVAILABLE`.
 */
export function isAnswered(outcome: LookupOutcome): boolean {
  return outcome.status !== 'unavailable';
}

/**
 * Same question for a lookup-all, which always answers 200 once the number parses.
 *
 * It counts as answered when at least one source has stored data or a successful call. A report
 * where every source is unavailable and none has history is not delivered as an answer.
 */
export function isReportUsable(report: AllLookupReport): boolean {
  return report.sources.some(
    (source) => source.history.length > 0 || (source.call !== undefined && source.call.status !== 'unavailable'),
  );
}

export interface NewAsyncLookup {
  vatNumber: string;
  kind?: AsyncKind;
  url?: string | null;
}

/** Creates one, already paid for. `retryAfter` is now, so the first attempt happens on the next pass. */
export async function createAsyncLookup(userId: bigint, input: NewAsyncLookup) {
  const vatNumber = parseVatNumber(normalizeVatInput(input.vatNumber ?? '')).formatted;
  const url =
    input.url === undefined || input.url === null || input.url.trim() === '' ? null : assertPublicUrl(input.url);

  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { lookupAsyncUrl: true },
  });
  // Refused now rather than at the first attempt: without a callback URL the answer would reach
  // nobody.
  resolveCallbackUrl(url, account.lookupAsyncUrl);

  const now = new Date();
  return getPrisma().asyncLookup.create({
    data: {
      userId,
      vatNumber,
      kind: input.kind ?? 'single',
      url,
      retryAfter: now,
      expiresAt: new Date(now.getTime() + config.asyncLookup.maxDays * 24 * 60 * 60 * 1000),
    },
    select: {
      publicId: true,
      vatNumber: true,
      kind: true,
      url: true,
      status: true,
      retryAfter: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

/** The listing, newest first, optionally filtered by status. */
export async function listAsyncLookups(
  userId: bigint,
  options: { status?: 'pending' | 'success' | 'failed'; limit?: number; before?: bigint } = {},
) {
  return getPrisma().asyncLookup.findMany({
    where: {
      userId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.before !== undefined ? { id: { lt: options.before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: options.limit ?? 50,
    select: {
      id: true,
      publicId: true,
      vatNumber: true,
      kind: true,
      url: true,
      status: true,
      attempts: true,
      retryAfter: true,
      expiresAt: true,
      completedAt: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
}

/** Turns the public cursor into the internal id, refusing another account's (like `/v1/audit`). */
export async function resolveAsyncCursor(userId: bigint, publicId: string): Promise<bigint | null> {
  const row = await getPrisma().asyncLookup.findFirst({ where: { userId, publicId }, select: { id: true } });
  return row?.id ?? null;
}

/** One lookup with its attempts and deliveries. */
export async function getAsyncLookup(userId: bigint, publicId: string) {
  const lookup = await getPrisma().asyncLookup.findFirst({
    where: { userId, publicId },
    select: {
      id: true,
      publicId: true,
      vatNumber: true,
      kind: true,
      url: true,
      status: true,
      attempts: true,
      retryAfter: true,
      expiresAt: true,
      completedAt: true,
      deliveredAt: true,
      response: true,
      createdAt: true,
      attemptLog: {
        orderBy: { attemptedAt: 'desc' },
        take: 100,
        select: {
          attemptedAt: true,
          outcome: true,
          httpStatus: true,
          errorCode: true,
          fault: true,
          durationMs: true,
        },
      },
      deliveries: {
        orderBy: { sentAt: 'desc' },
        take: 50,
        select: {
          publicId: true,
          event: true,
          url: true,
          attempt: true,
          httpStatus: true,
          error: true,
          durationMs: true,
          sentAt: true,
        },
      },
    },
  });
  return lookup;
}

/**
 * Deletes one. No refund: the credit paid for the attempts made, and refunding would make
 * create-then-cancel free.
 */
export async function deleteAsyncLookup(userId: bigint, publicId: string): Promise<boolean> {
  const result = await getPrisma().asyncLookup.deleteMany({ where: { userId, publicId } });
  return result.count > 0;
}

export interface AsyncReport {
  due: number;
  answered: number;
  retried: number;
  expired: number;
  delivered: number;
  failed: number;
}

/**
 * The ten-minute pass: every pending row whose retry date has passed.
 *
 * One query on `idx_user_async_lookup_due`. Sequential: these attempts target sources that have been
 * failing, and a struggling member state does not need sixteen concurrent calls.
 */
export async function runDueLookups(options: { dryRun?: boolean; limit?: number } = {}): Promise<AsyncReport> {
  const now = new Date();
  const due = await getPrisma().asyncLookup.findMany({
    where: { status: 'pending', retryAfter: { lte: now } },
    orderBy: { retryAfter: 'asc' },
    take: options.limit ?? 500,
    select: {
      id: true,
      publicId: true,
      userId: true,
      vatNumber: true,
      kind: true,
      url: true,
      attempts: true,
      expiresAt: true,
      createdAt: true,
      account: { select: { plan: true, lookupAsyncUrl: true } },
    },
  });

  const report: AsyncReport = { due: due.length, answered: 0, retried: 0, expired: 0, delivered: 0, failed: 0 };

  for (const lookup of due) {
    try {
      if (lookup.expiresAt <= now) {
        report.expired += 1;
        if (!options.dryRun) await giveUp(lookup, report);
        continue;
      }

      if (options.dryRun) continue;

      const attempted = await attempt(lookup);
      if (attempted.answered) {
        report.answered += 1;
        await complete(lookup, attempted.response!, 'lookup.completed', report, lookup.attempts + 1);
      } else {
        report.retried += 1;
        await getPrisma().asyncLookup.update({
          where: { id: lookup.id },
          data: {
            attempts: lookup.attempts + 1,
            retryAfter: nextRetryAt(lookup.attempts + 1, new Date()),
          },
        });
      }
    } catch (error) {
      // One failing lookup must not stop the batch, nor be retried unchanged on every pass. Without
      // advancing its retry date it would be retried every ten minutes for a week with no backoff.
      report.failed += 1;
      asyncLogger.error(
        { err: error, vatNumber: lookup.vatNumber, lookup: lookup.publicId },
        'asynchronous lookup failed',
      );
      try {
        await getPrisma().asyncLookup.update({
          where: { id: lookup.id },
          data: {
            attempts: lookup.attempts + 1,
            retryAfter: nextRetryAt(lookup.attempts + 1, new Date()),
          },
        });
      } catch (scheduleError) {
        // The database probably just failed. Log it. The row keeps its retry date.
        asyncLogger.error({ err: scheduleError, lookup: lookup.publicId }, 'could not reschedule');
      }
    }
  }

  return report;
}

/** The rows the pass processes. */
interface DueLookup {
  id: bigint;
  publicId: string;
  userId: bigint;
  vatNumber: string;
  kind: string;
  url: string | null;
  attempts: number;
  expiresAt: Date;
  /** When the credit was taken, needed by `refund`. */
  createdAt: Date;
  account: { plan: Plan; lookupAsyncUrl: string | null };
}

/**
 * One attempt, recorded in `user_async_lookup_attempt` whatever the result, successes included, so
 * the full story is visible.
 */
async function attempt(lookup: DueLookup): Promise<{ answered: boolean; response?: Record<string, unknown> }> {
  const startedAt = performance.now();
  const caller = { userId: lookup.userId };

  try {
    if (lookup.kind === 'all') {
      const report = await lookupVatAll(lookup.vatNumber, caller);
      const usable = isReportUsable(report);
      await recordAttempt(lookup.id, {
        outcome: usable ? 'found' : 'incomplete',
        httpStatus: 200,
        errorCode: usable ? null : 'SOURCE_UNAVAILABLE',
        fault: null,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return usable ? { answered: true, response: serializeAll(report) } : { answered: false };
    }

    const prefer = lookup.kind === 'proof' ? ('proof' as const) : ('completeness' as const);
    const outcome = await lookupVat(lookup.vatNumber, caller, { prefer });
    const answered = isAnswered(outcome);
    const failure = outcome.status === 'found' ? null : toApiError(outcome, prefer);

    await recordAttempt(lookup.id, {
      outcome: outcome.status,
      httpStatus: failure?.status ?? 200,
      errorCode: failure?.code ?? null,
      fault: outcome.status === 'unavailable' ? outcome.failure.fault : null,
      durationMs: Math.round(performance.now() - startedAt),
    });

    if (!answered) return { answered: false };
    return {
      answered: true,
      response: outcome.status === 'found' ? serialize(outcome) : failure!.toBody(),
    };
  } catch (error) {
    // The number was normalized at creation, so this is our error. Recorded as an attempt so the
    // history stays complete.
    await recordAttempt(lookup.id, {
      outcome: error instanceof InvalidVatError ? 'invalid' : 'error',
      httpStatus: error instanceof InvalidVatError ? 400 : 500,
      errorCode: error instanceof InvalidVatError ? 'INVALID_VAT_FORMAT' : 'INTERNAL_ERROR',
      fault: null,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

async function recordAttempt(
  asyncLookupId: bigint,
  row: { outcome: string; httpStatus: number; errorCode: string | null; fault: string | null; durationMs: number },
): Promise<void> {
  await getPrisma().asyncLookupAttempt.create({ data: { asyncLookupId, ...row } });
}

/** Marks it answered, stores the envelope, and delivers it. */
async function complete(
  lookup: DueLookup,
  response: Record<string, unknown>,
  event: 'lookup.completed' | 'lookup.failed',
  report: AsyncReport,
  attempts: number,
): Promise<void> {
  await getPrisma().asyncLookup.update({
    where: { id: lookup.id },
    data: {
      status: event === 'lookup.completed' ? 'success' : 'failed',
      attempts,
      completedAt: new Date(),
      response: response as Prisma.InputJsonValue,
    },
  });

  // The row is closed before delivering, and delivery cannot throw out of here. Otherwise an account
  // without a callback URL would leave the row pending forever, retried every ten minutes.
  try {
    const url = resolveCallbackUrl(lookup.url, lookup.account.lookupAsyncUrl);
    const secret = await callbackSecret(lookup.userId);
    const result = await deliver({
      userId: lookup.userId,
      url,
      secret,
      event,
      payload: {
        event,
        lookup: lookup.publicId,
        occurredAt: new Date().toISOString(),
        vatNumber: lookup.vatNumber,
        kind: lookup.kind,
        attempts,
        ...response,
      },
      asyncLookupId: lookup.id,
    });

    if (result.delivered) {
      report.delivered += 1;
      // Only set on an accepted delivery. A finished lookup without it was answered but not delivered.
      await getPrisma().asyncLookup.update({ where: { id: lookup.id }, data: { deliveredAt: new Date() } });
    } else {
      report.failed += 1;
    }
  } catch (error) {
    report.failed += 1;
    asyncLogger.error(
      { err: error, lookup: lookup.publicId, vatNumber: lookup.vatNumber },
      'asynchronous lookup answered but could not be delivered',
    );
  }
}

/**
 * A week of attempts without an answer.
 *
 * In this order: the row is closed as `failed`, a `lookup.failed` payload is sent so the caller
 * knows the wait is over, and the credit is refunded.
 *
 * `peek` loads the account's counter in this process for the refund. The CLI flushes it on exit.
 */
async function giveUp(lookup: DueLookup, report: AsyncReport): Promise<void> {
  const body = {
    error: {
      code: 'SOURCE_UNAVAILABLE',
      message:
        `No source answered for "${lookup.vatNumber}" in ${config.asyncLookup.maxDays} days of retrying. ` +
        'The lookup has been given up on and the credit it cost has been returned.',
    },
  };

  await complete(lookup, body, 'lookup.failed', report, lookup.attempts);

  await peek(lookup.userId, lookup.account.plan);
  // Dated by when the unit was taken (the creation day, possibly last month). `refund` ignores charges
  // from a closed period.
  refund(lookup.userId, lookup.createdAt, 1);
  asyncLogger.info(
    { lookup: lookup.publicId, vatNumber: lookup.vatNumber },
    'asynchronous lookup expired; credit refunded',
  );
}
