import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * The monthly quota counter.
 *
 * Decisions are made in memory and the database is updated in the background every
 * {@link FLUSH_INTERVAL_MS}. A synchronous `UPDATE ... SET used = used + 1` on every call would add
 * a database round trip to each lookup.
 *
 * Trade-offs:
 *
 * - Each process loads its own counter from the database, so the total can be under-counted by
 *   what other processes consumed since their last flush. A few seconds, in the customer's favor.
 * - A crash loses at most one flush interval of counting, also in the customer's favor.
 *
 * If this ever matters commercially, a Redis counter would fit behind the same interface.
 */

const FLUSH_INTERVAL_MS = 5_000;

export type Plan = 'free' | 'pro';

export interface QuotaSnapshot {
  limit: number;
  /** Never negative. */
  remaining: number;
  /** Start of the next period, in unix seconds: the value of `X-RateLimit-Reset`. */
  resetAt: number;
  exceeded: boolean;
}

interface Counter {
  periodStart: Date;
  periodEnd: Date;
  /** The plan this counter was loaded for, so an upgrade is noticed before the month ends. */
  plan: Plan;
  quota: number;
  /** Total for the period, loaded from the database and updated in memory. */
  used: number;
  /** What has not been written to the database yet. */
  pending: number;
}

const counters = new Map<string, Counter>();
const usageLogger = logger.child({ component: 'usage' });

/** Calendar months, UTC. Every DateTime in this codebase is UTC. */
export function periodBounds(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function quotaForPlan(plan: Plan): number {
  return plan === 'pro' ? config.quotas.pro : config.quotas.free;
}

/**
 * Loads the account's current period, creating it on the first call of the month. `plan` and
 * `quota` are copied when the period opens, so past months stay correct after a plan or config
 * change.
 */
export async function openPeriod(userId: bigint, plan: Plan, now: Date = new Date()) {
  const { start, end } = periodBounds(now);
  const quota = quotaForPlan(plan);

  return getPrisma().usagePeriod.upsert({
    where: { userId_periodStart: { userId, periodStart: start } },
    create: { userId, periodStart: start, periodEnd: end, plan, quota, used: 0 },
    // A plan bought mid-month raises that month's quota. `used` is not touched.
    update: { plan, quota },
    select: { periodStart: true, periodEnd: true, quota: true, used: true },
  });
}

async function counterFor(userId: bigint, plan: Plan, now: Date): Promise<Counter> {
  const key = userId.toString();
  const { start } = periodBounds(now);
  const existing = counters.get(key);

  // A counter from last month is a different period: flush it before replacing it. A counter for the
  // wrong plan is reloaded too.
  if (existing && existing.periodStart.getTime() === start.getTime() && existing.plan === plan) {
    return existing;
  }
  if (existing) await flushOne(userId, existing);

  const row = await openPeriod(userId, plan, now);
  const counter: Counter = {
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    plan,
    quota: row.quota,
    used: row.used,
    pending: 0,
  };
  counters.set(key, counter);
  return counter;
}

function snapshot(counter: Counter): QuotaSnapshot {
  return {
    limit: counter.quota,
    remaining: Math.max(0, counter.quota - counter.used),
    resetAt: Math.floor(counter.periodEnd.getTime() / 1000),
    exceeded: counter.used >= counter.quota,
  };
}

/** Reads the counter without changing it: used to decide on a 429. */
export async function peek(userId: bigint, plan: Plan, now: Date = new Date()): Promise<QuotaSnapshot> {
  return snapshot(await counterFor(userId, plan, now));
}

/**
 * Records one billable call. Every metered call costs one unit.
 *
 * Synchronous, so `X-RateLimit-Remaining` can be set on the same response. The caller already
 * called {@link peek}, which loaded the counter.
 *
 * Returns `null` if no counter is loaded, which only happens when the period changed between the
 * two calls (midnight on the first of the month).
 */
export function consume(userId: bigint, units = 1): QuotaSnapshot | null {
  const counter = counters.get(userId.toString());
  if (!counter) return null;
  counter.used += units;
  counter.pending += units;
  return snapshot(counter);
}

/**
 * Gives a unit back. The only thing that decreases the counter.
 *
 * Used by async lookups, which are billed at creation: a lookup that gives up after a week is
 * refunded.
 *
 * `chargedAt` is when the unit was taken. A lookup queued on 28 January and given up on 4 February
 * was charged to January, and only February's counter is loaded, so a charge from another period is
 * not refunded.
 *
 * Never below zero.
 *
 * Returns `null` when no counter is loaded: the caller must `peek` first.
 */
export function refund(userId: bigint, chargedAt: Date, units = 1): QuotaSnapshot | null {
  const counter = counters.get(userId.toString());
  if (!counter) return null;
  if (chargedAt < counter.periodStart || chargedAt >= counter.periodEnd) return snapshot(counter);

  const given = Math.min(units, counter.used);
  counter.used -= given;
  counter.pending -= given;
  return snapshot(counter);
}

async function flushOne(userId: bigint, counter: Counter): Promise<void> {
  const delta = counter.pending;
  if (delta === 0) return;
  // Cleared before the await, so a call during the flush is counted in the next one.
  counter.pending = 0;

  try {
    await getPrisma().usagePeriod.update({
      where: { userId_periodStart: { userId, periodStart: counter.periodStart } },
      // `increment` is a real SQL `used = used + ?`, so concurrent processes add up.
      data: { used: { increment: delta } },
    });
  } catch (error) {
    counter.pending += delta;
    usageLogger.error({ err: error, userId: userId.toString() }, 'failed to flush usage');
  }
}

export async function flushAll(): Promise<void> {
  await Promise.all([...counters].map(([key, counter]) => flushOne(BigInt(key), counter)));
}

let timer: NodeJS.Timeout | undefined;

export function startUsageFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushAll();
  }, FLUSH_INTERVAL_MS);
  // Must not keep a CLI or test runner alive.
  timer.unref();
}

/** Flushes one last time on shutdown. */
export async function stopUsageFlusher(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  await flushAll();
}

/** For tests: counters are process-wide. */
export function resetUsageCounters(): void {
  counters.clear();
}
