import { fetchJson } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * Vietnam, the only country served by an aggregator instead of its register.
 *
 * The tax administration's lookup (`tracuunnt.gdt.gov.vn`) and the business registration portal
 * are behind captchas, and there is no dump. VietQR republishes the tax data as open JSON without
 * a key.
 *
 * `meta.source` names VietQR, so the answer does not claim to come from the register.
 */
const API_BASE = 'https://api.vietqr.io/v2/business';

export const SOURCE = 'VIETQR';

/** `00` is a hit, `51` the documented miss, anything else a problem. */
const OK = '00';
const NOT_FOUND = '51';

interface VietQrBusiness {
  id?: string;
  name?: string;
  internationalName?: string | null;
  shortName?: string | null;
  address?: string | null;
  status?: string | null;
}

export interface VietQrResponse {
  code?: string;
  desc?: string;
  data?: VietQrBusiness | null;
}

/**
 * Status as a sentence: `NNT đang hoạt động` (operating) is live. Other known wordings
 * (`ngừng hoạt động`, `tạm nghỉ`, `đã đóng MST`) are not. Unknown wordings stay `unknown`.
 */
function statusOf(status: string | null | undefined): CompanyRecord['status'] {
  const text = status?.trim().toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('đang hoạt động')) return 'active';
  if (text.includes('ngừng') || text.includes('đóng') || text.includes('tạm nghỉ')) return 'inactive';
  return 'unknown';
}

export function mapVietnameseBusiness(taxCode: string, payload: VietQrResponse): CompanyRecord | null {
  if (payload.code !== OK) return null;
  const business = payload.data;
  // The Vietnamese legal name first. `internationalName` only exists for some companies.
  const name = business?.name?.trim() ?? business?.internationalName?.trim();
  if (!name) return null;

  return {
    vatNumber: `VN${taxCode}`,
    nationalId: taxCode,
    name,
    // No legal form field: it is inside the name (`CÔNG TY TNHH`, `CÔNG TY CỔ PHẦN`).
    legalForm: null,
    status: statusOf(business?.status),
    addressLine1: business?.address?.trim() || null,
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'VN',
    companyLastUpdatedAt: null,
  };
}

export class VietQrSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'VietQR (Tổng cục Thuế taxpayer data)';
  readonly countryCode = 'VN';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const taxCode = vat.nationalNumber;
    // A miss is a 200 with `code: "51"`, not a 404. Treating it as an error would retry and report an
    // outage.
    const payload = await fetchJson<VietQrResponse>(`${API_BASE}/${encodeURIComponent(taxCode)}`, {
      // A hit takes about a second, a miss 8 to 14 seconds (the service asks upstream first). The
      // timeout is set for the miss, with one retry only.
      timeoutMs: 25_000,
      retries: 1,
      deadline: context.deadline,
    });
    if (payload.code === NOT_FOUND) return { status: 'not-found' };

    return this.answer(mapVietnameseBusiness(taxCode, payload));
  }
}

export const vietqr = new VietQrSource();
