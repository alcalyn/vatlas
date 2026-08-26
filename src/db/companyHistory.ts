import { createHash } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from './pool.js';
import { getPrisma } from './prisma.js';
import {
  asDay,
  type BulkArtefactRow,
  type CompanyRecord,
  type CompanyStatement,
  type StatementInput,
  type StoredStatement,
} from '../api/types.js';
import { clamp } from '../lib/text.js';
import type { Bulk, Company } from '../generated/prisma/client.js';

/**
 * `company` is a history of plateaus: one row per period during which a source said exactly the
 * same thing, bounded by `date_start` and `date_end`.
 *
 * This file holds that rule: one decision ({@link placeStatement}) and one writer, used by both
 * the importer and the live path.
 *
 * Everything here uses the mysql2 pool rather than Prisma, so the rule has exactly one
 * implementation.
 */

/**
 * The data columns, in hash order: what the source said, not when or how.
 *
 * Not hashed: the dates (always different), `proof` (different on every call) and `bulk_id` (names
 * the file, not the fact). Hashing them would open a new plateau for every company on every import.
 *
 * `companyLastUpdatedAt` is not hashed either. It is when the register last touched the record, not
 * when the company changed:
 *
 * - INSEE reprocesses in bulk (one pass stamped 29.8% of `StockUniteLegale` with the same second).
 *   Hashing it would open millions of plateaus for unchanged companies.
 * - VIES has no such date.
 *
 * It is still stored and published as `meta.sourceUpdatedAt`, refreshed when a plateau is extended.
 *
 * The order and the separator are part of the stored hash. Changing either requires a full
 * re-import.
 */
const HASHED_FIELDS = [
  'status',
  'nationalId',
  'name',
  'legalForm',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'addressCountry',
] as const satisfies readonly (keyof CompanyRecord)[];

/** ASCII unit separator: never present in values, so field lists cannot collide. */
const SEPARATOR = '\u001f';

/**
 * Hash of what a source said.
 *
 * Truncated to 128 bits, as stored. Hashes are only compared between plateaus of one
 * `(vat_number, source)`, so this is more than enough.
 */
export function payloadHash(record: CompanyRecord): Buffer {
  // Every hashed field is a string or null.
  const parts = HASHED_FIELDS.map((field) => record[field] ?? '');
  return createHash('sha256').update(parts.join(SEPARATOR)).digest().subarray(0, 16);
}

/**
 * Width of every text column a statement writes.
 *
 * Registers do not respect column widths, and MySQL would refuse the row and fail the whole batch.
 * Values are truncated here with a visible ellipsis (`clamp()`).
 *
 * Applied before hashing, so a truncated row does not open a new plateau on every import.
 * `vatNumber`, `source` and `addressCountry` are not truncated: a value too long there is a mapping
 * bug and should fail.
 */
const COLUMN_WIDTHS = {
  nationalId: 32,
  name: 255,
  legalForm: 128,
  addressLine1: 512,
  addressLine2: 512,
  postalCode: 16,
  city: 128,
  proof: 255,
} as const satisfies Partial<Record<keyof StatementInput, number>>;

/** A statement with every text column truncated to its width. See {@link COLUMN_WIDTHS}. */
export function fitStatement(input: StatementInput): StatementInput {
  let fitted = input;
  for (const [field, width] of Object.entries(COLUMN_WIDTHS) as [keyof typeof COLUMN_WIDTHS, number][]) {
    const value = input[field];
    if (value === null || value.length <= width) continue;
    fitted = { ...fitted, [field]: clamp(value, width) };
  }
  return fitted;
}

/** The plateau a statement lands in or next to. */
export interface Plateau {
  dateStart: Date;
  dateEnd: Date;
  payloadHash: Buffer;
}

/**
 * What writing one statement does to the history.
 *
 * `replace` and `open` are the same SQL upsert, but counted separately.
 */
export type Placement =
  | { action: 'none' }
  | { action: 'extend'; dateStart: Date }
  | { action: 'merge'; dateStart: Date; dateEnd: Date; absorbed: Date }
  | { action: 'reopen'; from: Date; dateEnd: Date; truncateTo: Date | null }
  | { action: 'open' }
  | { action: 'replace' }
  | { action: 'split'; truncateTo: Date };

/** The previous day: where a split cuts the plateau it interrupts. */
function dayBefore(date: Date): Date {
  return new Date(date.getTime() - 86_400_000);
}

