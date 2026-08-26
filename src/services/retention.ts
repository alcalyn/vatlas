import { config } from '../config.js';
import { sendDormantWarningEmail } from '../console/emails.js';
import { DEFAULT_LOCALE, isLocale } from '../console/i18n.js';
import { getPrisma } from '../db/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import { deleteAccount } from './accounts.js';
import type { Plan } from './usage.js';

/**
 * Applies the retention periods published in the privacy policy. Run from cron with
 * `npm run retention`.
 *
 * Every window here must match `site/src/privacy/{en,fr}/index.html` §7. Change both together.
 */

/**
 * Detailed call logs: the VAT number looked up, and by whom.
 *
 * 90 days: the quota is monthly, so this covers the current and previous month, the reach of a
 * billing dispute. The aggregate counters in `user_usage_period` remain, without numbers.
 */
export const LOOKUP_LOG_DAYS = 90;

/**
 * `log_source_call` (one row per live source call) holds the same kind of data (VAT number,
 * timestamp, status), so it uses the same {@link LOOKUP_LOG_DAYS}.
 */

/**
 * Expired sessions. The policy calls these security logs and keeps them 12 months (they hold an IP
 * and a user agent).
 *
 * Measured from expiry rather than creation.
 */
/**
 * The audit trail, per plan, in different units.
 *
 * The audit trail is a paid feature: answering "what did your API say about this number in June"
 * two years later is what is sold. A free account keeps only the last {@link AUDIT_FREE_KEEP}
 * entries, enough to see the feature working. A count rather than a period, so it does not depend on
 * how often the account calls.
 *
 * Pro keeps two years, the reach of a VAT dispute, and not forever: this table grows with every
 * billable call and stores third-party company data.
 *
 * `npm run audit:prune` applies other rules on demand. These two values are enforced by
 * `npm run retention` and published in the privacy policy and on the pricing page. Keep all of them
 * in sync.
 */
export const AUDIT_FREE_KEEP = config.audit.freeKeep;
export const AUDIT_PRO_DAYS = config.audit.proDays;

export const EXPIRED_SESSION_DAYS = 365;

/**
 * Email links (verification, reset, old magic links) once used or expired. They hold `requestIp`,
 * so they are security logs with the same window.
 */
export const SPENT_LOGIN_TOKEN_DAYS = 365;

/** The console's VAT autofill throttle. Its window is 24 hours. */
export const CONSOLE_VAT_LOOKUP_DAYS = 30;

/**
 * The site's demo throttle. Its window is a week. Rows are kept 30 days like the console's, as
 * security logs.
 */
export const SITE_VAT_LOOKUP_DAYS = 30;

/**
 * The sign-up and failed sign-in throttle. Its windows are an hour at most. Rows are kept 30 days as
 * security logs.
 */
export const AUTH_ATTEMPT_DAYS = 30;

/**
 * How long an unused account is kept before erasure, and how much warning it gets.
 *
 * Three years is long enough for an integration used once a year. The warning lets the holder keep
 * the account by signing in.
 */
export const DORMANT_ACCOUNT_DAYS = 3 * 365;
export const DORMANT_WARNING_DAYS = 30;

/**
 * How long a callback delivery record is kept.
 *
 * Same as call logs: a payload holds a company's name and address, and it is only useful to debug a
 * receiver.
 *
 * Monitors are never purged: they are subscriptions, not logs.
 */
export const DELIVERY_DAYS = 90;

/**
 * How long a finished async lookup is kept, with its attempts. Same window: the stored envelope is
 * an answer about a company, like an audit row.
 *
 * Only `success` and `failed` rows. A `pending` one is live work, bounded by `ASYNC_LOOKUP_MAX_DAYS`.
 */
export const ASYNC_LOOKUP_DAYS = 90;

export interface RetentionReport {
  lookupLogs: number;
  sourceCallLogs: number;
  auditLookups: number;
  sessions: number;
  loginTokens: number;
  consoleVatLookups: number;
  siteVatLookups: number;
  authAttempts: number;
  deliveries: number;
  asyncLookups: number;
}

const retentionLogger = logger.child({ component: 'retention' });

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

/**
 * Deletes everything past its retention window and reports what was deleted.
 *
 * `log_lookup` is deleted in batches: it gets an insert on every API call, and one large `DELETE`
 * would hold locks long enough to slow the API.
 *
 * `dryRun` counts without deleting.
 */
