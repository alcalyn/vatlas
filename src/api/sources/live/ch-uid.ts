import { postXml } from '../../../lib/http.js';
import { extractTag as extract } from '../../../lib/xml.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';

/**
 * The UID register of the Federal Statistical Office: every Swiss enterprise, keyed by the number
 * on Swiss invoices, over an open SOAP service.
 *
 * `PublicServices.svc` is the public part of the UID web service (`GetByUID`, `Search`,
 * `ValidateUID`, `ValidateVatNumber`). The limit is 20 calls per minute, above which the caller is
 * temporarily blocked, so it is called once per lookup.
 *
 * `vatStatus` says whether the unit is in the MWST register and `vatEntryStatus` whether that entry
 * is still live, so a Swiss number not valid for VAT comes back as `not-registered`. Both code lists
 * come from the BFS interface specification 5.0.
 */
const ENDPOINT = 'https://www.uid-wse.admin.ch/V5.0/PublicServices.svc';
const ACTION = 'http://www.uid.admin.ch/xmlns/uid-wse/IPublicServices/GetByUID';

export const SOURCE = 'UID';

/** `2` means "in the MWST register", `3` means not, `1` never occurs. */
const VAT_REGISTERED = '2';
/** `1` is live, `2` is struck off the MWST register. */
const VAT_ENTRY_ACTIVE = '1';
/** Commercial register: `1` active, `2` struck off, `3` provisional. */
const HR_ENTRY_DELETED = '2';

/** eCH-0097 legal form codes. Only company forms are listed. Unknown codes stay null. */
const LEGAL_FORMS: Record<string, string> = {
  '0101': 'Einzelunternehmen',
  '0103': 'Kollektivgesellschaft',
  '0104': 'Kommanditgesellschaft',
  '0105': 'Kommanditaktiengesellschaft',
  '0106': 'Aktiengesellschaft',
  '0107': 'Gesellschaft mit beschränkter Haftung',
  '0108': 'Genossenschaft',
  '0109': 'Verein',
  '0110': 'Stiftung',
  '0302': 'Mehrwertsteuergruppe',
};

export function swissLegalForm(code: string | null): string | null {
  return code ? (LEGAL_FORMS[code.trim()] ?? null) : null;
}

/**
 * A unit has several addresses by `addressCategory`: `LEGAL` (seat), `POBOX`, `MAILING`. The seat
 * is used, or the first address when there is none.
 */
export function legalAddress(organisation: string): string | null {
  const blocks = organisation.match(/<(?:\w+:)?address(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?address>/g) ?? [];
  return blocks.find((block) => extract(block, 'addressCategory') === 'LEGAL') ?? blocks[0] ?? null;
}

/**
 * Active unless the commercial register says struck off. Units outside the commercial register
 * (small sole traders, associations) use their VAT entry. With neither, `unknown`.
 */
function statusOf(organisationType: string): CompanyRecord['status'] {
  const hr = extract(organisationType, 'commercialRegisterEntryStatus');
  if (hr) return hr === HR_ENTRY_DELETED ? 'inactive' : 'active';
  const vat = extract(organisationType, 'vatEntryStatus');
  if (vat) return vat === VAT_ENTRY_ACTIVE ? 'active' : 'inactive';
  return 'unknown';
}

/** Whether the unit is in the MWST register today. */
export function isVatRegistered(organisationType: string): boolean {
  if (extract(organisationType, 'vatStatus') !== VAT_REGISTERED) return false;
  const entry = extract(organisationType, 'vatEntryStatus');
  return entry === null || entry === VAT_ENTRY_ACTIVE;
}

/**
 * `GetByUID` returns an array (a UID can carry the enterprise and its VAT group), or an empty
 * `<GetByUIDResult/>`. The first entry is the unit itself.
 */
export function firstOrganisation(body: string): string | null {
  return /<(?:\w+:)?organisationType(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?organisationType>/.exec(body)?.[0] ?? null;
}

export function mapSwissOrganisation(uid: string, organisationType: string): CompanyRecord | null {
  // `organisationName` is the name in use, `organisationLegalName` the registered one. The registered
  // one comes first.
  const name = (
    extract(organisationType, 'organisationLegalName') ?? extract(organisationType, 'organisationName')
  )?.trim();
  if (!name) return null;

  const address = legalAddress(organisationType);
  const street = extract(address ?? '', 'street')?.trim() ?? null;
  const houseNumber = extract(address ?? '', 'houseNumber')?.trim() ?? null;

  return {
    vatNumber: `CH${uid}`,
    nationalId: uid,
    name,
    legalForm: swissLegalForm(extract(organisationType, 'legalForm')),
    status: statusOf(organisationType),
    // `addressLine1` is the street and number. `addressLine2` holds the two free lines (c/o, foreign
    // address).
    addressLine1:
      [street, houseNumber].filter(Boolean).join(' ') || extract(address ?? '', 'addressLine1')?.trim() || null,
    addressLine2: extract(address ?? '', 'addressLine2')?.trim() ?? null,
    postalCode: (extract(address ?? '', 'swissZipCode') ?? extract(address ?? '', 'foreignZipCode'))?.trim() ?? null,
    city: extract(address ?? '', 'town')?.trim() ?? null,
    addressCountry: extract(address ?? '', 'countryIdISO2')?.trim() ?? 'CH',
    companyLastUpdatedAt: null,
  };
}

/**
 * `uid` is in the service's namespace and its two children in eCH-0097. Getting this wrong returns
 * `Application_error`.
 */
function envelopeFor(uid: string): string {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetByUID xmlns="http://www.uid.admin.ch/xmlns/uid-wse">
      <uid xmlns:e="http://www.ech.ch/xmlns/eCH-0097/5">
        <e:uidOrganisationIdCategorie>CHE</e:uidOrganisationIdCategorie>
        <e:uidOrganisationId>${uid}</e:uidOrganisationId>
      </uid>
    </GetByUID>
  </s:Body>
</s:Envelope>`;
}

export class UidSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'UID-Register (Bundesamt für Statistik)';
  readonly countryCode = 'CH';

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const uid = vat.nationalNumber;
    const body = await postXml(ENDPOINT, envelopeFor(uid), {
      soapAction: ACTION,
      timeoutMs: 15_000,
      // 20 calls per minute: no retries.
      retries: 1,
      deadline: context.deadline,
    });

    const fault = extract(body, 'faultstring');
    if (fault !== null) throw new Error(`UID register fault: ${fault}`);

    const organisation = firstOrganisation(body);
    // An empty `<GetByUIDResult/>`: nothing under this number.
    if (organisation === null) return { status: 'not-found' };

    if (!isVatRegistered(organisation)) return { status: 'not-registered', checkedAt: new Date() };

    return this.answer(mapSwissOrganisation(uid, organisation));
  }
}

export const uid = new UidSource();
