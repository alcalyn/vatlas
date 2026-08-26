import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { get as httpGet, request as httpRequest, type IncomingMessage } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { delay } from './http.js';
import { projectRoot } from './paths.js';
import type { AppLogger } from './logger.js';

/** A download the server refused, with its status, so callers can tell a 429 from a 403. */
export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    statusMessage?: string,
  ) {
    super(`Download failed for ${url}: HTTP ${status} ${statusMessage ?? ''}`.trimEnd());
    this.name = 'HttpStatusError';
  }
}

/**
 * Request spacing for a publisher that limits requests rather than bytes.
 *
 * PRH allows about one request per minute per IP, HEAD included. Probing then downloading makes
 * two requests, so the download was always refused. Spacing them fixes it, and retrying covers the
 * rest.
 */
export interface RequestThrottle {
  /** Minimum delay between two requests to this host, HEAD and GET alike. */
  minIntervalMs: number;
  /** Wait after a 429 before retrying. */
  pauseMs: number;
  /** Total wait allowed for one request, after which the 429 is raised. */
  budgetMs: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  throttle?: RequestThrottle;
  logger?: AppLogger;
}

/**
 * When each throttled host was last called. Module-level, since the server counts the probe and the
 * download as one stream.
 */
const lastRequestAt = new Map<string, number>();

/** Waits for the host's quiet period, and records the request about to be made. */
async function space(url: string, throttle: RequestThrottle | undefined, logger?: AppLogger): Promise<void> {
  if (!throttle) return;
  const host = new URL(url).hostname;
  const last = lastRequestAt.get(host);
  const wait = last === undefined ? 0 : last + throttle.minIntervalMs - Date.now();
  if (wait > 0) {
    logger?.info({ host, waitMs: wait }, 'holding off: this publisher counts requests, not bytes');
    await delay(wait);
  }
  lastRequestAt.set(host, Date.now());
}

/** One request, spaced and retried. A 429 past the budget is returned for the caller to handle. */
async function throttledRequest(
  url: string,
  headers: Record<string, string>,
  method: 'GET' | 'HEAD',
  options: RequestOptions,
): Promise<IncomingMessage> {
  const { throttle, logger } = options;
  for (let waited = 0; ; waited += throttle?.pauseMs ?? 0) {
    await space(url, throttle, logger);
    const response = await requestStream(url, headers, 5, method);
    if (response.statusCode !== 429 || !throttle) return response;

    response.resume();
    if (waited + throttle.pauseMs > throttle.budgetMs) return response;
    logger?.warn(
      { url, method, waitedMs: waited, budgetMs: throttle.budgetMs },
      'the publisher answered 429, waiting before asking again',
    );
    await delay(throttle.pauseMs);
  }
}

export interface DownloadResult {
  path: string;
  /** True when nothing was downloaded and the cached copy was used. */
  fromCache: boolean;
  bytes: number;
  /**
   * The server's `Last-Modified`: the publication date of this edition. Kept in the sidecar so it
   * survives a reuse. Null when the server sends none.
   */
  lastModified: Date | null;
}

/**
 * Stored next to a downloaded file as `<file>.validators.json`: what the server said about it, to
 * recognise the same file later.
 *
 * `url` was added later, so older sidecars lack it. It is only compared when present.
 */
interface Validators {
  url?: string;
  etag: string | null;
  lastModified: string | null;
}

/** A missing or invalid header date is no date, never today. */
function parseHttpDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cacheDir(): string {
  return isAbsolute(config.downloadDir) ? config.downloadDir : join(projectRoot, config.downloadDir);
}

/**
 * Downloads a bulk file into `DOWNLOAD_DIR`, once.
 *
 * The cached copy is used when it is the file the server holds. A HEAD returns length, `ETag` and
 * `Last-Modified`, compared with the sidecar and the actual file size.
 *
 * - Belgium names each daily after its date, so a cached edition always matches.
 * - INSEE, PRH, RIK and URVID overwrite the same file, so it is downloaded again when they
 *   republish.
 *
 * When HEAD is not usable, a conditional GET is used: a 304 if unchanged, the transfer otherwise.
 */
export async function downloadFile(
  url: string,
  fileName: string,
  logger: AppLogger,
  options: RequestOptions = {},
): Promise<DownloadResult> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });

  const destination = join(dir, fileName);
  const validatorPath = `${destination}.validators.json`;
  const headers = { ...options.headers };

  const validators = await readValidators(validatorPath, destination, url);

  const cached = await cachedCopy(url, destination, validatorPath, validators, headers, {
    ...options,
    logger,
  });
  if (cached !== 'stale') {
    if (cached) return cached;
    // Only a copy not already ruled out may be validated by a 304.
    if (validators?.etag) headers['if-none-match'] = validators.etag;
    if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;
  }

  logger.info({ url, destination }, 'downloading bulk file');
  const response = await throttledRequest(url, headers, 'GET', { ...options, logger });

  if (response.statusCode === 304) {
    response.resume();
    const { size } = await stat(destination);
    logger.info({ url }, 'bulk file unchanged, reusing the cached copy');
    return {
      path: destination,
      fromCache: true,
      bytes: size,
      lastModified: parseHttpDate(validators?.lastModified ?? null),
    };
  }
  if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new HttpStatusError(url, response.statusCode, response.statusMessage);
  }

  await pipeline(response, createWriteStream(destination));

  const lastModified = header(response, 'last-modified');
  const { size } = await stat(destination);
  await writeValidators(validatorPath, { url, etag: header(response, 'etag'), lastModified });

  logger.info({ url, bytes: size }, 'bulk file downloaded');
  return { path: destination, fromCache: false, bytes: size, lastModified: parseHttpDate(lastModified) };
}

