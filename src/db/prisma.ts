import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { config } from '../config.js';
import { PrismaClient } from '../generated/prisma/client.js';

let client: PrismaClient | null = null;

/**
 * Prisma client, used for most queries. Writes to `company` use the mysql2 pool in ./pool.ts.
 *
 * Prisma 7 uses a driver adapter, and the MariaDB one speaks the MySQL protocol. It takes options
 * rather than a URL, so DATABASE_URL (also read by the prisma CLI) is parsed here.
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    const url = new URL(config.mysql.url);

    client = new PrismaClient({
      adapter: new PrismaMariaDb({
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
      }),
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
