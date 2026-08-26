import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { flushAll } from '../services/usage.js';
import { checkMonitors } from '../services/monitors.js';

function usage(): string {
  return [
    'Usage: npm run monitors [-- --dry-run] [--limit N]',
    '',
    'Walks every followed company, asks what the registers say now, and delivers a',
    'company.changed callback wherever the answer differs from the one the account was last',
    'told. Meant to run once a night from cron; safe to run twice.',
    '',
    'It asks the same question the API asks: the stored history first, and a live source when',
    'its last statement has aged past LIVE_MAX_AGE_DAYS. That is what lets a country with no',
    'bulk dump be monitored at all - its table would otherwise never move on its own.',
    '',
    'Nothing here is billed. The check is ours to schedule, and the account never asked for it;',
    'what bounds the job is MONITOR_FREE_MAX / MONITOR_PRO_MAX.',
    '',
    'Options:',
    '  --dry-run    Report what would be delivered, deliver nothing and write nothing',
    '  --limit N    Only the first N monitors, by creation order. For a first run.',
    '  --help       This text',
    '',
    'The first check of a monitor never delivers: it records what the register says today, so',
    'that the next one has something to have changed against.',
  ].join('\n');
}

function readLimit(args: string[]): number | undefined {
  const index = args.indexOf('--limit');
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit takes a whole number of monitors, at least 1');
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const limit = readLimit(args);
  const report = await checkMonitors({ dryRun, ...(limit !== undefined ? { limit } : {}) });

  const verb = dryRun ? 'would deliver' : 'delivered';
  process.stdout.write(
    [
      `checked      ${report.checked}`,
      `changed      ${report.changed}`,
      `${verb.padEnd(12)} ${report.delivered}`,
      `failed       ${report.failed}`,
      `unavailable  ${report.unavailable}`,
      '',
    ].join('\n'),
  );
}

async function shutdown(): Promise<void> {
  await flushAll();
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(async () => {
    await shutdown();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'monitors command failed');
    await shutdown();
    process.exit(1);
  });
