import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { type Prisma } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import { delay } from '../lib/http.js';
import { isBlockedAddress, safePost } from '../lib/ssrf.js';
import { isIP } from 'node:net';
import { openSecret, sealSecret } from './secretKeys.js';

/**
 * Callbacks: signed POSTs to a URL owned by the account.
 *
 * Monitors and async lookups both deliver through this module, which handles signing, retries and
 * the delivery records. It knows nothing about monitors or lookups: it gets a URL, a secret, an event
 * name and a body, signs, posts, and records what happened.
 */

const callbackLogger = logger.child({ component: 'callbacks' });

/** The four events: the `event` field of the body and the `X-Vatlas-Event` header. */
export type CallbackEvent = 'company.changed' | 'monitor.test' | 'lookup.completed' | 'lookup.failed';

/** An unusable callback URL, with a code so the API and the console can explain why. */
export class CallbackUrlError extends Error {
  constructor(
    readonly code: 'CALLBACK_URL_MISSING' | 'INVALID_CALLBACK_URL',
    message: string,
  ) {
    super(message);
    this.name = 'CallbackUrlError';
  }
}

/**
 * Host names a callback may not use unless `CALLBACK_ALLOW_PRIVATE_URLS` is set.
 *
 * The service makes requests to customer-supplied URLs, so without checks they could reach
 * internal services (cloud metadata on 169.254.169.254, admin panels, the database).
 *
 * This list is only the name check at creation (`localhost`, internal TLDs). IP literals, in every
 * form a URL parser accepts, are checked by value in `isBlockedAddress`. Names resolving to private
 * addresses are caught at connection time by `safePost`.
 */
const PRIVATE_HOST = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i];

/** The URL to use, or a refusal. Pure, so the API, the console and the cron reject the same URLs. */
export function assertPublicUrl(value: string): string {
  const raw = value.trim();
  if (raw === '') {
    throw new CallbackUrlError('INVALID_CALLBACK_URL', 'A callback URL is required.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError(
      'INVALID_CALLBACK_URL',
      `"${raw}" is not an absolute URL. Write it in full, scheme included: https://example.com/hooks/vatlas`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CallbackUrlError(
      'INVALID_CALLBACK_URL',
      `A callback URL must be http or https, not "${url.protocol.replace(':', '')}".`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new CallbackUrlError(
      'INVALID_CALLBACK_URL',
      'A callback URL must not carry credentials in the URL itself. The signature is what authenticates us.',
    );
  }

  if (raw.length > 2048) {
    throw new CallbackUrlError('INVALID_CALLBACK_URL', 'A callback URL may be at most 2048 characters.');
  }

  if (!config.callbacks.allowPrivateUrls) {
    const bareHost = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const isLiteralIp = isIP(bareHost) !== 0;
    // Strip a trailing dot: `localhost.` is `localhost`.
    const name = bareHost.replace(/\.$/, '');
    const refused = isLiteralIp ? isBlockedAddress(bareHost) : PRIVATE_HOST.some((pattern) => pattern.test(name));
    if (refused) {
      throw new CallbackUrlError(
        'INVALID_CALLBACK_URL',
        `"${url.hostname}" is a private or loopback address, which this service will not call. ` +
          'Use an address reachable from the internet.',
      );
    }
  }

  return url.toString();
}

/**
 * The URL of a delivery: the row's, else the account's default, else a refusal (raised at creation
 * so the customer knows).
 */
export function resolveCallbackUrl(own: string | null, accountDefault: string | null): string {
  const chosen = own ?? accountDefault;
  if (chosen === null || chosen.trim() === '') {
    throw new CallbackUrlError(
      'CALLBACK_URL_MISSING',
      'No callback URL: this one names none, and the account has no default. ' +
        'Set a default URL, or give this one an address of its own.',
    );
  }
  return assertPublicUrl(chosen);
}

/** `vtl_sign_` plus 32 random bytes. */
const SIGNING_PREFIX = 'vtl_sign';

function mintSigningSecret(): string {
  return `${SIGNING_PREFIX}_${randomBytes(32).toString('base64url')}`;
}

/**
 * The account's signing secret, created on first use.
 *
 * Accounts that never use callbacks never get one, and older accounts get one when needed.
 *
 * Encrypted like API keys, so the console can show it again.
 */
export async function callbackSecret(userId: bigint): Promise<string> {
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { callbackSecretSealed: true },
  });

  const existing = openSecret(account.callbackSecretSealed);
  if (existing !== undefined) return existing;

  return rotateCallbackSecret(userId);
}

/**
 * Replaces the signing secret. Also used when the stored secret can no longer be decrypted because
 * `TOKEN_PEPPER` changed.
 */
export async function rotateCallbackSecret(userId: bigint): Promise<string> {
  const secret = mintSigningSecret();
  await getPrisma().account.update({
    where: { id: userId },
    data: { callbackSecretSealed: sealSecret(secret) },
  });
  return secret;
}

/**
 * The `X-Vatlas-Signature` header for one body at one time.
 *
 * `t=<unix seconds>,v1=<hex>` where hex is `HMAC-SHA256(secret, "<t>.<body>")`, the same scheme as
 * Stripe.
 *
 * The timestamp is signed, so receivers can reject replays.
 *
 * The versioned format leaves room for another algorithm later.
 */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Verifies a header produced here. The service never calls it, but the docs show receivers how to
 * verify, and `test/callbacks.test.ts` checks it against `signPayload`.
 */
