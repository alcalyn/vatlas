import { basename, dirname, join } from 'node:path';
import { InvalidVatError, normalizeVatInput, parseVatNumber } from '../vat/parse.js';
import { VAT_RULES, normalizeCountryCode } from '../vat/rules.js';

/** Reads a file of VAT numbers and describes it, for `npm run benchmark` and `npm run sanitize`. */

/** Example lines shown per malformed reason or repeated number. */
export const EXAMPLES = 5;

export interface Entry {
  /** The line as written, to show malformed ones. */
  input: string;
  vatNumber: string;
  /** Prefix as counted, even when the rest is malformed. */
  countryCode: string;
  invalid?: { reason: string; message: string };
}

/**
 * The prefix decides the country, the parse decides whether the number is usable. Malformed
 * numbers are counted under their prefix so totals match the file.
 */
export function readEntries(text: string, limit?: number): { entries: Entry[]; lines: number } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const entries: Entry[] = [];
  for (const line of lines) {
    if (limit !== undefined && entries.length >= limit) break;

    const normalized = normalizeVatInput(line);
    const prefix = normalizeCountryCode(normalized.slice(0, 2));
    const countryCode = VAT_RULES[prefix] ? prefix : '??';

    try {
      const parsed = parseVatNumber(line);
      entries.push({ input: line, vatNumber: parsed.formatted, countryCode: parsed.countryCode });
    } catch (error) {
      if (!(error instanceof InvalidVatError)) throw error;
      entries.push({
        input: line,
        vatNumber: normalized,
        countryCode,
        invalid: { reason: error.reason, message: error.message },
      });
    }
  }

  return { entries, lines: lines.length };
}

/**
 * The first `limit` entries of each country, in file order. Countries stay interleaved as in the
 * file. Malformed numbers count against their prefix's quota.
 */
export function limitPerCountry(entries: Entry[], limit: number): Entry[] {
  const taken = new Map<string, number>();
  const kept: Entry[] = [];
  for (const entry of entries) {
    const count = taken.get(entry.countryCode) ?? 0;
    if (count >= limit) continue;
    taken.set(entry.countryCode, count + 1);
    kept.push(entry);
  }
  return kept;
}

/** Well-formed numbers, canonical, deduplicated, in file order. */
export function cleanNumbers(entries: Entry[]): string[] {
  const clean = new Set<string>();
  for (const entry of entries) {
    if (!entry.invalid) clean.add(entry.vatNumber);
  }
  return [...clean];
}

