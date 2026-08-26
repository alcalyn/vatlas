import { fetchJson } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * PRH, the Finnish Patent and Registration Office. Open data, no authentication.
 *
 * Finland offers a file and an endpoint, so it has two adapters with one `id`. The payload shape
 * and mapper live here and the importer reuses them.
 */
const API_BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';

export const SOURCE = 'PRH';

/** Language of each description: 1 Finnish, 2 Swedish, 3 English. */
const ENGLISH = '3';
const FINNISH = '1';

interface PrhDescription {
  languageCode?: string;
  description?: string;
}

interface PrhName {
  name?: string;
  type?: string;
  endDate?: string;
}

interface PrhAddress {
  type?: number;
  street?: string;
  buildingNumber?: string;
  postCode?: string;
  postOffices?: { city?: string; languageCode?: string }[];
  co?: string;
  postOfficeBox?: string;
  endDate?: string;
}

export interface PrhCompany {
  businessId?: { value?: string; registrationDate?: string };
  names?: PrhName[];
  companyForms?: { descriptions?: PrhDescription[]; endDate?: string }[];
  addresses?: PrhAddress[];
  registrationDate?: string;
  endDate?: string;
}

interface PrhPage {
  totalResults: number;
  companies: PrhCompany[];
}

function pickDescription(descriptions: PrhDescription[] | undefined): string | null {
  if (!descriptions?.length) return null;
  const english = descriptions.find((item) => item.languageCode === ENGLISH);
  return (english ?? descriptions[0])?.description ?? null;
}

/** Maps a PRH company, or null when the Business ID is unusable. */
export function mapFinnishCompany(company: PrhCompany): CompanyRecord | null {
  const businessId = company.businessId?.value;
  if (!businessId) return null;

  // Y-tunnus is written 0100002-9. The VAT number has the same digits without the hyphen.
  const vatNumber = businessId.replace(/-/g, '');
  if (!/^[0-9]{8}$/.test(vatNumber)) return null;

  const currentName = company.names?.find((name) => name.type === '1' && !name.endDate) ?? company.names?.[0];
  const currentForm = company.companyForms?.find((form) => !form.endDate) ?? company.companyForms?.[0];
  const address = company.addresses?.find((item) => !item.endDate) ?? company.addresses?.[0];
  const city =
    address?.postOffices?.find((office) => office.languageCode === FINNISH)?.city ??
    address?.postOffices?.[0]?.city ??
    null;

  const street = [address?.street, address?.buildingNumber].filter(Boolean).join(' ').trim();

  return {
    vatNumber: `FI${vatNumber}`,
    nationalId: businessId,
    name: currentName?.name ?? null,
    legalForm: pickDescription(currentForm?.descriptions),
    // PRH has several status code sets. An end date is the clear signal.
    status: company.endDate ? 'inactive' : 'active',
    addressLine1: street.length > 0 ? street : (address?.postOfficeBox ?? null),
    addressLine2: address?.co ?? null,
    postalCode: address?.postCode ?? null,
    city,
    addressCountry: 'FI',
    companyLastUpdatedAt: parseUtcDate(company.registrationDate),
  };
}

export class PrhSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'PRH open data (Patentti- ja rekisterihallitus)';
  readonly countryCode = 'FI';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    // Back to the hyphenated Business ID the API expects: 8 digits -> 7 + check digit.
    const businessId = `${vat.nationalNumber.slice(0, 7)}-${vat.nationalNumber.slice(7)}`;
    const page = await fetchJson<PrhPage>(`${API_BASE}?businessId=${encodeURIComponent(businessId)}`, {
      deadline: context.deadline,
    });
    return this.answer(page.companies?.[0] ? mapFinnishCompany(page.companies[0]!) : null);
  }
}

export const prh = new PrhSource();
