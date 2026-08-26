import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { parseAuditPruneArgs, usage } from './auditPruneArgs.js';
import { pruneAuditLookups } from '../services/retention.js';

/**
 * Prunes the audit trail on demand.
 *
 * `npm run retention` already applies the per-plan windows daily. This command is for other cases:
 * cleaning free accounts, capping by row count, or checking a window before applying it. It uses
 * `pruneAuditLookups`, like the cron.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const parsed = parseAuditPruneArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${usage()}\n`);
    process.exit(1);
  }

  const report = await pruneAuditLookups(parsed);
  const verb = parsed.dryRun ? 'would delete' : 'deleted';
  process.stdout.write(`audit_lookups ${verb} ${report.rows} rows across ${report.accounts} accounts\n`);
}

async function shutdown(): Promise<void> {
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(async () => {
    await shutdown();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'audit:prune command failed');
    await shutdown();
    process.exit(1);
  });
