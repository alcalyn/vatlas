import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { COUNTRIES, getCountry } from '../api/countries/registry.js';
import type { CountryAdapterInterface } from '../api/countries/types.js';
import type { ImportOptions } from '../api/sources/types.js';

/**
 * Parses and validates `npm run import` arguments before anything is downloaded.
 *
 * Separate from `import.ts`, which runs `main()` on import and so cannot be tested.
 */

/** One line per source that accepts local files, listing the `--file` slot names. */
export function slotLines(): string[] {
  const lines = COUNTRIES.flatMap((country) =>
    country.bulkSources
      .filter((source) => source.slots.length > 0)
      .map((source) => `  ${country.code}  ${source.id}: ${source.slots.join(', ')}`),
  );
  return lines.length > 0 ? lines : ['  (none)'];
}

/** Reads `--limit 1000` or `--limit=1000`, and similar flags. */
export function parseCount(args: string[], flag: string): number | null {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) return null;

  const raw = inline ? inline.slice(flag.length + 1) : args[args.indexOf(flag) + 1];
  const count = Number(raw);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`${flag} expects a positive integer, got "${raw ?? ''}"`);
  }
  return count;
}

/** Every value of a repeatable flag, as `--flag value` or `--flag=value`. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => {
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)];
    if (arg !== flag) return [];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} expects a value`);
    return [value];
  });
}

/**
 * Reads every `--file <slot>=<path>`.
 *
 * Slots are named rather than positional because files are not interchangeable (France's legal
 * units and establishments), and a mix-up would fail silently.
 */
export function parseFiles(args: string[], exists: (path: string) => boolean = fileExists): Map<string, string> {
  const files = new Map<string, string>();
  for (const value of values(args, '--file')) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`--file expects <slot>=<path>, got "${value}"`);
    }
    const slot = value.slice(0, separator);
    const path = resolve(value.slice(separator + 1));
    if (!path || !exists(path)) throw new Error(`--file: no such file "${path}"`);
    if (files.has(slot)) throw new Error(`--file: slot "${slot}" was given twice`);
    files.set(slot, path);
  }
  return files;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads `--date 2025-03-01` and similar flags as a UTC day.
 *
 * Only `YYYY-MM-DD`: `new Date('01/03/2025')` would parse, often as the wrong month.
 */
export function parseDate(args: string[], flag = '--date'): Date | null {
  const given = values(args, flag);
  if (given.length === 0) return null;
  if (given.length > 1) throw new Error(`${flag} can only be given once`);

  const raw = given[0]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${flag} expects YYYY-MM-DD, got "${raw}"`);
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${flag} is not a real date: "${raw}"`);
  return date;
}

/**
 * The two ways of asking for older editions cannot be combined.
 *
 * `--history` counts months back from today and keeps the newest, `--since-date` reads forward from
 * a day. Combined, the result would be unpredictable, so it is refused.
 */
export function checkWindow(options: ImportOptions): void {
  if (options.sinceDate && options.historyMonths !== null) {
    throw new Error(
      '--since-date and --history both choose which editions to read: give one or the other.\n' +
        'Pair --since-date with --max-files to read n editions forwards from that day.',
    );
  }
}

/** Reads `--except fr,fi` or `--except=fr`. */
export function parseExcept(args: string[]): Set<string> {
  const inline = args.find((arg) => arg.startsWith('--except='));
  if (!args.some((arg) => arg === '--except' || arg.startsWith('--except='))) return new Set();

  const raw = inline ? inline.slice('--except='.length) : args[args.indexOf('--except') + 1];
  const codes = (raw ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

  if (codes.length === 0) {
    throw new Error(`--except expects one or more country codes, got "${raw ?? ''}"`);
  }
  const unknown = codes.filter((code) => !getCountry(code));
  if (unknown.length > 0) {
    throw new Error(`--except: unknown country code${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`);
  }
  return new Set(codes);
}

/** Validates a local import before anything is read, so a missing flag is reported immediately. */
export function checkLocalFiles(options: ImportOptions, target: string, targets: CountryAdapterInterface[]): void {
  const files = options.localFiles!;

  if (!options.dumpDate) {
    throw new Error('--file needs --date: a file on disk carries no edition date of its own');
  }
  if (target === 'all') {
    throw new Error('--file names the files of one register, so it takes one country, not `all`');
  }
  if (options.historyMonths !== null || options.maxEditions !== null || options.sinceDate !== null) {
    throw new Error(
      '--file imports the one edition it was given: --history, --max-files and --since-date do not apply',
    );
  }

  const known = new Set(targets.flatMap((country) => country.bulkSources.flatMap((source) => source.slots)));
  if (known.size === 0) {
    const sources = targets.flatMap((country) => country.bulkSources.map((source) => source.id));
    throw new Error(
      sources.length === 0
        ? `${target.toUpperCase()} has no bulk source, so there is no file to import`
        : `${sources.join(', ')} reads no downloadable file - it is an API or a stream, and cannot be replayed from disk`,
    );
  }

  const unknown = [...files.keys()].filter((slot) => !known.has(slot));
  if (unknown.length > 0) {
    throw new Error(
      `--file: unknown slot${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}\n\nSlots for this country:\n` +
        [...known].map((slot) => `  ${slot}`).join('\n'),
    );
  }
}
