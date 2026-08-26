import { decodeXmlEntities, extractTag, streamXmlElements } from '../../../lib/xml.js';
import { listZipEntries, openZipEntries, openZipEntry } from '../../../lib/zip.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * Corporations Canada's open data: the federal corporate register.
 *
 * Each corporation has a `<businessNumber>`, the nine-digit root of the GST/HST number (the
 * invoice shows it followed by `RT0001`).
 *
 * Federal corporations only. Companies incorporated in a province are not in this file, and no
 * other free source covers them: provincial registries use their own numbers, and the CRA's
 * GST/HST registry only confirms a number against a name and a date.
 *
 * One file overwritten in place, no archive. The date is only inside, on the root element of each
 * member (`<cc:corpcan reportId="OPEN_DATA" date="...">`), so the file is downloaded before it can
 * be dated.
 *
 * About 27,000 corporations per edition are empty self-closing elements
 * (`<corporation corporationId="1201"/>`). `streamXmlElements` skips them, so `fetched + skipped`
 * is lower than the count in the file.
 */
const DOWNLOAD_URL = 'https://ised-isde.canada.ca/cc/lgcy/download/OPEN_DATA_SPLIT.zip';

const SLOT = 'ca_corpcan.zip';

export const SOURCE = 'CORPCAN';

/** The member with the code tables, and the ones with the corporations. */
const CODES_ENTRY = 'codes.xml';
const DATA_ENTRY = /^OPEN_DATA_(\d+)\.xml$/;

/**
 * Statuses of a corporation that still exists. `2`, `3` and `4` are dissolutions or
 * discontinuances pending: the company still trades.
 */
const LIVE_STATUSES = new Set(['1', '2', '3', '4']);

const join = (parts: (string | null)[], separator = ' '): string | null => {
  const text = parts
    .filter((part): part is string => Boolean(part))
    .join(separator)
    .trim();
  return text.length === 0 ? null : text;
};

/** Every `<tag ...>` element of one corporation, opening tag included. */
function* elements(xml: string, tag: string): Generator<string> {
  // `\b` keeps `<name` from matching `<names>` and `<act` from `<activity>`. These elements do not
  // nest, so a non-greedy body is exact.
  const pattern = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g');
  for (const match of xml.matchAll(pattern)) yield match[0];
}

const attribute = (element: string | null, name: string): string | null => {
  if (element === null) return null;
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(element);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : decodeXmlEntities(value);
};

/** The first `<tag ...>` element, or null. */
const firstElement = (xml: string, tag: string): string | null => elements(xml, tag).next().value ?? null;

/** The text of an element, null when absent, self-closing or empty. */
const text = (element: string | null): string | null => {
  const match = element === null ? null : /^<[^>]*[^/]>([\s\S]*)<\/[^>]+>$/.exec(element);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : decodeXmlEntities(value);
};

const isCurrent = (element: string): boolean => attribute(element, 'current') === 'true';

/**
 * The current element: the register keeps every past name and address inline, with exactly one of
 * each flagged `current="true"`.
 *
 * `code` narrows further: a name is the corporate name (`1`) or its version in the other official
 * language (`2`).
 */
function currentOne(xml: string, tag: string, code?: string): string | null {
  let fallback: string | null = null;
  for (const element of elements(xml, tag)) {
    if (!isCurrent(element)) continue;
    if (code === undefined || attribute(element, 'code') === code) return element;
    fallback ??= element;
  }
  return fallback;
}

/** The latest `effectiveDate` among current elements. */
function lastEffectiveDate(elementsInForce: (string | null)[]): Date | null {
  const dates = elementsInForce
    .map((element) => attribute(element, 'effectiveDate'))
    .map((value) => (value ? new Date(value) : null))
    .filter((date): date is Date => date !== null && !Number.isNaN(date.getTime()));
  return dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));
}

/**
 * Maps one `<corporation>`. Null without a business number (about 7% of the file, mostly long
 * dissolved).
 *
 * `acts` is the `act` code table from `codes.xml`: the statute a corporation exists under, the
 * closest thing to a legal form.
 */
