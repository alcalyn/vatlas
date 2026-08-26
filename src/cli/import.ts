import { COUNTRIES, getCountry, strategyOf } from '../api/countries/registry.js';
import type { CountryAdapterInterface } from '../api/countries/types.js';
import { ArtefactAlreadyImportedError } from '../api/sources/types.js';
import type { BulkArtefact, BulkSourceAdapterInterface, ImportOptions, ImportResult } from '../api/sources/types.js';
import { saveStatements, type BatchOrigin } from '../db/bulkWrites.js';
import { isBulkImported, isBulkUrlImported, markBulkImported, resolveBulk } from '../db/companyHistory.js';
import { finishImportRun, noteImportArtefact, startImportRun } from '../db/companyRepository.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import {
  checkLocalFiles,
  checkWindow,
  parseCount,
  parseDate,
  parseExcept,
  parseFiles,
  slotLines,
} from './importOptions.js';

/** The bulk importer, driven by country. A country resolves to the bulk sources it declares. */

function usage(): string {
  const width = Math.max(...COUNTRIES.map((country) => country.name.length));
  const countries = COUNTRIES.map(
    (country) => `  ${country.code}  ${country.name.padEnd(width)} ${strategyOf(country)}`,
  );
  return [
    'Usage: npm run import -- <country code|all> [options]',
    '',
    'Countries:',
    ...countries,
    '',
    'Options:',
    '  --limit <n>        Stop after n records per edition, to import a sample of a large bulk file',
    '  --history <n>      Reach back n months of older editions, the current month included:',
    '                     --history 4 run in September imports June, July, August and September.',
    '                     Only a publisher that keeps an archive has any to give - most overwrite',
    '                     one file in place, and the run says so.',
    '  --max-files <n>    At most n editions, newest first. Alone, it means the n most recent with',
    '                     no date bound - which is how to ask a register that publishes daily.',
    '                     With --since-date it keeps the oldest n instead, the run reading',
    '                     forwards from that day.',
    '  --since-date <YYYY-MM-DD> Read the archive from this day onwards, oldest edition first.',
    '                     The way back to an old edition of a publisher that keeps years of them:',
    '                     --since-date 2024-09-01 --max-files 1 imports that one edition alone.',
    '  --except <codes>   With `all`: skip these countries, comma separated (e.g. --except fr,fi)',
    '  --file <slot>=<p>  Read this file from disk instead of downloading it. Repeatable: a source',
    '                     that reads several files takes one --file per slot. Requires --date, and',
    '                     is how an old dump is imported once the publisher no longer offers it.',
    '  --date <YYYY-MM-DD> The edition date to file the run under, overriding the file and the',
    '                     server. Mandatory with --file: a copy on disk carries no date.',
    '',
    'Local file slots:',
    ...slotLines(),
  ].join('\n');
}

/** One line per country on stdout, so `all` reads as a report. */
function report(country: CountryAdapterInterface, message: string): void {
  process.stdout.write(`[${country.code}] ${message}\n`);
}

/**
 * Every bulk source of one country, in turn.
 *
 * A country without one prints its `importNote`, so `import -- all` explains why it is skipped.
 */
async function runCountry(country: CountryAdapterInterface, options: ImportOptions): Promise<void> {
  if (country.bulkSources.length === 0) {
    report(country, `Nothing to import: ${country.importNote ?? 'this country publishes no bulk file'}`);
    return;
  }

  for (const source of country.bulkSources) {
    await runSource(country, source, options);
  }
}

