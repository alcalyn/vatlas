import { fetchJson } from '../../../lib/http.js';
import { parseUtcDayMonthYear } from '../../../lib/time.js';
import { decodeXmlEntities, extractTag, streamXmlElements } from '../../../lib/xml.js';
import { openZipEntries } from '../../../lib/zip.js';
import type { CompanyRecord, CompanyStatus } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The Єдиний державний реєстр, the Ukrainian register of legal entities, published weekly by the
 * Ministry of Justice on data.gov.ua under CC-BY, without account, key or quota.
 *
 * The register is keyed by ЄДРПОУ (eight digits), and invoices carry the ІПН (twelve digits). The
 * first seven digits are shared: the eighth digit of the ЄДРПОУ is a check digit, and the ІПН
 * adds a serial and the tax office. So one can be computed from the other: 98.9% of 245,863 real
 * ІПН map to a ЄДРПОУ in this file. `VAT_RULES.UA.normalize` does the conversion before this mapper
 * runs.
 *
 * Limits (also in the country's `importNote`):
 *
 * - No address: it was withdrawn under martial law and is not in the schema.
 * - No VAT (ПДВ) status: `TAX_PAYER_TYPE` only lists other tax registers. The tax service's VAT
 *   register is closed since February 2022.
 * - Legal persons only. The sole traders archive (`FOP.zip`) has no identifier at all, so they
 *   could never be looked up.
 *
 * The file is windows-1251. Read as UTF-8, every name breaks.
 */
const PACKAGE_URL = 'https://data.gov.ua/api/3/action/package_show?id=03cc1239-3988-4451-aa0d-aadb77448714';

/** The legal entities archive. `fop.zip` and `fsu.zip` are not read. */
const FILE = 'uo.zip';

const SLOT = 'ua_edr.zip';

export const SOURCE = 'EDR';

/** Node sends no `User-Agent`, and data.gov.ua is behind Cloudflare. Sending one is a precaution. */
const HEADERS = { 'user-agent': 'vatlas/1.0 (+https://vatlas.dev)' };

interface CkanResource {
  url?: string;
  name?: string;
}

interface CkanPackage {
  result?: { resources?: CkanResource[] };
}

/**
 * `<STAN>` has six values. A company being wound up or in bankruptcy still exists and can still
 * invoice, so it is not `inactive`.
 */
export function ukrainianStatus(stan: string | null): CompanyStatus {
  if (!stan) return 'unknown';
  const value = stan.trim().toLowerCase();
  if (value.startsWith('зареєстровано')) return 'active';
  if (value.startsWith('в стані припинення') || value.startsWith('порушено справу')) return 'active';
  if (value.startsWith('припинено') || value.startsWith('скасовано')) return 'inactive';
  return 'unknown';
}

/**
 * `REGISTRATION` holds three fields: registration date, then date and number of the last registry
 * action (`24.05.2005; 24.05.2005; 10671020000003069`). The second date is used for
 * `companyLastUpdatedAt`.
 */
function registrationDate(registration: string | null): Date | null {
  const parts = (registration ?? '').split(';').map((part) => part.trim());
  return parseUtcDayMonthYear(parts[1]) ?? parseUtcDayMonthYear(parts[0]);
}

/**
 * Maps one `<SUBJECT>`. Null when `<EDRPOU>` is missing or not eight digits (a few have seven, and
 * padding them would invent a company).
 */
export function mapEdrSubject(xml: string): CompanyRecord | null {
  const edrpou = extractTag(xml, 'EDRPOU');
  if (!edrpou || !/^[0-9]{8}$/.test(edrpou)) return null;

  const name = extractTag(xml, 'NAME') ?? extractTag(xml, 'SHORT_NAME');
  if (!name) return null;

  return {
    vatNumber: `UA${edrpou}`,
    // `RECORD` is the register's own id, used as `nationalId`. The ЄДРПОУ is the key.
    nationalId: extractTag(xml, 'RECORD'),
    // The name includes the legal form («ПРИВАТНЕ ПІДПРИЄМСТВО "ФОРЕСТПРОМТРЕЙД"»), and `OPF` repeats
    // it as a separate field.
    name: decodeXmlEntities(name),
    legalForm: extractTag(xml, 'OPF'),
    status: ukrainianStatus(extractTag(xml, 'STAN')),
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    addressCountry: 'UA',
    companyLastUpdatedAt: registrationDate(extractTag(xml, 'REGISTRATION')),
  };
}

export class EdrBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Єдиний державний реєстр юридичних осіб (Мін’юст України)';
  readonly countryCode = 'UA';
  override readonly slots = [SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const url = context.options.localFiles?.has(SLOT) === true ? '' : await this.resource(context);

    // No date passed: CKAN's `last_modified` lags behind the file, so the HEAD inside
    // `fetchArtefact` dates the edition, still before downloading.
    const archive = await this.fetchArtefact(context, SLOT, { url, fileName: FILE }, { headers: HEADERS });
    const batch = this.batch(context, counters);

    // One member, `UO.xml`, about 1.9 GB.
    for await (const member of openZipEntries(archive.path, (name) => name.toLowerCase().endsWith('.xml'))) {
      for await (const subject of streamXmlElements(member.stream, 'SUBJECT', 'windows-1251')) {
        await batch.add(mapEdrSubject(subject));
        if (batch.full) {
          context.logger.info({ limit: context.options.limit }, 'Ukraine: sample limit reached, stopping');
          member.stream.destroy();
          await batch.flush();
          return;
        }
      }
    }

    await batch.flush();
  }

  /**
   * URL of `uo.zip` in the current edition. Not hard-coded, so a renamed or removed archive fails
   * here rather than during a download.
   */
  private async resource(context: ImportContext): Promise<string> {
    const payload = await fetchJson<CkanPackage>(PACKAGE_URL, { timeoutMs: 30_000, headers: HEADERS });
    const resources = payload.result?.resources ?? [];
    const match = resources.find((resource) => resource.url?.toLowerCase().endsWith(`/${FILE}`));
    if (!match?.url) {
      throw new Error(`the ЄДР dataset no longer publishes ${FILE}`);
    }
    context.logger.info({ resources: resources.length }, 'Ukraine: read the data.gov.ua dataset');
    return match.url;
  }
}

export const edrBulk = new EdrBulkSource();
