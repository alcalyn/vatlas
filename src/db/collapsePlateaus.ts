import type { PoolConnection } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from './pool.js';

/**
 * Repairs a history imported backwards before ./companyHistory.ts also checked the plateau after a
 * statement.
 *
 * Importing September then August used to leave two identical rows with a gap between them.
 * `placeStatement` now handles that, but existing rows are never merged by later imports.
 *
 * `npm run collapse` applies the table's rule to existing rows: consecutive plateaus of one
 * `(vat_number, source)` with the same `payload_hash` are one plateau. It does nothing on a
 * database only imported forwards, and is idempotent.
 */

/**
 * Survey and repair share the same pass over the history, so they are one function.
 *
 * Temporary tables are per connection, so the survey and the repair work on the same rows.
 */

/**
 * The `(vat_number, source)` pairs with more than one plateau, which keeps this pass fast.
 *
 * A number with one plateau cannot be affected, and that is almost all of them. Counting is an
 * ordered scan of the primary key, and the rest only works on a few thousand rows. Measured on
 * 863,000 plateaus: 0.5 s instead of 2 minutes.
 */
const MULTI_SQL = `
  CREATE TEMPORARY TABLE plateau_multi (PRIMARY KEY (vat_number, source)) AS
    SELECT vat_number, source FROM company GROUP BY vat_number, source HAVING COUNT(*) > 1
`;

/**
 * The plateaus of those numbers, each tagged with its run of identical statements: a new run starts
 * when the payload differs from the previous one.
 */
const RUNS_SQL = `
  CREATE TEMPORARY TABLE plateau_run (PRIMARY KEY (vat_number, source, date_start)) AS
    SELECT vat_number, source, date_start, date_end,
           SUM(opens) OVER (PARTITION BY vat_number, source ORDER BY date_start) AS run
      FROM (SELECT c.vat_number, c.source, c.date_start, c.date_end,
                   IF(c.payload_hash <=> LAG(c.payload_hash) OVER w, 0, 1) AS opens
              FROM company c
              JOIN plateau_multi m ON m.vat_number = c.vat_number AND m.source = c.source
            WINDOW w AS (PARTITION BY c.vat_number, c.source ORDER BY c.date_start)) AS tagged
`;

/** One row per run that should be a single plateau. Singletons drop out. */
const COLLAPSE_SQL = `
  CREATE TEMPORARY TABLE plateau_collapse (PRIMARY KEY (vat_number, source, run)) AS
    SELECT vat_number, source, run,
           MIN(date_start) AS keeps, MAX(date_start) AS lasts, MAX(date_end) AS ends,
           COUNT(*) AS plateaus
      FROM plateau_run
     GROUP BY vat_number, source, run
    HAVING COUNT(*) > 1
`;

/**
 * The survivor is the earliest row of each run (it names the opening edition, `bulk_id`), and takes
 * the last row's `date_end`, `proof` and `company_last_updated_at`.
 */
const APPLY_SQL = `
  UPDATE company c
    JOIN plateau_collapse x ON c.vat_number = x.vat_number AND c.source = x.source AND c.date_start = x.keeps
    JOIN company l ON l.vat_number = x.vat_number AND l.source = x.source AND l.date_start = x.lasts
     SET c.date_end = x.ends, c.proof = l.proof, c.company_last_updated_at = l.company_last_updated_at
`;

/**
 * Delete what the survivor now covers. Runs after the extension, so an interruption leaves an
 * overlap of identical rows rather than missing history.
 */
const DELETE_SQL = `
  DELETE c FROM company c
    JOIN plateau_run r ON r.vat_number = c.vat_number AND r.source = c.source AND r.date_start = c.date_start
    JOIN plateau_collapse x ON x.vat_number = r.vat_number AND x.source = r.source AND x.run = r.run
   WHERE r.date_start > x.keeps
`;

const BY_COUNTRY_SQL = `
  SELECT LEFT(vat_number, 2) AS country,
         GROUP_CONCAT(DISTINCT source ORDER BY source SEPARATOR ', ') AS sources,
         COUNT(DISTINCT vat_number) AS companies,
         SUM(plateaus - 1) AS redundant
    FROM plateau_collapse
   GROUP BY country
   ORDER BY redundant DESC, country ASC
`;

/** A few examples to check by hand. */
const SAMPLES_SQL = `
  SELECT vat_number, source, SUM(plateaus - 1) AS redundant
    FROM plateau_collapse
   GROUP BY vat_number, source
   ORDER BY redundant DESC, vat_number ASC
   LIMIT ?
`;

export interface CountryTotals {
  /** The country prefix of the VAT number. */
  country: string;
  sources: string;
  companies: number;
  /** Rows that would be removed. */
  redundant: number;
}

export interface CollapseSample {
  vatNumber: string;
  source: string;
  redundant: number;
}

export interface CollapseReport {
  /** Runs written as several plateaus. */
  runs: number;
  /** Rows the repair removes. */
  redundant: number;
  byCountry: CountryTotals[];
  samples: CollapseSample[];
  /** Null on a survey, the deleted row count after a repair. */
  deleted: number | null;
}

/**
 * Surveys the history, and repairs it unless asked only to look.
 *
 * On its own connection, since the temporary tables must outlive single queries. Released at the
 * end whatever happens.
 */
export async function collapsePlateaus(options: { dryRun?: boolean; samples?: number } = {}): Promise<CollapseReport> {
  const { dryRun = false, samples = 10 } = options;
  const db = await getPool().getConnection();

  try {
    await db.query(MULTI_SQL);
    await db.query(RUNS_SQL);
    await db.query(COLLAPSE_SQL);

    const [totals] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS runs, COALESCE(SUM(plateaus - 1), 0) AS redundant FROM plateau_collapse',
    );
    const [byCountry] = await db.query<RowDataPacket[]>(BY_COUNTRY_SQL);
    const [rows] = await db.query<RowDataPacket[]>(SAMPLES_SQL, [samples]);

    const report: CollapseReport = {
      runs: Number(totals[0]!.runs),
      redundant: Number(totals[0]!.redundant),
      byCountry: byCountry.map((row) => ({
        country: row.country as string,
        sources: row.sources as string,
        companies: Number(row.companies),
        redundant: Number(row.redundant),
      })),
      samples: rows.map((row) => ({
        vatNumber: row.vat_number as string,
        source: row.source as string,
        redundant: Number(row.redundant),
      })),
      deleted: null,
    };

    if (!dryRun && report.runs > 0) {
      await db.query(APPLY_SQL);
      const [result] = await db.query<ResultSetHeader>(DELETE_SQL);
      report.deleted = result.affectedRows;
    }

    return report;
  } finally {
    // Drop the temporary tables, so a second run on the same connection does not fail on CREATE.
    await dropTemporaries(db);
    db.release();
  }
}

async function dropTemporaries(db: PoolConnection): Promise<void> {
  await db.query('DROP TEMPORARY TABLE IF EXISTS plateau_collapse');
  await db.query('DROP TEMPORARY TABLE IF EXISTS plateau_run');
  await db.query('DROP TEMPORARY TABLE IF EXISTS plateau_multi');
}
