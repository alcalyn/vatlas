import { fetchJson } from '../../../lib/http.js';
import { parseUtcCompactDate, parseZonedDateTime } from '../../../lib/time.js';
import { listZipEntries, openZipEntry } from '../../../lib/zip.js';
import { decodeXmlEntities, extractAttribute, extractTag, streamXmlElements } from '../../../lib/xml.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The ABN Lookup bulk extract, published weekly by the Australian Business Register on
 * data.gov.au under CC-BY, without account.
 *
 * Two ZIP files at fixed CKAN resource URLs, ten XML files of about 630 MB each. The edition date is
 * the resource's `last_modified` (also used in the inner file names, `20260903_Public01.xml`), so
 * an edition already imported is skipped after one JSON call.
 *
 * The address is only a state and a postcode, no street. An active ABN is not a GST registration:
 * `GST/@status` says that, and is mapped to `not_registered`.
 */
const PACKAGE_URL = 'https://data.gov.au/data/api/3/action/package_show?id=abn-bulk-extract';

/** The cache slots, also the names `--file <slot>=<path>` takes for Australia. */
const SLOTS = ['au_public_split_1_10.zip', 'au_public_split_11_20.zip'] as const;

/** The file each slot fetches, matched on the CKAN resource URL. */
const FILES = ['public_split_1_10.zip', 'public_split_11_20.zip'] as const;

export const SOURCE = 'ABR';

interface CkanResource {
  url?: string;
  last_modified?: string;
}

interface CkanPackage {
  result?: { resources?: CkanResource[] };
}

/**
 * The raw inner XML of the first `<tag>...</tag>`, entities left encoded.
 *
 * `extractTag` decodes, which is wrong for a subtree: an `&lt;` in a name would become markup. An
 * `<ABR>` holds several names (the entity's own first, then gift recipient and trading names), and
 * only the first block is wanted.
 */
function sliceElement(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? (match[1] ?? null) : null;
}

/** Name of an individual: up to two given names, then the family name. */
function individualName(entity: string): string | null {
  const given = [...entity.matchAll(/<GivenName>([\s\S]*?)<\/GivenName>/g)].map((match) =>
    decodeXmlEntities((match[1] ?? '').trim()),
  );
  const family = extractTag(entity, 'FamilyName');
  const parts = [...given, family].filter((part): part is string => Boolean(part && part.length > 0));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Maps one `<ABR>` element, or null when it has no name. */
export function mapAbrRecord(xml: string): CompanyRecord | null {
  const abn = extractTag(xml, 'ABN');
  if (!abn || !/^[0-9]{11}$/.test(abn)) return null;

  // `MainEntity` for an organisation, `LegalEntity` for a sole trader. Exactly one is present and
  // both have the business address.
  const main = sliceElement(xml, 'MainEntity');
  const legal = main === null ? sliceElement(xml, 'LegalEntity') : null;
  const entity = main ?? legal;
  const name = main ? extractTag(main, 'NonIndividualNameText') : legal ? individualName(legal) : null;

  const abnActive = extractAttribute(xml, 'ABN', 'status') === 'ACT';
  const gstRegistered = extractAttribute(xml, 'GST', 'status') === 'ACT';

  return {
    vatNumber: `AU${abn}`,
    // The ACN is the ASIC company number. Non-companies have none, and the ABN is their only id.
    nationalId: extractTag(xml, 'ASICNumber') ?? abn,
    name,
    legalForm: extractTag(xml, 'EntityTypeText'),
    // A cancelled ABN is `inactive`. An active ABN without GST registration is `not_registered`, with
    // its name and address kept.
    status: !abnActive ? 'inactive' : gstRegistered ? 'active' : 'not_registered',
    addressLine1: null,
    addressLine2: null,
    postalCode: entity ? extractTag(entity, 'Postcode') : null,
    // No locality in the extract, so the state is used as the city.
    city: entity ? extractTag(entity, 'State') : null,
    addressCountry: 'AU',
    companyLastUpdatedAt: parseUtcCompactDate(extractAttribute(xml, 'ABR', 'recordLastUpdatedDate')),
  };
}

export class AbrBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'ABN Lookup bulk extract (Australian Business Register)';
  readonly countryCode = 'AU';
  override readonly slots = [...SLOTS];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const resources = await this.resources(context);
    const batch = this.batch(context, counters);

    for (const [index, slot] of SLOTS.entries()) {
      const resource = resources[index];
      if (!resource?.url) throw new Error(`the ABN bulk extract no longer publishes ${FILES[index]}`);

      // Declared before the download, from the CKAN metadata, so an edition already imported costs one
      // JSON call.
      await context.useArtefact(
        this.artefactOf(context, slot, { url: resource.url, fileName: resource.fileName, date: resource.date }),
      );

      const archive = await this.download(context, resource.url, slot);
      const entries = await listZipEntries(archive.path, (fileName) => fileName.toLowerCase().endsWith('.xml'));
      context.logger.info({ file: resource.fileName, entries: entries.length }, 'Australia: reading an archive');

      for (const entry of entries) {
        const stream = await openZipEntry(archive.path, (fileName) => fileName === entry);
        for await (const element of streamXmlElements(stream, 'ABR')) {
          const record = mapAbrRecord(element);
          // Skip nameless rows.
          await batch.add(record?.name ? record : null);
          if (batch.full) {
            context.logger.info({ limit: context.options.limit }, 'Australia: sample limit reached, stopping');
            stream.destroy();
            await batch.flush();
            return;
          }
        }
      }
    }

    await batch.flush();
  }

  /**
   * The two ZIPs of the current edition, in `FILES` order, with their CKAN date.
   *
   * Matched on file name rather than resource id, so a renamed or added resource fails loudly
   * instead of importing half an edition.
   */
  private async resources(context: ImportContext): Promise<{ url: string; fileName: string; date: Date | null }[]> {
    const payload = await fetchJson<CkanPackage>(PACKAGE_URL, { timeoutMs: 30_000 });
    const published = payload.result?.resources ?? [];
    context.logger.info({ resources: published.length }, 'Australia: read the data.gov.au dataset');

    return FILES.map((file) => {
      const match = published.find((resource) => resource.url?.endsWith(`/${file}`));
      // CKAN writes `2026-09-03T01:01:01.297989`, UTC without the marker. Parsed as local time it can
      // shift to the previous day.
      return { url: match?.url ?? '', fileName: file, date: parseZonedDateTime(match?.last_modified, 'UTC') };
    });
  }
}

export const abrBulk = new AbrBulkSource();
