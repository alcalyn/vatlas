import { collapsePlateaus, type CollapseReport } from '../db/collapsePlateaus.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Merges the plateaus that a backwards import split in two. See ../db/collapsePlateaus.ts.
 *
 * Report and repair are one command because both need the same pass over `company`.
 */

function usage(): string {
  return [
    'Usage: npm run collapse [-- --dry-run] [--samples <n>]',
    '',
    'Finds plateaus that say the same thing on both sides of a boundary - the shape a history',
    'imported backwards used to take, before a statement was placed between both of the plateaus',
    'it falls between - reports them by country, and merges them.',
    '',
    'Each run of consecutive plateaus of one (VAT number, source) with the same payload becomes',
    'one row: the earliest, since it names the edition the stretch opened with, carrying the last',
    "one's date_end, proof and company_last_updated_at.",
    '',
    'Options:',
    '  --dry-run       Report what would be merged and change nothing',
    '  --samples <n>   How many example VAT numbers to list (default 10)',
    '  --help          This text',
    '',
    'Safe to run twice - the second run finds nothing - and a no-op on a database that has only',
    'ever been imported forwards. It counts the plateaus of every number along the primary key and',
    'then works on the handful of numbers that have more than one, so it costs seconds rather than',
    'a pass over the whole table; still, run it when no import is running.',
  ].join('\n');
}

function report(result: CollapseReport, dryRun: boolean): string {
  if (result.runs === 0) {
    return 'Nothing to collapse: no two plateaus of one number and source say the same thing.\n';
  }

  const lines = [
    `${result.redundant} redundant plateau${result.redundant === 1 ? '' : 's'} across ${result.runs} stretch${result.runs === 1 ? '' : 'es'} that should be one row each.`,
    '',
    'country  sources                    companies  redundant',
  ];
  for (const country of result.byCountry) {
    lines.push(
      `${country.country.padEnd(9)}${country.sources.slice(0, 25).padEnd(27)}${String(country.companies).padStart(9)}${String(country.redundant).padStart(11)}`,
    );
  }

  lines.push('', `examples (${result.samples.length}):`);
  for (const sample of result.samples) {
    lines.push(`  ${sample.vatNumber.padEnd(16)}${sample.source.padEnd(10)}${sample.redundant} to merge`);
  }

  lines.push(
    '',
    dryRun
      ? 'Nothing written: --dry-run. Run without it to merge them.'
      : `Merged: ${result.deleted} row${result.deleted === 1 ? '' : 's'} deleted.`,
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const index = args.indexOf('--samples');
  const samples = index === -1 ? undefined : Number(args[index + 1]);
  if (samples !== undefined && (!Number.isInteger(samples) || samples < 0)) {
    process.stderr.write(`--samples takes a whole number, not "${args[index + 1] ?? ''}"\n\n${usage()}\n`);
    process.exit(1);
  }

  process.stdout.write(report(await collapsePlateaus({ dryRun, samples }), dryRun));
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
    logger.error({ err: error }, 'collapse command failed');
    await shutdown();
    process.exit(1);
  });
