import { createReadStream } from 'node:fs';
import { readColumn, streamCsv, type CsvRow } from '../../../lib/csv.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * Latvia is three open-data files joined by the importer.
 *
 * The whole run is filed under the Business Register's date, since the files form one edition.
 * Otherwise a company's history would jump when it moves from one file to another. `bulk_id` still
 * names the file each row was read from.
 */

/** VID public database of VAT payers (comma separated, quoted, UTF-8 BOM). */
const VAT_PAYERS_CSV =
  'https://data.gov.lv/dati/dataset/9a5eae1c-2438-48cf-854b-6a2c170f918f/resource/610910e9-e086-4c5b-a7ea-0a896a697672/download/pdb_pvnmaksataji_odata.csv';

/** Business Register of Latvia, full company list (semicolon separated). */
const REGISTER_CSV =
  'https://data.gov.lv/dati/dataset/4de9697f-850b-45ec-8bba-61fa09ce932f/resource/25e80bf3-f107-4ab4-89ef-251b5b9374e9/download/register.csv';

/**
 * The list of public persons and institutions (universities, research institutes, courts,
 * ministries, municipalities). They have a registration code and a VAT number but are not in the
 * Business Register.
 *
 * The VAT payers file has about 6,600 such bodies and `register.csv` only about 1,000, so this file
 * provides the addresses of the others.
 */
const PUBLIC_BODIES_CSV =
  'https://data.gov.lv/dati/dataset/2e4926ea-8648-44e6-9227-3cb20604ec31/resource/190ba502-08d1-4c4c-b1b9-b58299bf9a9f/download/ppi_public_persons_institutions.csv';

/** The three cache slots, also the names `--file <slot>=<path>` takes for Latvia. */
const REGISTER_SLOT = 'lv_register.csv';
const VAT_PAYERS_SLOT = 'lv_vat_payers.csv';
const PUBLIC_BODIES_SLOT = 'lv_public_bodies.csv';

export const SOURCE = 'UR_VID';

export interface VatPayerEntry {
  vatNumber: string;
  name: string | null;
  active: boolean;
  deregisteredAt: string | null;
}

/** Parses one row of the VAT payers file. `Numurs` already has the LV prefix. */
export function parseVatPayerRow(row: CsvRow): { registrationCode: string; entry: VatPayerEntry } | null {
  const number = readColumn(row, ['Numurs', 'numurs', 'PVN_numurs']);
  if (!number) return null;

  const normalized = number.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized.startsWith('LV')) return null;

  const vatNumber = normalized.slice(2);
  return {
    registrationCode: vatNumber,
    entry: {
      vatNumber,
      name: readColumn(row, ['Nosaukums', 'nosaukums']),
      // "ir" = yes, "nav" = no.
      active: (readColumn(row, ['Aktivs', 'aktivs']) ?? '').toLowerCase() === 'ir',
      deregisteredAt: readColumn(row, ['Izslegts', 'izslegts']),
    },
  };
}

/**
 * Latvian addresses go from the largest unit down, comma separated: "Rīga, Avotu iela 17", or
 * "Dundagas nov., Kolkas pag., Kolka, \"Krastnieki\"" in the countryside. Before the locality come
 * administrative units: *novads* (municipality), *pagasts* (parish) or *rajons* (old district).
 *
 * The `city` and `region` columns hold classifier ids ("100003003"), not names, so the town has to
 * be read from this string.
 */
const ADMINISTRATIVE_UNIT = /\s(?:nov|pag|rajons)\.?$/i;

export interface LatvianAddress {
  line1: string | null;
  city: string | null;
}

/**
 * Splits the address into the locality and what follows it. The first chunk that is not an
 * administrative unit is the town, the rest is the street (or the property name).
 */