/**
 * Where a statement belongs in a history: the rule of this table, testable without a database.
 *
 * `before` is the plateau with the greatest `date_start` on or before the statement's day, `after`
 * the one with the smallest `date_start` after it.
 *
 * The rule works in both directions: a source that said X in June and X again in September was
 * saying X in between, whichever edition is imported first. Checking `after` too makes the history
 * independent of import order.
 *
 * Outcomes:
 *
 * - none - same thing, on a day the plateau already covers. Re-importing writes nothing.
 * - extend - same thing, later, with nothing agreeing after. 95 to 98% of an import.
 * - merge - same thing as both neighbours: the gap between them closes. `before` absorbs it and
 *   `after` is deleted, so the surviving row names the opening edition.
 * - reopen - same thing as `after` but not `before`: an older edition shows `after` started
 *   earlier. `after` moves its `date_start` back. `truncateTo` is set when the day also falls
 *   inside `before`, which is then cut short so they do not overlap.
 * - replace - something different, on the day the plateau opened (two live calls on one day that
 *   disagree). The later answer replaces the earlier one.
 * - open - something different, after the plateau ended, with nothing agreeing later. A change,
 *   somewhere in the gap.
 * - split - something different inside a plateau, with nothing agreeing later. Only happens when
 *   importing an older edition after a newer one. The plateau is cut at the previous day and a new
 *   one opens, so plateaus never overlap (MySQL cannot enforce that as a constraint).
 *
 * Two adjacent plateaus of one `(number, source)` never share a hash (`merge` and `reopen` ensure
 * it), so `none` and `merge` cannot both apply.
 */
export function placeStatement(
  before: Plateau | null,
  after: Plateau | null,
  incoming: { date: Date; payloadHash: Buffer },
): Placement {
  const joinsAfter = after !== null && after.payloadHash.equals(incoming.payloadHash);
  const reopen = (truncateTo: Date | null): Placement => ({
    action: 'reopen',
    from: after!.dateStart,
    dateEnd: after!.dateEnd,
    truncateTo,
  });

  if (!before) return joinsAfter ? reopen(null) : { action: 'open' };

  if (before.payloadHash.equals(incoming.payloadHash)) {
    if (incoming.date <= before.dateEnd) return { action: 'none' };
    return joinsAfter
      ? { action: 'merge', dateStart: before.dateStart, dateEnd: after!.dateEnd, absorbed: after!.dateStart }
      : { action: 'extend', dateStart: before.dateStart };
  }

  // A second, different answer on the day the plateau opened: the row is rewritten, even if `after`
  // agrees with the new statement. This only happens with two live calls on the same day, where
  // `before` is one day long.
  if (incoming.date.getTime() === before.dateStart.getTime()) return { action: 'replace' };

  const truncateTo = incoming.date <= before.dateEnd ? dayBefore(incoming.date) : null;
  if (joinsAfter) return reopen(truncateTo);
  return truncateTo ? { action: 'split', truncateTo } : { action: 'open' };
}

const DATA_COLUMNS = [
  'status',
  'national_id',
  'name',
  'legal_form',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'address_country',
  'company_last_updated_at',
  'bulk_id',
  'proof',
  'payload_hash',
] as const;

const INSERT_SQL = `
  INSERT INTO company (vat_number, source, date_start, date_end, ${DATA_COLUMNS.join(', ')})
  VALUES (?, ?, ?, ?, ${DATA_COLUMNS.map(() => '?').join(', ')})
  ON DUPLICATE KEY UPDATE date_end = VALUES(date_end),
    ${DATA_COLUMNS.map((column) => `${column} = VALUES(${column})`).join(', ')}
`;

/**
 * The two plateaus around a day, in one round trip.
 *
 * Two index seeks in one query: this runs once per record, so a second round trip would be
 * measurable. Rows may come back in any order, so the caller tells them apart by date.
 *
 * `company_last_updated_at` and `proof` are only read for `merge`: the survivor takes the absorbed
 * row's values.
 */
const NEIGHBOURS_SQL = `
  (SELECT date_start, date_end, payload_hash, company_last_updated_at, proof
     FROM company
    WHERE vat_number = ? AND source = ? AND date_start <= ?
    ORDER BY date_start DESC
    LIMIT 1)
  UNION ALL
  (SELECT date_start, date_end, payload_hash, company_last_updated_at, proof
     FROM company
    WHERE vat_number = ? AND source = ? AND date_start > ?
    ORDER BY date_start ASC
    LIMIT 1)
`;

/**
 * Extending a plateau moves its end and refreshes two unhashed columns:
 * `company_last_updated_at` (read as "as of `date_end`") and `proof` (a June proof on a plateau
 * ending in September would contradict its date).
 *
 * `bulk_id` is not refreshed: it names the file that opened the plateau.
 */
const EXTEND_SQL = `
  UPDATE company
     SET date_end = ?, company_last_updated_at = ?, proof = ?
   WHERE vat_number = ? AND source = ? AND date_start = ?
`;

