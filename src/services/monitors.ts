import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { payloadHash } from '../db/companyHistory.js';
import { lookupVat } from '../api/resolve.js';
import { serialize } from '../api/serialize.js';
import { normalizeVatInput, parseVatNumber } from '../vat/parse.js';
import { assertPublicUrl, callbackSecret, deliver, resolveCallbackUrl, type CallbackEvent } from './callbacks.js';
import type { Plan } from './usage.js';

/**
 * Monitors: follow a company by VAT number and get notified when a register's answer changes.
 *
 * `company.payload_hash` is a 128-bit hash of the identity columns, and a plateau opens when it
 * changes. A monitor stores the same hash for the last answer sent to the account, so the nightly
 * check is one comparison per monitor.
 *
 * Not metered. Each plan has a limit on the number of monitors.
 */

const monitorLogger = logger.child({ component: 'monitors' });

/** How many companies this plan may follow. */
export function monitorLimitFor(plan: Plan): number {
  return plan === 'pro' ? config.monitors.pro : config.monitors.free;
}

/**
 * Whether a check has news.
 *
 * Pure, so the rule that decides whether a customer is called can be tested without database,
 * network or clock.
 *
 * A null `previous` is the first check, which never delivers: it records the current state.
 */
export function hasChanged(previous: Uint8Array | null, next: Uint8Array): boolean {
  if (previous === null) return false;
  if (previous.length !== next.length) return true;
  return previous.some((byte, index) => byte !== next[index]);
}

/** What the console and the API list, with the account default resolved. */
export async function listMonitors(userId: bigint) {
  return getPrisma().monitor.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      publicId: true,
      vatNumber: true,
      url: true,
      lastSource: true,
      lastPayload: true,
      lastCheckedAt: true,
      lastChangedAt: true,
      lastDeliveredAt: true,
      createdAt: true,
    },
  });
}

/** How many this account follows, for the plan limit. */
export async function countMonitors(userId: bigint): Promise<number> {
  return getPrisma().monitor.count({ where: { userId } });
}

/**
 * One monitor and its recent deliveries, by VAT number.
 *
 * An account follows a number once (`(user_id, vat_number)` is unique), so the number is the key and
 * the path matches the lookup's: `/v1/monitor/FR95884831538`. The `publicId` stays in the payload.
 *
 * Scoped by `userId`: another account's monitor resolves to nothing.
 */
export async function getMonitor(userId: bigint, vatNumberInput: string, deliveryLimit = 50) {
  const vatNumber = parseVatNumber(normalizeVatInput(vatNumberInput ?? '')).formatted;
  const monitor = await getPrisma().monitor.findFirst({
    where: { userId, vatNumber },
    select: {
      id: true,
      publicId: true,
      vatNumber: true,
      url: true,
      lastSource: true,
      lastPayload: true,
      lastCheckedAt: true,
      lastChangedAt: true,
      lastDeliveredAt: true,
      createdAt: true,
    },
  });
  if (!monitor) return null;

  const deliveries = await getPrisma().delivery.findMany({
    where: { monitorId: monitor.id },
    orderBy: { sentAt: 'desc' },
    take: deliveryLimit,
    select: {
      publicId: true,
      event: true,
      url: true,
      attempt: true,
      httpStatus: true,
      error: true,
      durationMs: true,
      sentAt: true,
      payload: true,
    },
  });

  return { ...monitor, deliveries };
}

/**
 * Why a monitor could not be created, turned into a status by the API and a sentence by the
 * console.
 */
export class MonitorError extends Error {
  constructor(
    readonly code: 'MONITOR_LIMIT_REACHED' | 'MONITOR_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'MonitorError';
  }
}

export interface NewMonitor {
  /** Any written form of the number, normalized here like the lookup does. */
  vatNumber: string;
  /** Null uses the account's default, checked now. */
  url?: string | null;
}