export function mapCorporation(xml: string, acts: ReadonlyMap<string, string>): CompanyRecord | null {
  const businessNumber = extractTag(xml, 'businessNumber');
  if (!businessNumber || !/^[0-9]{9}$/.test(businessNumber)) return null;

  const name = currentOne(xml, 'name', '1');
  const address = currentOne(xml, 'address', '2');
  const lines =
    address === null
      ? []
      : [...elements(address, 'addressLine')].map(text).filter((line): line is string => line !== null);
  const status = currentOne(xml, 'status');
  const act = currentOne(xml, 'act');

  return {
    vatNumber: `CA${businessNumber}`,
    // The corporation number, the registrar's own identifier. The business number is the key.
    nationalId: attribute(xml, 'corporationId'),
    name: text(name),
    legalForm: acts.get(attribute(act, 'code') ?? '') ?? null,
    status: LIVE_STATUSES.has(attribute(status, 'code') ?? '') ? 'active' : 'inactive',
    // An address has one or two `<addressLine>` (street and building name). Both are kept.
    addressLine1: lines[0] ?? null,
    addressLine2: lines.length > 1 ? lines.slice(1).join(', ') : null,
    postalCode: address ? extractTag(address, 'postalCode') : null,
    // "Abbotsford, BC": the province disambiguates city names.
    city: address
      ? join([extractTag(address, 'city'), attribute(firstElement(address, 'province'), 'code')], ', ')
      : null,
    // Country of the registered office, which can be abroad.
    addressCountry: address ? (attribute(firstElement(address, 'country'), 'code') ?? 'CA') : null,
    companyLastUpdatedAt: lastEffectiveDate([name, address, status, act]),
  };
}

/** The `act` code table, English labels, from `codes.xml`. Exported for the unit test. */
export function parseActCodes(xml: string): Map<string, string> {
  const block = /<code name="act">([\s\S]*?)<\/code>/.exec(xml)?.[1] ?? '';
  const codes = new Map<string, string>();
  for (const key of block.matchAll(/<key value="(\d+)">([\s\S]*?)<\/key>/g)) {
    const label = /<full lang="en">([\s\S]*?)<\/full>/.exec(key[2] ?? '')?.[1];
    if (label) codes.set(key[1] ?? '', decodeXmlEntities(label.trim()));
  }
  return codes;
}

/** Edition date from a member's root element: `<cc:corpcan ... date="2026-09-09T04:00:00-04:00">`. */
export function parseEditionDate(header: string): Date | null {
  const value = /<cc:corpcan\b[^>]*\bdate="([^"]+)"/.exec(header)?.[1];
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class CorporationsCanadaBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Federal Corporations (Corporations Canada)';
  readonly countryCode = 'CA';
  override readonly slots = [SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const archive = await this.download(context, DOWNLOAD_URL, SLOT);
    const members = await listZipEntries(archive.path, (name) => DATA_ENTRY.test(name));
    const first = members[0];
    if (first === undefined) throw new Error(`${SLOT} holds no OPEN_DATA member`);

    // Every member has the same root element, so the first one dates the edition.
    const date = parseEditionDate(await this.head(archive.path, first));
    const acts = parseActCodes(await this.read(archive.path, CODES_ENTRY));
    context.logger.info({ members: members.length, date, acts: acts.size }, 'Canada: read the archive');

    await context.useArtefact(
      this.artefactOf(context, SLOT, { url: DOWNLOAD_URL, fileName: 'OPEN_DATA_SPLIT.zip', date }),
    );

    const batch = this.batch(context, counters);
    for await (const member of openZipEntries(archive.path, (name) => DATA_ENTRY.test(name))) {
      for await (const corporation of streamXmlElements(member.stream, 'corporation')) {
        // Corporations without a business number end up in `skipped`.
        await batch.add(mapCorporation(corporation, acts));
        if (batch.full) {
          context.logger.info({ limit: context.options.limit }, 'Canada: sample limit reached, stopping');
          await batch.flush();
          return;
        }
      }
    }

    await batch.flush();
  }

  /** The first bytes of a member, enough for the root element. */
  private async head(path: string, member: string, bytes = 512): Promise<string> {
    const stream = await openZipEntry(path, (name) => name === member);
    for await (const chunk of stream) {
      stream.destroy();
      return Buffer.from(chunk as Uint8Array)
        .subarray(0, bytes)
        .toString('utf8');
    }
    return '';
  }

  /** A whole member, for small ones (`codes.xml` is 52 kB). */
  private async read(path: string, member: string): Promise<string> {
    const stream = await openZipEntry(path, (name) => name === member);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  }
}

export const corporationsCanadaBulk = new CorporationsCanadaBulkSource();
