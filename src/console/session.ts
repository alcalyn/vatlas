import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { clearInactivityWarning } from '../services/retention.js';
import { hashSecret } from '../services/secretKeys.js';

/**
 * Email links and console sessions.
 *
 * Both are bearer secrets stored like API keys: only `sha256(secret + TOKEN_PEPPER)` reaches the
 * database, so a dump of `auth_session` or `auth_login_token` holds no usable login or reset link.
 */

export const COOKIE_NAME = 'vatlas_session';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

/**
 * A reset link gives access to the account and lasts half an hour. A verification link only proves
 * the mailbox works, and people often open it the next day.
 */
const LINK_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 30 * 60 * 1000,
};

/** Where each kind of link lands in the console. */
const LINK_PATH: Record<EmailTokenPurpose, string> = {
  verify_email: '/verify-email',
  reset_password: '/password/reset',
};

/**
 * How many links of one kind one account may request, and over what window.
 *
 * An unthrottled "send an email to any address" endpoint would be used for spam, and would ruin the
 * sending domain's reputation.
 */
const THROTTLE_MAX = 3;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface EmailLink {
  url: string;
  /** False when the account asked too often: send nothing. */
  allowed: boolean;
}

export async function createEmailToken(
  userId: bigint,
  purpose: EmailTokenPurpose,
  ip: string | undefined,
): Promise<EmailLink> {
  const prisma = getPrisma();

  const recent = await prisma.loginToken.count({
    where: { userId, purpose, createdAt: { gte: new Date(Date.now() - THROTTLE_WINDOW_MS) } },
  });
  if (recent >= THROTTLE_MAX) return { url: '', allowed: false };

  const secret = newSecret();
  await prisma.loginToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashSecret(secret),
      expiresAt: new Date(Date.now() + LINK_TTL_MS[purpose]),
      requestIp: ip?.slice(0, 45) ?? null,
    },
  });

  const url = `${config.console.baseUrl}${LINK_PATH[purpose]}?token=${encodeURIComponent(secret)}`;
  return { url, allowed: true };
}

/**
 * Whether a link would still work, without using it. The reset page uses it on GET, since mail
 * scanners prefetch links and would otherwise consume them.
 */
export async function peekEmailToken(secret: string, purpose: EmailTokenPurpose): Promise<boolean> {
  const row = await getPrisma().loginToken.findUnique({
    where: { tokenHash: hashSecret(secret) },
    select: { purpose: true, consumedAt: true, expiresAt: true },
  });
  return row !== null && row.purpose === purpose && row.consumedAt === null && row.expiresAt > new Date();
}

/**
 * Uses a link once. `consumedAt` is set in the same conditional update that finds the row, so two
 * concurrent submissions cannot both succeed. The purpose is part of the match, so a verification
 * link never works as a reset.
 */
export async function consumeEmailToken(secret: string, purpose: EmailTokenPurpose): Promise<bigint | null> {
  const tokenHash = hashSecret(secret);
  const prisma = getPrisma();

  const claimed = await prisma.loginToken.updateMany({
    where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const row = await prisma.loginToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  return row?.userId ?? null;
}

/**
 * Signs the account out everywhere except the given session (after a password change).
 * `keepHash` absent means everywhere.
 */
export async function destroyOtherSessions(userId: bigint, keepHash?: string): Promise<void> {
  await getPrisma().session.deleteMany({
    where: { userId, ...(keepHash ? { tokenHash: { not: keepHash } } : {}) },
  });
}

export async function createSession(userId: bigint, req: Request, res: Response): Promise<void> {
  const secret = newSecret();
  const expiresAt = new Date(Date.now() + config.console.sessionTtlDays * 86_400_000);

  await getPrisma().session.create({
    data: {
      userId,
      tokenHash: hashSecret(secret),
      expiresAt,
      lastSeenAt: new Date(),
      userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
      ip: req.ip?.slice(0, 45) ?? null,
    },
  });

  setSessionCookie(res, secret, expiresAt);

  // Signing in proves the account is still used, so it cancels a pending erasure for inactivity.
  await clearInactivityWarning(userId);
}

export interface SessionAccount {
  userId: bigint;
  /** Whether the address is verified (the console banner reads this). */
  emailVerified: boolean;
}

export async function readSession(req: Request): Promise<bigint | null> {
  return (await readSessionAccount(req))?.userId ?? null;
}

export async function readSessionAccount(req: Request): Promise<SessionAccount | null> {
  const secret = readCookie(req, COOKIE_NAME);
  if (!secret) return null;

  const row = await getPrisma().session.findUnique({
    where: { tokenHash: hashSecret(secret) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      account: { select: { status: true, emailVerifiedAt: true } },
    },
  });
  if (!row || row.expiresAt <= new Date() || row.account.status !== 'active') return null;

  // Sliding expiry, written at most once a day.
  const remaining = row.expiresAt.getTime() - Date.now();
  if (remaining < (config.console.sessionTtlDays - 1) * 86_400_000) {
    void getPrisma()
      .session.update({
        where: { id: row.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + config.console.sessionTtlDays * 86_400_000),
        },
      })
      .catch(() => undefined);
  }

  return { userId: row.userId, emailVerified: row.account.emailVerifiedAt !== null };
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const secret = readCookie(req, COOKIE_NAME);
  if (secret) {
    await getPrisma()
      .session.deleteMany({ where: { tokenHash: hashSecret(secret) } })
      .catch(() => undefined);
  }
  clearSessionCookie(res);
}

/**
 * `SameSite=Lax` blocks this cookie on cross-site POSTs, which handles CSRF. It is still sent on a
 * top-level GET, like a link opened from an email.
 *
 * No `Domain=`: the cookie stays on the console host and is never sent to the API.
 */
function setSessionCookie(res: Response, secret: string, expiresAt: Date): void {
  res.cookie(COOKIE_NAME, secret, {
    httpOnly: true,
    sameSite: 'lax',
    // Not on plain HTTP, otherwise the cookie would not be set on localhost.
    secure: config.console.baseUrl.startsWith('https://'),
    expires: expiresAt,
    path: '/',
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** A small cookie reader instead of `cookie-parser`: only two known cookies are read. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
