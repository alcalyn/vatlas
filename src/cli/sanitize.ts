import { readFile, writeFile } from 'node:fs/promises';
import {
  cleanNumbers,
  limitPerCountry,
  listReport,
  numberOption,
  optionValue,
  parseArgs,
  readEntries,
  suffixed,
} from './vatList.js';

/**
 * Describes a list of VAT numbers and writes a clean copy. Needs no API, key or quota. The
 * benchmark measures the list it is given, so cleaning is a separate step.
 */

function usage(): string {
  return [
    'Usage: npm run sanitize -- <file> [options]',
    '',
    'Reads a list of intra-community VAT numbers (one per line; blank lines and # comments',
    'are ignored), reports what it holds - how many per country, what is malformed, what is',
    'repeated - and writes it back without the malformed lines, the repeats and the blanks,',
    'one canonical number per line, in the order of the input.',
    '',
    'Options:',
    '  --out <path>    Where to write the clean list (default: <file>-sanitized.<ext>)',
    '  --limit <n>     Only consider the first n numbers of the file',
    '  --limit-per-country <n>',
    '                  Only keep the first n numbers of each country, in the order of the',
    '                  file - the countries stay interleaved as the file interleaves them',
    '  --stats-only    Report what the list holds and write nothing',
    '  --help          This text',
    '',
    'Examples:',
    '  npm run sanitize -- data/vats.txt',
    '  npm run sanitize -- data/vats.txt --out data/clean.txt',
    '  npm run sanitize -- data/vats.txt --stats-only',
    '  npm run sanitize -- data/vats.txt --limit-per-country 100',
    '',
    'Nothing here calls the API, so it costs no quota and needs no key. The report is also',
    'written next to the list, as <file>.sanitize-report.txt.',
  ].join('\n');
}

const VALUE_OPTIONS = ['--out', '--limit', '--limit-per-country'];
const FLAG_OPTIONS = ['--stats-only'];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  const { file, error } = parseArgs(args, VALUE_OPTIONS, FLAG_OPTIONS);

  if (error && !wantsHelp) {
    process.stderr.write(`${error}\n\n${usage()}\n`);
    return 1;
  }
  if (wantsHelp || !file) {
    process.stdout.write(`${usage()}\n`);
    return wantsHelp ? 0 : 1;
  }

  const limit = args.includes('--limit') ? numberOption(args, '--limit', 0) : undefined;
  const perCountry = args.includes('--limit-per-country') ? numberOption(args, '--limit-per-country', 0) : undefined;
  const read = readEntries(await readFile(file, 'utf8'), limit);
  const lines = read.lines;
  // Trimmed before the report, so the report describes the list that is written.
  const entries = perCountry === undefined ? read.entries : limitPerCountry(read.entries, perCountry);
  if (entries.length === 0) {
    process.stderr.write(`${file} holds no VAT number.\n`);
    return 1;
  }

  const report = listReport('Sanitize', file, new Date(), lines, entries);
  process.stdout.write(`\n${report}`);
  const reportPath = `${file}.sanitize-report.txt`;
  await writeFile(reportPath, report, 'utf8');
  process.stdout.write(`Report written to ${reportPath}\n`);

  if (args.includes('--stats-only')) return 0;

  const clean = cleanNumbers(entries);
  const out = optionValue(args, '--out') ?? suffixed(file, '-sanitized');
  await writeFile(out, `${clean.join('\n')}\n`, 'utf8');
  process.stdout.write(`Clean list written to ${out} (${clean.length} numbers)\n`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
