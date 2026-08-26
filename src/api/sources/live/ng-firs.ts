import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * Nigeria's TIN verification, the Nigeria Revenue Service's public check. Open, free, no captcha.
 *
 * The CAC (company register) is behind a Cloudflare challenge, so this is the only Nigerian
 * source.
 *
 * It is a WebForms page, not an API: a GET for the three hidden ASP.NET state tokens, then a POST
 * with them. Four fields of predictable generated markup are read with regexes, without an HTML
 * parser.
 *
 * It returns a name, the two numbers and the tax office. No address, no legal form, no status.
 */
const ENDPOINT = 'https://apps.firs.gov.ng/tinverification/';

export const SOURCE = 'FIRS';

/** One GET and one POST per lookup, and the page is slow. */
const TIMEOUT_MS = 20_000;

/**
 * The value of a form field. Each is rendered as `name="txtX" type="text" value="..." id="txtX"`,
 * so the match is anchored on the name.
 */
export function formField(html: string, field: string): string | null {
  const match = new RegExp(`name="${field}"[^>]*?value="([^"]*)"`).exec(html);
  const value = match?.[1]?.trim();
  return value ? decodeEntities(value) : null;
}

/** The page is ASCII with HTML entities. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * How the number is typed in the form, not how it is stored.
 *
 * The ten-digit JTB number is typed as is. The older FIRS number is eight digits, a hyphen and
 * four more, and the hyphen is required: `009690090001` finds nothing, `00969009-0001` finds MTN.
 */
export function spellTin(nationalNumber: string): string {
  return nationalNumber.length === 12 ? `${nationalNumber.slice(0, 8)}-${nationalNumber.slice(8)}` : nationalNumber;
}

export function mapNigerianTaxpayer(nationalNumber: string, html: string): CompanyRecord | null {
  const name = formField(html, 'txtName');
  if (!name) return null;

  return {
    vatNumber: `NG${nationalNumber}`,
    nationalId: formField(html, 'txtRC') ?? nationalNumber,
    name,
    // The legal form is at the end of the name (`PLC`, `LIMITED`, `NIG LTD`) and is not extracted.
    legalForm: null,
    // The service says whether a number is registered, not whether the taxpayer trades.
    status: 'unknown',
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'NG',
    companyLastUpdatedAt: null,
  };
}

export class FirsSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'NRS TIN Verification (Nigeria Revenue Service)';
  readonly countryCode = 'NG';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const nationalNumber = vat.nationalNumber;

    // The service sometimes misses a valid number and finds it on the next try, so one retry. The
    // tokens are single use anyway.
    let html = await this.search(nationalNumber, context);
    if (formField(html, 'txtName') === null && this.saidNothing(html)) {
      html = await this.search(nationalNumber, context);
    }

    const record = mapNigerianTaxpayer(nationalNumber, html);
    if (record) return this.answer(record);

    // `Alert1` is the miss message. A page with neither a name nor the alert is an outage.
    if (this.saidNothing(html)) return { status: 'not-found' };
    throw new Error('NRS TIN verification returned neither a taxpayer nor a miss');
  }

  private saidNothing(html: string): boolean {
    return /id="Alert1"/.test(html);
  }

  /** Tokens, then the query carrying them. */
  private async search(nationalNumber: string, context: FetchContext): Promise<string> {
    const page = await this.get(ENDPOINT, context);
    const body = new URLSearchParams({
      __VIEWSTATE: formField(page, '__VIEWSTATE') ?? '',
      __VIEWSTATEGENERATOR: formField(page, '__VIEWSTATEGENERATOR') ?? '',
      __EVENTVALIDATION: formField(page, '__EVENTVALIDATION') ?? '',
      DropDownList1: 'TIN',
      TextBox1: spellTin(nationalNumber),
      Button1: 'Search',
    });

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.budget(context)),
    });
    if (!response.ok) throw new Error(`POST ${ENDPOINT} failed: HTTP ${response.status}`);
    return response.text();
  }

  private async get(url: string, context: FetchContext): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.budget(context)) });
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    return response.text();
  }

  /** Remaining lookup budget, capped: up to four calls share one deadline. */
  private budget(context: FetchContext): number {
    if (context.deadline === undefined) return TIMEOUT_MS;
    return Math.min(TIMEOUT_MS, Math.max(1, context.deadline - Date.now()));
  }
}

export const firs = new FirsSource();
