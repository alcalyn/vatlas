import { getPrisma } from '../db/prisma.js';

/**
 * Per-IP (and per-account for sign-ins) limits on the console's unauthenticated forms.
 *
 * Same count-in-window logic as the other throttles:
 *
 * - `signup`: each sign-up emails an address the visitor typed, so this prevents spam;
 * - `forgot`: same for reset links. `createEmailToken` limits per address, this limits per IP;
 * - `login`: failed sign-ins only. Per IP against password spraying, per account against guessing
 *   one account's password from many IPs.
 */
export type AttemptKind = 'signup' | 'forgot' | 'login';

const WINDOW_MS: Record<AttemptKind, number> = {
  signup: 60 * 60 * 1000,
  forgot: 60 * 60 * 1000,
  login: 15 * 60 * 1000,
};

const IP_MAX: Record<AttemptKind, number> = {
  signup: 5,
  forgot: 10,
  login: 30,
};

/** Five wrong passwords on one account, then a 15 minute wait. */
const ACCOUNT_LOGIN_MAX = 5;

const ipKey = (ip: string | undefined): string => ip?.slice(0, 45) ?? 'unknown';
const since = (kind: AttemptKind): Date => new Date(Date.now() - WINDOW_MS[kind]);

/** Whether this IP (and account, when given) still has budget for `kind`. */
export async function withinBudget(kind: AttemptKind, ip: string | undefined, userId?: bigint): Promise<boolean> {
  const prisma = getPrisma();
  const byIp = await prisma.authAttempt.count({ where: { kind, ip: ipKey(ip), createdAt: { gte: since(kind) } } });
  if (byIp >= IP_MAX[kind]) return false;
  if (kind === 'login' && userId !== undefined) {
    const byAccount = await prisma.authAttempt.count({ where: { kind, userId, createdAt: { gte: since(kind) } } });
    if (byAccount >= ACCOUNT_LOGIN_MAX) return false;
  }
  return true;
}

export async function recordAttempt(kind: AttemptKind, ip: string | undefined, userId?: bigint): Promise<void> {
  await getPrisma().authAttempt.create({ data: { kind, ip: ipKey(ip), userId: userId ?? null } });
}

/** A successful sign-in clears the account's failures. */
export async function clearLoginFailures(userId: bigint): Promise<void> {
  await getPrisma().authAttempt.deleteMany({ where: { kind: 'login', userId } });
}
