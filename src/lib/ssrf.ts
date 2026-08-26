import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * The address-level part of the callback SSRF protection.
 *
 * `assertPublicUrl` in `services/callbacks.ts` only checks the URL as written, which a name
 * resolving to a private IP passes, as does `[::ffff:127.0.0.1]` once the parser rewrites it. This
 * module checks the actual IP.
 *
 * Two entry points:
 *   - `isBlockedAddress`: checks one IP, for URLs that are already IP literals.
 *   - `pinnedLookup`: a `dns.lookup` replacement for `http.request`/`https.request` that resolves,
 *     refuses the request if any address is private or reserved, and connects only to a checked
 *     address. Checking inside the lookup prevents DNS rebinding.
 */

/**
 * Every range a callback must never reach: loopback, RFC 1918, link-local (169.254 metadata and its
 * IPv6 equivalent), CGNAT (Alibaba Cloud metadata), unique-local, multicast, documentation and
 * reserved blocks.
 */
const blocked = new BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT - Alibaba Cloud metadata
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local - cloud metadata
blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blocked.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blocked.addSubnet('192.0.2.0', 24, 'ipv4'); // documentation (TEST-NET-1)
blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blocked.addSubnet('198.51.100.0', 24, 'ipv4'); // documentation (TEST-NET-2)
blocked.addSubnet('203.0.113.0', 24, 'ipv4'); // documentation (TEST-NET-3)
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. 255.255.255.255
// IPv6
blocked.addAddress('::', 'ipv6'); // unspecified
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique-local
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast
blocked.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocked.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 - carries embedded IPv4

/**
 * The IPv4 inside an IPv4-mapped or IPv4-compatible IPv6 address, or null.
 * `new URL('http://[::ffff:127.0.0.1]')` normalizes to `::ffff:7f00:1` (hex), so both forms are
 * handled.
 */
function embeddedIpv4(ip: string): string | null {
  const bare = stripBrackets(ip).toLowerCase();
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (dotted) return dotted[1] ?? null;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? '0', 16);
    const low = Number.parseInt(hex[2] ?? '0', 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

/** The host without IPv6 brackets or zone id. */
function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '';
}

/**
 * Whether a callback must never reach this IP. Fails closed: anything not provably public is
 * blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = stripBrackets(ip);

  const mapped = embeddedIpv4(bare);
  if (mapped !== null) {
    return isIP(mapped) === 4 ? blocked.check(mapped, 'ipv4') : true;
  }

  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) return blocked.check(bare, 'ipv6');
  return true;
}

/**
 * A `dns.lookup` replacement for `http.request({ lookup })`: resolves the name, refuses if any
 * address is private or reserved, and passes only checked addresses to the connection. No window
 * between check and connect.
 *
 * Never called for IP literals (DNS is skipped), which is why literals are checked separately.
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  const opts = (typeof options === 'object' && options !== null ? options : {}) as {
    all?: boolean;
    family?: number;
    hints?: number;
    verbatim?: boolean;
  };
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;

  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      cb(err, '', 0);
      return;
    }
    const resolved = addresses as unknown as LookupAddress[];
    const offending = resolved.find((entry) => isBlockedAddress(entry.address));
    if (offending !== undefined) {
      const refusal: NodeJS.ErrnoException = new Error(
        `refusing to connect to ${hostname}: it resolves to ${offending.address}, a private or reserved address`,
      );
      refusal.code = 'ESSRFBLOCKED';
      cb(refusal, '', 0);
      return;
    }
    const first = resolved[0];
    if (first === undefined) {
      const empty: NodeJS.ErrnoException = new Error(`no address for ${hostname}`);
      empty.code = 'ENOTFOUND';
      cb(empty, '', 0);
      return;
    }
    if (opts.all) {
      cb(null, resolved);
    } else {
      cb(null, first.address, first.family);
    }
  });
};

export interface SafePostResult {
  status: number;
  statusText: string;
}

export interface SafePostOptions {
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** `CALLBACK_ALLOW_PRIVATE_URLS`: skip the checks to deliver to a local receiver in development. */
  allowPrivate: boolean;
}

/**
 * POST to a customer URL safely:
 *   - redirects are not followed, so a `302 -> 169.254.169.254` is recorded as a 302;
 *   - an IP literal host is checked before connecting (DNS is skipped for it);
 *   - a named host is resolved and pinned by `pinnedLookup`.
 *
 * The response body is drained and ignored: only the status matters.
 */
export function safePost(target: string, options: SafePostOptions): Promise<SafePostResult> {
  const url = new URL(target);

  if (!options.allowPrivate) {
    const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isIP(host) !== 0 && isBlockedAddress(host)) {
      const refusal: NodeJS.ErrnoException = new Error(
        `refusing to connect to ${url.hostname}: a private or reserved address`,
      );
      refusal.code = 'ESSRFBLOCKED';
      return Promise.reject(refusal);
    }
  }

  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<SafePostResult>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...options.headers, 'content-length': Buffer.byteLength(options.body).toString() },
        ...(options.allowPrivate ? {} : { lookup: pinnedLookup }),
      },
      (res) => {
        const result: SafePostResult = { status: res.statusCode ?? 0, statusText: res.statusMessage ?? '' };
        // Drain and discard.
        res.resume();
        res.on('end', () => resolve(result));
        res.on('close', () => resolve(result));
        res.on('error', () => resolve(result));
      },
    );

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error('callback request timed out'));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
