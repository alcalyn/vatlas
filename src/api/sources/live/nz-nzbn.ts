import { config } from '../../../config.js';
import { fetchJson, HttpPermanentError } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The NZBN register, New Zealand's business identifier, like the Australian ABN.
 *
 * The tax number (IRD number) is not public. The NZBN is the identifier businesses are quoted by,
 * like the UEN in Singapore.
 *
 * Free with a subscription key from `portal.api.business.govt.nz`. Without it there is no
 * fallback, so New Zealand answers `unavailable`.
 */
const API_BASE = 'https://api.business.govt.nz/gateway/nzbn/v5/entities';

/**
 * The gateway has no 404. An unallocated number answers 400 with this sentence. A 400 with any
 * other body is a refused request, so an outage.
 */
const NOT_FOUND_MESSAGE = 'could not find nzbn number';

export const SOURCE = 'NZBN';

/**
 * Statuses of a live entity. 70 receivership, 71 liquidation, 72 statutory management and 80
 * removed are not live.
 *
 * The code is matched, with the description as fallback.
 */
const LIVE_STATUS_CODE = '50';
const LIVE_STATUS_DESCRIPTION = new Set(['registered', 'active']);

/** Missing fields come back as explicit nulls, so the types say so. */
interface NzbnAddress {
  addressType?: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  postCode?: string | null;
  countryCode?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface NzbnEntity {
  nzbn?: string | null;
  entityName?: string | null;
  entityStatusCode?: string | null;
  entityStatusDescription?: string | null;
  entityTypeCode?: string | null;
  entityTypeDescription?: string | null;
  registrationDate?: string | null;
  lastUpdatedDate?: string | null;
  addresses?: { addressList?: NzbnAddress[] | null } | null;
}

/**
 * An entity has several addresses (registered office, service, postal), with historical ones
 * marked by `endDate`. Use the current registered office.
 */
export function currentAddress(entity: NzbnEntity): NzbnAddress | null {
  const list = entity.addresses?.addressList ?? [];
  const current = list.filter((address) => !address.endDate);
  const preferred = ['REGISTERED', 'OFFICE', 'SERVICE', 'POSTAL'];
  for (const type of preferred) {
    const match = current.find((address) => address.addressType?.toUpperCase() === type);
    if (match) return match;
  }
  return current[0] ?? list[0] ?? null;
}

function entityStatus(entity: NzbnEntity): CompanyRecord['status'] {
  if (entity.entityStatusCode) return entity.entityStatusCode === LIVE_STATUS_CODE ? 'active' : 'inactive';
  const described = entity.entityStatusDescription?.trim().toLowerCase();
  if (!described) return 'unknown';
  return LIVE_STATUS_DESCRIPTION.has(described) ? 'active' : 'inactive';
}

export function mapNewZealandEntity(entity: NzbnEntity): CompanyRecord | null {
  const nzbn = entity.nzbn?.replace(/[^0-9]/g, '');
  if (!nzbn || nzbn.length !== 13) return null;

  const address = currentAddress(entity);

  // The city is the last filled line: usually `address3` with the suburb in `address2`, but records
  // from the charities and incorporated societies registers leave `address3` empty and use
  // `address4`.
  const locality = [address?.address2, address?.address3, address?.address4]
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line));
  const city = locality.pop() ?? null;

  return {
    vatNumber: `NZ${nzbn}`,
    nationalId: nzbn,
    name: entity.entityName?.trim() || null,
    legalForm: entity.entityTypeDescription?.trim() || null,
    status: entityStatus(entity),
    addressLine1: address?.address1?.trim() || null,
    addressLine2: locality.join(', ') || null,
    postalCode: address?.postCode?.trim() || null,
    city,
    addressCountry: address?.countryCode?.toUpperCase() ?? 'NZ',
    companyLastUpdatedAt: parseUtcDate(entity.lastUpdatedDate),
  };
}

/**
 * Whether a refusal means "nothing under this number" rather than a refused request. Matched on
 * the sentence: other 400s, and 401 or 403 from a lapsed key, are outages.
 */
function isMiss(error: unknown): boolean {
  return (
    error instanceof HttpPermanentError && error.status === 400 && error.body.toLowerCase().includes(NOT_FOUND_MESSAGE)
  );
}

export class NzbnSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'New Zealand Business Number register';
  readonly countryCode = 'NZ';

  override get available(): boolean {
    return Boolean(config.sources.nzbn.apiKey);
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    let entity: NzbnEntity;
    try {
      entity = await fetchJson<NzbnEntity>(`${API_BASE}/${encodeURIComponent(vat.nationalNumber)}`, {
        timeoutMs: 15_000,
        retries: 2,
        deadline: context.deadline,
        headers: { 'Ocp-Apim-Subscription-Key': config.sources.nzbn.apiKey! },
      });
    } catch (error) {
      if (isMiss(error)) return { status: 'not-found' };
      throw error;
    }
    return this.answer(entity.nzbn ? mapNewZealandEntity(entity) : null);
  }
}

export const nzbn = new NzbnSource();
