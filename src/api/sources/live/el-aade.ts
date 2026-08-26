import { config } from '../../../config.js';
import { extractTag } from '../../../lib/xml.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * AADE's RgWsPublic2, the Greek tax register lookup.
 *
 * Free, but requires a TAXISnet special-purpose account, only issued to Greek taxpayers. Without
 * `AADE_USER` / `AADE_PASSWORD` the source is unavailable (the usual case).
 *
 * Greece uses `EL`, the VAT prefix, as returned by `normalizeCountryCode`.
 */
const ENDPOINT = 'https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2';

export const SOURCE = 'AADE';

export interface AadeFields {
  afm?: string | null;
  onomasia?: string | null;
  doyDescr?: string | null;
  postalAddress?: string | null;
  postalAddressNo?: string | null;
  postalZipCode?: string | null;
  postalAreaDescription?: string | null;
  legalStatusDescr?: string | null;
  deactivationFlag?: string | null;
  firmFlagDescr?: string | null;
}

/** Maps the `basic_rec` block. `deactivationFlag` is "1" for active and "2" for deactivated. */
export function mapGreekFields(fields: AadeFields): CompanyRecord | null {
  const afm = fields.afm?.replace(/[^0-9]/g, '');
  if (!afm || !/^[0-9]{9}$/.test(afm)) return null;

  const line1 = [fields.postalAddress, fields.postalAddressNo].filter(Boolean).join(' ').trim();

  return {
    vatNumber: `EL${afm}`,
    nationalId: afm,
    name: fields.onomasia ?? null,
    legalForm: fields.legalStatusDescr ?? null,
    status: fields.deactivationFlag === '1' ? 'active' : 'inactive',
    addressLine1: line1.length > 0 ? line1 : null,
    addressLine2: null,
    postalCode: fields.postalZipCode ?? null,
    city: fields.postalAreaDescription ?? null,
    addressCountry: 'EL',
    companyLastUpdatedAt: null,
  };
}

/** Reads the `basic_rec` fields from the SOAP answer. */
export function parseAadeResponse(xml: string): AadeFields | null {
  if (extractTag(xml, 'faultstring')) return null;
  // Business errors are reported in the body, not as faults.
  const errorCode = extractTag(xml, 'errorCode');
  if (errorCode) return null;

  const afm = extractTag(xml, 'afm');
  if (!afm) return null;

  return {
    afm,
    onomasia: extractTag(xml, 'onomasia'),
    doyDescr: extractTag(xml, 'doyDescr'),
    postalAddress: extractTag(xml, 'postalAddress'),
    postalAddressNo: extractTag(xml, 'postalAddressNo'),
    postalZipCode: extractTag(xml, 'postalZipCode'),
    postalAreaDescription: extractTag(xml, 'postalAreaDescription'),
    legalStatusDescr: extractTag(xml, 'legalStatusDescr'),
    deactivationFlag: extractTag(xml, 'deactivationFlag'),
    firmFlagDescr: extractTag(xml, 'firmFlagDescr'),
  };
}

/** WS-Security UsernameToken in the header. */
function envelope(user: string, password: string, afm: string): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="http://rgwspublic2/RgWsPublic2Service" xmlns:ns2="http://rgwspublic2/RgWsPublic2">
  <env:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${escape(user)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escape(password)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </env:Header>
  <env:Body>
    <ns1:rgWsPublic2AfmMethod>
      <ns1:INPUT_REC>
        <ns2:afm_called_for>${escape(afm)}</ns2:afm_called_for>
        <ns2:as_on_date/>
      </ns1:INPUT_REC>
    </ns1:rgWsPublic2AfmMethod>
  </env:Body>
</env:Envelope>`;
}

export class AadeSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'RgWsPublic2 (ΑΑΔΕ)';
  readonly countryCode = 'EL';

  override get available(): boolean {
    const { user, password } = config.sources.aade;
    return Boolean(user && password);
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const { user, password } = config.sources.aade;
    // One attempt, within the remaining lookup budget: this runs before VIES.
    const timeoutMs = Math.min(config.vies.timeoutMs, Math.max(1, context.deadline - Date.now()));
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
      body: envelope(user!, password!, vat.nationalNumber),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Like VIES, faults come with HTTP 200, so the body decides.
    const fields = parseAadeResponse(await response.text());
    return this.answer(fields ? mapGreekFields(fields) : null);
  }
}

export const aade = new AadeSource();