export async function enforceRetention(
  options: { dryRun?: boolean; batchSize?: number } = {},
): Promise<RetentionReport> {
  const prisma = getPrisma();
  const batchSize = options.batchSize ?? 10_000;
  const dryRun = options.dryRun ?? false;

  const lookupCutoff = daysAgo(LOOKUP_LOG_DAYS);
  const sessionCutoff = daysAgo(EXPIRED_SESSION_DAYS);
  const tokenCutoff = daysAgo(SPENT_LOGIN_TOKEN_DAYS);
  const vatLookupCutoff = daysAgo(CONSOLE_VAT_LOOKUP_DAYS);
  const siteLookupCutoff = daysAgo(SITE_VAT_LOOKUP_DAYS);
  const authAttemptCutoff = daysAgo(AUTH_ATTEMPT_DAYS);
  const deliveryCutoff = daysAgo(DELIVERY_DAYS);
  const asyncCutoff = daysAgo(ASYNC_LOOKUP_DAYS);
  // `completedAt` rather than `createdAt`, so a slow lookup is not purged right after it answers.
  const finishedAsync: Prisma.AsyncLookupWhereInput = {
    status: { in: ['success', 'failed'] },
    completedAt: { lt: asyncCutoff },
  };

  if (dryRun) {
    const [
      lookupLogs,
      sourceCallLogs,
      audit,
      sessions,
      loginTokens,
      consoleVatLookups,
      siteVatLookups,
      authAttempts,
      deliveries,
      asyncLookups,
    ] = await Promise.all([
      prisma.lookupLog.count({ where: { createdAt: { lt: lookupCutoff } } }),
      prisma.sourceCallLog.count({ where: { calledAt: { lt: lookupCutoff } } }),
      pruneAuditLookups({ dryRun: true, batchSize }),
      prisma.session.count({ where: { expiresAt: { lt: sessionCutoff } } }),
      prisma.loginToken.count({ where: { expiresAt: { lt: tokenCutoff } } }),
      prisma.consoleVatLookup.count({ where: { createdAt: { lt: vatLookupCutoff } } }),
      prisma.siteVatLookup.count({ where: { createdAt: { lt: siteLookupCutoff } } }),
      prisma.authAttempt.count({ where: { createdAt: { lt: authAttemptCutoff } } }),
      // One OR rather than two counts, so a delivery matching both conditions is counted once.
      prisma.delivery.count({
        where: { OR: [{ sentAt: { lt: deliveryCutoff } }, { asyncLookup: finishedAsync }] },
      }),
      prisma.asyncLookup.count({ where: finishedAsync }),
    ]);
    return {
      lookupLogs,
      sourceCallLogs,
      auditLookups: audit.rows,
      sessions,
      loginTokens,
      consoleVatLookups,
      siteVatLookups,
      authAttempts,
      deliveries,
      asyncLookups,
    };
  }

  let lookupLogs = 0;
  for (;;) {
    // `deleteMany` has no `limit`, so the batch is selected first and deleted by id.
    const batch = await prisma.lookupLog.findMany({
      where: { createdAt: { lt: lookupCutoff } },
      select: { id: true },
      take: batchSize,
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;

    const { count } = await prisma.lookupLog.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } });
    lookupLogs += count;
    if (batch.length < batchSize) break;
  }

  // Batched for the same reason. A lookup with retries writes one `log_lookup` row and up to four
  // here.
  let sourceCallLogs = 0;
  for (;;) {
    const batch = await prisma.sourceCallLog.findMany({
      where: { calledAt: { lt: lookupCutoff } },
      select: { id: true },
      take: batchSize,
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;

    const { count } = await prisma.sourceCallLog.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } });
    sourceCallLogs += count;
    if (batch.length < batchSize) break;
  }

  // The audit trail has its own pass: its window depends on the plan.
  const audit = await pruneAuditLookups({ batchSize });

  const [sessions, loginTokens, consoleVatLookups, siteVatLookups, authAttempts, deliveries] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: sessionCutoff } } }),
    prisma.loginToken.deleteMany({ where: { expiresAt: { lt: tokenCutoff } } }),
    prisma.consoleVatLookup.deleteMany({ where: { createdAt: { lt: vatLookupCutoff } } }),
    prisma.siteVatLookup.deleteMany({ where: { createdAt: { lt: siteLookupCutoff } } }),
    prisma.authAttempt.deleteMany({ where: { createdAt: { lt: authAttemptCutoff } } }),
    prisma.delivery.deleteMany({ where: { sentAt: { lt: deliveryCutoff } } }),
  ]);

  // Deliveries of expiring lookups, deleted explicitly rather than by cascade so the report counts
  // them.
  const cascaded = await prisma.delivery.deleteMany({
    where: { asyncLookup: finishedAsync },
  });

  // After its deliveries. Attempts still cascade.
  const asyncLookups = await prisma.asyncLookup.deleteMany({ where: finishedAsync });

  const report: RetentionReport = {
    lookupLogs,
    sourceCallLogs,
    auditLookups: audit.rows,
    sessions: sessions.count,
    loginTokens: loginTokens.count,
    consoleVatLookups: consoleVatLookups.count,
    siteVatLookups: siteVatLookups.count,
    authAttempts: authAttempts.count,
    deliveries: deliveries.count + cascaded.count,
    asyncLookups: asyncLookups.count,
  };
  retentionLogger.info(report, 'retention enforced');
  return report;
}

