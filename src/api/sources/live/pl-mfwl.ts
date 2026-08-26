import { parseAddress } from '../../../lib/address.js';
import { fetchJson } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The Polish Ministry of Finance White List (`wykaz podatników VAT`).
 *
 * The ministry's flat file only has hashed NIP / bank account pairs, no name or address. The API
 * returns the identity, so Polish numbers are resolved on demand.
 */
const API_BASE = 'https://wl-api.mf.gov.pl/api/search/nip';

export const SOURCE = 'MF_WL';

interface WhiteListSubject {
  name?: string;
  nip?: string;
  statusVat?: string;
  regon?: string;
  krs?: string;
  residenceAddress?: string;
  workingAddress?: string;
  registrationLegalDate?: string;
}

interface WhiteListResponse {
  result?: { subject?: WhiteListSubject | null };
}

/**
 * Polish company names end with their legal form, in full or abbreviated.
 *
 * Each alternative is anchored (start or space before, end after), otherwise `SA` would match
 * inside "PRZEDSIĘBIORSTWO WISA". Longest forms first, so "SPÓŁKA Z OGRANICZONĄ
 * ODPOWIEDZIALNOŚCIĄ SPÓŁKA KOMANDYTOWA" is not read as a plain limited company.
 */
const LEGAL_FORMS: { endings: string[]; form: string }[] = [
  {
    endings: [
      'SP(?:ÓŁ|OL)KA Z OGRANICZON[ĄA] ODPOWIEDZIALNO[ŚS]CI[ĄA] SP(?:ÓŁ|OL)KA KOMANDYTOWA',
      'SP\\.? Z ?O\\.?O\\.? SP\\.? ?K\\.?',
    ],
    form: 'Spółka z ograniczoną odpowiedzialnością spółka komandytowa',
  },
  {
    endings: ['SP(?:ÓŁ|OL)KA Z OGRANICZON[ĄA] ODPOWIEDZIALNO[ŚS]CI[ĄA]', 'SP\\.? Z ?O\\.?O\\.?'],
    form: 'Spółka z ograniczoną odpowiedzialnością',
  },
  { endings: ['SP(?:ÓŁ|OL)KA KOMANDYTOWO-AKCYJNA', 'S\\.?K\\.?A\\.?'], form: 'Spółka komandytowo-akcyjna' },
  { endings: ['PROSTA SP(?:ÓŁ|OL)KA AKCYJNA', 'P\\.?S\\.?A\\.?'], form: 'Prosta spółka akcyjna' },
  { endings: ['SP(?:ÓŁ|OL)KA AKCYJNA', 'S\\.?A\\.?'], form: 'Spółka akcyjna' },
  { endings: ['SP(?:ÓŁ|OL)KA KOMANDYTOWA', 'SP\\.? ?K\\.?'], form: 'Spółka komandytowa' },
  { endings: ['SP(?:ÓŁ|OL)KA JAWNA', 'SP\\.? ?J\\.?'], form: 'Spółka jawna' },
  { endings: ['SP(?:ÓŁ|OL)KA PARTNERSKA', 'SP\\.? ?P\\.?'], form: 'Spółka partnerska' },
  { endings: ['SP(?:ÓŁ|OL)KA CYWILNA', 'S\\.?C\\.?'], form: 'Spółka cywilna' },
  { endings: ['SP(?:ÓŁ|OL)DZIELNIA.*'], form: 'Spółdzielnia' },
  { endings: ['FUNDACJA.*'], form: 'Fundacja' },
  { endings: ['STOWARZYSZENIE.*'], form: 'Stowarzyszenie' },
];

const LEGAL_FORM_PATTERNS = LEGAL_FORMS.map(({ endings, form }) => ({
  pattern: new RegExp(`(?:^|\\s)(?:${endings.join('|')})$`),
  form,
}));

/**
 * Reads the legal form from the end of the name. The White List has no field for it (the KRS number
 * only says the entity is court-registered).
 */
export function polishLegalForm(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/["',]+$/, '')
    .trim();
  return LEGAL_FORM_PATTERNS.find(({ pattern }) => pattern.test(normalized))?.form ?? null;
}

/** "Czynny" (active) and "Zwolniony" (exempt) both mean registered. */
export function mapPolishSubject(subject: WhiteListSubject): CompanyRecord | null {
  const nip = subject.nip?.replace(/[^0-9]/g, '');
  if (!nip || !/^[0-9]{10}$/.test(nip)) return null;

  const status = subject.statusVat ?? '';
  // One string, "UL. PROSTA 51, 00-838 WARSZAWA", split here so the answer is as detailed as VIES's.
  const address = parseAddress(subject.workingAddress ?? subject.residenceAddress ?? null, 'PL');

  return {
    vatNumber: `PL${nip}`,
    nationalId: subject.regon ?? nip,
    name: subject.name ?? null,
    legalForm: polishLegalForm(subject.name),
    status: status === 'Czynny' || status === 'Zwolniony' ? 'active' : 'inactive',
    addressLine1: address.line1,
    addressLine2: address.line2,
    postalCode: address.postalCode,
    city: address.city,
    addressCountry: 'PL',
    companyLastUpdatedAt: parseUtcDate(subject.registrationLegalDate),
  };
}

export class WhiteListSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Wykaz podatników VAT (Ministerstwo Finansów)';
  readonly countryCode = 'PL';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    // The API answers "as of" a day: today.
    const date = new Date().toISOString().slice(0, 10);
    const url = `${API_BASE}/${encodeURIComponent(vat.nationalNumber)}?date=${date}`;

    const response = await fetchJson<WhiteListResponse>(url, {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    const subject = response.result?.subject;
    return this.answer(subject ? mapPolishSubject(subject) : null);
  }
}

export const whiteList = new WhiteListSource();
