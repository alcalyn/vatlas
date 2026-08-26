import { fetchJsonOrNull } from '../../../lib/http.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The Servicio de Rentas Internas, through the REST service used by its own portal: open, no key,
 * no quota.
 *
 * Identity and establishments are two endpoints, both called. The address call is best effort: a
 * company without its street is better than no answer.
 *
 * Both answer an unknown number with 204 and an empty body, so they use `fetchJsonOrNull`
 * (`fetchJson` would see a parse failure, retry, and report an outage).
 */
const API_BASE = 'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest';

export const SOURCE = 'SRI';

interface TaxpayerDates {
  fechaInicioActividades?: string;
  fechaCese?: string;
  fechaActualizacion?: string;
}

export interface SriTaxpayer {
  numeroRuc?: string;
  razonSocial?: string;
  estadoContribuyenteRuc?: string;
  tipoContribuyente?: string;
  regimen?: string;
  informacionFechasContribuyente?: TaxpayerDates;
}

export interface SriEstablishment {
  direccionCompleta?: string;
  estado?: string;
  numeroEstablecimiento?: string;
  matriz?: string;
}

/** `ACTIVO` is live. `SUSPENDIDO` (suspended) and `PASIVO` (closed) are not. */
function statusOf(estado: string | undefined): CompanyRecord['status'] {
  const value = estado?.trim().toUpperCase();
  if (!value) return 'unknown';
  if (value === 'ACTIVO') return 'active';
  if (value === 'SUSPENDIDO' || value === 'PASIVO') return 'inactive';
  return 'unknown';
}

/** `2026-09-10 16:11:00.0`: a space instead of `T`, and tenths of a second. */
function parseSriDate(value: string | undefined): Date | null {
  const text = value?.trim();
  if (!text) return null;
  const parsed = new Date(text.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * An Ecuadorian address is a path: province, cantón, parroquia, then the street:
 * `PICHINCHA / RUMIÑAHUI / COTOGCHOA / AV. GENERAL ENRIQUEZ S/N`.
 *
 * Split on " / " rather than "/" because streets often end in `S/N` (sin número). The cantón is
 * used as the city.
 */
export function splitEcuadorianAddress(direccion: string | null | undefined): {
  line1: string | null;
  line2: string | null;
  city: string | null;
} {
  const parts = (direccion ?? '')
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { line1: null, line2: null, city: null };
  // Shorter paths are kept whole.
  if (parts.length < 3) return { line1: parts.join(', '), line2: null, city: null };
  return { line1: parts.at(-1) ?? null, line2: parts.at(-2) ?? null, city: parts[1] ?? null };
}

/** The head office among the establishments. */
export function headOffice(establishments: SriEstablishment[] | null): SriEstablishment | null {
  return establishments?.find((place) => place.matriz?.trim().toUpperCase() === 'SI') ?? null;
}

export function mapEcuadorianTaxpayer(
  ruc: string,
  taxpayer: SriTaxpayer,
  establishments: SriEstablishment[] | null,
): CompanyRecord | null {
  const name = taxpayer.razonSocial?.trim();
  if (!name) return null;

  const address = splitEcuadorianAddress(headOffice(establishments)?.direccionCompleta);

  return {
    vatNumber: `EC${ruc}`,
    nationalId: ruc,
    name,
    // The register's taxpayer type (`SOCIEDAD`, `PERSONA NATURAL`).
    legalForm: taxpayer.tipoContribuyente?.trim() ?? null,
    status: statusOf(taxpayer.estadoContribuyenteRuc),
    addressLine1: address.line1,
    addressLine2: address.line2,
    // No postal code.
    postalCode: null,
    city: address.city,
    addressCountry: 'EC',
    companyLastUpdatedAt: parseSriDate(taxpayer.informacionFechasContribuyente?.fechaActualizacion),
  };
}

export class SriSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'Servicio de Rentas Internas (catastro de RUC)';
  readonly countryCode = 'EC';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const ruc = vat.nationalNumber;
    const options = { timeoutMs: 15_000, retries: 2, deadline: context.deadline };

    // The parameter is `ruc`, not `numerosRuc` like the path. The latter answers 400.
    const taxpayers = await fetchJsonOrNull<SriTaxpayer[]>(
      `${API_BASE}/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc=${encodeURIComponent(ruc)}`,
      options,
    );
    const taxpayer = taxpayers?.[0];
    if (!taxpayer) return { status: 'not-found' };

    const establishments = await this.establishments(ruc, options);
    return this.answer(mapEcuadorianTaxpayer(ruc, taxpayer, establishments));
  }

  /** Establishments, the only source of an Ecuadorian address. Best effort. */
  private async establishments(
    ruc: string,
    options: { timeoutMs: number; retries: number; deadline?: number },
  ): Promise<SriEstablishment[] | null> {
    try {
      return await fetchJsonOrNull<SriEstablishment[]>(
        `${API_BASE}/Establecimiento/consultarPorNumeroRuc?numeroRuc=${encodeURIComponent(ruc)}`,
        options,
      );
    } catch (error) {
      this.logger.warn({ err: error, ruc }, 'SRI establishments unavailable, answering without an address');
      return null;
    }
  }
}

export const sri = new SriSource();