export function verifySignature(secret: string, body: string, header: string): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!Number.isInteger(timestamp) || provided === undefined) return false;

  // Checked first, on characters: `timingSafeEqual` throws on buffers of different byte length, and
  // character length is not byte length. A forged signature must return false, not throw.
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  // Constant-time comparison.
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

/** One delivery attempt. Exactly one parent is set. */
export interface DeliveryRequest {
  userId: bigint;
  url: string;
  secret: string;
  event: CallbackEvent;
  payload: unknown;
  monitorId?: bigint;
  asyncLookupId?: bigint;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  /** Status of the last attempt, or null when nothing answered. */
  httpStatus: number | null;
  error: string | null;
}

/**
 * Signs, posts, and records every attempt.
 *
 * Any `2xx` is a success. Anything else is retried `config.callbacks.retries` times with doubling
 * backoff, and every attempt is recorded, failures included, so customers can debug their receiver.
 *
 * The row is inserted before the request and completed after, so a killed process still leaves a
 * trace, and `X-Vatlas-Delivery` carries the row's id for the receiver's idempotency.
 */
export async function deliver(request: DeliveryRequest): Promise<DeliveryResult> {
  const body = JSON.stringify(request.payload);
  const attemptCount = config.callbacks.retries + 1;
  let last: DeliveryResult = { delivered: false, attempts: 0, httpStatus: null, error: 'not attempted' };

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    if (attempt > 1) await delay(2 ** (attempt - 2) * 1_000);

    const publicId = randomUUID();
    const row = await getPrisma().delivery.create({
      data: {
        publicId,
        userId: request.userId,
        monitorId: request.monitorId ?? null,
        asyncLookupId: request.asyncLookupId ?? null,
        event: request.event,
        url: request.url,
        payload: request.payload as Prisma.InputJsonValue,
        attempt,
      },
      select: { id: true },
    });

    const startedAt = performance.now();
    let httpStatus: number | null = null;
    let error: string | null = null;

    try {
      // `safePost` resolves and pins the address, refuses private or reserved ones, and does not follow
      // redirects. Only the status is read.
      const response = await safePost(request.url, {
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Vatlas/1.0 (+https://vatlas.dev)',
          'x-vatlas-event': request.event,
          'x-vatlas-delivery': publicId,
          'x-vatlas-signature': signPayload(request.secret, body, Math.floor(Date.now() / 1000)),
        },
        body,
        timeoutMs: config.callbacks.timeoutMs,
        allowPrivate: config.callbacks.allowPrivateUrls,
      });
      httpStatus = response.status;
      const ok = response.status >= 200 && response.status < 300;
      if (!ok) error = `HTTP ${response.status} ${response.statusText}`.slice(0, 255);
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 255);
    }

    const durationMs = Math.round(performance.now() - startedAt);
    await getPrisma().delivery.update({
      where: { id: row.id },
      data: { httpStatus, error, durationMs },
    });

    last = { delivered: error === null, attempts: attempt, httpStatus, error };
    if (last.delivered) return last;

    callbackLogger.warn(
      { event: request.event, url: request.url, attempt, httpStatus, err: error },
      'callback delivery failed',
    );
  }

  return last;
}

/**
 * Sends the last delivery again, once.
 *
 * The payload is read from `user_delivery`, so the exact same body is sent. For a monitor, the
 * `previous` part of the event would otherwise have changed.
 *
 * Once, not a new retry ladder: the original attempts are already listed.
 *
 * Null when there is nothing to resend.
 */
export async function resendLastDelivery(
  userId: bigint,
  subject: { monitorId?: bigint; asyncLookupId?: bigint },
): Promise<(DeliveryResult & { url: string }) | null> {
  const last = await getPrisma().delivery.findFirst({
    where: {
      userId,
      ...(subject.monitorId !== undefined ? { monitorId: subject.monitorId } : {}),
      ...(subject.asyncLookupId !== undefined ? { asyncLookupId: subject.asyncLookupId } : {}),
    },
    orderBy: { id: 'desc' },
    select: { event: true, url: true, payload: true, monitorId: true, asyncLookupId: true },
  });
  if (!last) return null;

  // The URL is resolved again: the resend usually follows a URL fix.
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { monitorUrl: true, lookupAsyncUrl: true },
  });
  const own =
    subject.monitorId !== undefined
      ? await getPrisma().monitor.findUniqueOrThrow({ where: { id: subject.monitorId }, select: { url: true } })
      : await getPrisma().asyncLookup.findUniqueOrThrow({
          where: { id: subject.asyncLookupId! },
          select: { url: true },
        });
  const url = resolveCallbackUrl(
    own.url,
    subject.monitorId !== undefined ? account.monitorUrl : account.lookupAsyncUrl,
  );

  const result = await deliver({
    userId,
    url,
    secret: await callbackSecret(userId),
    event: last.event as CallbackEvent,
    payload: last.payload,
    ...(last.monitorId !== null ? { monitorId: last.monitorId } : {}),
    ...(last.asyncLookupId !== null ? { asyncLookupId: last.asyncLookupId } : {}),
  });

  return { ...result, url };
}