/**
 * The cached copy, when it is the file the server offers. `null` when there is nothing to compare
 * (no copy, or no usable HEAD), and `'stale'` when the copy is not the file, which a conditional
 * request must then not accept.
 *
 * Not the file when: the length differs (also catches interrupted downloads), the slot holds a
 * different URL, or the `ETag` / `Last-Modified` changed.
 */
async function cachedCopy(
  url: string,
  destination: string,
  validatorPath: string,
  validators: Validators | null,
  headers: Record<string, string>,
  options: RequestOptions & { logger: AppLogger },
): Promise<DownloadResult | 'stale' | null> {
  const { logger } = options;
  let size: number;
  try {
    ({ size } = await stat(destination));
  } catch {
    return null;
  }
  // The slot holds a different file (INSEE changed the URL).
  if (await isForeign(validatorPath, url)) return 'stale';

  const remote = await head(url, headers, options);
  if (!remote) return null;
  if (remote.bytes !== size) return 'stale';

  if (changed(validators?.etag, remote.etag) || changed(validators?.lastModified, remote.lastModified)) {
    logger.info({ url, path: destination }, 'the publisher has republished this file, downloading it again');
    return 'stale';
  }

  // Rewritten so old sidecars get a URL, and the date survives if the server stops sending it.
  await writeValidators(validatorPath, {
    url,
    etag: remote.etag ?? validators?.etag ?? null,
    lastModified: remote.lastModified ?? validators?.lastModified ?? null,
  });

  logger.info({ url, path: destination, bytes: size }, 'bulk file already in cache, not downloading');
  return {
    path: destination,
    fromCache: true,
    bytes: size,
    lastModified: parseHttpDate(remote.lastModified ?? validators?.lastModified ?? null),
  };
}

/** Two validators only disagree when both are present. */
function changed(cached: string | null | undefined, remote: string | null): boolean {
  return Boolean(cached && remote && cached !== remote);
}

/**
 * The edition date the server holds, without downloading.
 *
 * Sources that must declare their file first (files overwritten in place, dated only by
 * `Last-Modified`) ask this, so an edition already imported costs a HEAD. `DOWNLOAD_DIR` can
 * therefore be emptied at any time.
 *
 * Null when HEAD is unusable or undated. The caller then downloads and declares afterwards.
 */
export async function probePublished(url: string, options: RequestOptions = {}): Promise<Date | null> {
  const remote = await head(url, { ...options.headers }, options);
  return parseHttpDate(remote?.lastModified ?? null);
}

/** What a HEAD says about the file, or null when unusable. */
async function head(
  url: string,
  headers: Record<string, string>,
  options: RequestOptions = {},
): Promise<{ bytes: number; etag: string | null; lastModified: string | null } | null> {
  try {
    const response = await throttledRequest(url, headers, 'HEAD', options);
    response.resume();
    if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) return null;

    const length = Number(header(response, 'content-length'));
    if (!Number.isInteger(length) || length <= 0) return null;
    return { bytes: length, etag: header(response, 'etag'), lastModified: header(response, 'last-modified') };
  } catch {
    return null;
  }
}

async function writeValidators(validatorPath: string, validators: Validators): Promise<void> {
  await writeFile(validatorPath, JSON.stringify(validators), 'utf8');
}

/** A response header as a string: Node returns arrays for repeatable headers. */
function header(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * GET a URL and return the response stream, following redirects.
 *
 * Uses the core HTTP client rather than `fetch`: undici crashes with an uncatchable assertion
 * (`Parser.finish`) when a large response ends with `Connection: close` while the consumer applies
 * backpressure.
 */
async function requestStream(
  url: string,
  headers: Record<string, string>,
  redirectsLeft = 5,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<IncomingMessage> {
  const target = new URL(url);
  const secure = target.protocol !== 'http:';
  const send = method === 'HEAD' ? (secure ? httpsRequest : httpRequest) : secure ? httpsGet : httpGet;

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = send(target, { headers, method }, resolve);
    // Guards the handshake and headers only. A slow body is not a stall.
    request.setTimeout(60_000, () => request.destroy(new Error(`Timed out connecting to ${url}`)));
    request.on('error', reject);
    if (method === 'HEAD') request.end();
  });

  const location = header(response, 'location');
  const isRedirect = response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400;
  if (isRedirect && location) {
    response.resume();
    if (redirectsLeft === 0) throw new Error(`Too many redirects for ${url}`);
    return requestStream(new URL(location, target).toString(), headers, redirectsLeft - 1, method);
  }

  return response;
}

/** The sidecar, when its file still exists and it matches this URL. */
async function readValidators(validatorPath: string, destination: string, url: string): Promise<Validators | null> {
  try {
    await stat(destination);
    const raw = await readFile(validatorPath, 'utf8');
    const validators = JSON.parse(raw) as Validators;
    return validators.url !== undefined && validators.url !== url ? null : validators;
  } catch {
    return null;
  }
}

/**
 * True when the cached file came from a different URL in the same slot.
 *
 * Sources whose URL changes every release (INSEE) use a fixed cache name, so the copy is the
 * previous edition.
 */
async function isForeign(validatorPath: string, url: string): Promise<boolean> {
  try {
    const validators = JSON.parse(await readFile(validatorPath, 'utf8')) as Validators;
    return validators.url !== undefined && validators.url !== url;
  } catch {
    return false;
  }
}
