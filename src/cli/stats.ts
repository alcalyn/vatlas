import { writeFile } from 'node:fs/promises';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { collectSiteStats } from '../services/siteStats.js';
import { optionValue } from './vatList.js';

/** Where the site reads them from. */
const DEFAULT_OUT = 'site/public/data/stats.json';
const DEFAULT_BENCHMARK = 'site/public/data/benchmark.json';

function usage(): string {
  return [
    `Usage: npm run stats [-- --out ${DEFAULT_OUT}] [--benchmark ${DEFAULT_BENCHMARK}]`,
    '',
    'Counts what the home page advertises and writes it as JSON for the site to read.',
    'The site is static, so nothing is computed at request time: re-run this and commit the',
    'file to refresh the figures.',
    '',
    '  vatNumbers    rows in company',
    '  lookups       rows in log_lookup, plus a fixed offset for lookups made before it existed',
    '  countries     country adapters registered',
    '  latencyP50Ms  median latency of the last published benchmark run',
    '  answeredPct   share of that run that came back with an answer',
    '',
    'Options:',
    `  --out         Where to write the JSON (default ${DEFAULT_OUT})`,
    `  --benchmark   The benchmark summary to fold in (default ${DEFAULT_BENCHMARK})`,
    '  --help        This text',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const out = optionValue(args, '--out') ?? DEFAULT_OUT;
  const benchmarkPath = optionValue(args, '--benchmark') ?? DEFAULT_BENCHMARK;

  const stats = await collectSiteStats({ benchmarkPath });
  await writeFile(out, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');

  const pct = stats.answeredPct === null ? 'n/a' : `${stats.answeredPct.toFixed(1)}%`;
  process.stdout.write(
    [
      `vatNumbers    ${stats.vatNumbers}`,
      `lookups       ${stats.lookups}`,
      `countries     ${stats.countries}`,
      `latencyP50Ms  ${stats.latencyP50Ms ?? 'n/a'}`,
      `answeredPct   ${pct}`,
      '',
      `Written to ${out}`,
      '',
    ].join('\n'),
  );
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
    logger.error({ err: error }, 'stats command failed');
    await shutdown();
    process.exit(1);
  });
