import { fetchJson } from '../../../lib/http.js';
import { parseAddress } from '../../../lib/address.js';
import { parseUtcDate } from '../../../lib/time.js';
import { extractAttribute, extractTag } from '../../../lib/xml.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The Peppol Directory, used to resolve German numbers.
 *
 * The Handelsregister cannot be searched by USt-IdNr and VIES returns `---` for name and address.
 * In Peppol, participant scheme 9930 is the German VAT number, so the directory can be searched
 * by it.
 *
 * Measured 2026-08-29: 12,659 German participants, ~87% keyed by USt-IdNr, all named, ~20% with a
 * locality. Well under 1% of German taxable persons, so VIES stays the fallback. Coverage grows
 * with the German e-invoicing mandate (through 2028).
 *
 * - The name is declared by the participant and not verified. Hence its own `source` and a
 *   `status` of `unknown`: being on Peppol proves neither identity nor an active VAT registration.
 * - The export is EU-wide. Filtering to DE is one line.
 */
const SEARCH_API = 'https://directory.peppol.eu/search/1.0/json';

/** The Peppol issuing agency code whose identifiers are German VAT numbers. */
export const VAT_SCHEME = '9930';
const PARTICIPANT_SCHEME = 'iso6523-actorid-upis';

export const SOURCE = 'PEPPOL';

/** The four address columns parsed from a Peppol `geoinfo`, shared by both mappers. */
function geoInfoAddress(
  geoInfo: string | null,
): Pick<CompanyRecord, 'addressLine1' | 'addressLine2' | 'postalCode' | 'city'> {
  const address = parseAddress(geoInfo?.trim() || null, 'DE');
  return {
    addressLine1: address.line1,
    addressLine2: address.line2,
    postalCode: address.postalCode,
    city: address.city,
  };
}

/**
 * Maps one `<businesscard>`. Null for anything that is not a German company with a usable key
 * (almost all of the file).
 */
export function mapPeppolCard(xml: string): CompanyRecord | null {
  const vatNumber = germanVatNumber(xml);
  if (!vatNumber) return null;

  const name = extractAttribute(xml, 'name', 'name')?.trim();
  if (!name) return null;

  return {
    vatNumber: `DE${vatNumber}`,
    nationalId: null,
    name,
    legalForm: null,
    // Peppol registration says nothing about VAT registration.
    status: 'unknown',
    // `geoinfo` is free text: a town or a full address. `parseAddress` finds a German postal code when
    // there is one, and otherwise returns the string whole in `line1`.
    ...geoInfoAddress(extractTag(xml, 'geoinfo')),
    addressCountry: 'DE',
    companyLastUpdatedAt: parseUtcDate(extractTag(xml, 'regdate')),
  };
}

/**
 * The VAT number can come from the participant identifier (scheme 9930), or from a `<id
 * scheme="VAT">` declared next to another identifier (Leitweg-ID or GLN, common for German public
 * bodies).
 */
function germanVatNumber(xml: string): string | null {
  const participant = extractAttribute(xml, 'participant', 'value') ?? '';
  const [scheme, ...rest] = participant.split(':');
  if (scheme === VAT_SCHEME) {
    const fromParticipant = normalizeGermanVat(rest.join(':'));
    if (fromParticipant) return fromParticipant;
  }

  for (const id of xml.match(/<id\b[^>]*>/g) ?? []) {
    if (extractAttribute(id, 'id', 'scheme')?.toUpperCase() !== 'VAT') continue;
    const declared = normalizeGermanVat(extractAttribute(id, 'id', 'value'));
    if (declared) return declared;
  }

  return null;
}

/** `de811335517`, `DE 811335517` and `811335517` all normalize to the same national part. */
function normalizeGermanVat(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const national = normalized.startsWith('DE') ? normalized.slice(2) : normalized;
  return /^[0-9]{9}$/.test(national) ? national : null;
}

/** One entity of a `/search/1.0/json` answer. Missing fields are omitted. */
interface PeppolEntity {
  name?: { name?: string; language?: string }[];
  countryCode?: string;
  geoInfo?: string;
  regDate?: string;
}

interface PeppolSearchResponse {
  'total-result-count'?: number;
  matches?: { entities?: PeppolEntity[] }[];
}

export function mapPeppolEntity(vatNumber: string, entity: PeppolEntity): CompanyRecord | null {
  const name = entity.name?.find((candidate) => candidate.name?.trim())?.name?.trim();
  if (!name) return null;

  return {
    vatNumber: `DE${vatNumber}`,
    nationalId: null,
    name,
    legalForm: null,
    status: 'unknown',
    ...geoInfoAddress(entity.geoInfo ?? null),
    addressCountry: 'DE',
    companyLastUpdatedAt: parseUtcDate(entity.regDate),
  };
}

export class PeppolSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Peppol Directory';
  readonly countryCode = 'DE';

  /**
   * The directory's search for one participant. Used even though the file is imported: the export is
   * nightly, and a company registered today shows up here first.
   */
  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const participant = `${PARTICIPANT_SCHEME}::${VAT_SCHEME}:de${vat.nationalNumber}`;
    const url = `${SEARCH_API}?participant=${encodeURIComponent(participant)}`;

    const answer = await fetchJson<PeppolSearchResponse>(url, {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    const entity = answer.matches?.[0]?.entities?.[0];
    return this.answer(entity ? mapPeppolEntity(vat.nationalNumber, entity) : null);
  }
}

export const peppol = new PeppolSource();