export interface DormantReport {
  warned: number;
  deleted: number;
  /** Accounts past the window that could not be erased (usually a live subscription). */
  skipped: number;
}

/**
 * The last activity on an account.
 *
 * Read from where activity shows up: account creation, last session seen, and last key use. A new
 * unused account is dated from its creation.
 *
 * Not `log_lookup`, which is purged after 90 days. `secret_keys.last_used_at` has the same
 * information without expiry.
 */
async function lastActivityAt(userId: bigint, createdAt: Date): Promise<Date> {
  const prisma = getPrisma();
  const [session, key] = await Promise.all([
    prisma.session.findFirst({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: { lastSeenAt: true },
    }),
    prisma.secretKey.findFirst({
      where: { userId, lastUsedAt: { not: null } },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    }),
  ]);

  const candidates = [createdAt, session?.lastSeenAt, key?.lastUsedAt].filter((d): d is Date => d instanceof Date);
  return candidates.reduce((latest, current) => (current > latest ? current : latest));
}

/**
 * Warns, then erases, accounts unused for {@link DORMANT_ACCOUNT_DAYS}.
 *
 * Two steps a month apart, as the privacy policy promises: an account is warned once, then erased
 * when the warning is {@link DORMANT_WARNING_DAYS} old. Signing in clears the warning
 * (`clearInactivityWarning()`).
 *
 * Erasure goes through {@link deleteAccount}, like a holder's own deletion, including the refusal
 * on a live subscription. A paying account is never erased for inactivity.
 */
export async function enforceDormantAccounts(options: { dryRun?: boolean } = {}): Promise<DormantReport> {
  const prisma = getPrisma();
  const dryRun = options.dryRun ?? false;
  const dormantCutoff = daysAgo(DORMANT_ACCOUNT_DAYS);
  const warningCutoff = daysAgo(DORMANT_WARNING_DAYS);

  const candidates = await prisma.account.findMany({
    where: { deletedAt: null, status: 'active', createdAt: { lt: dormantCutoff } },
    select: { id: true, email: true, locale: true, createdAt: true, inactivityWarnedAt: true },
  });

  const report: DormantReport = { warned: 0, deleted: 0, skipped: 0 };

  for (const account of candidates) {
    const lastSeen = await lastActivityAt(account.id, account.createdAt);
    if (lastSeen >= dormantCutoff) continue;

    if (account.inactivityWarnedAt === null) {
      report.warned += 1;
      if (dryRun) continue;
      const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
      await sendDormantWarningEmail(account.email, DORMANT_WARNING_DAYS, locale);
      await prisma.account.update({ where: { id: account.id }, data: { inactivityWarnedAt: new Date() } });
      continue;
    }

    // Warned, but the month has not passed yet.
    if (account.inactivityWarnedAt > warningCutoff) continue;

    if (dryRun) {
      report.deleted += 1;
      continue;
    }
    const result = await deleteAccount(account.id);
    if (result.ok) report.deleted += 1;
    else report.skipped += 1;
  }

  retentionLogger.info(report, dryRun ? 'dormant accounts (dry run)' : 'dormant accounts enforced');
  return report;
}

