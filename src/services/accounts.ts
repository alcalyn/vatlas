import { getPrisma } from '../db/prisma.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords.js';
import { forgetKey, maskedKey, mintKey, openSecret } from './secretKeys.js';
import { periodBounds, quotaForPlan, type Plan } from './usage.js';

/**
 * Accounts and their API keys. Every console write to the database lives here, so `src/console/`
 * only has routes and HTML.
 */

/** What a new account gets, so the console has something to show right away. */
const DEFAULT_TOKEN_NAME = 'default';

/** What the sign-up form recorded when the consent box was ticked. */
export interface TermsAcceptance {
  /** The version string the form displayed, see `console/legal.ts`. */
  version: string;
  ip?: string;
}

export type CreateAccountResult = { created: true; userId: bigint } | { created: false; reason: 'exists' };

/**
 * Creates an account with a first period and a working key, in one transaction, so no account can
 * exist without a way to call the API.
 *
 * The account works right away, unverified. The console asks for verification since resets and
 * invoices go to that address.
 *
 * An address that already has an account is refused with a message saying so. That reveals the
 * address is registered (the sign-in form does not), which is the price of signing in right after
 * sign-up. The form is throttled per IP.
 */
export async function createAccount(
  email: string,
  password: string,
  locale: string,
  terms: TermsAcceptance,
): Promise<CreateAccountResult> {
  const normalized = normalizeEmail(email);
  const prisma = getPrisma();

  const existing = await prisma.account.findUnique({ where: { email: normalized }, select: { id: true } });
  if (existing) return { created: false, reason: 'exists' };

  const plan: Plan = 'free';
  const { start, end } = periodBounds();
  const key = mintKey();
  const passwordHash = await hashPassword(password);
  const now = new Date();

  try {
    const account = await prisma.account.create({
      data: {
        email: normalized,
        plan,
        locale,
        passwordHash,
        passwordChangedAt: now,
        termsVersion: terms.version,
        termsAcceptedAt: now,
        termsAcceptedIp: terms.ip?.slice(0, 45) ?? null,
        usagePeriods: {
          create: { periodStart: start, periodEnd: end, plan, quota: quotaForPlan(plan), used: 0 },
        },
        secretKeys: {
          create: {
            name: DEFAULT_TOKEN_NAME,
            prefix: key.prefix,
            last4: key.last4,
            keyHash: key.keyHash,
            secretSealed: key.secretSealed,
          },
        },
      },
      select: { id: true },
    });
    return { created: true, userId: account.id };
  } catch (error) {
    // Two concurrent sign-ups for the same address: the unique key decides.
    if ((error as { code?: string }).code === 'P2002') return { created: false, reason: 'exists' };
    throw error;
  }
}

export type AuthenticateResult = { ok: true; userId: bigint } | { ok: false; userId?: bigint };

/**
 * Email and password in, account out, or nothing. Unknown address, no password yet, wrong password
 * and suspended account all fail the same way in the same time. `userId` is returned on failure
 * only so the caller can count the attempt against the account's throttle.
 */
export async function authenticate(email: string, password: string): Promise<AuthenticateResult> {
  const account = await getPrisma().account.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true, passwordHash: true, status: true },
  });

  if (!account?.passwordHash) {
    await burnPasswordCheck(password);
    return { ok: false, userId: account?.id };
  }
  const matches = await verifyPassword(password, account.passwordHash);
  if (!matches || account.status !== 'active') return { ok: false, userId: account.id };
  return { ok: true, userId: account.id };
}

export async function accountByEmail(email: string) {
  return getPrisma().account.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true, email: true, locale: true, status: true },
  });
}

export async function setPassword(userId: bigint, password: string): Promise<void> {
  await getPrisma().account.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() },
  });
}

/** Only the first verification is recorded. */
export async function markEmailVerified(userId: bigint): Promise<void> {
  await getPrisma().account.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
}

export async function dismissOnboarding(userId: bigint): Promise<void> {
  await getPrisma().account.updateMany({
    where: { id: userId, onboardingDismissedAt: null },
    data: { onboardingDismissedAt: new Date() },
  });
}

/** Why {@link deleteAccount} refused. */
export type DeleteAccountResult = { ok: true } | { ok: false; reason: 'subscription-active' | 'not-found' };

/**
 * Erasure under GDPR Article 17, as described in the privacy policy: what identifies the holder is
 * removed, what the law requires is kept.
 *
 * The row is not deleted: `log_lookup` references `user_id` without a foreign key and feeds the
 * usage counters, and invoices must be kept ten years. Every personal field is overwritten instead.
 *
 * In one transaction:
 *
 * - the email is replaced by a per-account tombstone (it is the unique key, so not null and not a
 *   shared constant);
 * - the billing profile (name, postal address) is deleted;
 * - the audit trail is deleted: it holds third-party VAT numbers only kept for this account.
 *   `log_lookup` stays, it has its own retention;
 * - every key is revoked (effective within the 60 s key cache);
 * - sessions, pending email links and the password hash are removed;
 * - monitors, async lookups, delivery records, both default callback URLs and the signing secret
 *   are removed.
 *
 * Refused while a subscription is live: erasing the account would leave Stripe billing a customer
 * we can no longer identify. The Terms say so too.
 */
