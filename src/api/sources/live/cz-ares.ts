import { fetchJson } from '../../../lib/http.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * ARES, the Ministry of Finance register of economic subjects. It publishes the DIČ (`CZ` + IČO)
 * with the company, free and without authentication. The Czech VAT number is the prefixed IČO, so
 * one request resolves it.
 */
const API_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';

export const SOURCE = 'ARES';

/**
 * ARES returns the legal form as a code. These cover almost the whole register. Unknown codes are
 * kept as is.
 */
const LEGAL_FORMS: Record<string, string> = {
  '100': 'Podnikající fyzická osoba',
  '101': 'Fyzická osoba podnikající dle živnostenského zákona',
  '111': 'Veřejná obchodní společnost (v.o.s.)',
  '112': 'Společnost s ručením omezeným (s.r.o.)',
  '113': 'Společnost komanditní (k.s.)',
  '121': 'Akciová společnost (a.s.)',
  '141': 'Obecně prospěšná společnost',
  '205': 'Družstvo',
  '301': 'Státní podnik',
  '325': 'Organizační složka státu',
  '331': 'Příspěvková organizace',
  '601': 'Vysoká škola',
  '641': 'Pobočný spolek',
  '706': 'Spolek',
  '736': 'Nadace',
  '751': 'Zájmové sdružení právnických osob',
  '801': 'Obec',
  '804': 'Kraj',
};

export function czechLegalForm(code: string | undefined | null): string | null {
  if (!code) return null;
  return LEGAL_FORMS[code] ?? code;
}

interface AresSeat {
  kodStatu?: string;
  nazevObce?: string;
  nazevUlice?: string;
  nazevCastiObce?: string;
  cisloDomovni?: number;
  cisloOrientacni?: number;
  cisloOrientacniPismeno?: string;
  psc?: number;
  textovaAdresa?: string;
}

export interface AresSubject {
  ico?: string;
  dic?: string;
  obchodniJmeno?: string;
  pravniForma?: string;
  sidlo?: AresSeat;
  datumVzniku?: string;
  datumZaniku?: string;
  datumAktualizace?: string;
  seznamRegistraci?: Record<string, string>;
}

/** `psc` is a number. Czech postal codes are written as three digits, a space, two digits. */
function formatPostalCode(psc: number | undefined): string | null {
  if (psc === undefined || psc === null) return null;
  const digits = String(psc).padStart(5, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Street, house number and orientation number, in Czech order. */
function formatStreet(seat: AresSeat | undefined): string | null {
  if (!seat) return null;
  const orientation = seat.cisloOrientacni ? `/${seat.cisloOrientacni}${seat.cisloOrientacniPismeno ?? ''}` : '';
  const number = seat.cisloDomovni ? `${seat.cisloDomovni}${orientation}` : '';
  const line = [seat.nazevUlice ?? seat.nazevCastiObce, number].filter(Boolean).join(' ').trim();
  return line.length > 0 ? line : (seat.textovaAdresa ?? null);
}

/** Maps one ARES subject. Null without a DIČ: not VAT registered, which is for VIES to say. */
export function mapCzechSubject(subject: AresSubject): CompanyRecord | null {
  const ico = subject.ico?.replace(/[^0-9]/g, '');
  const dic = subject.dic?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!ico || !dic || !dic.startsWith('CZ')) return null;

  const vatNumber = dic.slice(2);
  if (!/^[0-9]{8,10}$/.test(vatNumber)) return null;

  return {
    vatNumber: `CZ${vatNumber}`,
    nationalId: ico,
    name: subject.obchodniJmeno ?? null,
    legalForm: czechLegalForm(subject.pravniForma),
    status: subject.datumZaniku ? 'inactive' : 'active',
    addressLine1: formatStreet(subject.sidlo),
    addressLine2: subject.sidlo?.nazevCastiObce ?? null,
    postalCode: formatPostalCode(subject.sidlo?.psc),
    city: subject.sidlo?.nazevObce ?? null,
    addressCountry: subject.sidlo?.kodStatu ?? 'CZ',
    companyLastUpdatedAt: parseUtcDate(subject.datumAktualizace),
  };
}

export class AresSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'ARES (Ministerstvo financí)';
  readonly countryCode = 'CZ';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    // ARES is keyed by IČO, the national part of the Czech VAT number.
    const subject = await fetchJson<AresSubject>(`${API_BASE}/${encodeURIComponent(vat.nationalNumber)}`, {
      timeoutMs: 15_000,
      retries: 2,
      deadline: context.deadline,
    });
    // Some deployments answer a miss with a `kod` payload instead of a 404.
    return this.answer(subject.ico ? mapCzechSubject(subject) : null);
  }
}

export const ares = new AresSource();
