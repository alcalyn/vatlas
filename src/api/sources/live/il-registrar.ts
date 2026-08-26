import { fetchJson } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * רשם החברות, the Israeli Registrar of Companies, published as a CKAN dataset on the national open
 * data portal: 730,000 companies, free, queryable row by row through the datastore API.
 *
 * The nine-digit company number is also the number on invoices.
 */
const DATASTORE = 'https://data.gov.il/api/3/action/datastore_search';
const RESOURCE_ID = 'f004176c-b85f-4542-8901-7b3176f9a054';

export const SOURCE = 'RASHAM';

/** Every field name is in Hebrew. Named once here so the mapper stays readable. */
const FIELD = {
  number: 'מספר חברה',
  name: 'שם חברה',
  nameEnglish: 'שם באנגלית',
  type: 'סוג תאגיד',
  status: 'סטטוס חברה',
  statusCode: 'קוד סטטוס חברה',
  city: 'שם עיר',
  street: 'שם רחוב',
  houseNumber: 'מספר בית',
  postalCode: 'מיקוד',
  poBox: 'ת.ד.',
  country: 'מדינה',
} as const;

/**
 * Statuses of a company that still exists: 0 active, 78 temporarily active, 15 and 16 being
 * wound up. Anything else (struck off 19, liquidated 35 and 36, merged 76) no longer exists.
 */
const LIVE_STATUS_CODES = new Set([0, 15, 16, 78]);

/** The portal replaces double quotes with tildes, so `בע"מ` (Ltd) arrives as `בע~מ`. */
export function restoreQuotes(value: string): string {
  return value.replace(/~/g, '"');
}

export interface RegistrarRecord {
  [key: string]: unknown;
}

interface DatastoreResponse {
  success?: boolean;
  result?: { records?: RegistrarRecord[] };
}

function text(record: RegistrarRecord, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  const trimmed = restoreQuotes(String(value)).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Israeli addresses: street then number, no comma. */
function streetLine(record: RegistrarRecord): string | null {
  const street = text(record, FIELD.street);
  const houseNumber = text(record, FIELD.houseNumber);
  const line = [street, houseNumber].filter(Boolean).join(' ');
  return line.length > 0 ? line : null;
}

export function mapIsraeliCompany(record: RegistrarRecord): CompanyRecord | null {
  const number = String(record[FIELD.number] ?? '').replace(/[^0-9]/g, '');
  if (number.length !== 9) return null;

  const statusCode = Number(record[FIELD.statusCode]);
  const poBox = text(record, FIELD.poBox);

  return {
    vatNumber: `IL${number}`,
    nationalId: number,
    // The English name is only on some rows. The Hebrew one is always there.
    name: text(record, FIELD.name) ?? text(record, FIELD.nameEnglish),
    legalForm: text(record, FIELD.type),
    status: Number.isNaN(statusCode) ? 'unknown' : LIVE_STATUS_CODES.has(statusCode) ? 'active' : 'inactive',
    addressLine1: streetLine(record),
    addressLine2: poBox ? `ת.ד. ${poBox}` : null,
    postalCode: text(record, FIELD.postalCode),
    city: text(record, FIELD.city),
    // The country is written in Hebrew, so only "is it Israel" is derived.
    addressCountry: text(record, FIELD.country) === 'ישראל' ? 'IL' : null,
    companyLastUpdatedAt: null,
  };
}

/** `filters` matches the column exactly. `q` would full-text search names too. */
function urlFor(number: string): string {
  const filters = JSON.stringify({ [FIELD.number]: Number(number) });
  const query = new URLSearchParams({ resource_id: RESOURCE_ID, filters, limit: '1' });
  return `${DATASTORE}?${query.toString()}`;
}

export class RegistrarSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'רשם החברות (data.gov.il)';
  readonly countryCode = 'IL';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const response = await fetchJson<DatastoreResponse>(urlFor(vat.nationalNumber), {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
      // Without a User-Agent the portal returns a challenge page.
      headers: { 'user-agent': 'vatlas/1.0 (+https://vatlas.dev)' },
    });

    const record = response.result?.records?.[0];
    return this.answer(record ? mapIsraeliCompany(record) : null);
  }
}

export const rasham = new RegistrarSource();
