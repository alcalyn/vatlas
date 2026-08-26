import type { RequestThrottle } from '../../../lib/download.js';
import { streamJsonArray } from '../../../lib/jsonArrayStream.js';
import { openZipEntry } from '../../../lib/zip.js';
import { mapFinnishCompany, SOURCE, type PrhCompany } from '../live/fi-prh.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The Finnish Trade Register as one zipped JSON array, refreshed daily. The paginated endpoint
 * would take more than 8,000 requests.
 *
 * Uses the live adapter's mapper: same register, same record shape.
 */
const ALL_COMPANIES_ZIP = 'https://avoindata.prh.fi/opendata-ytj-api/v3/all_companies';

/** The cache slot, also the name `--file <slot>=<path>` takes for Finland. */
const SLOT = 'fi_all_companies.zip';

/**
 * PRH allows about one request per minute per IP on this endpoint, and a HEAD counts like the
 * 96 MB download.
 *
 * The import makes two requests (HEAD to date the edition, then GET), so they are spaced out. The
 * pause and budget below handle a 429 despite the spacing.
 */
const THROTTLE: RequestThrottle = {
  minIntervalMs: 90_000,
  pauseMs: 60_000,
  budgetMs: 300_000,
};

export class PrhBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'PRH open data (Patentti- ja rekisterihallitus)';
  readonly countryCode = 'FI';
  override readonly slots = [SLOT];

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    // PRH publishes no file name or edition number: the Last-Modified of the endpoint dates the
    // snapshot, checked before downloading.
    const archive = await this.fetchArtefact(
      context,
      SLOT,
      { url: ALL_COMPANIES_ZIP, fileName: 'all_companies.zip' },
      { throttle: THROTTLE },
    );
    const entry = await openZipEntry(archive.path, (fileName) => fileName.endsWith('.json'));

    const batch = this.batch(context, counters);
    for await (const company of streamJsonArray<PrhCompany>(entry)) {
      const record = mapFinnishCompany(company);
      // Skip nameless rows.
      await batch.add(record?.name ? record : null);

      if (counters.fetched > 0 && counters.fetched % 100_000 === 0) {
        context.logger.info({ fetched: counters.fetched }, 'Finland: companies imported so far');
      }
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Finland: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
  }
}

export const prhBulk = new PrhBulkSource();
