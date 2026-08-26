import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';
import { resolveKey, type ResolvedKey } from '../services/secretKeys.js';
import { consume, peek, type QuotaSnapshot } from '../services/usage.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Authentication and quota for the metered API.
 *
 * The key is an RFC 6750 bearer token (`Authorization: Bearer vtl_live_...`), which clients,
 * proxies and log scrubbers already treat as a credential.
 *
 * The published contract: `401` without a usable key, `429` once the monthly quota is spent, and
 * `X-RateLimit-Limit` / `-Remaining` / `-Reset` on every answer.
 *
 * `/v1/countries` and `/health` are open. `/v1/audit` needs a key but is not metered, hence two
 * guards.
 */

const SCHEME = 'bearer';
const authLogger = logger.child({ component: 'auth' });

/** Extracts the token from `Authorization`. The scheme is case-insensitive (RFC 7235). */
export function readBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const space = header.indexOf(' ');
  if (space === -1) return undefined;
  if (header.slice(0, space).toLowerCase() !== SCHEME) return undefined;
  const value = header.slice(space + 1).trim();
  return value === '' ? undefined : value;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by {@link requireSecretKey} on every request that reaches a handler. */
    secretKey?: ResolvedKey;
  }
}

/**
 * Which answers are billed: those where an answer was produced. A number VIES reports as
 * unregistered is a `404` and is billed.
 *
 * Not billed: `400` (rejected before any source was asked), `401` and `429` (nothing served), and
 * `503 SOURCE_UNAVAILABLE` (our outage, the caller is told to retry).
 */
export function countsAgainstQuota(status: number): boolean {
  return status === 200 || status === 404;
}

/** Authenticates and meters. Used by the lookup endpoints. */
export const requireSecretKey = guard(1);

/**
 * Authenticates without metering, for `/v1/audit`. Rate limit headers are still sent, but
 * nothing is consumed and a spent quota does not block access.
 */
export const requireSecretKeyUnmetered = guard(0);

/** `cost` is what one answered call spends: 1 for a lookup, 0 for a free endpoint. */
function guard(cost: number) {
  const metered = cost > 0;

  return async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const provided = readBearer(req.get('authorization'));

    if (!provided) {
      // Also used when the header uses another scheme, such as `Basic`.
      challenge(res);
      next(
        new ApiError(
          401,
          'MISSING_SECRET_KEY',
          'This endpoint requires a secret key, sent as "Authorization: Bearer <key>".',
        ),
      );
      return;
    }

    let key: ResolvedKey | null;
    try {
      key = await resolveKey(provided);
    } catch (error) {
      next(error);
      return;
    }

    if (!key) {
      // Revoked, unknown and malformed keys get the same answer, so keys cannot be probed.
      challenge(res, 'invalid_token');
      next(new ApiError(401, 'INVALID_SECRET_KEY', 'This secret key is not valid, or has been revoked.'));
      return;
    }

    req.secretKey = key;

    let quota: QuotaSnapshot;
    try {
      quota = await peek(key.userId, key.plan);
    } catch (error) {
      next(error);
      return;
    }

    if (!metered) {
      // Nothing to consume. The headers are informational.
      setRateLimitHeaders(res, quota);
      touchLastUsed(key.keyId);
      next();
      return;
    }

    if (quota.exceeded) {
      setRateLimitHeaders(res, quota);
      next(
        new ApiError(
          429,
          'QUOTA_EXCEEDED',
          `The monthly quota of ${quota.limit} requests for this account is spent. ` +
            'It renews at the start of the next month.',
          { limit: quota.limit, resetAt: new Date(quota.resetAt * 1000).toISOString() },
        ),
      );
      return;
    }

    // The status is only known after the handler ran, and a `finish` listener is too late to add
    // headers. `writeHead` is the last point where both are available.
    const writeHead = res.writeHead.bind(res);
    res.writeHead = function patched(this: Response, ...args: unknown[]) {
      const counted = countsAgainstQuota(res.statusCode) ? consume(key.userId, cost) : null;
      setRateLimitHeaders(res, counted ?? quota);
      return writeHead(...(args as Parameters<typeof writeHead>));
    } as typeof res.writeHead;

    touchLastUsed(key.keyId);
    next();
  };
}

/**
 * RFC 6750 `WWW-Authenticate` for a `401`: the expected scheme, and `invalid_token` when a
 * credential was offered and rejected.
 */
function challenge(res: Response, error?: 'invalid_token'): void {
  res.setHeader('WWW-Authenticate', error ? `Bearer error="${error}"` : 'Bearer');
}

function setRateLimitHeaders(res: Response, quota: QuotaSnapshot): void {
  if (res.headersSent) return;
  res.setHeader('X-RateLimit-Limit', String(quota.limit));
  res.setHeader('X-RateLimit-Remaining', String(quota.remaining));
  res.setHeader('X-RateLimit-Reset', String(quota.resetAt));
}

/**
 * "Last used" in the console. Not awaited, and written at most once a minute per key, to keep
 * writes off the hot path.
 */
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

function touchLastUsed(keyId: bigint): void {
  const id = keyId.toString();
  const now = Date.now();
  const previous = lastUsedWrites.get(id);
  if (previous !== undefined && now - previous < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(id, now);

  getPrisma()
    .secretKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch((error: unknown) => authLogger.error({ err: error }, 'failed to stamp last_used_at'));
}
