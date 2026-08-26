import mysql from 'mysql2/promise';
import { config } from '../config.js';

let pool: mysql.Pool | null = null;

/**
 * The raw mysql2 driver. Every write to `company` uses it (importer and live path), so the plateau
 * rule of ./companyHistory.ts has one implementation. Other queries use Prisma (./prisma.ts).
 */
export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.mysql.url,
      waitForConnections: true,
      // The importer runs sixteen writers at once (`bulkWrites.ts`). With the default of ten they would
      // wait on the pool.
      connectionLimit: 24,
      charset: 'utf8mb4_unicode_ci',
      // Write and read dates as UTC.
      timezone: 'Z',
      dateStrings: false,
    });

    // Make NOW() and friends UTC regardless of server configuration.
    pool.on('connection', (connection) => {
      void connection.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