export async function createMonitor(userId: bigint, plan: Plan, input: NewMonitor) {
  // Normalized first, so the followed number and the lookup's number are the same string. Invalid
  // input throws `InvalidVatError` (400 INVALID_VAT_FORMAT).
  const vatNumber = parseVatNumber(normalizeVatInput(input.vatNumber ?? '')).formatted;
  const url =
    input.url === undefined || input.url === null || input.url.trim() === '' ? null : assertPublicUrl(input.url);

  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { monitorUrl: true },
  });
  // Checked at creation: a monitor without a callback URL would silently do nothing.
  resolveCallbackUrl(url, account.monitorUrl);

  // The duplicate is checked before the limit: an account at its limit re-following a number is not
  // asking for a new monitor. The unique index is still the real check.
  const already = await getPrisma().monitor.findUnique({
    where: { userId_vatNumber: { userId, vatNumber } },
    select: { id: true },
  });
  if (already) {
    throw new MonitorError('MONITOR_EXISTS', `"${vatNumber}" is already followed by this account.`);
  }

  const limit = monitorLimitFor(plan);
  if ((await countMonitors(userId)) >= limit) {
    throw new MonitorError(
      'MONITOR_LIMIT_REACHED',
      `This account may follow ${limit} companies. Delete one, or move to a plan that follows more.`,
    );
  }

  try {
    return await getPrisma().monitor.create({
      data: { userId, vatNumber, url },
      select: { publicId: true, vatNumber: true, url: true, createdAt: true },
    });
  } catch (error) {
    // The unique index is the real check: two concurrent requests both pass the read above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new MonitorError('MONITOR_EXISTS', `"${vatNumber}" is already followed by this account.`);
    }
    throw error;
  }
}

/** A real delete. */
export async function deleteMonitor(userId: bigint, vatNumberInput: string): Promise<boolean> {
  const vatNumber = parseVatNumber(normalizeVatInput(vatNumberInput ?? '')).formatted;
  const result = await getPrisma().monitor.deleteMany({ where: { userId, vatNumber } });
  return result.count > 0;
}

/**
 * The body of a change event.
 *
 * `data` and `meta` are the plain lookup envelope, and `previous` is the same envelope for the last
 * state sent. The event also names its monitor.
 */
export function changeEvent(
  event: CallbackEvent,
  monitor: { publicId: string; vatNumber: string },
  current: Record<string, unknown>,
  previous: unknown,
): Record<string, unknown> {
  return {
    event,
    monitor: monitor.publicId,
    occurredAt: new Date().toISOString(),
    vatNumber: monitor.vatNumber,
    ...current,
    previous: previous ?? null,
  };
}

/**
 * A change event with sample data, in the shape of a real one, sent to the monitor's real URL and
 * signed with the real secret.
 *
 * Lets an integration be tested before the followed company changes. Recorded as a delivery,
 * tagged `monitor.test`.
 */
export async function sendTestDelivery(userId: bigint, vatNumberInput: string) {
  const vatNumber = parseVatNumber(normalizeVatInput(vatNumberInput ?? '')).formatted;
  const monitor = await getPrisma().monitor.findFirst({
    where: { userId, vatNumber },
    select: { id: true, publicId: true, vatNumber: true, url: true },
  });
  if (!monitor) return null;

  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { monitorUrl: true },
  });
  const url = resolveCallbackUrl(monitor.url, account.monitorUrl);
  const secret = await callbackSecret(userId);

  const payload = changeEvent(
    'monitor.test',
    monitor,
    sampleStatement(monitor.vatNumber, 'RUE DE LA PAIX', 'EXAMPLE COMPANY'),
    sampleStatement(monitor.vatNumber, 'AVENUE DES CHAMPS', 'EXAMPLE COMPANY'),
  );

  return deliver({ userId, url, secret, event: 'monitor.test', payload, monitorId: monitor.id });
}

/** The sample company of a test event. The two versions differ, which makes it a change. */
function sampleStatement(vatNumber: string, line1: string, name: string): Record<string, unknown> {
  const country = vatNumber.slice(0, 2);
  const today = new Date().toISOString().slice(0, 10);
  return {
    data: {
      vatNumber,
      countryCode: country,
      nationalNumber: vatNumber.slice(2),
      nationalId: vatNumber.slice(2),
      name,
      legalForm: null,
      status: 'active',
      address: { line1, line2: null, postalCode: '75002', city: 'PARIS', country },
    },
    meta: { source: 'VATLAS_TEST', sourceDate: today, sourceSince: today, sourceUpdatedAt: null },
  };
}

