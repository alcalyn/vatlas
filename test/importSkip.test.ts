import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkArtefact, ImportContext } from '../src/api/sources/types.js';

/**
 * What an already imported edition costs when the cache is empty.
 *
 * `DOWNLOAD_DIR` is disposable: a deleted file must not be downloaded again just to learn it was
 * already imported. The `bulk` row is checked before downloading.
 */

const BODY = 'PK pretend this is a register';
const LAST_MODIFIED = 'Fri, 14 Aug 2026 00:00:00 GMT';

interface Portal {
  server: Server;
  url: string;
  gets: number;
  heads: number;
  /** A publisher with no dates: the fallback. */
  dates: boolean;
}

async function startPortal(): Promise<Portal> {
  const state = { gets: 0, heads: 0, dates: true };

  const server = createServer((request, response) => {
    const head = request.method === 'HEAD';
    state[head ? 'heads' : 'gets'] += 1;
    response.writeHead(200, {
      'content-length': String(Buffer.byteLength(BODY)),
      ...(state.dates ? { 'last-modified': LAST_MODIFIED } : {}),
    });
    response.end(head ? undefined : BODY);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('the portal did not get a port');

  return Object.assign(state, { server, url: `http://127.0.0.1:${address.port}` });
}

let portal: Portal;
let types: typeof import('../src/api/sources/types.js');

const SLOT = 'stub_register.zip';

/** A source without archive, dated by the server (PRH, RIK, INSEE, URVID). */
function sourceFor(types: typeof import('../src/api/sources/types.js'), url: string) {
  class StubSource extends types.BulkSource {
    readonly id = 'STUB';
    readonly name = 'A register that overwrites one slot in place';
    readonly countryCode = 'XX';
    override readonly slots = [SLOT];
    /** Set once the bytes are read, which must not happen twice. */
    read = false;

    protected async run(context: ImportContext, counters: types.Counters): Promise<void> {
      await this.fetchArtefact(context, SLOT, { url, fileName: 'register.zip' });
      this.read = true;
      counters.fetched = 1;
    }
  }
  return new StubSource();
}

/** The context the CLI builds, over a `bulk` table with the editions already read. */
const contextOver = (imported: { fileName: string; date: string }[] = []) => {
  const done = new Set(imported.map((row) => `${row.fileName}@${row.date}`));
  const key = (artefact: BulkArtefact) => `${artefact.fileName}@${artefact.date.toISOString().slice(0, 10)}`;
  const declared: BulkArtefact[] = [];
  const context = {
    logger: { info: () => {}, warn: () => {} },
    options: { limit: null, historyMonths: null, maxEditions: null, localFiles: null, dumpDate: null, sinceDate: null },
    useArtefact: async (artefact: BulkArtefact) => {
      if (declared.length === 0 && done.has(key(artefact))) {
        throw new types.ArtefactAlreadyImportedError(`${artefact.fileName} has already been imported in full`);
      }
      declared.push(artefact);
    },
    save: async () => ({ inserted: 0, updated: 0 }),
    alreadyImported: async (artefact: BulkArtefact) => done.has(key(artefact)),
    alreadyImportedUrl: async () => false,
    markImported: async () => {},
  } as unknown as ImportContext;
  return { context, declared };
};

beforeEach(async () => {
  portal = await startPortal();
  vi.stubEnv('DOWNLOAD_DIR', await mkdtemp(join(tmpdir(), 'vatlas-cache-')));
  // `config` is parsed once at import, and the cache directory comes from it.
  vi.resetModules();
  types = await import('../src/api/sources/types.js');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => portal.server.close(() => resolve()));
});

describe('a slot the publisher overwrites in place, with nothing in the cache', () => {
  it('costs a HEAD and no transfer when the edition has already been imported', async () => {
    const source = sourceFor(types, `${portal.url}/register.zip`);
    const { context } = contextOver([{ fileName: 'register.zip', date: '2026-08-14' }]);

    const result = await source.import(context);

    expect(portal.gets).toBe(0);
    expect(portal.heads).toBe(1);
    expect(source.read).toBe(false);
    expect(result.notImportedReason).toContain('already been imported');
  });

  it('downloads it when it is an edition nobody has read, and files it under the server’s date', async () => {
    const source = sourceFor(types, `${portal.url}/register.zip`);
    const { context, declared } = contextOver([{ fileName: 'register.zip', date: '2026-07-14' }]);

    const result = await source.import(context);

    expect(portal.gets).toBe(1);
    expect(result.fetched).toBe(1);
    expect(declared.map((artefact) => artefact.date.toISOString())).toEqual([new Date(LAST_MODIFIED).toISOString()]);
  });

  it('falls back to naming the artefact after the download when the server dates nothing', async () => {
    portal.dates = false;
    const source = sourceFor(types, `${portal.url}/register.zip`);
    const { context, declared } = contextOver();

    await source.import(context);

    // No date available beforehand, so the file is downloaded and declared afterwards.
    expect(portal.gets).toBe(1);
    expect(declared).toHaveLength(1);
  });
});

describe('the Japanese register, whose edition is written only inside the archive', () => {
  const page = `<a href="#" onclick="return doDownload('5075','2','01');">全件</a>`;

  it('refuses the edition on the URL alone, before any of the twelve files is fetched', async () => {
    const { invoiceRegistryBulk } = await import('../src/api/sources/bulk/jp-invoice.js');
    const { context } = contextOver();
    // The management number in the URL changes every edition, so this gives the same answer as
    // `isBulkImported` without downloading.
    const asked: string[] = [];
    const jp = {
      ...context,
      alreadyImportedUrl: async (url: string) => {
        asked.push(url);
        return true;
      },
    } as unknown as ImportContext;
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(page, { status: 200 }));

    const result = await invoiceRegistryBulk.import(jp);

    expect(result.notImportedReason).toContain('already been imported');
    expect(asked).toEqual([
      'https://www.invoice-kohyo.nta.go.jp/download/zenken/dlfile?dlFilKanriNo=5075&jinkakukbn=2&type=01',
    ]);
    // Only the download page was requested, no archive.
    expect(fetched).toHaveBeenCalledTimes(1);
    fetched.mockRestore();
  });
});
