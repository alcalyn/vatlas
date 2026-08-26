import type { RowDataPacket } from 'mysql2';
import { getPool } from '../../../db/pool.js';

/**
 * The `br_empresa` staging table: 55 million names held during one Brazilian edition, joined
 * against the establishments. Only used by the Brazilian importer.
 */
export interface BrazilCompany {
  razaoSocial: string;
  naturezaJuridica: string | null;
}

/** Rows per INSERT. */
const CHUNK = 5_000;

/** Empties the table, at the start of every edition and at the end of the run. */
export async function resetBrazilCompanies(): Promise<void> {
  await getPool().query('TRUNCATE TABLE br_empresa');
}

/**
 * Stages one chunk of `Empresas` rows.
 *
 * `ON DUPLICATE KEY UPDATE` because the same root appears more than once, and the last name wins.
 * Uses the legacy `VALUES(col)` syntax so MariaDB keeps working.
 */
export async function stageBrazilCompanies(rows: [string, string, string | null][]): Promise<void> {
  const pool = getPool();
  for (let index = 0; index < rows.length; index += CHUNK) {
    const chunk = rows.slice(index, index + CHUNK);
    const placeholders = chunk.map(() => '(?,?,?)').join(',');
    await pool.query(
      `INSERT INTO br_empresa (cnpj_basico, razao_social, natureza_juridica) VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE razao_social = VALUES(razao_social), natureza_juridica = VALUES(natureza_juridica)`,
      chunk.flat(),
    );
  }
}

/** The staged companies of one batch of establishments, in one query. */
export async function loadBrazilCompanies(keys: string[]): Promise<Map<string, BrazilCompany>> {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return new Map();

  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT cnpj_basico, razao_social, natureza_juridica FROM br_empresa
     WHERE cnpj_basico IN (${wanted.map(() => '?').join(',')})`,
    wanted,
  );

  return new Map(
    rows.map((row) => [
      String(row.cnpj_basico),
      { razaoSocial: String(row.razao_social), naturezaJuridica: (row.natureza_juridica as string | null) ?? null },
    ]),
  );
}
