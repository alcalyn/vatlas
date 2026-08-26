import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Console passwords.
 *
 * scrypt from `node:crypto` rather than a bcrypt or argon2 package: memory-hard and built in, with
 * no native addon.
 *
 * The stored form includes its parameters (`scrypt$N$r$p$salt$hash`), so the cost can be raised
 * later and old hashes still verify.
 *
 * Not `hashSecret()`: keys and sessions are 256 random bits, for which one SHA-256 is enough.
 * Passwords need a slow salted hash.
 */

/** 2^15 x 8 x 128 bytes = 32 MiB per hash, ~50-100 ms on a server core. */
const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Length is the only rule: composition rules do not help against guessing.
 *
 * The maximum stops very long passwords from being used to burn CPU.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function isAcceptablePassword(password: string): boolean {
  const length = [...password].length;
  return length >= PASSWORD_MIN && length <= PASSWORD_MAX;
}

function derive(password: string, salt: Buffer, options: ScryptOptions, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `maxmem` must cover 128·N·r with headroom, or Node rejects the parameters.
    scrypt(password.normalize('NFKC'), salt, length, { ...options, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST, KEY_LENGTH);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** False for anything that does not parse, so a corrupt row reads as a wrong password, not a 500. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rawN, rawR, rawP, rawSalt, rawHash, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || rawSalt === undefined || rawHash === undefined || rest.length > 0) return false;
  const [N, r, p] = [rawN, rawR, rawP].map(Number) as [number, number, number];
  if (![N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return false;

  const salt = Buffer.from(rawSalt, 'base64url');
  const expected = Buffer.from(rawHash, 'base64url');
  if (expected.length === 0) return false;

  try {
    const actual = await derive(password, salt, { N, r, p }, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A hash no password matches, verified when the address has no account (or no password), so
 * "unknown address" takes as long as "wrong password".
 */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(password, await dummy);
}