export function splitLatvianAddress(raw: string | null | undefined): LatvianAddress {
  const chunks = (raw ?? '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const locality = chunks.findIndex((chunk) => !ADMINISTRATIVE_UNIT.test(chunk));
  if (locality === -1) {
    // Only administrative units: keep the whole string.
    return { line1: chunks.length > 0 ? chunks.join(', ') : null, city: null };
  }

  const rest = chunks.slice(locality + 1).join(', ');
  return { line1: rest.length > 0 ? rest : null, city: chunks[locality] ?? null };
}

/** A public body's registration code and address, from the public institutions list. */
export interface PublicBodyEntry {
  name: string | null;
  address: string | null;
}

export interface LatvianPublicBodyAddress {
  line1: string | null;
  city: string | null;
  postalCode: string | null;
}

/** Eleven digits. The file writes "0" when there is none. */
const REGISTRATION_CODE = /^\d{11}$/;

const LATVIAN_POSTAL_CODE = /^LV-?(\d{4})$/i;

/**
 * The public institutions list writes addresses the other way round: "Ķengaraga iela 8, Rīga,
 * LV-1063", street first and postal code last (like VIES). So the postal code is taken from the
 * end, the last chunk that is not an administrative unit is the town, and the rest is the street.
 *
 * About thirty rows have only a locality ("Rīga", or "Adamova, Vērēmu pag., Rēzeknes nov."): the
 * town is still found and `line1` stays null.
 */
export function parsePublicBodyAddress(raw: string | null | undefined): LatvianPublicBodyAddress {
  const chunks = (raw ?? '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const postal = LATVIAN_POSTAL_CODE.exec(chunks[chunks.length - 1] ?? '');
  if (postal) chunks.pop();
  const postalCode = postal ? `LV-${postal[1]}` : null;

  let locality = -1;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (!ADMINISTRATIVE_UNIT.test(chunks[index] ?? '')) {
      locality = index;
      break;
    }
  }

  if (locality === -1) {
    // Only administrative units: keep the whole string.
    return { line1: chunks.length > 0 ? chunks.join(', ') : null, city: null, postalCode };
  }

  const street = chunks.slice(0, locality).join(', ');
  return { line1: street.length > 0 ? street : null, city: chunks[locality] ?? null, postalCode };
}

/** Joins a Business Register row with its VAT payer entry. */
export function mapRegisterRow(row: CsvRow, entry: VatPayerEntry): CompanyRecord {
  const registrationCode = readColumn(row, ['regcode', 'reg_code']) ?? entry.vatNumber;
  const terminated = readColumn(row, ['terminated']);
  const postalCode = readColumn(row, ['index']);
  const address = splitLatvianAddress(readColumn(row, ['address']));

  return {
    vatNumber: `LV${entry.vatNumber}`,
    nationalId: registrationCode,
    name: readColumn(row, ['name']) ?? entry.name,
    legalForm: readColumn(row, ['type_text', 'regtype_text']),
    status: terminated || !entry.active ? 'inactive' : 'active',
    addressLine1: address.line1,
    addressLine2: null,
    postalCode: postalCode ? `LV-${postalCode.padStart(4, '0')}` : null,
    city: address.city,
    addressCountry: 'LV',
    companyLastUpdatedAt: null,
  };
}

/**
 * A VAT payer missing from the Business Register but in the public institutions list. Only the
 * address is used: `authorityType` is an English enumeration (`COURT`, ...), not a legal form, so
 * `legalForm` stays null.
 */
export function mapPublicBody(registrationCode: string, entry: VatPayerEntry, body: PublicBodyEntry): CompanyRecord {
  const address = parsePublicBodyAddress(body.address);

  return {
    vatNumber: `LV${entry.vatNumber}`,
    nationalId: registrationCode,
    name: entry.name ?? body.name,
    legalForm: null,
    status: entry.active ? 'active' : 'inactive',
    addressLine1: address.line1,
    addressLine2: null,
    postalCode: address.postalCode,
    city: address.city,
    addressCountry: 'LV',
    companyLastUpdatedAt: null,
  };
}

/** A VAT payer in neither register still gets a row. */
export function mapVatPayerOnly(registrationCode: string, entry: VatPayerEntry): CompanyRecord {
  return {
    vatNumber: `LV${entry.vatNumber}`,
    nationalId: registrationCode,
    name: entry.name,
    legalForm: null,
    status: entry.active ? 'active' : 'inactive',
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'LV',
    companyLastUpdatedAt: null,
  };
}

export class LatviaBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Uzņēmumu reģistrs / VID open data';
  readonly countryCode = 'LV';
  override readonly slots = [REGISTER_SLOT, VAT_PAYERS_SLOT, PUBLIC_BODIES_SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    // The register dates the run, so it is resolved first: an edition already imported costs no
    // download.
    const registerFile = await this.fetchArtefact(context, REGISTER_SLOT, {
      url: REGISTER_CSV,
      fileName: 'register.csv',
    });
    const editionDate = this.published(registerFile.lastModified, context);

    // Pass 1: the VAT payers file says which companies have a VAT number. Small enough to hold in
    // memory.
    const vatFile = await this.download(context, VAT_PAYERS_CSV, VAT_PAYERS_SLOT);

    const byRegistrationCode = new Map<string, VatPayerEntry>();
    for await (const row of streamCsv(createReadStream(vatFile.path), { delimiter: ',' })) {
      const parsed = parseVatPayerRow(row);
      if (!parsed) {
        counters.skipped += 1;
        continue;
      }
      byRegistrationCode.set(parsed.registrationCode, parsed.entry);
    }
    context.logger.info({ vatPayers: byRegistrationCode.size }, 'Latvia: VAT payers loaded');

    // Pass 2: stream the register and enrich every known VAT payer.
    const batch = this.batch(context, counters);
    const seen = new Set<string>();

    for await (const row of streamCsv(createReadStream(registerFile.path), { delimiter: ';' })) {
      const registrationCode = readColumn(row, ['regcode', 'reg_code']);
      const entry = registrationCode ? byRegistrationCode.get(registrationCode) : undefined;
      if (!registrationCode || !entry) {
        counters.skipped += 1;
        continue;
      }

      seen.add(registrationCode);
      await batch.add(mapRegisterRow(row, entry));
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Latvia: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
    if (batch.full) return;

    // Pass 3: the public institutions list, for VAT payers missing from the register. Downloaded here
    // so a `--limit` run, which stops earlier, does not fetch it.
    const publicBodies = await this.loadPublicBodies(context);
    if (publicBodies.size > 0) {
      await context.useArtefact({
        ...this.artefactOf(context, PUBLIC_BODIES_SLOT, {
          url: PUBLIC_BODIES_CSV,
          fileName: 'ppi_public_persons_institutions.csv',
          date: editionDate,
        }),
        date: editionDate,
      });
    }

    for (const [registrationCode, entry] of byRegistrationCode) {
      if (seen.has(registrationCode)) continue;
      const body = publicBodies.get(registrationCode);
      if (!body) continue;

      seen.add(registrationCode);
      await batch.add(mapPublicBody(registrationCode, entry, body));
      if (batch.full) break;
    }
    await batch.flush();
    if (batch.full) return;

    // Pass 4: VAT payers in neither register (sole traders, foreign taxable persons). Only their name
    // is known, from the VAT payers file, which is the file these rows are attributed to.
    await context.useArtefact({
      ...this.artefactOf(context, VAT_PAYERS_SLOT, {
        url: VAT_PAYERS_CSV,
        fileName: 'pdb_pvnmaksataji_odata.csv',
        date: editionDate,
      }),
      date: editionDate,
    });

    for (const [registrationCode, entry] of byRegistrationCode) {
      if (seen.has(registrationCode)) continue;
      await batch.add(mapVatPayerOnly(registrationCode, entry));
      if (batch.full) break;
    }
    await batch.flush();
  }

  /**
   * Reads the public institutions list into a map keyed by registration code.
   *
   * A body has a `registrationNumber` and sometimes a separate `taxpayerUnitNumber` (a court
   * registered as 50900016161 pays tax as 90010099202, and the VAT file uses the second). Both are
   * indexed, and a registration number wins when a code is both.
   */
  private async loadPublicBodies(context: ImportContext): Promise<Map<string, PublicBodyEntry>> {
    const entries = new Map<string, PublicBodyEntry>();
    const file = await this.download(context, PUBLIC_BODIES_CSV, PUBLIC_BODIES_SLOT);

    const byTaxpayerUnit = new Map<string, PublicBodyEntry>();
    for await (const row of streamCsv(createReadStream(file.path), { delimiter: ';' })) {
      const address = readColumn(row, ['address']);
      if (!address) continue;

      const entry: PublicBodyEntry = { name: readColumn(row, ['name']), address };
      const registration = readColumn(row, ['registrationNumber', 'registration_number']);
      const taxpayerUnit = readColumn(row, ['taxpayerUnitNumber', 'taxpayer_unit_number']);

      if (registration && REGISTRATION_CODE.test(registration)) entries.set(registration, entry);
      // Prefer a registered body over a removed one when a taxpayer unit number is claimed twice.
      if (taxpayerUnit && REGISTRATION_CODE.test(taxpayerUnit)) {
        const registered = (readColumn(row, ['Status', 'status']) ?? '').toUpperCase() === 'REGISTERED';
        if (registered || !byTaxpayerUnit.has(taxpayerUnit)) byTaxpayerUnit.set(taxpayerUnit, entry);
      }
    }

    for (const [code, entry] of byTaxpayerUnit) {
      if (!entries.has(code)) entries.set(code, entry);
    }

    context.logger.info({ publicBodies: entries.size }, 'Latvia: public institutions loaded');
    return entries;
  }
}

export const latviaBulk = new LatviaBulkSource();
