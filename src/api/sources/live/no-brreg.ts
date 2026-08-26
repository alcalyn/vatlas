import { fetchJson, HttpNotFoundError } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * Enhetsregisteret, the Brønnøysund register of every Norwegian legal entity: REST, JSON, no key,
 * no quota, open licence.
 *
 * `registrertIMvaregisteret` is the verdict of the VAT register (Merverdiavgiftsregisteret), so a
 * Norwegian company not registered for VAT is a `not-registered` answer.
 *
 * The nightly dump is not imported: the API is fast and a live source only stores the numbers
 * asked.
 */
const API_BASE = 'https://data.brreg.no/enhetsregisteret/api';

export const SOURCE = 'BRREG';

interface BrregAddress {
  adresse?: (string | null)[];
  postnummer?: string;
  poststed?: string;
  landkode?: string;
}

export interface BrregUnit {
  organisasjonsnummer?: string;
  navn?: string;
  organisasjonsform?: { kode?: string; beskrivelse?: string };
  forretningsadresse?: BrregAddress;
  postadresse?: BrregAddress;
  registrertIMvaregisteret?: boolean;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  slettedato?: string;
}

/**
 * Four independent flags (bankruptcy, voluntary winding-up, compulsory winding-up, deletion). Any
 * of them means not trading. The register always sets all four, so never `unknown`.
 */
function statusOf(unit: BrregUnit): CompanyRecord['status'] {
  const ended =
    unit.konkurs === true ||
    unit.underAvvikling === true ||
    unit.underTvangsavviklingEllerTvangsopplosning === true ||
    typeof unit.slettedato === 'string';
  return ended ? 'inactive' : 'active';
}

/** The business address first, then the postal address (often a PO box). */
function addressOf(unit: BrregUnit): BrregAddress | null {
  return unit.forretningsadresse ?? unit.postadresse ?? null;
}

export function mapNorwegianUnit(organisationNumber: string, unit: BrregUnit): CompanyRecord | null {
  const name = unit.navn?.trim();
  if (!name) return null;

  const address = addressOf(unit);
  // `adresse` is an array: an address may have a c/o line.
  const lines = (address?.adresse ?? []).map((line) => line?.trim()).filter((line): line is string => Boolean(line));

  return {
    vatNumber: `NO${organisationNumber}`,
    nationalId: organisationNumber,
    name,
    legalForm: unit.organisasjonsform?.beskrivelse?.trim() ?? null,
    status: statusOf(unit),
    addressLine1: lines[0] ?? null,
    addressLine2: lines.length > 1 ? lines.slice(1).join(', ') : null,
    postalCode: address?.postnummer?.trim() ?? null,
    city: address?.poststed?.trim() ?? null,
    addressCountry: address?.landkode?.trim() ?? 'NO',
    companyLastUpdatedAt: null,
  };
}

export class BrregSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Enhetsregisteret (Brønnøysundregistrene)';
  readonly countryCode = 'NO';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const organisationNumber = vat.nationalNumber;
    const options = { timeoutMs: 10_000, retries: 2, deadline: context.deadline };

    // Branches (underenhet) have their own organisasjonsnummer in another collection, so a 404 on the
    // first endpoint means trying the second. Only the second 404 is `not-found`.
    let unit: BrregUnit;
    try {
      unit = await fetchJson<BrregUnit>(`${API_BASE}/enheter/${organisationNumber}`, options);
    } catch (error) {
      if (!(error instanceof HttpNotFoundError)) throw error;
      unit = await fetchJson<BrregUnit>(`${API_BASE}/underenheter/${organisationNumber}`, options);
    }

    // The entity exists and is not in the VAT register. Branches have no such flag (their VAT belongs
    // to the parent), so a missing field is not a no.
    if (unit.registrertIMvaregisteret === false) {
      return { status: 'not-registered', checkedAt: new Date() };
    }

    return this.answer(mapNorwegianUnit(organisationNumber, unit));
  }
}

export const brreg = new BrregSource();
