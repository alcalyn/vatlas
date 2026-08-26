import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { readColumn } from '../src/lib/csv.js';
import { streamParquet, toText } from '../src/lib/parquet.js';

/**
 * `streamParquet` must return rows in file order, every value as the CSV would write it, and ignore
 * a column the publisher renamed.
 */
describe('streamParquet', () => {
  let directory = '';
  let path = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vatlas-parquet-'));
    path = join(directory, 'sample.parquet');

    const buffer = parquetWriteBuffer({
      columnData: [
        { name: 'siren', data: ['000325175', '884831538', '923000201', '999999999'], type: 'STRING' },
        { name: 'siege', data: [true, false, true, false], type: 'BOOLEAN' },
        { name: 'categorie', data: [1000n, 5499n, 5710n, null], type: 'INT64', nullable: true },
        {
          name: 'traite',
          data: [
            new Date('2026-01-05T10:00:00Z'),
            new Date('2026-01-05T10:00:00Z'),
            new Date('2026-02-28T23:59:59Z'),
            new Date('2026-02-28T23:59:59Z'),
          ],
          type: 'TIMESTAMP',
        },
        { name: 'inutilise', data: ['a', 'b', 'c', 'd'], type: 'STRING' },
      ],
      // Two row groups, so the walk over `metadata.row_groups` is exercised.
      rowGroupSize: 2,
    });
    await writeFile(path, Buffer.from(buffer));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('yields every row in file order, across row groups', async () => {
    const sirens: string[] = [];
    for await (const row of streamParquet(path)) sirens.push(row.siren ?? '');
    expect(sirens).toEqual(['000325175', '884831538', '923000201', '999999999']);
  });

  it('renders typed values as the text the CSV edition holds', async () => {
    const rows = [];
    for await (const row of streamParquet(path)) rows.push(row);

    expect(rows[0]).toMatchObject({
      siren: '000325175',
      siege: 'true',
      categorie: '1000',
      traite: '2026-01-05T10:00:00',
    });
    expect(rows[1]?.siege).toBe('false');
    expect(rows[2]?.traite).toBe('2026-02-28T23:59:59');
    // A null reads as blank, which `readColumn` turns back into null.
    expect(readColumn(rows[3] ?? {}, ['categorie'])).toBeNull();
  });

  it('reads only the projected columns, and ignores one the file does not have', async () => {
    const rows = [];
    for await (const row of streamParquet(path, { columns: ['siren', 'siege', 'disparue'] })) {
      rows.push(row);
    }

    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['siege', 'siren']);
    expect(readColumn(rows[0] ?? {}, ['disparue'])).toBeNull();
    expect(rows).toHaveLength(4);
  });
});

describe('toText', () => {
  it('renders each Parquet type the way a CSV would carry it', () => {
    expect(toText(null)).toBe('');
    expect(toText(undefined)).toBe('');
    expect(toText('PARIS')).toBe('PARIS');
    expect(toText(true)).toBe('true');
    expect(toText(false)).toBe('false');
    expect(toText(5710n)).toBe('5710');
    expect(toText(75002)).toBe('75002');
    // Published without zone and stored that way: rendering it back loses nothing.
    expect(toText(new Date('2026-01-05T10:00:00Z'))).toBe('2026-01-05T10:00:00');
    expect(toText(new Date('nope'))).toBe('');
    expect(toText(new TextEncoder().encode('SARL'))).toBe('SARL');
  });
});
