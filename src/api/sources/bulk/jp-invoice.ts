import { streamCsvRows } from '../../../lib/csv.js';
import { parseUtcCompactDate, parseUtcDate } from '../../../lib/time.js';
import { listZipEntries, openZipEntry } from '../../../lib/zip.js';
import type { CompanyRecord } from '../../types.js';
import { ArtefactAlreadyImportedError, BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The National Tax Agency's register of qualified invoice issuers: an actual VAT register. The
 * 登録番号 (`T` + the thirteen digits of the 法人番号) is the consumption tax registration number
 * printed on Japanese invoices.
 *
 * Republished on the first working day of each month, in about twelve zipped CSVs: corporations,
 * unincorporated associations and individuals. No account.
 *
 * Download links contain a management number that changes with each edition, so they are read
 * from the download page (`doDownload('5075','2','01')`).
 *
 * The file is a history: a number can appear once per event, and only the row flagged 最新履歴 = 1
 * is current. Older rows have no name or address.
 */
const DOWNLOAD_PAGE = 'https://www.invoice-kohyo.nta.go.jp/download/zenken';
const FILE_URL = (id: string, kind: string): string =>
  `https://www.invoice-kohyo.nta.go.jp/download/zenken/dlfile?dlFilKanriNo=${id}&jinkakukbn=${kind}&type=01`;

/**
 * The three 人格区分 (corporations, unincorporated associations, individuals) and how many cache
 * slots each gets. `type=01` is the CSV format.
 *
 * `slots` is a maximum: the number of files grows with the register.
 */
const KINDS = [
  { code: '2', prefix: 'h', slots: 8 },
  { code: '3', prefix: 'k', slots: 2 },
  { code: '1', prefix: 's', slots: 8 },
] as const;

const SLOTS = KINDS.flatMap(({ prefix, slots }) =>
  Array.from({ length: slots }, (_, index) => `jp_invoice_${prefix}_${index + 1}.zip`),
);

/** The NTA answers 403 without a `User-Agent`, and Node sends none by default. */
const HEADERS = { 'user-agent': 'vatlas/1.0 (+https://vatlas.dev)' };

export const SOURCE = 'NTA';

/** Column positions from the NTA's resource definition. The file has no header. */
const COLUMN = {
  registeredNumber: 1,
  latest: 6,
  registrationDate: 7,
  updateDate: 8,
  disposalDate: 9,
  expireDate: 10,
  address: 11,
  addressRequest: 14,
  name: 18,
  addressInside: 19,
} as const;

const cell = (row: string[], index: number): string | null => {
  const value = row[index]?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

/**
 * Maps one row. Null for a superseded history row, and for a registration whose holder did not
 * consent to publishing their name (most individuals).
 *
 * `asOf` is the file's date: 失効年月日 (lapse date) is often in the future, so whether a
 * registration is live depends on the file date, not today.
 */
export function mapInvoiceRow(row: string[], asOf: Date): CompanyRecord | null {
  const registered = cell(row, COLUMN.registeredNumber);
  if (!registered || !/^T[0-9]{13}$/.test(registered)) return null;
  // 最新履歴: 1 is the current state, 0 a past event.
  if (cell(row, COLUMN.latest) !== '1') return null;

  const lapsed = (value: string | null): boolean => {
    const date = parseUtcDate(value);
    return date !== null && date.getTime() <= asOf.getTime();
  };

  return {
    vatNumber: `JP${registered}`,
    // The national identifier is the 法人番号. The `T` belongs to the invoice number.
    nationalId: registered.slice(1),
    name: cell(row, COLUMN.name),
    // No legal form: in Japanese it is part of the name.
    legalForm: null,
    // 取消 (struck off) and 失効 (lapsed) end the registration, unless the date is in the future.
    status: lapsed(cell(row, COLUMN.disposalDate)) || lapsed(cell(row, COLUMN.expireDate)) ? 'inactive' : 'active',
    // Head office, published address, or place of business in Japan of a foreign issuer, in that
    // order.
    addressLine1: cell(row, COLUMN.address) ?? cell(row, COLUMN.addressRequest) ?? cell(row, COLUMN.addressInside),
    addressLine2: null,
    // The address is one string, without postcode or separate locality. Prefecture and city are codes
    // the register does not resolve.
    postalCode: null,
    city: null,
    addressCountry: 'JP',
    companyLastUpdatedAt: parseUtcDate(cell(row, COLUMN.updateDate) ?? cell(row, COLUMN.registrationDate)),
  };
}

/**
 * Management numbers of the CSV files, in page order, per 人格区分.
 *
 * Exported for the unit test against a committed fixture.
 */
export function parseDownloadIds(html: string): Map<string, string[]> {
  const byKind = new Map<string, string[]>();
  for (const match of html.matchAll(/doDownload\('(\d+)','([123])','01'\)/g)) {
    const [, id, kind] = match;
    if (!id || !kind) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  }
  return byKind;
}

/** `h_all_20260831_001.csv`: the only place the edition date is written. */
export function editionDateOf(entryName: string): Date | null {
  const match = /_(\d{8})_/.exec(entryName);
  return parseUtcCompactDate(match?.[1]);
}

export class InvoiceRegistryBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Qualified invoice issuer registry (National Tax Agency)';
  readonly countryCode = 'JP';
  override readonly slots = SLOTS;

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const byKind = await this.downloadIds(context);
    const batch = this.batch(context, counters);
    // Resolved from the first file and reused: the files form one monthly edition.
    let date: Date | null = null;

    for (const { code, prefix, slots } of KINDS) {
      const ids = byKind.get(code) ?? [];
      if (ids.length > slots) {
        context.logger.warn(
          { kind: code, offered: ids.length, slots },
          'Japan: the download page offers more files than this source has cache slots for',
        );
      }

      for (const [index, id] of ids.slice(0, slots).entries()) {
        const slot = `jp_invoice_${prefix}_${index + 1}.zip`;
        const url = FILE_URL(id, code);
        // The edition date is only inside the zip, but the management number in the URL changes with each
        // edition. So a URL already imported means an edition already imported, decided from the first
        // file before downloading.
        if (date === null && (await context.alreadyImportedUrl(url))) {
          throw new ArtefactAlreadyImportedError(`${url} has already been imported in full`);
        }
        const archive = await this.download(context, url, slot, { headers: HEADERS });
        const entries = await listZipEntries(archive.path, (name) => name.toLowerCase().endsWith('.csv'));
        const entry = entries[0];
        if (!entry) throw new Error(`${slot} holds no CSV`);

        const found = editionDateOf(entry);
        if (date === null) date = found;
        else if (found && found.getTime() !== date.getTime()) {
          context.logger.warn(
            { file: entry, expected: date, found },
            'Japan: this file belongs to another edition; filing it under the first one read',
          );
        }

        await context.useArtefact(this.artefactOf(context, slot, { url, fileName: entry, date }));

        // `asOf` is the edition date, whatever a file claims.
        const asOf = this.published(date, context);
        const stream = await openZipEntry(archive.path, (name) => name === entry);
        for await (const row of streamCsvRows(stream)) {
          const record = mapInvoiceRow(row, asOf);
          // Skip nameless rows. Most individuals withhold their name, so this is common here.
          await batch.add(record?.name ? record : null);
          if (batch.full) {
            context.logger.info({ limit: context.options.limit }, 'Japan: sample limit reached, stopping');
            stream.destroy();
            await batch.flush();
            return;
          }
        }
      }
    }

    await batch.flush();
  }

  /** Reads the download page, the only place that names this month's files. */
  private async downloadIds(context: ImportContext): Promise<Map<string, string[]>> {
    const response = await fetch(DOWNLOAD_PAGE, { redirect: 'follow', headers: HEADERS });
    if (!response.ok) {
      throw new Error(`the invoice registry download page failed: HTTP ${response.status} ${response.statusText}`);
    }
    const byKind = parseDownloadIds(await response.text());
    if (byKind.size === 0) throw new Error('the invoice registry download page lists no file');
    context.logger.info(
      { files: [...byKind.values()].reduce((total, ids) => total + ids.length, 0) },
      'Japan: read the download page',
    );
    return byKind;
  }
}

export const invoiceRegistryBulk = new InvoiceRegistryBulkSource();