/** Cutting a plateau short, on a split. */
const TRUNCATE_SQL = 'UPDATE company SET date_end = ? WHERE vat_number = ? AND source = ? AND date_start = ?';

/**
 * Moving a plateau's start back, on a `reopen`.
 *
 * `date_start` is part of the key, so this rewrites the clustered index entry. Acceptable here
 * since it only happens when importing older editions.
 *
 * `bulk_id` moves with it, since it names the opening edition. `proof` and
 * `company_last_updated_at` stay, since `date_end` did not move.
 */
const REOPEN_SQL = `
  UPDATE company
     SET date_start = ?, bulk_id = ?
   WHERE vat_number = ? AND source = ? AND date_start = ?
`;

/** Deleting the plateau a `merge` folded into its predecessor. */
const DELETE_SQL = 'DELETE FROM company WHERE vat_number = ? AND source = ? AND date_start = ?';

/** The resulting plateau and what the write was (the importer counts actions). */
export interface WriteResult {
  action: Placement['action'];
  dateStart: Date;
  dateEnd: Date;
}

/**
 * Writes one statement: read the two plateaus around it, decide, apply. One round trip in the
 * common case, three at worst.
 *
 * No transaction: millions of transactions would cost more than the import. The worst an
 * interleaving with a live write can do is lose a `date_end` extension, which the next import
 * restores. The upsert covers two writers opening the same plateau.
 *
 * When a placement writes twice, the order keeps the history readable if interrupted: a `merge`
 * extends before deleting (a brief overlap of identical rows loses nothing), a `reopen` truncates
 * `before` first (a brief gap is better than an overlap of different rows).
 */
export async function writeStatement(db: Pool | PoolConnection, statement: StatementInput): Promise<WriteResult> {
  const input = fitStatement(statement);
  const date = asDay(input.date);
  const hash = payloadHash(input);
  const { vatNumber, source } = input;

  const [rows] = await db.query<RowDataPacket[]>(NEIGHBOURS_SQL, [vatNumber, source, date, vatNumber, source, date]);
  const neighbours = rows.map(toPlateau);
  const before = neighbours.find((plateau) => plateau.dateStart <= date) ?? null;
  const after = neighbours.find((plateau) => plateau.dateStart > date) ?? null;

  const placement = placeStatement(before, after, { date, payloadHash: hash });

  switch (placement.action) {
    case 'none':
      return { action: 'none', dateStart: before!.dateStart, dateEnd: before!.dateEnd };

    case 'extend':
      await db.query(EXTEND_SQL, [
        date,
        input.companyLastUpdatedAt,
        input.proof,
        vatNumber,
        source,
        placement.dateStart,
      ]);
      return { action: 'extend', dateStart: placement.dateStart, dateEnd: date };

    case 'merge':
      // The survivor takes the absorbed row's provenance, since its last day is now `after`'s.
      await db.query(EXTEND_SQL, [
        placement.dateEnd,
        after!.companyLastUpdatedAt,
        after!.proof,
        vatNumber,
        source,
        placement.dateStart,
      ]);
      await db.query(DELETE_SQL, [vatNumber, source, placement.absorbed]);
      return { action: 'merge', dateStart: placement.dateStart, dateEnd: placement.dateEnd };

    case 'reopen':
      if (placement.truncateTo) {
        await db.query(TRUNCATE_SQL, [placement.truncateTo, vatNumber, source, before!.dateStart]);
      }
      await db.query(REOPEN_SQL, [date, input.bulkId, vatNumber, source, placement.from]);
      return { action: 'reopen', dateStart: date, dateEnd: placement.dateEnd };

    case 'split':
      await db.query(TRUNCATE_SQL, [placement.truncateTo, vatNumber, source, before!.dateStart]);
      await insertPlateau(db, input, date, hash);
      return { action: 'split', dateStart: date, dateEnd: date };

    default:
      await insertPlateau(db, input, date, hash);
      return { action: placement.action, dateStart: date, dateEnd: date };
  }
}

/** One neighbour row, with the two columns a `merge` carries over. */
interface NeighbourPlateau extends Plateau {
  companyLastUpdatedAt: Date | null;
  proof: string | null;
}

function toPlateau(row: RowDataPacket): NeighbourPlateau {
  return {
    dateStart: row.date_start as Date,
    dateEnd: row.date_end as Date,
    payloadHash: row.payload_hash as Buffer,
    companyLastUpdatedAt: row.company_last_updated_at as Date | null,
    proof: row.proof as string | null,
  };
}