/** Cancels a pending erasure. Called on every sign-in. */
export async function clearInactivityWarning(userId: bigint): Promise<void> {
  await getPrisma().account.updateMany({
    where: { id: userId, inactivityWarnedAt: { not: null } },
    data: { inactivityWarnedAt: null },
  });
}

export interface AuditPruneOptions {
  /** Plans to process. Defaults to all. */
  plans?: Plan[];
  /** Delete rows older than this many days, whatever the plan. */
  olderThanDays?: number;
  /** Keep only the N most recent rows per account. */
  keepPerAccount?: number;
  dryRun?: boolean;
  batchSize?: number;
}

export interface AuditPruneReport {
  /** Accounts that had something to delete. */
  accounts: number;
  rows: number;
}

/**
 * Prunes `user_audit` by age, by count, or both.
 *
 * Used by `npm run retention` (no options: applies {@link AUDIT_FREE_KEEP} and
 * {@link AUDIT_PRO_DAYS}) and `npm run audit:prune` (operator options). One implementation for both.
 *
 * Walks accounts one at a time, since the window depends on the plan and `--keep N` is per account.
 * Uses the `(user_id, fetched_at)` index and deletes in batches, like the `log_lookup` loop.
 *
 * `id` is auto-increment, so ordering by id is insertion order, and "the N most recent" is one
 * pivot lookup.
 */
export async function pruneAuditLookups(options: AuditPruneOptions = {}): Promise<AuditPruneReport> {
  const prisma = getPrisma();
  const batchSize = options.batchSize ?? 10_000;
  const dryRun = options.dryRun ?? false;
  const plans = options.plans ?? ['free', 'pro'];
  const byPolicy = options.olderThanDays === undefined && options.keepPerAccount === undefined;

  const accounts = await prisma.account.findMany({
    where: { plan: { in: plans } },
    select: { id: true, plan: true },
  });

  const report: AuditPruneReport = { accounts: 0, rows: 0 };

  for (const account of accounts) {
    // By default the free plan is limited by row count and the paid plan by age. Explicit options apply
    // to every plan processed.
    const policy = byPolicy ? publishedPolicy(account.plan) : {};
    const days = options.olderThanDays ?? policy.olderThanDays;
    const keep = options.keepPerAccount ?? policy.keepPerAccount;
    let removed = 0;

    if (days !== undefined) {
      removed += await deleteAuditWhere(
        { userId: account.id, fetchedAt: { lt: daysAgo(days) } },
        { dryRun, batchSize },
      );
    }

    if (keep !== undefined) {
      // The id of the last row to keep. Everything below goes. `findFirst` with `skip` is one indexed
      // read.
      const pivot = await prisma.auditLookup.findFirst({
        where: { userId: account.id },
        orderBy: { id: 'desc' },
        skip: keep,
        select: { id: true },
      });
      if (pivot) {
        removed += await deleteAuditWhere({ userId: account.id, id: { lte: pivot.id } }, { dryRun, batchSize });
      }
    }

    if (removed > 0) {
      report.accounts += 1;
      report.rows += removed;
    }
  }

  retentionLogger.info(report, dryRun ? 'audit trail (dry run)' : 'audit trail pruned');
  return report;
}

/** The published rule for a plan. */
function publishedPolicy(plan: Plan): { olderThanDays?: number; keepPerAccount?: number } {
  return plan === 'pro' ? { olderThanDays: AUDIT_PRO_DAYS } : { keepPerAccount: AUDIT_FREE_KEEP };
}

/** Deletes matching rows in batches of ids (`deleteMany` has no `limit`). */
async function deleteAuditWhere(
  where: { userId: bigint; fetchedAt?: { lt: Date }; id?: { lte: bigint } },
  options: { dryRun: boolean; batchSize: number },
): Promise<number> {
  const prisma = getPrisma();
  if (options.dryRun) return prisma.auditLookup.count({ where });

  let deleted = 0;
  for (;;) {
    const batch = await prisma.auditLookup.findMany({
      where,
      select: { id: true },
      take: options.batchSize,
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;

    const { count } = await prisma.auditLookup.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } });
    deleted += count;
    if (batch.length < options.batchSize) break;
  }
  return deleted;
}