export function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = key(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

/** "database 1180, VIES 20", largest first. */
export function describe(counts: Map<string, number>): string {
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${label} ${count}`)
      .join(', ') || '-'
  );
}

export function percent(part: number, total: number): string {
  return total === 0 ? '-' : `${((part / total) * 100).toFixed(1)}%`;
}

/** One short printable line: control characters or a very long row would break the report. */
export function excerpt(line: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean;
}

/** `list.txt` gives `list-sanitized.txt`, `list` gives `list-sanitized`. */
export function suffixed(file: string, suffix: string): string {
  const name = basename(file);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  return join(dirname(file), `${stem}${suffix}${extension}`);
}

/**
 * What the file holds, printed before the benchmark's first request (last chance to notice a
 * broken list before spending quota) and by `npm run sanitize`.
 */
export function listReport(title: string, file: string, at: Date, lines: number, entries: Entry[]): string {
  const out: string[] = [];
  const add = (line = ''): number => out.push(line);

  const malformed = entries.filter((entry) => entry.invalid);

  add(`${title} - ${basename(file)}`);
  add(`  ${at.toISOString()}`);
  add();

  add('Input');
  add(`  lines read           ${lines}`);
  add(`  VAT numbers          ${entries.length}`);
  add(
    `  malformed            ${malformed.length}` +
      (malformed.length > 0 ? `   (${describe(countBy(malformed, (entry) => entry.invalid!.reason))})` : ''),
  );

  const repeats = [...countBy(entries, (entry) => entry.vatNumber).entries()].filter(([, count]) => count > 1);
  const duplicated = repeats.reduce((total, [, count]) => total + count - 1, 0);
  add(
    `  duplicates           ${duplicated}` +
      (duplicated > 0 ? `   (${repeats.length} number${repeats.length > 1 ? 's' : ''} appearing more than once)` : ''),
  );
  for (const [vatNumber, count] of repeats.sort((a, b) => b[1] - a[1]).slice(0, EXAMPLES)) {
    add(`        ${vatNumber} x ${count}`);
  }
  if (repeats.length > EXAMPLES) add(`        ... and ${repeats.length - EXAMPLES} more`);
  add(`  usable               ${entries.length - malformed.length}`);
  add();

  // Every EU country, zeros included, so a missing country is visible.
  add('Numbers per country');
  const perCountry = countBy(entries, (entry) => entry.countryCode);
  for (const rule of Object.values(VAT_RULES)) {
    add(`  ${rule.code}  ${rule.name.padEnd(18)} ${String(perCountry.get(rule.code) ?? 0).padStart(6)}`);
  }
  const unknown = perCountry.get('??') ?? 0;
  if (unknown > 0) add(`  ??  ${'unknown prefix'.padEnd(18)} ${String(unknown).padStart(6)}`);

  // A few examples per rejection reason: a big count of UNKNOWN_COUNTRY can be a header, a second
  // column or the wrong file, and only examples tell which.
  const reasons = [...countBy(malformed, (entry) => entry.invalid!.reason).entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of reasons) {
    add(`        ${reason} ${count}`);
    const samples = malformed.filter((entry) => entry.invalid!.reason === reason).slice(0, EXAMPLES);
    for (const sample of samples) add(`          ${excerpt(sample.input)}`);
    if (count > samples.length) add(`          ... and ${count - samples.length} more`);
  }
  add();

  return `${out.join('\n')}\n`;
}

/** The same facts as `listReport`, as data. Both are built from this shape. */
export interface ListStats {
  title: string;
  file: string;
  startedAt: string;
  input: {
    linesRead: number;
    vatNumbers: number;
    malformed: number;
    malformedByReason: Record<string, number>;
    duplicates: number;
    repeatedNumbers: number;
    usable: number;
  };
  /** Every country the service knows, zeros included. */
  perCountry: Record<string, number>;
  /** Numbers with a prefix no country here has, if any. */
  unknownPrefix: number;
}

export function listStats(title: string, file: string, at: Date, lines: number, entries: Entry[]): ListStats {
  const malformed = entries.filter((entry) => entry.invalid);
  const repeats = [...countBy(entries, (entry) => entry.vatNumber).entries()].filter(([, count]) => count > 1);

  const perCountry: Record<string, number> = {};
  const counts = countBy(entries, (entry) => entry.countryCode);
  for (const rule of Object.values(VAT_RULES)) perCountry[rule.code] = counts.get(rule.code) ?? 0;

  return {
    title,
    file: basename(file),
    startedAt: at.toISOString(),
    input: {
      linesRead: lines,
      vatNumbers: entries.length,
      malformed: malformed.length,
      malformedByReason: Object.fromEntries(countBy(malformed, (entry) => entry.invalid!.reason)),
      duplicates: repeats.reduce((total, [, count]) => total + count - 1, 0),
      repeatedNumbers: repeats.length,
      usable: entries.length - malformed.length,
    },
    perCountry,
    unknownPrefix: counts.get('??') ?? 0,
  };
}

/** Flags without value, shared by both commands. */
export const COMMON_FLAGS = ['--help', '-h'];

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function numberOption(args: string[], name: string, fallback: number): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} expects a positive number, got "${raw}"`);
  }
  return Math.floor(value);
}

/**
 * Parses arguments and refuses anything unknown: a misspelled `--stats-only` must not run the whole
 * list against the API and spend quota. Only the first positional argument is the file; a second is
 * usually the value of a mistyped option, so it is refused too.
 */
export function parseArgs(
  args: string[],
  valueOptions: string[],
  flagOptions: string[],
): { file?: string; error?: string } {
  let file: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('-')) {
      if (valueOptions.includes(arg)) {
        if (args[index + 1] === undefined) return { error: `${arg} expects a value` };
        index += 1;
        continue;
      }
      if (flagOptions.includes(arg) || COMMON_FLAGS.includes(arg)) continue;
      return { error: `Unknown option "${arg}"` };
    }
    if (file !== undefined) return { error: `Unexpected argument "${arg}"` };
    file = arg;
  }

  return { file };
}
