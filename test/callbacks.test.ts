import { describe, expect, it } from 'vitest';
import {
  CallbackUrlError,
  assertPublicUrl,
  resolveCallbackUrl,
  signPayload,
  verifySignature,
} from '../src/services/callbacks.js';

/**
 * The signature is a published contract: customer receivers depend on it. The vector below is
 * fixed on purpose: if anything signed changes, this fails. Changing it breaks every integration.
 */
describe('signPayload', () => {
  const secret = 'vtl_sign_example';
  const body = '{"event":"company.changed"}';

  // Checked against an independent implementation:
  //   printf '1767225600.{"event":"company.changed"}' \\
  //     | openssl dgst -sha256 -hmac 'vtl_sign_example' -hex
  it("signs the timestamp and the body together, in Stripe's shape", () => {
    expect(signPayload(secret, body, 1_767_225_600)).toBe(
      't=1767225600,v1=6cc7f0977f91abaef46d5569aafca141e6a4390c6dcf55dea65de966042f9d58',
    );
  });

  it('changes when the body changes', () => {
    expect(signPayload(secret, body, 1)).not.toBe(signPayload(secret, `${body} `, 1));
  });

  /** The timestamp is signed, so receivers can reject old deliveries. */
  it('changes when only the timestamp changes', () => {
    expect(signPayload(secret, body, 1)).not.toBe(signPayload(secret, body, 2));
  });

  it('round-trips through the verifier the documentation shows', () => {
    const header = signPayload(secret, body, 1_767_225_600);
    expect(verifySignature(secret, body, header)).toBe(true);
    expect(verifySignature('vtl_sign_other', body, header)).toBe(false);
    expect(verifySignature(secret, `${body} `, header)).toBe(false);
    expect(verifySignature(secret, body, 'nonsense')).toBe(false);
    expect(verifySignature(secret, body, 't=1767225600,v1=short')).toBe(false);
  });

  /**
   * A forged signature must return false, not throw. `timingSafeEqual` throws on buffers of different
   * byte length, and sixty-four accented characters are 128 bytes.
   */
  it.each([
    ['é'.repeat(64), 'sixty-four characters, a hundred and twenty-eight bytes'],
    ['Z'.repeat(64), 'the right length and not hexadecimal'],
    ['a'.repeat(63), 'one short'],
    ['a'.repeat(65), 'one long'],
    ['', 'empty'],
  ])('rejects a forged signature (%s) rather than throwing', (forged) => {
    expect(verifySignature(secret, body, `t=1767225600,v1=${forged}`)).toBe(false);
  });
});

/**
 * The guard against request forgery. Only the URL shape checks are tested here, which apply whatever
 * `CALLBACK_ALLOW_PRIVATE_URLS` says.
 */
describe('assertPublicUrl', () => {
  it('accepts an absolute http(s) URL', () => {
    expect(assertPublicUrl('https://example.test/hooks/vatlas')).toBe('https://example.test/hooks/vatlas');
    expect(assertPublicUrl('  https://example.test/hooks  ')).toBe('https://example.test/hooks');
  });

  it.each([
    ['', 'empty'],
    ['example.test/hooks', 'no scheme, so not absolute'],
    ['ftp://example.test/hooks', 'a scheme we do not speak'],
    ['https://user:pass@example.test/hooks', 'credentials in the URL itself'],
  ])('refuses %s (%s)', (value) => {
    expect(() => assertPublicUrl(value)).toThrow(CallbackUrlError);
  });

  it('names the refusal with a code, so the API can pick a status for it', () => {
    try {
      assertPublicUrl('nonsense');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CallbackUrlError);
      expect((error as CallbackUrlError).code).toBe('INVALID_CALLBACK_URL');
    }
  });
});

describe('resolveCallbackUrl', () => {
  it('prefers the address on the row', () => {
    expect(resolveCallbackUrl('https://own.test/hook', 'https://default.test/hook')).toBe('https://own.test/hook');
  });

  it('falls back to the account default', () => {
    expect(resolveCallbackUrl(null, 'https://default.test/hook')).toBe('https://default.test/hook');
  });

  /** Refused rather than skipped: a monitor with nowhere to deliver would silently do nothing. */
  it('refuses when there is neither, and says which problem it is', () => {
    try {
      resolveCallbackUrl(null, null);
      expect.unreachable();
    } catch (error) {
      expect((error as CallbackUrlError).code).toBe('CALLBACK_URL_MISSING');
    }
  });

  it('treats a blank default as no default', () => {
    expect(() => resolveCallbackUrl(null, '   ')).toThrow(CallbackUrlError);
  });
});
