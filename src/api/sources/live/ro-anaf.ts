import { postJson } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * ANAF publishes the taxpayer register through one free endpoint, up to a hundred CUI per call,
 * with identity, structured address and VAT registration periods. The Romanian VAT number is `RO`
 * + the CUI. No bulk file. Limited to one request per second.
 */
const API_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';

export const SOURCE = 'ANAF';

interface AnafGeneral {
  cui?: number;
  denumire?: string;
  adresa?: string;
  nrRegCom?: string;
  forma_juridica?: string;
  data_inregistrare?: string;
  codPostal?: string;
}

interface AnafSeat {
  sdenumire_Strada?: string;
  snumar_Strada?: string;
  sdetalii_Adresa?: string;
  scod_Postal?: string;
  sdenumire_Localitate?: string;
  sdenumire_Judet?: string;
}

export interface AnafEntry {
  date_generale?: AnafGeneral;
  adresa_sediu_social?: AnafSeat;
  inregistrare_scop_Tva?: { scpTVA?: boolean };
  stare_inactiv?: { statusInactivi?: boolean };
}

interface AnafResponse {
  found?: AnafEntry[];
  notFound?: unknown[];
}

/**
 * Maps one ANAF entry. Null when `scpTVA` is false: the CUI exists but has no VAT registration,
 * which is VIES's to report.
 */
export function mapRomanianEntry(entry: AnafEntry): CompanyRecord | null {
  const general = entry.date_generale;
  const cui = general?.cui;
  if (cui === undefined || cui === null) return null;
  if (entry.inregistrare_scop_Tva?.scpTVA !== true) return null;

  const vatNumber = String(cui);
  if (!/^[0-9]{2,10}$/.test(vatNumber)) return null;

  const seat = entry.adresa_sediu_social;
  const street = [seat?.sdenumire_Strada, seat?.snumar_Strada && `nr. ${seat.snumar_Strada}`]
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    vatNumber: `RO${vatNumber}`,
    nationalId: general?.nrRegCom ?? vatNumber,
    name: general?.denumire ?? null,
    legalForm: general?.forma_juridica ?? null,
    status: entry.stare_inactiv?.statusInactivi === true ? 'inactive' : 'active',
    // The structured address is cleaner than `adresa` but not always filled, so fall back.
    addressLine1: street.length > 0 ? street : (general?.adresa ?? null),
    addressLine2: seat?.sdetalii_Adresa ?? null,
    postalCode: seat?.scod_Postal || general?.codPostal || null,
    city: seat?.sdenumire_Localitate ?? seat?.sdenumire_Judet ?? null,
    addressCountry: 'RO',
    companyLastUpdatedAt: parseUtcDate(general?.data_inregistrare),
  };
}

export class AnafSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'ANAF (Agenția Națională de Administrare Fiscală)';
  readonly countryCode = 'RO';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const cui = Number(vat.nationalNumber);
    if (!Number.isInteger(cui)) return { status: 'not-found' };

    // The endpoint takes a batch even for one number, and answers 404 for the whole request when it
    // knows none of the CUI. The base class reads that as a miss.
    const date = new Date().toISOString().slice(0, 10);
    const response = await postJson<AnafResponse>(API_URL, [{ cui, data: date }], {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    const entry = response.found?.[0];
    return this.answer(entry ? mapRomanianEntry(entry) : null);
  }
}

export const anaf = new AnafSource();