/** Runs one bulk source, recording the attempt in `log_import`. */
async function runSource(
  country: CountryAdapterInterface,
  source: BulkSourceAdapterInterface,
  options: ImportOptions,
): Promise<ImportResult> {
  report(country, `Import from ${source.id}...`);

  const runId = await startImportRun(country.code, source.id);
  const childLogger = logger.child({ country: country.code, source: source.id });
  // A Map logs as `{}`, so convert it.
  const logged = { ...options, localFiles: options.localFiles ? Object.fromEntries(options.localFiles) : null };
  childLogger.info({ options: logged }, 'import started');

  // The file last declared through `useArtefact`.
  let origin: BatchOrigin | null = null;
  // The files declared since the last `markImported`: one edition (Latvia reads three files into
  // one).
  let declared: BulkArtefact[] = [];

  try {
    const result = await source.import({
      logger: childLogger,
      options,
      useArtefact: async (artefact: BulkArtefact) => {
        // The first file of an edition is the last point where a source can stop without having written
        // anything. Reported as an outcome, not a failure.
        if (declared.length === 0 && (await isBulkImported(source.id, artefact.fileName, artefact.date))) {
          throw new ArtefactAlreadyImportedError(
            `${artefact.fileName} of ${artefact.date.toISOString().slice(0, 10)} has already been imported in full`,
          );
        }
        const bulkId = await resolveBulk(source.id, artefact.url, artefact.fileName, artefact.date);
        origin = { source: source.id, date: artefact.date, bulkId };
        declared.push(artefact);
        await noteImportArtefact(runId, artefact.fileName, artefact.date);
        childLogger.info({ file: artefact.fileName, date: artefact.date }, 'artefact selected');
      },
      alreadyImported: (artefact: BulkArtefact) => isBulkImported(source.id, artefact.fileName, artefact.date),
      alreadyImportedUrl: (url: string) => isBulkUrlImported(source.id, url),
      markImported: async () => {
        const read = declared;
        declared = [];
        // A `--limit` run stops in the middle of every edition, so nothing is marked as imported.
        if (options.limit !== null) return;
        for (const artefact of read) {
          await markBulkImported(source.id, artefact.fileName, artefact.date);
        }
      },
      save: (records) => {
        if (origin === null) {
          // A source saving before declaring its file would write rows without date or file. Caught here.
          throw new Error(`${source.id} called save() before useArtefact()`);
        }
        return saveStatements(records, origin);
      },
    });

    await finishImportRun(runId, 'success', result);
    childLogger.info(result, 'import finished');
    report(country, summarize(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishImportRun(runId, 'failed', null, message);
    report(country, `Import failed: ${message}`);
    throw error;
  }
}

function summarize(result: ImportResult): string {
  if (result.notImportedReason) return `Import not necessary because ${result.notImportedReason}`;

  const seconds = (result.durationMs / 1000).toFixed(1);
  // The edition count is only shown when more than one was read.
  const editions = result.editions && result.editions.length > 1 ? `${result.editions.length} editions, ` : '';
  // Show the skipped count, otherwise a run that skipped thirty editions looks idle.
  const passed = result.skippedEditions?.length
    ? `, ${result.skippedEditions.length} already imported and skipped`
    : '';
  // A run that stopped early still says what it did.
  const stopped = result.stoppedReason ? ` - stopped early: ${result.stoppedReason}` : '';
  return (
    `${editions}${result.fetched} fetched, ${result.inserted} inserted, ${result.updated} updated, ` +
    `${result.skipped} skipped in ${seconds}s${passed}${stopped}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // With `--except fr`, `fr` is the flag's value, not the target, so skip values of value flags.
  const valueFlags = new Set(['--limit', '--except', '--history', '--max-files', '--file', '--date', '--since-date']);
  const consumed = new Set(args.flatMap((arg, index) => (valueFlags.has(arg) ? [index + 1] : [])));
  const target = args.find((arg, index) => !arg.startsWith('--') && !consumed.has(index));

  if (!target || target === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const localFiles = parseFiles(args);
  const options: ImportOptions = {
    limit: parseCount(args, '--limit'),
    historyMonths: parseCount(args, '--history'),
    maxEditions: parseCount(args, '--max-files'),
    localFiles: localFiles.size > 0 ? localFiles : null,
    dumpDate: parseDate(args),
    sinceDate: parseDate(args, '--since-date'),
  };
  checkWindow(options);

  const except = parseExcept(args);

  const targets =
    target === 'all'
      ? COUNTRIES.filter((country) => !except.has(country.code))
      : (() => {
          const country = getCountry(target);
          if (!country) throw new Error(`Unknown country code "${target}"\n\n${usage()}`);
          return [country];
        })();

  if (options.localFiles) checkLocalFiles(options, target, targets);

  for (const country of targets) {
    // `all` continues when one country fails.
    if (target === 'all') {
      try {
        await runCountry(country, options);
      } catch (error) {
        logger.error({ err: error, country: country.code }, 'import failed, continuing with the next country');
      }
    } else {
      await runCountry(country, options);
    }
  }
}

async function shutdown(): Promise<void> {
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'import command failed');
    await shutdown();
    process.exit(1);
  });