function insertPlateau(
  db: Pool | PoolConnection,
  input: StatementInput,
  date: Date,
  hash: Buffer,
): Promise<[ResultSetHeader, unknown]> {
  return db.query<ResultSetHeader>(INSERT_SQL, [
    input.vatNumber,
    input.source,
    date,
    date,
    input.status,
    input.nationalId,
    input.name,
    input.legalForm,
    input.addressLine1,
    input.addressLine2,
    input.postalCode,
    input.city,
    input.addressCountry,
    input.companyLastUpdatedAt,
    input.bulkId,
    input.proof,
    hash,
  ]) as Promise<[ResultSetHeader, unknown]>;
}

/**
 * The live path: write one answer and return the plateau it landed in.
 *
 * The caller needs the plateau, since `date_start` answers "since when" and may be older than
 * today.
 */
export async function recordStatement(statement: StatementInput): Promise<CompanyStatement> {
  const result = await writeStatement(getPool(), statement);
  // Truncated before returning, so the caller gets what the table holds.
  const { date: _date, ...rest } = fitStatement(statement);
  return { ...rest, dateStart: result.dateStart, dateEnd: result.dateEnd };
}

/**
 * The latest statement of every named source for a number, in one query. The `bulk` row is joined
 * here, since lookup-all publishes the file a statement came from.
 */
export async function latestBySource(vatNumber: string, sources: string[]): Promise<Map<string, StoredStatement>> {
  if (sources.length === 0) return new Map();

  const rows = await getPrisma().company.findMany({
    where: { vatNumber, source: { in: sources } },
    orderBy: { dateStart: 'desc' },
    include: { bulk: true },
  });

  const latest = new Map<string, StoredStatement>();
  // Newest first, so the first row per source is its answer. Plateaus of one source never overlap.
  for (const row of rows) if (!latest.has(row.source)) latest.set(row.source, toStored(row));
  return latest;
}

/**
 * Everything every named source has said about a number, oldest first, for lookup-all.
 *
 * Grouped by source: sources do not share a timeline, and interleaving them would read as one
 * history of the company.
 */
export async function historyBySource(vatNumber: string, sources: string[]): Promise<Map<string, StoredStatement[]>> {
  if (sources.length === 0) return new Map();

  const rows = await getPrisma().company.findMany({
    where: { vatNumber, source: { in: sources } },
    orderBy: { dateStart: 'asc' },
    include: { bulk: true },
  });

  const history = new Map<string, StoredStatement[]>();
  for (const row of rows) {
    const entries = history.get(row.source) ?? [];
    entries.push(toStored(row));
    history.set(row.source, entries);
  }
  return history;
}

function toStored(row: Company & { bulk: Bulk | null }): StoredStatement {
  const { payloadHash: _hash, bulk, ...statement } = row;
  return { ...statement, bulk: bulk === null ? null : toArtefact(bulk) };
}

function toArtefact({ createdAt: _createdAt, ...artefact }: Bulk): BulkArtefactRow {
  return artefact;
}

/**
 * Finds the `bulk` row for a file, creating it the first time.
 *
 * Re-importing the same file must reuse its row. The unique key is (source, file name), which
 * publishers keep stable. Generated download URLs are not.
 */
export async function resolveBulk(source: string, url: string, fileName: string, date: Date): Promise<bigint> {
  const row = await getPrisma().bulk.upsert({
    where: { source_fileName: { source, fileName } },
    create: { source, url, fileName, date: asDay(date) },
    // The file keeps its identity but its URL can change (data.gouv.fr does that), so update it.
    update: { url },
    select: { id: true },
  });
  return row.id;
}

/**
 * Whether this file and edition were already read to the end.
 *
 * Matching on the date too matters for publishers that overwrite the same file name
 * (`register.csv` daily, `StockUniteLegale` monthly).
 */
export async function isBulkImported(source: string, fileName: string, date: Date): Promise<boolean> {
  const row = await getPrisma().bulk.findUnique({
    where: { source_fileName: { source, fileName } },
    select: { date: true, importedAt: true },
  });
  return row?.importedAt != null && row.date.getTime() === asDay(date).getTime();
}

/**
 * Whether anything read to the end was downloaded from this exact URL.
 *
 * Like {@link isBulkImported} but for the URL, for the one register whose edition is only inside
 * the archive (the NTA puts a per-edition number in the URL). Only the source knows when this
 * applies.
 */
export async function isBulkUrlImported(source: string, url: string): Promise<boolean> {
  // `bulk` has a few thousand rows at most, so no index is needed.
  const row = await getPrisma().bulk.findFirst({
    where: { source, url, importedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Marks a file as read to the end.
 *
 * The date is written too: for a file overwritten in place, `resolveBulk` keeps the first date
 * seen, so this is what records the current edition.
 */
export async function markBulkImported(source: string, fileName: string, date: Date): Promise<void> {
  await getPrisma().bulk.update({
    where: { source_fileName: { source, fileName } },
    data: { date: asDay(date), importedAt: new Date() },
  });
}
