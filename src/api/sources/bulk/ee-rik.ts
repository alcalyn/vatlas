import { openZipEntry } from '../../../lib/zip.js';
import { readColumn, streamCsv, type CsvRow } from '../../../lib/csv.js';
import { parseUtcDayMonthYear } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * RIK, the Estonian e-Business Register. The daily "basic data" file already contains the VAT
 * number (`kmkr_nr`), so nothing has to be joined. The simplest importer, a good model for new
 * ones.
 */
const BASIC_DATA_ZIP =
  'https://avaandmed.ariregister.rik.ee/sites/default/files/avaandmed/ettevotja_rekvisiidid__lihtandmed.csv.zip';

/** The cache slot, also the name `--file <slot>=<path>` takes for Estonia. */
const SLOT = 'ee_lihtandmed.csv.zip';

export const SOURCE = 'RIK';

/** Maps one row, or null when the company is not VAT registered. */
export function mapEstonianRow(row: CsvRow): CompanyRecord | null {
  const rawVat = readColumn(row, ['kmkr_nr']);
  if (!rawVat) return null;

  const normalized = rawVat.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vatNumber = normalized.startsWith('EE') ? normalized.slice(2) : normalized;
  if (!/^[0-9]{9}$/.test(vatNumber)) return null;

  // "R" is a registered legal person. Anything else (liquidation, bankruptcy, deleted) is inactive.
  const statusCode = readColumn(row, ['ettevotja_staatus']);

  return {
    vatNumber: `EE${vatNumber}`,
    nationalId: readColumn(row, ['ariregistri_kood']),
    name: readColumn(row, ['nimi']),
    legalForm: readColumn(row, ['ettevotja_oiguslik_vorm']),
    status: statusCode === 'R' ? 'active' : 'inactive',
    addressLine1:
      readColumn(row, ['ads_normaliseeritud_taisaadress']) ??
      readColumn(row, ['ettevotja_aadress', 'asukoht_ettevotja_aadressis']),
    addressLine2: null,
    postalCode: readColumn(row, ['indeks_ettevotja_aadressis']),
    city: readColumn(row, ['asukoha_ehak_tekstina']),
    addressCountry: 'EE',
    companyLastUpdatedAt: parseUtcDayMonthYear(readColumn(row, ['ettevotja_esmakande_kpv'])),
  };
}

export class RikBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'e-Business Register open data (RIK)';
  readonly countryCode = 'EE';
  override readonly slots = [SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    // Same URL every day, so the date comes from a HEAD before downloading.
    const archive = await this.fetchArtefact(context, SLOT, {
      url: BASIC_DATA_ZIP,
      fileName: 'ettevotja_rekvisiidid__lihtandmed.csv.zip',
    });
    const entry = await openZipEntry(archive.path, (fileName) => fileName.endsWith('.csv'));

    const batch = this.batch(context, counters);
    for await (const row of streamCsv(entry, { delimiter: ';' })) {
      const record = mapEstonianRow(row);
      // Skip nameless rows.
      await batch.add(record?.name ? record : null);
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Estonia: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
  }
}

export const rikBulk = new RikBulkSource();
