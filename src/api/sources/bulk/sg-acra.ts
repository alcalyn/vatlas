import { createReadStream } from 'node:fs';
import { delay, fetchJson } from '../../../lib/http.js';
import { readColumn, streamCsv, type CsvRow } from '../../../lib/csv.js';
import { parseUtcDate } from '../../../lib/time.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * ACRA's register of Singapore entities, published monthly on data.gov.sg as 27 CSV files (one
 * per initial plus "others"), open licence, no key.
 *
 * The UEN is not a GST number. IRAS reuses it as the GST registration number, but this dump says
 * nothing about GST registration. Singapore is served as a register of identity.
 *
 * The download URL is a signed S3 URL that expires within minutes, so `bulk` stores the stable
 * `poll-download` URL instead.
 */
const COLLECTION_URL = 'https://api-production.data.gov.sg/v2/public/api/collections/2/metadata';
const DATASET_URL = (id: string): string => `https://api-production.data.gov.sg/v2/public/api/datasets/${id}/metadata`;
const DOWNLOAD_URL = (id: string): string => `https://api-open.data.gov.sg/v1/public/api/datasets/${id}/poll-download`;

/** A-Z then "others": the cache slots, also the names `--file <slot>=<path>` takes for Singapore. */
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'.split(''), 'others'] as const;
const slotFor = (letter: string): string => `sg_acra_${letter}.csv`;

export const SOURCE = 'ACRA';

/** Empty cells are the two letters `na`, not blanks. */
function acraColumn(row: CsvRow, candidates: string[]): string | null {
  const value = readColumn(row, candidates);
  return value === null || value.toLowerCase() === 'na' ? null : value;
}

const join = (parts: (string | null)[]): string | null => {
  const text = parts
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim();
  return text.length > 0 ? text : null;
};

/** Maps one row, or null when it has no name. */
export function mapAcraRow(row: CsvRow): CompanyRecord | null {
  const uen = acraColumn(row, ['uen']);
  if (!uen) return null;

  const status = acraColumn(row, ['entity_status_description']);
  const level = acraColumn(row, ['level_no']);
  const unit = acraColumn(row, ['unit_no']);
  const street = join([acraColumn(row, ['block']), acraColumn(row, ['street_name'])]);
  // An entity registered abroad has empty local fields and two free-text lines, with no country, so
  // `addressCountry` is null. Decided on the fields since `address_type` is always LOCAL.
  const overseas = street === null ? acraColumn(row, ['other_address_line1']) : null;

  return {
    vatNumber: `SG${uen.toUpperCase()}`,
    nationalId: uen.toUpperCase(),
    name: acraColumn(row, ['entity_name']),
    legalForm:
      acraColumn(row, ['company_type_description']) ??
      acraColumn(row, ['business_constitution_description']) ??
      acraColumn(row, ['entity_type_description']),
    // "Live", "Live Company", "Registered". Anything else (struck off, dissolved, cancelled, ...) is not
    // trading.
    status: status !== null && /^(live|registered)/i.test(status) ? 'active' : 'inactive',
    addressLine1: street ?? overseas,
    addressLine2: overseas
      ? acraColumn(row, ['other_address_line2'])
      : join([level && unit ? `#${level}-${unit}` : null, acraColumn(row, ['building_name'])]),
    postalCode: overseas ? null : acraColumn(row, ['postal_code']),
    city: overseas ? null : street === null ? null : 'Singapore',
    addressCountry: overseas ? null : street === null ? null : 'SG',
    companyLastUpdatedAt: parseUtcDate(acraColumn(row, ['registration_incorporation_date'])),
  };
}

interface CollectionMetadata {
  data?: { collectionMetadata?: { lastUpdatedAt?: string; childDatasets?: string[] } };
}

interface DatasetMetadata {
  data?: { name?: string };
}

interface PollDownload {
  data?: { status?: string; url?: string };
}

export class AcraBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'ACRA information on corporate entities (data.gov.sg)';
  readonly countryCode = 'SG';
  override readonly slots = LETTERS.map(slotFor);

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const collection = await fetchJson<CollectionMetadata>(COLLECTION_URL);
    const metadata = collection.data?.collectionMetadata;
    const children = metadata?.childDatasets ?? [];
    if (children.length === 0) throw new Error('the ACRA collection lists no dataset');

    // One date for all 27 files: they are one monthly edition.
    const date = parseUtcDate(metadata?.lastUpdatedAt);
    const byLetter = await this.letters(context, children);
    const batch = this.batch(context, counters);

    for (const letter of LETTERS) {
      const id = byLetter.get(letter);
      if (!id) {
        context.logger.warn({ letter }, 'Singapore: the collection no longer publishes this file');
        continue;
      }

      const slot = slotFor(letter);
      await context.useArtefact(
        this.artefactOf(context, slot, {
          url: DOWNLOAD_URL(id),
          fileName: `acra_corporate_entities_${letter}.csv`,
          date,
        }),
      );

      const archive = await this.download(context, await this.signedUrl(context, id), slot);
      for await (const row of streamCsv(createReadStream(archive.path))) {
        const record = mapAcraRow(row);
        // Skip nameless rows.
        await batch.add(record?.name ? record : null);
        if (batch.full) {
          context.logger.info({ limit: context.options.limit }, 'Singapore: sample limit reached, stopping');
          await batch.flush();
          return;
        }
      }
    }

    await batch.flush();
  }

  /**
   * Which dataset id holds which initial.
   *
   * `childDatasets` is not alphabetical, so the letter is read from each dataset's name
   * (`ACRA Information on Corporate Entities ('W')`). The slots stay readable for `--file`.
   */
  private async letters(context: ImportContext, children: string[]): Promise<Map<string, string>> {
    const byLetter = new Map<string, string>();
    for (const id of children) {
      const metadata = await fetchJson<DatasetMetadata>(DATASET_URL(id));
      const name = metadata.data?.name ?? '';
      const match = /\('([A-Za-z]+)'\)/.exec(name);
      const letter = match?.[1]?.toLowerCase();
      if (!letter) {
        context.logger.warn({ id, name }, 'Singapore: cannot tell which initial this dataset holds');
        continue;
      }
      byLetter.set(letter, id);
    }
    context.logger.info({ files: byLetter.size }, 'Singapore: resolved the collection');
    return byLetter;
  }

  /**
   * The signed S3 URL for one dataset, requested at the last moment since it expires.
   *
   * The endpoint returns `DOWNLOAD_SUCCESS` with the URL, or a pending status while it prepares the
   * file, so it is polled a few times.
   */
  private async signedUrl(context: ImportContext, id: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await delay(2_000);
      const answer = await fetchJson<PollDownload>(DOWNLOAD_URL(id));
      if (answer.data?.status === 'DOWNLOAD_SUCCESS' && answer.data.url) return answer.data.url;
      context.logger.info({ id, status: answer.data?.status }, 'Singapore: the download is not ready yet');
    }
    throw new Error(`data.gov.sg never made ${id} available for download`);
  }
}

export const acraBulk = new AcraBulkSource();
