import { postJson } from '../../../lib/http.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer } from '../types.js';
import {
  cvrAuthorization,
  cvrCredentials,
  DISTRIBUTION,
  mapDanishCompany,
  type CvrCompany,
  type CvrResponse,
} from './dk-cvr.js';

/**
 * Greenland, read from the Danish CVR. The Greenlandic register was merged into the CVR on
 * 2018-01-01, so the Danish endpoint and account are used and nothing is imported.
 *
 * Greenland has no VAT. The number is the CVR registration number, eight digits like Denmark's:
 * `GL12608950` and `DK12608950` are the same legal person. Only the seat tells them apart, so a
 * `GL` lookup only answers for a company seated in Greenland.
 *
 * The Danish adapter is unchanged: looking up a Greenlandic company under `DK` is valid too.
 */
export const SOURCE = 'CVR-GL';

/**
 * Whether the company is seated in Greenland. Both checks are needed: on 2026-09-17,
 * `landekode = GL` matched 14,520 companies and postal codes 3900-3999 matched 14,532. The 39xx
 * range is Greenland's only.
 */
export function isGreenlandic(company: CvrCompany): boolean {
  const address = company.virksomhedMetadata?.nyesteBeliggenhedsadresse;
  if (!address) return false;
  if (address.landekode?.toUpperCase() === 'GL') return true;
  const postalCode = address.postnummer;
  return postalCode !== undefined && postalCode >= 3900 && postalCode <= 3999;
}

export class GreenlandCvrSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'CVR distribution (Erhvervsstyrelsen), Greenland';
  readonly countryCode = 'GL';

  override get available(): boolean {
    return cvrCredentials() !== null;
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const credentials = cvrCredentials()!;
    const response = await postJson<CvrResponse>(
      DISTRIBUTION,
      { size: 1, query: { term: { 'Vrvirksomhed.cvrNummer': Number(vat.nationalNumber) } } },
      {
        headers: cvrAuthorization(credentials.user, credentials.password),
        timeoutMs: 15_000,
        retries: 2,
        deadline: context.deadline,
      },
    );

    const company = response.hits?.hits?.[0]?._source?.Vrvirksomhed;
    // Not `not-registered`: the number exists, but not in this country.
    if (!company || !isGreenlandic(company)) return this.answer(null);
    return this.answer(mapDanishCompany(company, 'GL'));
  }
}

export const greenlandCvr = new GreenlandCvrSource();
