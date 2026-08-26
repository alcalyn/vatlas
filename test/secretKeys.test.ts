import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  hashesMatch,
  looksLikeKey,
  maskedKey,
  mintKey,
  openSecret,
  sealSecret,
  KEY_PREFIX,
} from '../src/services/secretKeys.js';
import { countsAgainstQuota, readBearer } from '../src/api/auth.js';
import { periodBounds, quotaForPlan } from '../src/services/usage.js';

describe('mintKey', () => {
  it('produces the shape the published documentation promises', () => {
    // site/src/_pages/docs.html shows `Authorization: Bearer vtl_live_xxxxxxxxxxxxxxxxxxxx`, so the
    // prefix and separator are a public contract.
    const key = mintKey();
    expect(key.secret).toMatch(/^vtl_live_[0-9A-Za-z]{32}$/);
    expect(key.prefix).toBe(KEY_PREFIX);
    expect(key.last4).toBe(key.secret.slice(-4));
  });

  it('never returns the same secret twice', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => mintKey().secret));
    expect(secrets.size).toBe(500);
  });

  it('stores a hash that does not leak the secret', () => {
    const key = mintKey();
    expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.keyHash).not.toContain(key.secret);
  });

  it('seals the secret so the console can show it again', () => {
    const key = mintKey();
    expect(openSecret(key.secretSealed)).toBe(key.secret);
    // Encrypted: the ciphertext must not contain the key.
    expect(key.secretSealed).not.toContain(key.secret);
  });

  it('hashes deterministically, so a lookup by hash can be a plain WHERE', () => {
    const key = mintKey();
    expect(hashSecret(key.secret)).toBe(key.keyHash);
  });

  it('draws the whole alphabet, which a modulo bias would not', () => {
    // Rejection sampling avoids the `byte % 62` bias. 500 keys is 16,000 characters: every symbol should
    // appear.
    const seen = new Set(Array.from({ length: 500 }, () => mintKey().secret.slice(KEY_PREFIX.length + 1)).join(''));
    expect(seen.size).toBe(62);
  });
});

describe('looksLikeKey', () => {
  it('accepts what mintKey produces', () => {
    expect(looksLikeKey(mintKey().secret)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['vtl_live_tooshort', 'wrong length'],
    ['vtl_test_KMg2nSwYsHy2Qo1b90BDGzf99AfEGPI3', 'unknown prefix'],
    ['KMg2nSwYsHy2Qo1b90BDGzf99AfEGPI3', 'no prefix'],
    ['vtl_live_KMg2nSwYsHy2Qo1b90BDGzf99AfEGP!3', 'punctuation'],
  ])('rejects %s (%s) before any query runs', (value) => {
    expect(looksLikeKey(value)).toBe(false);
  });
});

describe('hashesMatch', () => {
  it('is true for equal digests and false otherwise', () => {
    const a = hashSecret('one');
    expect(hashesMatch(a, hashSecret('one'))).toBe(true);
    expect(hashesMatch(a, hashSecret('two'))).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    expect(hashesMatch(hashSecret('one'), 'abcd')).toBe(false);
  });
});

describe('countsAgainstQuota', () => {
  // Published on the pricing page and in the docs: a malformed number costs nothing, and neither does
  // our outage.
  it('bills an answer that was actually produced', () => {
    expect(countsAgainstQuota(200)).toBe(true);
    expect(countsAgainstQuota(404)).toBe(true);
  });

  it.each([
    [400, 'invalid syntax, no source consulted'],
    [401, 'nothing was served'],
    [429, 'nothing was served'],
    [503, 'a member state failed us, not the customer'],
    [500, 'our bug'],
  ])('does not bill %i (%s)', (status) => {
    expect(countsAgainstQuota(status)).toBe(false);
  });
});

describe('periodBounds', () => {
  it('spans one calendar month in UTC', () => {
    const { start, end } = periodBounds(new Date('2026-08-27T22:15:00Z'));
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    const { start, end } = periodBounds(new Date('2026-12-31T23:59:59Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('puts an instant just before midnight UTC in the month UTC says, not the local one', () => {
    // In Europe/Paris, 2026-08-31T23:30Z is already September. The counter uses UTC.
    const { start } = periodBounds(new Date('2026-08-31T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('quotaForPlan', () => {
  it('is the only thing that separates the two plans', () => {
    expect(quotaForPlan('free')).toBe(100);
    expect(quotaForPlan('pro')).toBe(5_000);
  });
});

describe('readBearer', () => {
  it('reads the credential out of a well-formed header', () => {
    expect(readBearer('Bearer vtl_live_abc')).toBe('vtl_live_abc');
  });

  it('matches the scheme case-insensitively, because RFC 7235 says it is', () => {
    // Some clients send `bearer`.
    expect(readBearer('bearer vtl_live_abc')).toBe('vtl_live_abc');
    expect(readBearer('BEARER vtl_live_abc')).toBe('vtl_live_abc');
  });

  it('tolerates padding around the credential', () => {
    expect(readBearer('Bearer   vtl_live_abc  ')).toBe('vtl_live_abc');
  });

  it.each([
    [undefined, 'no header at all'],
    ['', 'an empty header'],
    ['Bearer', 'a scheme with nothing after it'],
    ['Bearer   ', 'a scheme with only whitespace after it'],
    ['Basic dXNlcjpwYXNz', 'another scheme'],
    ['vtl_live_abc', 'a bare key with no scheme'],
  ])('returns nothing for %s (%s)', (header) => {
    expect(readBearer(header)).toBeUndefined();
  });

  it('does not mistake a key containing spaces for a scheme', () => {
    // Everything after the first space is the credential. `looksLikeKey` decides if it is plausible.
    expect(readBearer('Bearer not a real key')).toBe('not a real key');
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips', () => {
    expect(openSecret(sealSecret('vtl_live_abc'))).toBe('vtl_live_abc');
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A new IV per encryption, so two identical keys look different in a dump.
    const seals = new Set(Array.from({ length: 50 }, () => sealSecret('vtl_live_abc')));
    expect(seals.size).toBe(50);
  });

  it('refuses a seal that has been tampered with, rather than returning garbage', () => {
    // GCM authenticates as well as encrypts.
    const sealed = sealSecret('vtl_live_abc');
    const [iv, tag, ciphertext] = sealed.split('.');
    const flipped = `${ciphertext!.slice(0, -2)}${ciphertext!.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expect(openSecret(`${iv}.${tag}.${flipped}`)).toBeUndefined();
  });

  it.each([
    [null, 'a key that predates sealing'],
    ['', 'an empty column'],
    ['not-a-seal', 'something that is not three parts'],
    ['a.b', 'a truncated seal'],
  ])('returns nothing for %s (%s)', (sealed) => {
    expect(openSecret(sealed)).toBeUndefined();
  });
});

describe('maskedKey', () => {
  it('shows only what is safe to show, and never the middle', () => {
    const masked = maskedKey('vtl_live', 'aWBX');
    expect(masked.startsWith('vtl_live_')).toBe(true);
    expect(masked.endsWith('aWBX')).toBe(true);
    expect(masked).not.toMatch(/[0-9A-Za-z]{10,}$/);
  });
});
