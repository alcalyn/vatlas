import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCountry } from '../src/api/countries/registry.js';
import { BulkSource, type BulkArtefact, type Counters, type ImportContext } from '../src/api/sources/types.js';
import { checkLocalFiles, checkWindow, parseDate, parseFiles } from '../src/cli/importOptions.js';

/**
 * Importing a file the publisher no longer offers: `--file <slot>=<path> --date <day>`.
 *
 * Nothing is downloaded for a given slot, and every row is filed under the given day.
 */

const exists = () => true;

describe('--file', () => {
  it('reads <slot>=<path> in both flag forms and keeps them apart by slot', () => {
    const files = parseFiles(['--file', 'a.parquet=/dumps/one', '--file=b.parquet=/dumps/two'], exists);
    expect([...files]).toEqual([
      ['a.parquet', '/dumps/one'],
      ['b.parquet', '/dumps/two'],
    ]);
  });

  it('refuses a value that names no slot', () => {
    expect(() => parseFiles(['--file', '/dumps/one'], exists)).toThrow('<slot>=<path>');
  });

  it('refuses the same slot twice, which would silently keep only one of the two files', () => {
    expect(() => parseFiles(['--file', 'a=/one', '--file', 'a=/two'], exists)).toThrow('given twice');
  });

  it('refuses a file that is not there, before anything is imported', () => {
    expect(() => parseFiles(['--file', 'a=/dumps/gone'], () => false)).toThrow('no such file');
  });
});

describe('--date', () => {
  it('reads a YYYY-MM-DD day as UTC', () => {
    expect(parseDate(['--date', '2025-03-01'])!.toISOString()).toBe('2025-03-01T00:00:00.000Z');
  });

  it('takes no other shape, since 01/03/2025 means two different days', () => {
    expect(() => parseDate(['--date', '01/03/2025'])).toThrow('YYYY-MM-DD');
  });

  it('is absent by default, which leaves the file to date itself', () => {
    expect(parseDate(['--limit', '10'])).toBeNull();
  });
});

describe('the two ways of asking for older editions', () => {
  const window = {
    limit: null,
    historyMonths: null,
    maxEditions: null,
    localFiles: null,
    dumpDate: null,
    sinceDate: null,
  };

  it('refuses a run given both, rather than deciding which end of the list wins', () => {
    expect(() => checkWindow({ ...window, historyMonths: 4, sinceDate: new Date('2024-09-01T00:00:00Z') })).toThrow(
      '--since-date and --history',
    );
  });

  it('takes either one on its own, with or without the cap', () => {
    expect(() => checkWindow({ ...window, historyMonths: 4, maxEditions: 6 })).not.toThrow();
    expect(() => checkWindow({ ...window, sinceDate: new Date('2024-09-01T00:00:00Z'), maxEditions: 1 })).not.toThrow();
  });
});

describe('what a local import refuses before reading anything', () => {
  const options = {
    limit: null,
    historyMonths: null,
    maxEditions: null,
    localFiles: new Map([['fr_stock_unite_legale.parquet', '/dumps/old.parquet']]),
    dumpDate: new Date('2025-03-01T00:00:00Z'),
    sinceDate: null,
  };
  const france = [getCountry('FR')!];

  it("accepts a slot the country's source declares", () => {
    expect(() => checkLocalFiles(options, 'fr', france)).not.toThrow();
  });

  it('needs --date, a file on disk having no edition date of its own', () => {
    expect(() => checkLocalFiles({ ...options, dumpDate: null }, 'fr', france)).toThrow('--date');
  });

  it('takes one country and not `all`', () => {
    expect(() => checkLocalFiles(options, 'all', france)).toThrow('one country');
  });

  it('does not mix with the history flags, there being one edition to read', () => {
    expect(() => checkLocalFiles({ ...options, historyMonths: 4 }, 'fr', france)).toThrow('--history');
    expect(() => checkLocalFiles({ ...options, sinceDate: new Date('2025-03-01T00:00:00Z') }, 'fr', france)).toThrow(
      '--since-date',
    );
  });

  it('names the slots it knows when given one it does not', () => {
    const wrong = { ...options, localFiles: new Map([['stock.parquet', '/dumps/old.parquet']]) };
    expect(() => checkLocalFiles(wrong, 'fr', france)).toThrow('fr_stock_unite_legale.parquet');
  });

  it('says so for a register that reads no file at all, rather than accepting a flag that would do nothing', () => {
    expect(() => checkLocalFiles(options, 'dk', [getCountry('DK')!])).toThrow('cannot be replayed from disk');
  });
});

/** A source with one slot, like RIK, PRH and the other single-file registers. */
class StubSource extends BulkSource {
  readonly id = 'STUB';
  readonly name = 'a register with one file';
  readonly countryCode = 'XX';
  override readonly slots = ['stub.csv'];
  declared: BulkArtefact | null = null;
  path = '';

  protected override async editions(): Promise<BulkArtefact[]> {
    throw new Error('the publisher must not be asked anything for a local import');
  }

  protected override async run(context: ImportContext, counters: Counters): Promise<void> {
    const file = await this.download(context, 'https://example.test/stub.csv', 'stub.csv');
    this.path = file.path;
    this.declared = this.artefactOf(context, 'stub.csv', {
      url: 'https://example.test/stub.csv',
      fileName: 'stub.csv',
      date: file.lastModified,
    });
    await context.useArtefact(this.declared);
    counters.fetched = 1;
  }
}

const contextFor = (localFiles: Map<string, string> | null, dumpDate: Date | null): ImportContext =>
  ({
    logger: { info: () => {}, warn: () => {} },
    options: { limit: null, historyMonths: null, maxEditions: null, localFiles, dumpDate, sinceDate: null },
    useArtefact: async () => {},
    save: async () => ({ inserted: 0, updated: 0 }),
    alreadyImported: async () => false,
    markImported: async () => {},
  }) as unknown as ImportContext;

describe('a source handed a local file', () => {
  const dumpDate = new Date('2025-03-01T00:00:00Z');

  const dump = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'dump-'));
    const path = join(dir, 'stock_2025_03.csv');
    await writeFile(path, 'a,b\n1,2\n');
    return path;
  };

  it('reads the file from disk and never asks the publisher for an edition list', async () => {
    const path = await dump();
    const source = new StubSource();

    await source.import(contextFor(new Map([['stub.csv', path]]), dumpDate));

    expect(source.path).toBe(path);
  });

  it("records the artefact under the file's own name and the day that was given", async () => {
    const path = await dump();
    const source = new StubSource();

    await source.import(contextFor(new Map([['stub.csv', path]]), dumpDate));

    expect(source.declared!.fileName).toBe(basename(path));
    expect(source.declared!.date.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    // A local path, so the row says where the bytes came from.
    expect(source.declared!.url).toContain('file://');
  });
});
