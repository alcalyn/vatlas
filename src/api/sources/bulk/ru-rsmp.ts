import { decodeXmlEntities, streamXmlElements } from '../../../lib/xml.js';
import { parseUtcDayMonthYear } from '../../../lib/time.js';
import { openZipEntries } from '../../../lib/zip.js';
import type { BulkArtefact } from '../types.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The Russian register of small and medium-sized businesses, published monthly as open data by the
 * Federal Tax Service.
 *
 * The ЕГРЮЛ (full register of legal entities) is sold, and its free lookup (egrul.nalog.ru) has a
 * captcha. This file is the only free dataset keyed by ИНН.
 *
 * Limits (also in the country's `importNote`):
 *
 * - Small and medium-sized businesses only. Large companies are not in the file.
 * - No street: only region, district and town.
 * - Legal persons only. Half the documents are `<ИПВклМСП>`, individual entrepreneurs, which are
 *   dropped: millions of natural persons with no reason to be stored.
 *
 * Every monthly edition since the start (122 in September 2026) has its own URL, so `--history`,
 * `--max-files` and `--since-date` reach ten years back.
 */
const DATASET_PAGE = 'https://www.nalog.gov.ru/opendata/7707329152-rsmp/';

/** `.../data-10092026-structure-12052026.zip`: the edition date is the first of the two. */
const EDITION_URL = /https?:\/\/[^"']*\/data-(\d{2})(\d{2})(\d{4})-structure-\d{8}\.zip/g;

const SLOT = 'ru_rsmp.zip';

export const SOURCE = 'RSMP';

/**
 * Node sends no `User-Agent` by default, and some publishers answer with a challenge page without
 * one.
 */
const HEADERS = { 'user-agent': 'vatlas/1.0 (+https://vatlas.dev)' };

/** The first `<tag ...>` element of a document. Cyrillic tags, so no `\b`. */
function element(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`);
  return pattern.exec(xml)?.[0] ?? null;
}

function attribute(host: string | null, name: string): string | null {
  if (host === null) return null;
  const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(host)?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : decodeXmlEntities(value);
}

const join = (parts: (string | null)[], separator = ', '): string | null => {
  const text = parts
    .filter((part): part is string => Boolean(part))
    .join(separator)
    .trim();
  return text.length === 0 ? null : text;
};

/**
 * Place types written before the name (town, village, republic), as opposed to after it:
 * `г. Челябинск`, `Респ. Татарстан`, but `Челябинская обл.`, `Прокопьевский р-н`.
 */
const LEADING_TYPES = new Set([
  'г',
  'город',
  'пгт',
  'рп',
  'с',
  'п',
  'д',
  'х',
  'сл',
  'ст-ца',
  'п/ст',
  'респ',
  'республика',
]);

/**
 * `<Город Тип="г." Наим="Челябинск"/>` -> `г. Челябинск`.
 *
 * The register is inconsistent: `Тип="обл." Наим="Челябинская"` in one document and
 * `Тип="ОБЛАСТЬ" Наим="КЕМЕРОВСКАЯ ОБЛАСТЬ - КУЗБАСС"` in the next. The guard avoids writing the
 * type twice.
 */
function place(host: string | null): string | null {
  const name = attribute(host, 'Наим');
  if (!name) return null;
  const type = attribute(host, 'Тип');
  if (!type) return name;

  const stem = type.replace(/\.$/, '').toLowerCase();
  const words = name.toLowerCase().split(/[\s-]+/);
  // Only for stems long enough: `г` is a prefix of many town names.
  if (stem.length >= 2 && words.some((word) => word.startsWith(stem))) return name;

  return LEADING_TYPES.has(stem) ? `${type} ${name}` : `${name} ${type}`;
}

/** Maps one `<Документ>`. Null for an individual entrepreneur, see the header. */
export function mapRsmpDocument(xml: string): CompanyRecord | null {
  const org = element(xml, 'ОргВклМСП');
  const inn = attribute(org, 'ИННЮЛ');
  if (!inn || !/^[0-9]{10}$/.test(inn)) return null;

  const located = element(xml, 'СведМН');

  return {
    vatNumber: `RU${inn}`,
    // The ОГРН, the register's own number. The ИНН is the key.
    nationalId: attribute(org, 'ОГРН'),
    // The full name, which includes the legal form ("ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «...»"),
    // with the short name as fallback.
    name: attribute(org, 'НаимОрг') ?? attribute(org, 'НаимОргСокр'),
    // No separate legal form: it is in the name.
    legalForm: null,
    // Being in the register is the statement. A company that leaves it stops appearing, and its last
    // plateau says when.
    status: 'active',
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    // Town, district and region: all the file says about location.
    city: located
      ? join([
          place(element(located, 'Город')) ?? place(element(located, 'НаселПункт')),
          place(element(located, 'Район')),
          place(element(located, 'Регион')),
        ])
      : null,
    addressCountry: 'RU',
    // The day the company entered the register, the only date on a row.
    companyLastUpdatedAt: parseUtcDayMonthYear(attribute(element(xml, 'Документ'), 'ДатаВклМСП')),
  };
}

/**
 * The editions listed on the dataset page, newest first. Exported for the unit test against a
 * committed fixture.
 */
export function parseEditions(html: string): BulkArtefact[] {
  const editions = new Map<string, BulkArtefact>();
  for (const [url, day, month, year] of html.matchAll(EDITION_URL)) {
    if (!url || editions.has(url)) continue;
    editions.set(url, {
      url,
      fileName: url.slice(url.lastIndexOf('/') + 1),
      date: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
    });
  }
  return [...editions.values()];
}

export class RsmpBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Единый реестр субъектов МСП (ФНС России)';
  readonly countryCode = 'RU';
  override readonly slots = [SLOT];

  protected override async editions(context: ImportContext): Promise<BulkArtefact[]> {
    const response = await fetch(DATASET_PAGE, { redirect: 'follow', headers: HEADERS });
    if (!response.ok) {
      throw new Error(`the МСП dataset page failed: HTTP ${response.status} ${response.statusText}`);
    }
    const editions = parseEditions(await response.text());
    if (editions.length === 0) throw new Error('the МСП dataset page lists no edition');
    context.logger.info({ editions: editions.length }, 'Russia: read the dataset page');
    return editions;
  }

  protected async run(context: ImportContext, counters: Counters, edition: BulkArtefact | null): Promise<void> {
    if (!edition) throw new Error('the МСП register is imported edition by edition');

    const archive = await this.fetchArtefact(context, SLOT, edition, { headers: HEADERS });
    const batch = this.batch(context, counters);

    // About 7,000 members of about 900 documents each, each member all companies or all
    // entrepreneurs.
    for await (const member of openZipEntries(archive.path, (name) => name.toLowerCase().endsWith('.xml'))) {
      for await (const document of streamXmlElements(member.stream, 'Документ')) {
        // Individual entrepreneurs map to null and count as `skipped`.
        await batch.add(mapRsmpDocument(document));
        if (batch.full) {
          context.logger.info({ limit: context.options.limit }, 'Russia: sample limit reached, stopping');
          await batch.flush();
          return;
        }
      }
    }

    await batch.flush();
  }
}

export const rsmpBulk = new RsmpBulkSource();