export async function deleteAccount(userId: bigint): Promise<DeleteAccountResult> {
  const prisma = getPrisma();

  const account = await prisma.account.findUnique({
    where: { id: userId },
    select: { id: true, plan: true, subscriptionStatus: true, deletedAt: true },
  });
  if (!account || account.deletedAt) return { ok: false, reason: 'not-found' };

  // `canceled`/`incomplete_expired` mean it is over. Anything else is live, including `past_due`
  // (the card is being retried).
  const liveSubscription =
    account.subscriptionStatus !== null && !['canceled', 'incomplete_expired'].includes(account.subscriptionStatus);
  if (account.plan === 'pro' || liveSubscription) return { ok: false, reason: 'subscription-active' };

  const now = new Date();
  const keys = await prisma.secretKey.findMany({
    where: { userId, revokedAt: null },
    select: { keyHash: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.billingProfile.deleteMany({ where: { userId } });
    await tx.auditLookup.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.loginToken.deleteMany({ where: { userId } });
    await tx.authAttempt.deleteMany({ where: { userId } });
    // Callbacks: deliveries first, by `userId` (they hang off two parents, one about to be deleted),
    // then monitors and async lookups. The callback URLs and signing secret go with the identity below.
    await tx.delivery.deleteMany({ where: { userId } });
    await tx.monitor.deleteMany({ where: { userId } });
    await tx.asyncLookup.deleteMany({ where: { userId } });
    await tx.secretKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.account.update({
      where: { id: userId },
      data: {
        email: `deleted+${userId}@invalid`,
        status: 'deleted',
        deletedAt: now,
        termsAcceptedIp: null,
        passwordHash: null,
        monitorUrl: null,
        lookupAsyncUrl: null,
        callbackSecretSealed: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    });
  });

  // Outside the transaction: it only clears this process's cache. Other processes wait out their
  // 60 seconds, like for a single revocation.
  for (const { keyHash } of keys) forgetKey(keyHash);

  return { ok: true };
}

/**
 * Lowercased: `Alice@...` and `alice@...` must not be two accounts. MySQL's collation would fold
 * them anyway, but the application does not rely on it.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createSecretKey(userId: bigint, name: string): Promise<string> {
  const key = mintKey();
  await getPrisma().secretKey.create({
    data: {
      userId,
      name: name.trim().slice(0, 64) || DEFAULT_TOKEN_NAME,
      prefix: key.prefix,
      last4: key.last4,
      keyHash: key.keyHash,
      secretSealed: key.secretSealed,
    },
  });
  return key.secret;
}

/**
 * A soft delete, so past usage in `log_lookup` keeps a key name. Scoped by `userId` so a guessed id
 * cannot revoke another account's key.
 */
export async function revokeSecretKey(userId: bigint, keyId: bigint): Promise<boolean> {
  const result = await getPrisma().secretKey.updateMany({
    where: { id: keyId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return false;

  // Only clears this process's cache. Others wait out their 60 seconds, see `secretKeys.ts`.
  const row = await getPrisma().secretKey.findUnique({ where: { id: keyId }, select: { keyHash: true } });
  if (row) forgetKey(row.keyHash);
  return true;
}

/**
 * Everything the console needs about the keys, including the secrets: they stay visible and
 * copyable while live. `key` falls back to a masked form for a key that predates encryption, or
 * whose encrypted value no longer opens.
 *
 * Revoked keys are never returned.
 */
export async function listSecretKeys(userId: bigint) {
  const rows = await getPrisma().secretKey.findMany({
    where: { userId },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      prefix: true,
      last4: true,
      secretSealed: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });

  return rows.map(({ secretSealed, ...row }) => {
    const secret = row.revokedAt === null ? openSecret(secretSealed) : undefined;
    return { ...row, key: secret ?? maskedKey(row.prefix, row.last4), copyable: secret !== undefined };
  });
}

/**
 * Monthly usage history, newest last, from `user_usage_period` (never purged, one row per month with
 * the quota of the time).
 */
export async function usageHistory(userId: bigint, months = 12) {
  const rows = await getPrisma().usagePeriod.findMany({
    where: { userId },
    orderBy: { periodStart: 'desc' },
    take: months,
    select: { periodStart: true, periodEnd: true, plan: true, quota: true, used: true },
  });
  return rows.reverse();
}

/**
 * Requests per key for the current period, from `log_lookup` with a GROUP BY on the
 * `(secret_key_id, created_at)` index. If `log_lookup` gets a shorter retention, this needs an
 * aggregate table.
 */
export async function usageByKey(userId: bigint): Promise<Map<string, number>> {
  const { start } = periodBounds();
  const rows = await getPrisma().lookupLog.groupBy({
    by: ['secretKeyId'],
    // Same outcomes as `countsAgainstQuota`, so per-key figures add up to the period total.
    where: { userId, createdAt: { gte: start }, status: { in: BILLED_STATUSES } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.secretKeyId !== null) counts.set(row.secretKeyId.toString(), row._count._all);
  }
  return counts;
}

/** The `LookupOutcome` statuses that produce a 200 or a 404, see `api/auth.ts`. */
const BILLED_STATUSES = ['found', 'not-registered', 'not-found'];
