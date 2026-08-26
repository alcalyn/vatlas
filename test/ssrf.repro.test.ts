import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSRF regression tests for callback URLs.
 *
 * With the filter enabled (CALLBACK_ALLOW_PRIVATE_URLS=false, the production default), every bypass
 * must be refused: at creation for an IP literal, at connection time for a name resolving to a
 * private address. A local .env may set the flag to true, so it is forced off before importing.
 */

let assertPublicUrl: (v: string) => string;
let isBlockedAddress: (ip: string) => boolean;
let safePost: (
  url: string,
  o: { body: string; headers: Record<string, string>; timeoutMs: number; allowPrivate: boolean },
) => Promise<{ status: number; statusText: string }>;

beforeAll(async () => {
  vi.stubEnv('CALLBACK_ALLOW_PRIVATE_URLS', 'false');
  vi.resetModules();
  ({ assertPublicUrl } = await import('../src/services/callbacks.js'));
  ({ isBlockedAddress, safePost } = await import('../src/lib/ssrf.js'));
});

describe('assertPublicUrl now refuses the literal-host bypasses', () => {
  const refused = [
    'http://localhost./',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://100.100.100.200/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
  ];
  for (const url of refused) {
    it(`refuses ${url}`, () => {
      expect(() => assertPublicUrl(url)).toThrow(/private or loopback/);
    });
  }

  it('still accepts a genuinely public URL', () => {
    expect(() => assertPublicUrl('https://example.com/hooks/vatlas')).not.toThrow();
  });
});

describe('isBlockedAddress: address-level verdicts', () => {
  it.each([
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['not-an-ip', true], // fails closed
    ['8.8.8.8', false],
    ['93.184.216.34', false],
  ] as const)('%s -> blocked=%s', (ip, expected) => {
    expect(isBlockedAddress(ip)).toBe(expected);
  });
});

describe('safePost does not follow a redirect into loopback', () => {
  let attacker: Server;
  let victim: Server;
  let attackerUrl = '';
  let victimHit = false;

  beforeEach(() => {
    victimHit = false;
  });

  beforeAll(async () => {
    victim = createServer((_q, r) => {
      victimHit = true;
      r.writeHead(200).end('INTERNAL');
    });
    await new Promise<void>((ok) => victim.listen(0, '127.0.0.1', ok));
    const vPort = (victim.address() as AddressInfo).port;

    attacker = createServer((_q, r) => {
      r.writeHead(302, { location: `http://127.0.0.1:${vPort}/` }).end();
    });
    await new Promise<void>((ok) => attacker.listen(0, '127.0.0.1', ok));
    attackerUrl = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}/`;
  });

  afterAll(() => {
    attacker.close();
    victim.close();
  });

  it('records the 302 and never reaches the internal target', async () => {
    // allowPrivate:true so the test can reach the local server. What is tested is redirect handling,
    // independent of the address check.
    const res = await safePost(attackerUrl, { body: '{}', headers: {}, timeoutMs: 2000, allowPrivate: true });
    expect(res.status).toBe(302);
    expect(victimHit).toBe(false);
  });

  it('refuses a literal private target outright when allowPrivate is false', async () => {
    await expect(
      safePost('http://[::ffff:127.0.0.1]/', { body: '{}', headers: {}, timeoutMs: 2000, allowPrivate: false }),
    ).rejects.toThrow();
  });
});
