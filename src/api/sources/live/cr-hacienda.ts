import { fetchJson } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The Costa Rican Ministry of Finance's e-invoicing API, used by every invoicing system in the
 * country. Open, no key, no quota. It says whether a number is registered and under which name.
 *
 * No address: the service validates invoices, it is not a directory.
 */
const API_BASE = 'https://api.hacienda.go.cr/fe/ae';

/**
 * Akamai filters the API with a User-Agent allowlist: `curl`, `Wget`, `python-requests`, `axios`,
 * `Java` and `Go-http-client` pass; `undici`, browser strings and `vatlas/1.0` get a 403, and any
 * User-Agent containing a URL gets a 400. No User-Agent works from a residential IP but not from a
 * datacenter.
 *
 * So a common HTTP client name is used. It is not a browser impersonation.
 */
const HEADERS = { 'user-agent': 'curl/8.14.1' };

export const SOURCE = 'HACIENDA';

/**
 * The legal form is in the number: a cédula jurídica is `3-1NN-XXXXXX`, and the middle group gives
 * the type. Only commercial forms are listed. Unknown groups stay null.
 */
const LEGAL_FORMS: Record<string, string> = {
  '3101': 'Sociedad Anónima',
  '3102': 'Sociedad de Responsabilidad Limitada',
  '3103': 'Sociedad en Nombre Colectivo',
  '3104': 'Sociedad en Comandita',
  '3105': 'Sociedad Extranjera',
  '3106': 'Empresa Individual de Responsabilidad Limitada',
};

export function costaRicanLegalForm(identification: string): string | null {
  return LEGAL_FORMS[identification.slice(0, 4)] ?? null;
}

interface HaciendaSituation {
  estado?: string;
  moroso?: string;
  omiso?: string;
  administracionTributaria?: string;
}

export interface HaciendaTaxpayer {
  nombre?: string;
  tipoIdentificacion?: string;
  regimen?: { codigo?: number; descripcion?: string };
  situacion?: HaciendaSituation;
  actividades?: { estado?: string; tipo?: string; codigo?: string; descripcion?: string }[];
}

/**
 * `Inscrito` and `Inscrito de oficio` (opened by the administration) are live. Anything else
 * (`Desinscrito`, `No inscrito`) is not a current taxpayer.
 */
function statusOf(situation: HaciendaSituation | undefined): CompanyRecord['status'] {
  const estado = situation?.estado?.trim().toLowerCase();
  if (!estado) return 'unknown';
  return estado.startsWith('inscrito') ? 'active' : 'inactive';
}

export function mapCostaRicanTaxpayer(identification: string, taxpayer: HaciendaTaxpayer): CompanyRecord | null {
  const name = taxpayer.nombre?.trim();
  if (!name) return null;

  return {
    vatNumber: `CR${identification}`,
    nationalId: identification,
    name,
    legalForm: costaRicanLegalForm(identification),
    status: statusOf(taxpayer.situacion),
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'CR',
    companyLastUpdatedAt: null,
  };
}

export class HaciendaSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Ministerio de Hacienda (API de facturación electrónica)';
  readonly countryCode = 'CR';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const identification = vat.nationalNumber;
    // An unknown number answers 404, which `fetch` turns into `not-found`.
    const taxpayer = await fetchJson<HaciendaTaxpayer>(
      `${API_BASE}?identificacion=${encodeURIComponent(identification)}`,
      { timeoutMs: 15_000, retries: 2, headers: HEADERS, deadline: context.deadline },
    );
    return this.answer(mapCostaRicanTaxpayer(identification, taxpayer));
  }
}

export const hacienda = new HaciendaSource();
