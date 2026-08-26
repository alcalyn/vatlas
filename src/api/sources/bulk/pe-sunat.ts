import { streamCsvRows } from '../../../lib/csv.js';
import { listZipEntries, openZipEntry } from '../../../lib/zip.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * SUNAT's *padrón reducido*, the Peruvian tax register: 18 million RUCs in one pipe-separated file,
 * rebuilt daily, no account.
 *
 * The RUC is the number on Peruvian invoices.
 *
 * - The file is latin-1. Read as UTF-8, every accented name breaks.
 * - The locality is a six-digit UBIGEO with no published table. The first two digits are the
 *   department, which is kept. The district is not resolved.
 * - A few rows have a `|` inside the name and one field too many. They are skipped like other
 *   malformed lines.
 */
const ARCHIVE_URL = 'http://www2.sunat.gob.pe/padron_reducido_ruc.zip';
const SLOT = 'pe_padron_reducido.zip';

export const SOURCE = 'SUNAT';

/** Column positions of `padron_reducido_ruc.txt`, which has a header line. */
const COLUMN = {
  ruc: 0,
  name: 1,
  status: 2,
  // `condición de domicilio`: HABIDO / NO HABIDO, whether SUNAT finds the taxpayer at the declared
  // address. Not part of `CompanyRecord`. Named for the reader.
  condition: 3,
  ubigeo: 4,
  streetType: 5,
  streetName: 6,
  // The header names these the other way round, but the data has the type first:
  // `...|URB.|PANDO III ETAPA|...`.
  zoneType: 7,
  zoneCode: 8,
  number: 9,
  interior: 10,
  lot: 11,
  apartment: 12,
  block: 13,
  kilometre: 14,
} as const;

/** The 25 departments and Callao, keyed by the first two UBIGEO digits. */
const DEPARTMENTS: Record<string, string> = {
  '01': 'Amazonas',
  '02': 'Áncash',
  '03': 'Apurímac',
  '04': 'Arequipa',
  '05': 'Ayacucho',
  '06': 'Cajamarca',
  '07': 'Callao',
  '08': 'Cusco',
  '09': 'Huancavelica',
  '10': 'Huánuco',
  '11': 'Ica',
  '12': 'Junín',
  '13': 'La Libertad',
  '14': 'Lambayeque',
  '15': 'Lima',
  '16': 'Loreto',
  '17': 'Madre de Dios',
  '18': 'Moquegua',
  '19': 'Pasco',
  '20': 'Piura',
  '21': 'Puno',
  '22': 'San Martín',
  '23': 'Tacna',
  '24': 'Tumbes',
  '25': 'Ucayali',
};

export function departmentOf(ubigeo: string | null): string | null {
  if (!ubigeo || ubigeo.length < 2) return null;
  return DEPARTMENTS[ubigeo.slice(0, 2)] ?? null;
}

/** Missing values are written as a single hyphen. */
const cell = (row: string[], index: number): string | null => {
  const value = row[index]?.trim();
  if (value === undefined || value.length === 0 || value === '-' || /^-+$/.test(value)) return null;
  return value;
};

/**
 * `ACTIVO` and `SUSPENSION TEMPORAL` (temporarily stopped trading) are live. `BAJA`, `ANULACION`
 * and `INHABILITADO` have ended. The rest says nothing either way.
 */
export function peruvianStatus(estado: string | null): CompanyRecord['status'] {
  if (!estado) return 'unknown';
  if (estado === 'ACTIVO' || estado.startsWith('SUSPENSION')) return 'active';
  if (estado.startsWith('BAJA') || estado.startsWith('ANUL') || estado.startsWith('INHABILITADO')) {
    return 'inactive';
  }
  return 'unknown';
}

/** `AV. JOSE PARDO 601 INT. 1603`, in Peruvian address order. */
function streetLine(row: string[]): string | null {
  const interior = cell(row, COLUMN.interior);
  const parts = [
    cell(row, COLUMN.streetType),
    cell(row, COLUMN.streetName),
    cell(row, COLUMN.number),
    interior ? `INT. ${interior}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Urbanisation, block, lot, apartment and kilometre, whichever the row has. */
function complementLine(row: string[]): string | null {
  const label = (prefix: string, index: number): string | null => {
    const value = cell(row, index);
    return value ? `${prefix} ${value}` : null;
  };
  const parts = [
    [cell(row, COLUMN.zoneType), cell(row, COLUMN.zoneCode)].filter(Boolean).join(' ') || null,
    label('MZA.', COLUMN.block),
    label('LOTE', COLUMN.lot),
    label('DPTO.', COLUMN.apartment),
    label('KM.', COLUMN.kilometre),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function mapPaddedRucRow(row: string[]): CompanyRecord | null {
  const ruc = cell(row, COLUMN.ruc)?.replace(/[^0-9]/g, '');
  if (!ruc || ruc.length !== 11) return null;
  // Rows with a `|` in the name have shifted columns. The header line also lands here (its first
  // field is "RUC").
  if (row.length !== 16) return null;

  const ubigeo = cell(row, COLUMN.ubigeo);

  return {
    vatNumber: `PE${ruc}`,
    nationalId: ruc,
    name: cell(row, COLUMN.name),
    // No legal form column: it is the suffix of the name (S.A.C., S.R.L., E.I.R.L.).
    legalForm: null,
    status: peruvianStatus(cell(row, COLUMN.status)),
    addressLine1: streetLine(row),
    addressLine2: complementLine(row),
    // No postal codes in the register.
    postalCode: null,
    city: departmentOf(ubigeo),
    addressCountry: 'PE',
    companyLastUpdatedAt: null,
  };
}

export class SunatBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Padrón reducido RUC (SUNAT)';
  readonly countryCode = 'PE';
  override readonly slots = [SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    // Fixed URL dated by `Last-Modified`, so a HEAD identifies the edition before downloading 390 MB.
    const archive = await this.fetchArtefact(context, SLOT, {
      url: ARCHIVE_URL,
      fileName: 'padron_reducido_ruc.txt',
    });

    const entries = await listZipEntries(archive.path, (name) => name.toLowerCase().endsWith('.txt'));
    const entry = entries[0];
    if (!entry) throw new Error(`${SLOT} holds no padrón file`);

    const batch = this.batch(context, counters);
    const stream = await openZipEntry(archive.path, (name) => name === entry);

    for await (const row of streamCsvRows(stream, {
      delimiter: '|',
      encoding: 'latin1',
      // The file uses no quoting, and a stray `"` in a name would swallow the rest of the file.
      quote: '\0',
    })) {
      const record = mapPaddedRucRow(row);
      await batch.add(record?.name ? record : null);
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Peru: sample limit reached, stopping');
        stream.destroy();
        await batch.flush();
        return;
      }
    }

    await batch.flush();
  }
}

export const sunatBulk = new SunatBulkSource();
