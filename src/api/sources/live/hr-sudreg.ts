import { config } from '../../../config.js';
import { fetchJson } from '../../../lib/http.js';
import { clamp } from '../../../lib/text.js';
import { parseZonedDateTime } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * Sudski registar, the Croatian court register. Free open-data API, with a client id and secret
 * sent by email. The OIB is the Croatian VAT number. Without `SUDREG_CLIENT_ID` /
 * `SUDREG_CLIENT_SECRET`, Croatia resolves through VIES only.
 *
 * The v3 API exposes the register's tables one by one: `/subjekti` has no name, address or legal
 * form, so the import joins `/tvrtke`, `/sjedista` and `/pravni_oblici` on MBS.
 * `/detalji_subjekta` returns a full subject but needs an identifier, so it serves lookups.
 */
export const API_BASE = 'https://sudreg-data.gov.hr/api/javni';
const TOKEN_URL = 'https://sudreg-data.gov.hr/api/oauth/token';

export const SOURCE = 'SUDREG';
/** `vrste_postupaka` 1: no bankruptcy, liquidation or pre-bankruptcy procedure. */
const NO_PROCEDURE = 1;
const NO_PROCEDURE_LABEL = 'Bez postupka';
/** Timestamps are in local time without zone. */
export const TIME_ZONE = 'Europe/Zagreb';

/** True when credentials are configured. */
export function sudregCredentials(): { clientId: string; clientSecret: string } | null {
  const { clientId, clientSecret } = config.sources.sudreg;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface SudregSeat {
  /** Set for a foreign seat, and also for many domestic ones. */
  drzava_id?: number;
  /** With `expand_relations`, `/detalji_subjekta` replaces the id by the country itself. */
  drzava?: { oznaka_2?: string };
  naziv_naselja?: string;
  /** Town of a foreign seat, free text. */
  naselje_van_sifrarnika?: string;
  ulica?: string;
  kucni_broj?: number;
  kucni_podbroj?: string;
  postanski_broj?: number;
}

/**
 * The current procedure, in three shapes: a code on `/subjekti`, a nested `postupci` record on
 * `/detalji_subjekta`, and a label instead of the code with `expand_relations`.
 */
type SudregProcedure = number | { postupak?: number | { znacenje?: string } };

export interface SudregSubject {
  mbs?: number;
  /** `NUMBER(11)` in the register, so an OIB starting with zero arrives short. */
  oib?: number | string;
  /** 1 while registered, 0 once struck off. */
  status?: number;
  postupak?: SudregProcedure;
  stecajna_masa?: number;
  likvidacijska_masa?: number;
  vrijeme_zadnje_izmjene?: string;
}

/** What `/subjekti` leaves to other tables, resolved for one subject. */
export interface SudregRelations {
  name: string | null;
  /**
   * The registered short name. Full names often exceed 255 characters ("Sinko Europe društvo s
   * ograničenom odgovornošću za trgovinu na veliko elektroničkom i telekomunikacijskom opremom i
   * dijelovima"). Null for about 5,000 subjects without one, and on the lookup path
   * (`/detalji_subjekta` does not have it).
   */
  shortName: string | null;
  legalForm: string | null;
  seat: SudregSeat | null;
  /** ISO 3166 alpha-2 of the seat, HR when no country is given. */
  addressCountry: string;
}

interface SudregDetail extends SudregSubject {
  tvrtka?: { ime?: string };
  sjediste?: SudregSeat;
  pravni_oblik?: { vrsta_pravnog_oblika?: { naziv?: string } };
}

/**
 * An OIB has eleven digits but is stored as a number: 00123456789 comes back as 123456789. Padding
 * restores it.
 */
function normalizeOib(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length === 0 || digits.length > 11) return null;
  const padded = digits.padStart(11, '0');
  // Only pad values that pass the check digit, otherwise a stray 0 would become HR00000000000.
  return hasValidOibChecksum(padded) ? padded : null;
}

/** ISO 7064 MOD 11,10, the OIB check digit. */
function hasValidOibChecksum(oib: string): boolean {
  let remainder = 10;
  for (const digit of oib.slice(0, 10)) {
    remainder = (remainder + Number(digit)) % 10;
    if (remainder === 0) remainder = 10;
    remainder = (remainder * 2) % 11;
  }
  return (11 - remainder) % 10 === Number(oib[10]);
}

