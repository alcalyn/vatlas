import { fetchJson } from '../../../lib/http.js';
import { readColumn, type CsvRow } from '../../../lib/csv.js';
import { streamParquet } from '../../../lib/parquet.js';
import { parseZonedDateTime } from '../../../lib/time.js';
import { frenchLegalForm } from './frenchLegalForms.js';
import { frenchVatNumber } from '../../../vat/rules.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * SIRENE, INSEE's register of every French business. The largest import, and the only one with
 * identity and address in two separate files.
 *
 * `StockUniteLegale` holds the legal unit (SIREN, name, legal form, status) and no address.
 * `StockEtablissement` holds every establishment (2.2 GB), of which the head office
 * (`etablissementSiege`) gives the company's address.
 *
 * Both files are sorted by SIREN and merged while streaming, with one cursor each, so each row is
 * complete when written and nothing is held in memory.
 *
 * The Parquet versions are used: smaller to download, and only the needed columns are read (eleven
 * of the fifty in `StockEtablissement`). `streamParquet` returns rows as text, like the CSV.
 *
 * INSEE changes the URLs every month, so they are resolved from the dataset API.
 */
const DATASET_API = 'https://www.data.gouv.fr/api/1/datasets/5b7ffc618b4c4169d30727e0/';

export const SOURCE = 'SIRENE';

/** The two cache slots, also the names `--file <slot>=<path>` takes for France. */
const LEGAL_UNITS_SLOT = 'fr_stock_unite_legale.parquet';
const ESTABLISHMENTS_SLOT = 'fr_stock_etablissement.parquet';

interface DataGouvDataset {
  resources: { title?: string; format?: string; url?: string; filesize?: number }[];
}

/** The last path segment of a URL, which is how INSEE names its files. */
export function fileNameOf(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
}

/** Picks the resource whose URL ends with the given suffix. */
export async function resolveResourceUrl(suffix: string): Promise<string> {
  const dataset = await fetchJson<DataGouvDataset>(DATASET_API, { timeoutMs: 30_000 });
  const resource = dataset.resources.find((item) => item.url?.endsWith(suffix));
  if (!resource?.url) {
    throw new Error(`No SIRENE resource ending with "${suffix}" found on data.gouv.fr`);
  }
  return resource.url;
}

/**
 * Columns read by `mapLegalUnitRow` and `frenchName`. A column missing here silently reads as
 * null.
 */
const LEGAL_UNIT_COLUMNS = [
  'siren',
  'denominationUniteLegale',
  'prenomUsuelUniteLegale',
  'prenom1UniteLegale',
  'nomUsageUniteLegale',
  'nomUniteLegale',
  'categorieJuridiqueUniteLegale',
  'etatAdministratifUniteLegale',
  'dateDernierTraitementUniteLegale',
];

