import { config } from '../../../config.js';
import { fetchJson } from '../../../lib/http.js';
import { clamp } from '../../../lib/text.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * GEMI, the Greek General Commercial Registry. Its open-data API key is sent by email, no Greek
 * account needed. It is searchable by AFM (the Greek VAT number) and returns the name in Greek and
 * Latin, the structured address, the legal form and a dated status.
 *
 * - 8 requests per minute.
 * - An unknown AFM answers 404 with an empty body.
 * - A search by AFM takes about 2.3 s, against 0.3 s for VIES. That is why Greece asks GEMI after
 *   VIES.
 * - Coverage is incomplete (OTE, EL094013380, is missing).
 */
const GEMI_ENDPOINT = 'https://opendata-api.businessportal.gr/api/opendata/v1/companies';

export const SOURCE = 'GEMI';

/**
 * `GET /metadata/companyStatuses` lists twelve statuses, and this is the only one with
 * `isActive: true`. Search results only include `{id, descr}`, hence the id.
 */
const GEMI_ACTIVE_STATUS = 3;

/** One row of `GET /companies`, reduced to what `CompanyRecord` needs. */
export interface GemiCompany {
  /** GEMI registration number. An integer in the spec, sent as a string. */
  arGemi?: number | string | null;
  afm?: string | null;
  /** Registered name in Greek, preferred. */
  coNameEl?: string | null;
  /** The same name in Latin characters, if registered. */
  coNamesEn?: string[] | null;
  street?: string | null;
  streetNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
  /** A municipality and its regional unit. Not a city, see below. */
  municipality?: { id?: number; descr?: string } | null;
  legalType?: { id?: number; descr?: string } | null;
  status?: { id?: number; descr?: string } | null;
  /** `YYYY-MM-DD`, last status change. */
  lastStatusChange?: string | null;
  /** False for the head office, true for a branch. Several rows can share one AFM. */
  isBranch?: boolean | null;
}

interface GemiSearchResponse {
  searchMetadata?: { totalCount?: number };
  searchResults?: GemiCompany[];
}

/** Maps one search result. Pure, tested from a captured row. */
export function mapGemiCompany(company: GemiCompany): CompanyRecord | null {
  const afm = company.afm?.replace(/[^0-9]/g, '');
  if (!afm || !/^[0-9]{9}$/.test(afm)) return null;

  const name = company.coNameEl?.trim() || company.coNamesEn?.[0]?.trim() || '';
  const line1 = [company.street, company.streetNumber].filter(Boolean).join(' ').trim();

  return {
    vatNumber: `EL${afm}`,
    // The GEMI number. AADE has no registration number of its own, so an `EL` row's `national_id`
    // depends on which register answered.
    nationalId: company.arGemi === null || company.arGemi === undefined ? afm : String(company.arGemi),
    name: clamp(name, 255),
    legalForm: company.legalType?.descr ? clamp(company.legalType.descr, 128) : null,
    status: company.status?.id === GEMI_ACTIVE_STATUS ? 'active' : 'inactive',
    addressLine1: line1.length > 0 ? clamp(line1, 255) : null,
    addressLine2: null,
    postalCode: company.zipCode ?? null,
    // `city` only. `municipality.descr` is a municipality and its regional unit ("ΑΘΗΝΑΙΩΝ / ΚΕΝΤΡΙΚΟΥ
    // ΤΟΜΕΑ ΑΘΗΝΩΝ"), not a town.
    city: company.city ? clamp(company.city, 128) : null,
    addressCountry: 'EL',
    companyLastUpdatedAt: parseUtcDate(company.lastStatusChange),
  };
}

export class GemiSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'ΓΕΜΗ open data (Γενικό Εμπορικό Μητρώο)';
  readonly countryCode = 'EL';

  override get available(): boolean {
    return Boolean(config.sources.gemi.apiKey);
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    // The AFM must have nine digits, leading zeros included.
    const afm = vat.nationalNumber.padStart(9, '0');
    const url = `${GEMI_ENDPOINT}?afm=${encodeURIComponent(afm)}&resultsSize=2`;

    let answer: GemiSearchResponse;
    try {
      answer = await fetchJson<GemiSearchResponse>(url, {
        headers: { api_key: config.sources.gemi.apiKey! },
        timeoutMs: config.vies.timeoutMs,
        // One attempt: with 8 requests per minute, a retry would be refused too.
        retries: 0,
        deadline: context.deadline,
      });
    } catch {
      // Unknown AFM (404), rate limit (429) and bad key (401) all mean GEMI has nothing right now.
      // Swallowed rather than thrown, otherwise a rate limit would make Greece look unavailable.
      return { status: 'not-found' };
    }

    const results = answer.searchResults ?? [];
    // One AFM can have a head office and branches. The head office is the company.
    const company = results.find((row) => row.isBranch === false) ?? results[0];
    return this.answer(company ? mapGemiCompany(company) : null);
  }
}

export const gemi = new GemiSource();
