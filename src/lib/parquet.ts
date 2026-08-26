import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { FileMetaData } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { CsvRow } from './csv.js';

export interface ParquetOptions {
  /**
   * Columns to read. Parquet is columnar, so other columns are never read or decompressed. A column
   * missing from the file is ignored, like in CSV where `readColumn` returns null.
   */
  columns?: string[];
}

/**
 * Streams a Parquet file one row at a time, like `streamCsv`.
 *
 * Read one row group at a time, so memory stays at one group of the requested columns.
 */
export async function* streamParquet(path: string, options: ParquetOptions = {}): AsyncGenerator<CsvRow> {
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const columns = project(metadata, options.columns);

  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const rows = await parquetReadObjects({
      file,
      metadata,
      columns,
      compressors,
      rowStart,
      rowEnd,
    });

    for (const row of rows) {
      const text: CsvRow = {};
      for (const [key, value] of Object.entries(row)) {
        text[key] = toText(value);
      }
      yield text;
    }

    rowStart = rowEnd;
  }
}

/**
 * Keeps only the columns the file has: hyparquet refuses unknown columns, and a renamed column
 * should read as null rather than abort the import.
 */
function project(metadata: FileMetaData, columns: string[] | undefined): string[] | undefined {
  if (!columns) return undefined;
  const available = new Set(parquetSchema(metadata).children.map((child) => child.element.name));
  return columns.filter((column) => available.has(column));
}

const utf8 = new TextDecoder();

/**
 * Renders a Parquet value as the text the CSV edition would hold.
 *
 * Adapters are written against CSV and read everything through `readColumn`, so converting back to
 * text lets a source switch formats without touching its mapper.
 *
 * `Date` matters: SIRENE timestamps are Paris local time without zone, stored by the publisher as if
 * UTC. Rendering them without zone gives the same text as the CSV, so
 * `parseZonedDateTime(value, 'Europe/Paris')` still works.
 */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 19);
  if (value instanceof Uint8Array) return utf8.decode(value);
  return String(value);
}
