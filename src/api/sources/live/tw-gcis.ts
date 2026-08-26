import { fetchJsonOrNull } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * GCIS, the Ministry of Economic Affairs' commercial registration platform: no key, no quota, JSON
 * with OData filters, and the address in the answer.
 *
 * Taiwan has two registers: 公司登記 (companies) and 商業登記 (sole traders and partnerships). The
 * source asks the first, then the second. Both are GCIS and share one history.
 */
const COMPANY_DATASET = 'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
const BUSINESS_DATASET = 'https://data.gcis.nat.gov.tw/od/data/api/7E6AFA72-AD6A-46D3-8681-ED77951D912D';

export const SOURCE = 'GCIS';

/**
 * Status in words: 核准設立 is live, anything else (dissolved, revoked, closed) is not. 停業 is a
 * suspension, the company still exists, so `active`.
 */
const LIVE_STATUS = new Set(['核准設立', '核准設立 (法人登記)', '核准登記']);
const SUSPENDED = '停業';

function statusOf(description: string | undefined | null): CompanyRecord['status'] {
  if (!description) return 'unknown';
  if (LIVE_STATUS.has(description) || description.startsWith(SUSPENDED)) return 'active';
  return 'inactive';
}

export interface GcisCompany {
  Business_Accounting_NO?: string;
  Company_Name?: string;
  Company_Status_Desc?: string;
  Company_Location?: string;
  Responsible_Name?: string;
  Company_Setup_Date?: string;
  Change_Of_Approval_Data?: string;
}

export interface GcisBusiness {
  President_No?: string;
  Business_Name?: string;
  Business_Current_Status?: string;
  Business_Address?: string;
  Business_Responsible_Name?: string;
}

/** Minguo calendar, zero-padded to seven characters: `0760221` is year 76 of the republic, 1987. */
export function parseMinguoDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, '').padStart(7, '0');
  if (digits.length !== 7) return null;
  const year = Number(digits.slice(0, 3)) + 1911;
  const month = Number(digits.slice(3, 5));
  const day = Number(digits.slice(5, 7));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/** One address string, from city down, without postal code. Kept whole in `addressLine1`. */
function addressOf(location: string | undefined | null): string | null {
  const trimmed = location?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function mapTaiwanCompany(company: GcisCompany): CompanyRecord | null {
  const ubn = company.Business_Accounting_NO?.replace(/[^0-9]/g, '');
  if (!ubn || ubn.length !== 8) return null;

  return {
    vatNumber: `TW${ubn}`,
    nationalId: ubn,
    name: company.Company_Name?.trim() ?? null,
    // No legal form field: it is the end of the Chinese name (股份有限公司, 有限公司).
    legalForm: null,
    status: statusOf(company.Company_Status_Desc),
    addressLine1: addressOf(company.Company_Location),
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'TW',
    companyLastUpdatedAt: parseMinguoDate(company.Change_Of_Approval_Data),
  };
}

export function mapTaiwanBusiness(business: GcisBusiness): CompanyRecord | null {
  const ubn = business.President_No?.replace(/[^0-9]/g, '');
  if (!ubn || ubn.length !== 8) return null;

  return {
    vatNumber: `TW${ubn}`,
    nationalId: ubn,
    name: business.Business_Name?.trim() ?? null,
    legalForm: null,
    status: statusOf(business.Business_Current_Status),
    addressLine1: addressOf(business.Business_Address),
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'TW',
    companyLastUpdatedAt: null,
  };
}

/** One OData filter query per number: there is no lookup by key. */
function urlFor(dataset: string, field: string, ubn: string): string {
  const filter = encodeURIComponent(`${field} eq ${ubn}`);
  return `${dataset}?$format=json&$filter=${filter}&$skip=0&$top=1`;
}

export class GcisSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = '商工登記公示資料 (經濟部商業發展署)';
  readonly countryCode = 'TW';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const ubn = vat.nationalNumber;

    // A miss is a 200 with an empty body on both datasets, hence `fetchJsonOrNull`.
    const companies = await fetchJsonOrNull<GcisCompany[]>(urlFor(COMPANY_DATASET, 'Business_Accounting_NO', ubn), {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    const company = companies?.[0];
    if (company) return this.answer(mapTaiwanCompany(company));

    // Not a company: try the other register.
    const businesses = await fetchJsonOrNull<GcisBusiness[]>(urlFor(BUSINESS_DATASET, 'President_No', ubn), {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    return this.answer(businesses?.[0] ? mapTaiwanBusiness(businesses[0]) : null);
  }
}

export const gcis = new GcisSource();
