import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';

export type CsvRow = Record<string, string>;

export interface CsvOptions {
  delimiter?: string;
  /** Strip a UTF-8 byte order mark, which several portals ship. */
  bom?: boolean;
  quote?: string;
  /** Encoding. UTF-8 everywhere except the Brazilian CNPJ files, which are latin-1. */
  encoding?: BufferEncoding;
}

/** Streams a CSV with a header line as objects, one row at a time. */
export async function* streamCsv(input: Readable, options: CsvOptions = {}): AsyncGenerator<CsvRow> {
  const parser = input.pipe(
    parse({
      columns: true,
      bom: options.bom ?? true,
      delimiter: options.delimiter ?? ',',
      quote: options.quote ?? '"',
      encoding: options.encoding ?? 'utf8',
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: false,
    }),
  );

  for await (const row of parser) {
    yield row as CsvRow;
  }
}

/**
 * Same, by position, for files without a header line (Japanese invoice extract, CNPJ tables).
 * Their mappers take a `string[]`.
 */
export async function* streamCsvRows(input: Readable, options: CsvOptions = {}): AsyncGenerator<string[]> {
  const parser = input.pipe(
    parse({
      columns: false,
      bom: options.bom ?? true,
      delimiter: options.delimiter ?? ',',
      quote: options.quote ?? '"',
      encoding: options.encoding ?? 'utf8',
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: false,
    }),
  );

  for await (const row of parser) {
    yield row as string[];
  }
}

/**
 * Finds a column among several candidate names, case-insensitive: portals rename columns between
 * releases.
 */
export function pickColumn(row: CsvRow, candidates: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find((key) => key.trim().toLowerCase() === candidate.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

/** Reads a value from several possible column names. Null when all are missing or blank. */
export function readColumn(row: CsvRow, candidates: string[]): string | null {
  const key = pickColumn(row, candidates);
  if (!key) return null;
  const value = row[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