export interface MonitorReport {
  checked: number;
  changed: number;
  delivered: number;
  failed: number;
  /** Checks where no source answered. Neither a change nor an error. */
  unavailable: number;
}

/**
 * The nightly pass: for every followed company, ask the registers and deliver what changed.
 *
 * Uses `lookupVat` rather than reading `company`: it reads storage like the API and calls live
 * sources older than `LIVE_MAX_AGE_DAYS`, so countries without a bulk dump are monitored too. It
 * writes `log_lookup` like any lookup.
 *
 * Four at a time, so national registers are not flooded.
 */
export async function checkMonitors(options: { dryRun?: boolean; limit?: number } = {}): Promise<MonitorReport> {
  const monitors = await getPrisma().monitor.findMany({
    orderBy: { id: 'asc' },
    ...(options.limit !== undefined ? { take: options.limit } : {}),
    select: {
      id: true,
      publicId: true,
      userId: true,
      vatNumber: true,
      url: true,
      lastPayloadHash: true,
      lastPayload: true,
      account: { select: { monitorUrl: true } },
    },
  });

  const report: MonitorReport = { checked: 0, changed: 0, delivered: 0, failed: 0, unavailable: 0 };

  await mapWithConcurrency(monitors, 4, async (monitor) => {
    try {
      const outcome = await lookupVat(monitor.vatNumber, { userId: monitor.userId });
      report.checked += 1;

      // A member state that did not answer is not a company that did not change. Record the check
      // without touching the hash.
      if (outcome.status !== 'found' && outcome.status !== 'not-registered') {
        report.unavailable += 1;
        if (!options.dryRun) {
          await getPrisma().monitor.update({
            where: { id: monitor.id },
            data: { lastCheckedAt: new Date() },
          });
        }
        return;
      }

      // `payloadHash` returns a Buffer and Prisma types Bytes as Uint8Array. Copied rather than cast.
      const next = Uint8Array.from(payloadHash(outcome.statement));
      const changed = hasChanged(monitor.lastPayloadHash, next);
      // Only set when the receiver accepts. Older than `lastChangedAt` means the last change was not
      // delivered.
      let delivered = false;
      // The plain lookup envelope, for both outcomes. A `not-registered` statement gives
      // `data.status = not_registered`, the change customers care most about. `serialize` is typed for
      // `found`, hence the narrowing.
      const envelope = serialize({ ...outcome, status: 'found' });
      const now = new Date();

      if (changed) report.changed += 1;
      if (options.dryRun) return;

      if (changed) {
        // No callback URL is a failed delivery, not a failed check. Throwing would skip the hash update and
        // the same change would be announced every night.
        try {
          const secret = await callbackSecret(monitor.userId);
          const url = resolveCallbackUrl(monitor.url, monitor.account.monitorUrl);
          const result = await deliver({
            userId: monitor.userId,
            url,
            secret,
            event: 'company.changed',
            payload: changeEvent('company.changed', monitor, envelope, monitor.lastPayload),
            monitorId: monitor.id,
          });
          if (result.delivered) {
            report.delivered += 1;
            delivered = true;
          } else {
            report.failed += 1;
          }
        } catch (error) {
          report.failed += 1;
          monitorLogger.error(
            { err: error, vatNumber: monitor.vatNumber, monitor: monitor.publicId },
            'monitor changed but could not be delivered',
          );
        }
      }

      // Written even if delivery failed, otherwise the same change would be announced every night until
      // the receiver recovers.
      await getPrisma().monitor.update({
        where: { id: monitor.id },
        data: {
          lastPayloadHash: next,
          lastPayload: envelope as Prisma.InputJsonValue,
          lastSource: outcome.statement.source,
          lastCheckedAt: now,
          ...(changed ? { lastChangedAt: now } : {}),
          ...(delivered ? { lastDeliveredAt: now } : {}),
        },
      });
    } catch (error) {
      // One failing company must not stop the others.
      report.failed += 1;
      monitorLogger.error(
        { err: error, vatNumber: monitor.vatNumber, monitor: monitor.publicId },
        'monitor check failed',
      );
    }
  });

  return report;
}
