import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtefactAlreadyImportedError,
  BulkSource,
  EditionUnavailableError,
  selectEditions,
  type BulkArtefact,
  type Counters,
  type ImportContext,
} from '../src/api/sources/types.js';
import { discardDownload, isZipFile, listFullFiles } from '../src/api/sources/bulk/be-kbo.js';

/**
 * Which editions a run reads: the `--history` / `--max-files` / `--since-date` rule.
 *
 * `--history` bounds how far back, `--max-files` how many, and `--since-date` starts from the other
 * end and reverses `--max-files`.
 */

const artefact = (day: string) => ({
  url: `https://example.test/${day}.zip`,
  fileName: `${day}.zip`,
  date: new Date(`${day}T00:00:00Z`),
});

/** Monthly editions on the first of each month, like INSEE. */
const monthly = ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map(artefact);
const september = new Date('2026-09-05T10:00:00Z');

const names = (editions: { fileName: string }[]) => editions.map((edition) => edition.fileName.replace('.zip', ''));

describe('choosing the editions to import', () => {
  it('reads only the current one when neither flag is given', () => {
    expect(names(selectEditions(monthly, { historyMonths: null, maxEditions: null }, september))).toEqual([
      '2026-09-01',
    ]);
  });

  it('counts the current month as the first of the n', () => {
    // Four months in September is June to September, four files. "Today minus four months" would also
    // catch May.
    expect(names(selectEditions(monthly, { historyMonths: 4, maxEditions: null }, september))).toEqual([
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('hands them back oldest first, so a history is built in the order it happened', () => {
    const chosen = selectEditions(monthly, { historyMonths: 12, maxEditions: null }, september);
    expect(chosen[0]!.date.getTime()).toBeLessThan(chosen.at(-1)!.date.getTime());
  });

  it('keeps the newest when the cap bites, not the oldest', () => {
    expect(names(selectEditions(monthly, { historyMonths: 12, maxEditions: 2 }, september))).toEqual([
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('takes the n most recent when only the cap is given', () => {
    // A week of a daily register, no month arithmetic.
    expect(names(selectEditions(monthly, { historyMonths: null, maxEditions: 3 }, september))).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('crosses the turn of the year', () => {
    const editions = ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'].map(artefact);
    expect(
      names(selectEditions(editions, { historyMonths: 3, maxEditions: null }, new Date('2026-02-14T00:00:00Z'))),
    ).toEqual(['2025-12-01', '2026-01-01', '2026-02-01']);
  });

  it('is unbothered by a publisher that lists its files out of order', () => {
    const shuffled = [monthly[2]!, monthly[4]!, monthly[0]!, monthly[3]!, monthly[1]!];
    expect(names(selectEditions(shuffled, { historyMonths: null, maxEditions: null }, september))).toEqual([
      '2026-09-01',
    ]);
  });

  it('asks for nothing when the archive is empty', () => {
    expect(selectEditions([], { historyMonths: 6, maxEditions: 6 }, september)).toEqual([]);
  });

  it('walks forwards from the day given, oldest first', () => {
    expect(
      names(
        selectEditions(
          monthly,
          { historyMonths: null, maxEditions: null, sinceDate: new Date('2026-07-01T00:00:00Z') },
          september,
        ),
      ),
    ).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
  });

  it('keeps the oldest when the cap bites, which is how one old edition is named', () => {
    // One edition out of a long archive.
    expect(
      names(
        selectEditions(
          monthly,
          { historyMonths: null, maxEditions: 1, sinceDate: new Date('2026-06-01T00:00:00Z') },
          september,
        ),
      ),
    ).toEqual(['2026-06-01']);
  });

  it('takes an edition dated on the day itself, the bound being inclusive', () => {
    const chosen = selectEditions(
      monthly,
      { historyMonths: null, maxEditions: 2, sinceDate: new Date('2026-05-01T00:00:00Z') },
      september,
    );
    expect(names(chosen)).toEqual(['2026-05-01', '2026-06-01']);
  });

  it('reaches back further than the calendar window ever could', () => {
    // Two years back: `--history` would need 25 months and import them all.
    const years = ['2024-09-01', '2025-03-01', '2026-09-01'].map(artefact);
    expect(
      names(
        selectEditions(
          years,
          { historyMonths: null, maxEditions: 1, sinceDate: new Date('2024-01-01T00:00:00Z') },
          september,
        ),
      ),
    ).toEqual(['2024-09-01']);
  });

  it('chooses nothing when the archive stops before the day given', () => {
    expect(
      selectEditions(
        monthly,
        { historyMonths: null, maxEditions: null, sinceDate: new Date('2027-01-01T00:00:00Z') },
        september,
      ),
    ).toEqual([]);
  });

  it('reads a daily archive as days, which is what four months of Belgium is', () => {
    const daily = Array.from({ length: 30 }, (_, index) => artefact(`2026-09-${String(index + 1).padStart(2, '0')}`));
    const chosen = selectEditions(daily, { historyMonths: 4, maxEditions: 6 }, september);
    expect(names(chosen)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
  });
});

describe('the Belgian archive, which is the only one there is', () => {
  const page = `
    <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0462_2026_08_25_Full.zip">full</a>
    <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0462_2026_08_25_Update.zip">update</a>
    <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0464_2026_08_27_Full.zip">full</a>
    <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0463_2026_08_26_Full.zip">full</a>
  `;

  it('lists every full extract the portal keeps, oldest first, and no update file', () => {
    expect(listFullFiles(page).map((file) => file.name)).toEqual([
      'KboOpenData_0462_2026_08_25_Full.zip',
      'KboOpenData_0463_2026_08_26_Full.zip',
      'KboOpenData_0464_2026_08_27_Full.zip',
    ]);
  });

  it("dates each one from its own name, which is the portal's only statement of its edition", () => {
    expect(listFullFiles(page)[0]!.date.toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });
});

/**
 * What a history run does when the publisher refuses one edition.
 *
 * Belgium's case: 31 dailies take eleven hours and the portal session expires before. The editions
 * already imported must be kept.
 */
class StubArchiveSource extends BulkSource {
  readonly id = 'STUB';
  readonly name = 'a publisher that keeps an archive';
  readonly countryCode = 'XX';
  readonly read: string[] = [];

  constructor(
    private readonly offered: BulkArtefact[],
    /** How many editions succeed before one is refused. -1 refuses none. */
    private readonly refuseAfter: number,
  ) {
    super();
  }

  protected override async editions(): Promise<BulkArtefact[]> {
    return this.offered;
  }

  protected override async run(
    _context: ImportContext,
    counters: Counters,
    edition: BulkArtefact | null,
  ): Promise<void> {
    if (this.read.length === this.refuseAfter) {
      throw new EditionUnavailableError('the portal served its login page twice');
    }
    this.read.push(edition!.fileName);
    counters.fetched = 10;
    counters.inserted = 10;
  }
}

/** A context over a `bulk` table holding the editions already read. */
const contextOver = (imported: string[] = []): ImportContext => {
  const done = new Set(imported);
  return {
    logger: { info: () => {}, warn: () => {} },
    // No month bound, so the test does not depend on the calendar.
    options: { limit: null, historyMonths: null, maxEditions: 5 },
    useArtefact: async (artefact: BulkArtefact) => {
      // What the CLI does with this: stop the source.
      if (done.has(artefact.fileName)) {
        throw new ArtefactAlreadyImportedError(`${artefact.fileName} has already been imported in full`);
      }
    },
    save: async () => ({ inserted: 0, updated: 0 }),
    alreadyImported: async (artefact: BulkArtefact) => done.has(artefact.fileName),
    markImported: async () => {},
  } as unknown as ImportContext;
};

const stubContext = contextOver();

describe('an edition the publisher will not serve', () => {
  it('keeps the editions already imported and names why it stopped', async () => {
    const source = new StubArchiveSource(monthly, 2);
    const result = await source.import(stubContext);

    // Two editions read, three left, and the result says two.
    expect(source.read).toEqual(['2026-05-01.zip', '2026-06-01.zip']);
    expect(result.editions).toEqual(['2026-05-01.zip', '2026-06-01.zip']);
    expect(result.fetched).toBe(20);
    expect(result.stoppedReason).toContain('login page');
  });

  it('fails outright when the very first edition is refused, there being nothing to protect', async () => {
    const source = new StubArchiveSource(monthly, 0);
    await expect(source.import(stubContext)).rejects.toThrow('login page');
  });

  it('says nothing about stopping when every edition was read', async () => {
    const result = await new StubArchiveSource(monthly, -1).import(stubContext);
    expect(result.editions).toHaveLength(5);
    expect(result.stoppedReason).toBeUndefined();
  });
});

describe('an edition that has already been imported', () => {
  it('is passed over without being read, and named as skipped rather than as imported', async () => {
    const source = new StubArchiveSource(monthly, -1);
    const result = await source.import(contextOver(['2026-05-01.zip', '2026-06-01.zip']));

    // The file is never touched: no download, no passes.
    expect(source.read).toEqual(['2026-07-01.zip', '2026-08-01.zip', '2026-09-01.zip']);
    expect(result.editions).toEqual(['2026-07-01.zip', '2026-08-01.zip', '2026-09-01.zip']);
    expect(result.skippedEditions).toEqual(['2026-05-01.zip', '2026-06-01.zip']);
  });

  it('reports a run with nothing left to import as unnecessary, not as an import of nothing', async () => {
    const source = new StubArchiveSource(monthly, -1);
    const result = await source.import(contextOver(names(monthly).map((name) => `${name}.zip`)));

    expect(source.read).toEqual([]);
    expect(result.editions).toEqual([]);
    expect(result.notImportedReason).toContain('already been imported');
  });
});

/**
 * A publisher without archive (INSEE, PRH, RIK, URVID) only knows its file inside `run`, so it can
 * only be stopped there.
 */
class StubSlotSource extends BulkSource {
  readonly id = 'SLOT';
  readonly name = 'a publisher that overwrites one file in place';
  readonly countryCode = 'XX';
  rowsRead = 0;

  protected override async run(context: ImportContext, counters: Counters): Promise<void> {
    await context.useArtefact(artefact('2026-09-01'));
    // Everything after `useArtefact` is what the skip avoids.
    this.rowsRead = 30_000_000;
    counters.fetched = 10;
  }
}

describe('the current file of a publisher that keeps no archive', () => {
  it('is read when it has not been imported', async () => {
    const source = new StubSlotSource();
    const result = await source.import(contextOver());

    expect(source.rowsRead).toBe(30_000_000);
    expect(result.fetched).toBe(10);
  });

  it('stops at the artefact rather than reading it again, and the run is not a failure', async () => {
    const source = new StubSlotSource();
    const result = await source.import(contextOver(['2026-09-01.zip']));

    expect(source.rowsRead).toBe(0);
    expect(result.notImportedReason).toContain('already been imported');
  });
});

describe('telling the KBO zip from the KBO login page', () => {
  const scratch = async (name: string, bytes: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'kbo-'));
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  };

  it('accepts a file that starts with the zip magic bytes', async () => {
    expect(await isZipFile(await scratch('real.zip', 'PKrest of the archive'))).toBe(true);
  });

  it('rejects the login page the portal serves as HTTP 200 under the name of the zip', async () => {
    const page = await readFile(join(import.meta.dirname, 'fixtures', 'be_kbo_login_page.html'), 'utf8');
    expect(page).toContain('Bienvenue sur BCE-open-data');
    expect(await isZipFile(await scratch('KboOpenData_Full.zip', page))).toBe(false);
  });

  it('discards the validator sidecar along with the file, or the next run would get it from cache', async () => {
    const path = await scratch('KboOpenData_Full.zip', 'not a zip');
    await writeFile(`${path}.validators.json`, '{"etag":"x","lastModified":null}');

    await discardDownload(path);

    await expect(stat(path)).rejects.toThrow();
    await expect(stat(`${path}.validators.json`)).rejects.toThrow();
  });
});
