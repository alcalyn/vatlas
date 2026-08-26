import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { flushAll } from '../services/usage.js';
import { runDueLookups } from '../services/asyncLookups.js';

function usage(): string {
  return [
    'Usage: npm run lookups:async [-- --dry-run] [--limit N]',
    '',
    'Attempts every asynchronous lookup whose retry date has passed, delivers the answer to the',
    'callback URL as soon as there is one, and schedules the next attempt when there is not.',
    'Meant to run every ten minutes from cron; safe to run twice.',
    '',
    'The ladder doubles from ten minutes with a jitter of half the delay either way, up to',
    `${Math.round(config.asyncLookup.maxBackoffMs / 3_600_000)} h. After ${config.asyncLookup.maxDays} days a lookup that has never been answered is given up`,
    'on: it goes to failed, a lookup.failed payload is delivered, and the credit it cost at',
    'creation is returned.',
    '',
    'Options:',
    '  --dry-run    Report what is due, attempt nothing and deliver nothing',
    '  --limit N    At most N lookups this pass (default 500)',
    '  --help       This text',
    '',
    'A found number, one a source reports as not registered, and one nothing holds are all',
    'answers and all end the lookup. Only an unreachable source is retried - which is the whole',
    'reason the feature exists.',
  ].join('\n');
}

function readLimit(args: string[]): number | undefined {
  const index = args.indexOf('--limit');
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit takes a whole number of lookups, at least 1');
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
  const report = await runDueLookups({ dryRun, ...(limit !== undefined ? { limit } : {}) });

  process.stdout.write(
    [
      `due          ${report.due}`,
      `answered     ${report.answered}`,
      `retried      ${report.retried}`,
      `expired      ${report.expired}`,
      `delivered    ${report.delivered}`,
      `failed       ${report.failed}`,
      '',
    ].join('\n'),
  );
}

/** Flush the usage counter before exiting, so credits refunded in memory are saved. */
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
    logger.error({ err: error }, 'asynchronous lookups command failed');
    await shutdown();
    process.exit(1);
  });