/**
 * A sub-number is usually a letter (2 + "A" is 2A), sometimes with its own separator ("/1"). Bare
 * digits get a slash, since 10 + "1" would read 101.
 */
function joinHouseNumber(number: number | undefined, sub: string | undefined): string {
  if (number === undefined || number === null) return sub ?? '';
  if (!sub) return String(number);
  return /^[0-9]+$/.test(sub) ? `${number}/${sub}` : `${number}${sub}`;
}

function inProcedure(value: SudregProcedure | undefined): boolean {
  if (value === undefined) return false;
  const code = typeof value === 'number' ? value : value.postupak;
  if (typeof code === 'number') return code !== NO_PROCEDURE;
  if (typeof code === 'object' && code !== null) {
    return code.znacenje !== undefined && code.znacenje !== NO_PROCEDURE_LABEL;
  }
  return false;
}

export function mapCroatianSubject(subject: SudregSubject, relations: SudregRelations): CompanyRecord | null {
  const oib = normalizeOib(subject.oib);
  if (!oib) return null;

  // The full name when it fits, else the short one, else the truncated full name.
  const name = relations.name ?? relations.shortName ?? '';
  const preferred = name.length > 255 && relations.shortName ? relations.shortName : name;

  const seat = relations.seat;
  const houseNumber = joinHouseNumber(seat?.kucni_broj, seat?.kucni_podbroj);
  const line1 = [seat?.ulica, houseNumber].filter(Boolean).join(' ').trim();
  const city = seat?.naziv_naselja ?? seat?.naselje_van_sifrarnika ?? null;

  return {
    vatNumber: `HR${oib}`,
    // The MBS has nine digits and is stored as a number too, so it is padded.
    nationalId: subject.mbs ? String(subject.mbs).padStart(9, '0') : oib,
    name: clamp(preferred, 255),
    legalForm: relations.legalForm === null ? null : clamp(relations.legalForm, 128),
    // Struck off, or in bankruptcy or liquidation: the company no longer trades.
    status:
      subject.status === 0 ||
      inProcedure(subject.postupak) ||
      subject.stecajna_masa === 1 ||
      subject.likvidacijska_masa === 1
        ? 'inactive'
        : 'active',
    addressLine1: line1.length > 0 ? clamp(line1, 255) : null,
    addressLine2: null,
    postalCode: seat?.postanski_broj ? String(seat.postanski_broj).padStart(5, '0') : null,
    city: city === null ? null : clamp(city, 128),
    addressCountry: relations.addressCountry,
    // Only `/detalji_subjekta` dates a row. Bulk tables date the edition.
    companyLastUpdatedAt: parseZonedDateTime(subject.vrijeme_zadnje_izmjene, TIME_ZONE),
  };
}

/** Client credentials grant. The token lasts six hours, so it is fetched once per run. */
export async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`sudreg token request failed: HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('sudreg token request returned no access_token');
  return body.access_token;
}

export class SudregSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Sudski registar (sudreg open data)';
  readonly countryCode = 'HR';

  override get available(): boolean {
    return sudregCredentials() !== null;
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const { clientId, clientSecret } = sudregCredentials()!;
    // The endpoint answers 400 for an OIB with a bad check digit. Throwing here would waste the
    // country's time budget.
    if (!hasValidOibChecksum(vat.nationalNumber)) return { status: 'not-found' };

    const token = await accessToken(clientId, clientSecret);
    const detail = await fetchJson<SudregDetail>(
      // `no_data_error=0` turns "no such subject" from a 400 into an empty object.
      `${API_BASE}/detalji_subjekta?tip_identifikatora=oib&identifikator=${encodeURIComponent(vat.nationalNumber)}` +
        '&expand_relations=true&no_data_error=0',
      {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 15_000,
        retries: 2,
        deadline: context.deadline,
      },
    );

    return this.answer(
      detail?.oib
        ? mapCroatianSubject(detail, {
            name: detail.tvrtka?.ime ?? null,
            shortName: null,
            legalForm: detail.pravni_oblik?.vrsta_pravnog_oblika?.naziv ?? null,
            seat: detail.sjediste ?? null,
            addressCountry: detail.sjediste?.drzava?.oznaka_2 ?? 'HR',
          })
        : null,
    );
  }
}

export const sudreg = new SudregSource();
