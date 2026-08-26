import { config } from '../../../config.js';
import { postJson } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * CVR, the Danish central business register. The Danish VAT number is `DK` + the CVR number. The
 * register is distributed through an Elasticsearch endpoint, free but with credentials granted on
 * request. Without `CVR_USER` / `CVR_PASSWORD`, Denmark resolves through VIES only.
 *
 * Payload shape, mapper and credentials are shared with the importer.
 */
export const DISTRIBUTION = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

export const SOURCE = 'CVR';

export interface CvrHit {
  _source?: { Vrvirksomhed?: CvrCompany };
}

export interface CvrResponse {
  _scroll_id?: string;
  hits?: { hits?: CvrHit[] };
}

/** Basic auth header, shared by both adapters. */
export function cvrAuthorization(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

/** True when credentials are configured. */
export function cvrCredentials(): { user: string; password: string } | null {
  const { user, password } = config.sources.cvr;
  return user && password ? { user, password } : null;
}

interface CvrAddress {
  vejnavn?: string;
  husnummerFra?: number;
  bogstavFra?: string;
  etage?: string;
  postnummer?: number;
  postdistrikt?: string;
  landekode?: string;
  conavn?: string;
}

export interface CvrCompany {
  cvrNummer?: number;
  sidstIndlaest?: string;
  virksomhedMetadata?: {
    nyesteNavn?: { navn?: string };
    nyesteVirksomhedsform?: { langBeskrivelse?: string };
    nyesteBeliggenhedsadresse?: CvrAddress;
    sammensatStatus?: string;
  };
}

/** Status in Danish: only "NORMAL" and "Aktiv" mean active. */
function isActive(status: string | undefined): boolean {
  if (!status) return false;
  const normalized = status.toUpperCase();
  return normalized === 'NORMAL' || normalized === 'AKTIV';
}

/**
 * `prefix` because Greenland is in the CVR too (its register was merged into it on 2018-01-01).
 * Denmark is the default.
 */
export function mapDanishCompany(company: CvrCompany, prefix = 'DK'): CompanyRecord | null {
  const cvr = company.cvrNummer;
  if (cvr === undefined || cvr === null) return null;

  const vatNumber = String(cvr).padStart(8, '0');
  if (!/^[0-9]{8}$/.test(vatNumber)) return null;

  const metadata = company.virksomhedMetadata;
  const address = metadata?.nyesteBeliggenhedsadresse;
  const houseNumber = address?.husnummerFra ? `${address.husnummerFra}${address.bogstavFra ?? ''}` : '';
  const line1 = [address?.vejnavn, houseNumber, address?.etage].filter(Boolean).join(' ').trim();

  return {
    vatNumber: `${prefix}${vatNumber}`,
    nationalId: vatNumber,
    name: metadata?.nyesteNavn?.navn ?? null,
    legalForm: metadata?.nyesteVirksomhedsform?.langBeskrivelse ?? null,
    status: isActive(metadata?.sammensatStatus) ? 'active' : 'inactive',
    addressLine1: line1.length > 0 ? line1 : null,
    addressLine2: address?.conavn ?? null,
    postalCode: address?.postnummer ? String(address.postnummer).padStart(4, '0') : null,
    city: address?.postdistrikt ?? null,
    addressCountry: address?.landekode ?? 'DK',
    companyLastUpdatedAt: parseUtcDate(company.sidstIndlaest),
  };
}

export class CvrSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'CVR distribution (Erhvervsstyrelsen)';
  readonly countryCode = 'DK';

  override get available(): boolean {
    return cvrCredentials() !== null;
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const credentials = cvrCredentials()!;
    const response = await postJson<CvrResponse>(
      DISTRIBUTION,
      { size: 1, query: { term: { 'Vrvirksomhed.cvrNummer': Number(vat.nationalNumber) } } },
      {
        headers: cvrAuthorization(credentials.user, credentials.password),
        timeoutMs: 15_000,
        retries: 2,
        deadline: context.deadline,
      },
    );

    const company = response.hits?.hits?.[0]?._source?.Vrvirksomhed;
    return this.answer(company ? mapDanishCompany(company) : null);
  }
}

export const cvr = new CvrSource();
