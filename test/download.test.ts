import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../src/lib/logger.js';

/**
 * The download cache. A Belgian history run is 31 dailies, each named after its date, so a file
 * already on disk must never be downloaded again.
 *
 * The two cases of the single rule: a file that never changes, and the slot INSEE overwrites every
 * month under the same name.
 */

const BODY = 'PK pretend this is 312 MB of Belgian register';
const NEXT_EDITION = `${BODY}, one month later, same length!`.slice(0, BODY.length);

interface Portal {
  server: Server;
  url: string;
  gets: number;
  heads: number;
  /** What the slot holds now. Republishing changes both. */
  body: string;
  etag: string;
}

async function startPortal(): Promise<Portal> {
  const state = { gets: 0, heads: 0, body: BODY, etag: '"v1"' };

  const server = createServer((request, response) => {
    const head = request.method === 'HEAD';
    state[head ? 'heads' : 'gets'] += 1;

    if (!head && request.headers['if-none-match'] === state.etag) {
      response.writeHead(304).end();
      return;
    }
    response.writeHead(200, {
      'content-length': String(Buffer.byteLength(state.body)),
      etag: state.etag,
      'last-modified': 'Fri, 14 Aug 2026 00:00:00 GMT',
    });
    response.end(head ? undefined : state.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('the portal did not get a port');

  return Object.assign(state, { server, url: `http://127.0.0.1:${address.port}` });
}

let portal: Portal;
let downloadFile: typeof import('../src/lib/download.js').downloadFile;

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as AppLogger;

beforeEach(async () => {
  portal = await startPortal();
  vi.stubEnv('DOWNLOAD_DIR', await mkdtemp(join(tmpdir(), 'vatlas-cache-')));
  // `config` is parsed once at import, and the cache directory comes from it.
  vi.resetModules();
  ({ downloadFile } = await import('../src/lib/download.js'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => portal.server.close(() => resolve()));
});

describe('an edition named after the day it holds, as Belgium publishes them', () => {
  const edition = () => downloadFile(`${portal.url}/KboOpenData_0451_2026_08_14_Full.zip`, 'be_kbo_0451.zip', quiet);

  it('is not transferred again once it is in the cache', async () => {
    await edition();
    const again = await edition();

    expect(portal.gets).toBe(1);
    expect(again.fromCache).toBe(true);
    expect(again.bytes).toBe(Buffer.byteLength(BODY));
  });

  it('keeps its date across the reuse, because the edition is dated by the file it came from', async () => {
    const first = await edition();
    expect((await edition()).lastModified).toEqual(first.lastModified);
  });

  it('is fetched again when the copy on disk is not the length the portal says', async () => {
    // What an interrupted download leaves: a partial file.
    const { path } = await edition();
    await writeFile(path, 'PK truncated');

    const again = await edition();

    expect(portal.gets).toBe(2);
    expect(again.fromCache).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(BODY);
  });

  it('is reused even when it was downloaded before the sidecar recorded anything useful', async () => {
    const { path } = await edition();
    await writeFile(`${path}.validators.json`, JSON.stringify({ etag: null, lastModified: null }), 'utf8');

    expect((await edition()).fromCache).toBe(true);
    expect(portal.gets).toBe(1);
  });
});

describe('a single slot overwritten in place, as every other publisher offers', () => {
  const slot = (url = `${portal.url}/StockUniteLegale_utf8.zip`) =>
    downloadFile(url, 'fr_stock_unite_legale.zip', quiet);

  it('reuses the copy on disk for as long as the publisher has not touched it', async () => {
    await slot();
    const again = await slot();

    expect(portal.gets).toBe(1);
    expect(again.fromCache).toBe(true);
  });

  it('downloads again the day the slot is republished, same name and same length or not', async () => {
    const { path } = await slot();
    portal.body = NEXT_EDITION;
    portal.etag = '"v2"';

    const next = await slot();

    expect(next.fromCache).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(NEXT_EDITION);
  });

  it('does not take the previous edition for the new one when the publisher moves the URL', async () => {
    // INSEE uses a new path every month for the same cache slot: the cached copy is last month's.
    await slot(`${portal.url}/2026-08-stock.zip`);
    const next = await slot(`${portal.url}/2026-09-stock.zip`);

    expect(next.fromCache).toBe(false);
    expect((await stat(next.path)).size).toBe(Buffer.byteLength(BODY));
  });

  it('falls back to a conditional GET when the server answers no useful HEAD', async () => {
    const { path } = await slot();
    // A portal that refuses HEAD: the 304 decides.
    const { port } = portal.server.address() as { port: number };
    portal.server.close();
    const strict = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      portal.gets += 1;
      if (request.headers['if-none-match'] === '"v1"') response.writeHead(304).end();
      else response.writeHead(200, { etag: '"v1"' }).end(BODY);
    });
    await new Promise<void>((resolve) => strict.listen(port, '127.0.0.1', resolve));
    portal.server = strict;

    const again = await slot();

    expect(again.fromCache).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(BODY);
  });
});
