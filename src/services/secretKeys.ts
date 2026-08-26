import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * API keys: creation, hashing, encryption, and the lookup on the request path.
 *
 * Each key is stored twice:
 *
 * - `key_hash`, `sha256(secret + TOKEN_PEPPER)`, used to authenticate requests. Unique and indexed,
 *   so authentication is one `WHERE key_hash = ?`. SHA-256 rather than a slow KDF: the secret is 32
 *   random characters, so dictionary attacks do not apply, and a KDF would add tens of milliseconds
 *   to every request.
 * - `secret_sealed`, AES-256-GCM under a key derived from the same pepper, only so the console can
 *   show the key again. Never read on the request path.
 *
 * The second column weakens security on purpose: a one-way hash cannot be reversed by anyone. The
 * ciphertext is useless without the pepper (stored in the environment, not the database), but an
 * attacker with both can read every key.
 */

/**
 * The `vtl_live_` format is published in `site/src/_pages/docs.html`, so it is part of the
 * documented contract. The key is sent as a bearer token, see `api/auth.ts`.
 */
export const KEY_PREFIX = 'vtl_live';
const SECRET_LENGTH = 32;
/** Base62: no punctuation to escape, no `-`/`_` to lose at a line break. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Matches what {@link mintKey} produces. */
const KEY_PATTERN = new RegExp(`^${KEY_PREFIX}_[0-9A-Za-z]{${SECRET_LENGTH}}$`);

export interface MintedKey {
  secret: string;
  prefix: string;
  last4: string;
  keyHash: string;
  secretSealed: string;
}

export function mintKey(): MintedKey {
  const secret = `${KEY_PREFIX}_${randomString(SECRET_LENGTH)}`;
  return {
    secret,
    prefix: KEY_PREFIX,
    last4: secret.slice(-4),
    keyHash: hashSecret(secret),
    secretSealed: sealSecret(secret),
  };
}

/** Rejection sampling rather than `byte % 62`, which would bias the first letters of the alphabet. */
function randomString(length: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Also used for sessions and email links. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(`${secret}${config.tokenPepper}`).digest('hex');
}

/**
 * The encryption key, derived from `TOKEN_PEPPER` with scrypt so any pepper gives a full 256-bit
 * key. Derived once, since scrypt is slow and this runs when rendering console pages.
 *
 * The salt is constant because there is one key, which must be the same across processes. The
 * per-secret randomness is in the IV, where GCM needs it.
 */
let sealingKey: Buffer | undefined;
function getSealingKey(): Buffer {
  if (!sealingKey) sealingKey = scryptSync(config.tokenPepper, 'vatlas/secret-key-seal', 32);
  return sealingKey;
}

const keyLogger = logger.child({ component: 'secretKeys' });

/** `iv.tag.ciphertext`, base64url, in one short ASCII column. */
export function sealSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

/**
 * Returns `undefined` rather than throwing when decryption fails, which happens when `TOKEN_PEPPER`
 * changed (and every key is then invalid anyway). The console shows a masked key.
 */
export function openSecret(sealed: string | null): string | undefined {
  if (!sealed) return undefined;
  const [iv, tag, ciphertext] = sealed.split('.');
  if (!iv || !tag || !ciphertext) return undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', getSealingKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    keyLogger.warn('could not open a sealed secret key; TOKEN_PEPPER has probably changed');
    return undefined;
  }
}

/** What the console shows when the key cannot be recovered. */
export function maskedKey(prefix: string, last4: string): string {
  return `${prefix}_${'•'.repeat(12)}${last4}`;
}

/** Cheap check before touching the database, also keeps junk out of the cache. */
export function looksLikeKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** Constant-time comparison of two hex digests, for comparisons outside SQL. */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export interface ResolvedKey {
  keyId: bigint;
  userId: bigint;
  plan: 'free' | 'pro';
}

interface CacheEntry {
  /** `null` is cached too, so an invalid key does not cost a query on every retry. */
  value: ResolvedKey | null;
  expiresAt: number;
}

/**
 * Without this cache, authentication would add a database round trip to every call.
 *
 * The cost, documented in the console and the docs: a revoked key keeps working for up to a minute.
 */
const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export async function resolveKey(secret: string): Promise<ResolvedKey | null> {
  if (!looksLikeKey(secret)) return null;

  const keyHash = hashSecret(secret);
  const cached = cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const row = await getPrisma().secretKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      revokedAt: true,
      account: { select: { id: true, plan: true, status: true } },
    },
  });

  const usable = row !== null && row.revokedAt === null && row.account.status === 'active';
  const value: ResolvedKey | null = usable ? { keyId: row.id, userId: row.account.id, plan: row.account.plan } : null;

  cache.set(keyHash, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Removes one key from this process's cache. Other processes wait for their TTL. */
export function forgetKey(keyHash: string): void {
  cache.delete(keyHash);
}

/** For tests: the cache is process-wide. */
export function clearKeyCache(): void {
  cache.clear();
}