/** Display name of a legal unit: company name, or the person's name. */
export function frenchName(row: CsvRow): string {
  const denomination = readColumn(row, ['denominationUniteLegale']);
  if (denomination) return denomination;

  const firstName = readColumn(row, ['prenomUsuelUniteLegale', 'prenom1UniteLegale']);
  const lastName = readColumn(row, ['nomUsageUniteLegale']) ?? readColumn(row, ['nomUniteLegale']);
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

/** The address part of a record, from the head office pass. */
export type FrenchAddress = Pick<
  CompanyRecord,
  'addressLine1' | 'addressLine2' | 'postalCode' | 'city' | 'addressCountry'
>;

const NO_ADDRESS: FrenchAddress = {
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  addressCountry: 'FR',
};

/**
 * Maps one StockUniteLegale row with its head office address, or null when the SIREN or name is
 * unusable.
 */
export function mapLegalUnitRow(row: CsvRow, address: FrenchAddress = NO_ADDRESS): CompanyRecord | null {
  const siren = readColumn(row, ['siren']);
  if (!siren || !/^[0-9]{9}$/.test(siren)) return null;

  const name = frenchName(row);
  if (!name) return null;

  // Timestamp without zone, in French local time.
  const lastProcessed = readColumn(row, ['dateDernierTraitementUniteLegale']);

  return {
    // The VAT number is derived from the SIREN.
    vatNumber: `FR${frenchVatNumber(siren)}`,
    nationalId: siren,
    name,
    // Keeps the INSEE code when the nomenclature has no label.
    legalForm: legalFormLabel(readColumn(row, ['categorieJuridiqueUniteLegale'])),
    status: readColumn(row, ['etatAdministratifUniteLegale']) === 'A' ? 'active' : 'inactive',
    ...address,
    companyLastUpdatedAt: parseZonedDateTime(lastProcessed, 'Europe/Paris'),
  };
}

function legalFormLabel(code: string | null): string | null {
  return frenchLegalForm(code) ?? code;
}

/** One head office: its SIREN and address. */
export interface HeadOffice {
  siren: string;
  address: FrenchAddress;
}

/** Columns read by `mapHeadOfficeRow`: eleven of the fifty in `StockEtablissement`. */
const HEAD_OFFICE_COLUMNS = [
  'siren',
  'etablissementSiege',
  'numeroVoieEtablissement',
  'indiceRepetitionEtablissement',
  'typeVoieEtablissement',
  'libelleVoieEtablissement',
  'complementAdresseEtablissement',
  'codePostalEtablissement',
  'libelleCommuneEtablissement',
  'libelleCommuneEtrangerEtablissement',
  'libellePaysEtrangerEtablissement',
];

/** Maps a head office row, or null for any other establishment. */
export function mapHeadOfficeRow(row: CsvRow): HeadOffice | null {
  if (readColumn(row, ['etablissementSiege']) !== 'true') return null;

  const siren = readColumn(row, ['siren']);
  if (!siren || !/^[0-9]{9}$/.test(siren)) return null;

  const street = [
    readColumn(row, ['numeroVoieEtablissement']),
    readColumn(row, ['indiceRepetitionEtablissement']),
    readColumn(row, ['typeVoieEtablissement']),
    readColumn(row, ['libelleVoieEtablissement']),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  const foreignCountry = readColumn(row, ['libellePaysEtrangerEtablissement']);

  return {
    siren,
    address: {
      addressLine1: street.length > 0 ? street : null,
      addressLine2: readColumn(row, ['complementAdresseEtablissement']),
      postalCode: readColumn(row, ['codePostalEtablissement']),
      city:
        readColumn(row, ['libelleCommuneEtablissement']) ?? readColumn(row, ['libelleCommuneEtrangerEtablissement']),
      addressCountry: foreignCountry ? null : 'FR',
    },
  };
}

export class SireneBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'SIRENE (INSEE)';
  readonly countryCode = 'FR';
  override readonly slots = [LEGAL_UNITS_SLOT, ESTABLISHMENTS_SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    // An old file imported from disk has no URL anymore, so the dataset API is only asked when
    // something must be downloaded.
    const legalUnitsUrl = context.options.localFiles?.has(LEGAL_UNITS_SLOT)
      ? ''
      : await resolveResourceUrl('stock-stockunitelegale-parquet.parquet');
    // The legal unit file gives the row's identity, so it is the one recorded in `bulk`. Declared
    // before downloading, so a month already imported fetches nothing.
    const archive = await this.fetchArtefact(context, LEGAL_UNITS_SLOT, {
      url: legalUnitsUrl,
      fileName: legalUnitsUrl ? fileNameOf(legalUnitsUrl) : '',
    });

    const headOffices = await this.headOffices(context);

    const batch = this.batch(context, counters);
    for await (const row of streamParquet(archive.path, { columns: LEGAL_UNIT_COLUMNS })) {
      const siren = readColumn(row, ['siren']);
      await batch.add(mapLegalUnitRow(row, siren === null ? NO_ADDRESS : await headOffices.at(siren)));

      if (counters.fetched > 0 && counters.fetched % 500_000 === 0) {
        context.logger.info({ fetched: counters.fetched }, 'France: legal units imported so far');
      }
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'France: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
  }

  /**
   * A cursor over the head offices of `StockEtablissement`, advanced by the legal unit pass.
   *
   * Both files are sorted by SIREN (nine digits, so text and numeric order agree), so one cursor on
   * each is a complete join and the establishment file is read exactly once.
   */
  private async headOffices(context: ImportContext): Promise<HeadOfficeCursor> {
    const url = context.options.localFiles?.has(ESTABLISHMENTS_SLOT)
      ? ''
      : await resolveResourceUrl('stock-stocketablissement-parquet.parquet');
    const archive = await this.download(context, url, ESTABLISHMENTS_SLOT);

    async function* offices(): AsyncGenerator<HeadOffice> {
      for await (const row of streamParquet(archive.path, { columns: HEAD_OFFICE_COLUMNS })) {
        const office = mapHeadOfficeRow(row);
        if (office) yield office;
      }
    }

    return new HeadOfficeCursor(offices(), context);
  }
}

/**
 * The establishment side of the merge: asked one SIREN at a time, in ascending order.
 *
 * Unsorted input would silently lose addresses, so the order is checked and a warning logged.
 */
class HeadOfficeCursor {
  private current: HeadOffice | null = null;
  private done = false;
  private lastAsked = '';
  private warned = false;

  constructor(
    private readonly offices: AsyncGenerator<HeadOffice>,
    private readonly context: ImportContext,
  ) {}

  /** The head office address of this SIREN, or an empty one. */
  async at(siren: string): Promise<FrenchAddress> {
    if (siren < this.lastAsked) this.warnUnsorted('legal units', this.lastAsked, siren);
    this.lastAsked = siren;

    while (!this.done && (this.current === null || this.current.siren < siren)) {
      const previous = this.current?.siren ?? '';
      const next = await this.offices.next();
      if (next.done) {
        this.done = true;
        this.current = null;
        break;
      }
      if (next.value.siren < previous) this.warnUnsorted('establishments', previous, next.value.siren);
      this.current = next.value;
    }

    return this.current?.siren === siren ? this.current.address : NO_ADDRESS;
  }

  private warnUnsorted(file: string, previous: string, current: string): void {
    if (this.warned) return;
    this.warned = true;
    this.context.logger.warn(
      { file, previous, current },
      'SIRENE stock file is not ordered by SIREN: addresses past this point will be missing',
    );
  }
}

export const sireneBulk = new SireneBulkSource();
