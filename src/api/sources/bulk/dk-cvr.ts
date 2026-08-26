import { postJson } from '../../../lib/http.js';
import {
  cvrAuthorization,
  cvrCredentials,
  DISTRIBUTION,
  mapDanishCompany,
  SOURCE,
  type CvrResponse,
} from '../live/dk-cvr.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The whole Danish register, through the distribution endpoint's scroll API.
 *
 * Scroll rather than `from`/`size`: Elasticsearch refuses pagination past 10,000 rows, and CVR has
 * about two million companies.
 */
const PAGE_SIZE = 1000;
const SCROLL_WINDOW = '5m';
const SCROLL_URL = 'http://distribution.virk.dk/_search/scroll';

export class CvrBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'CVR distribution (Erhvervsstyrelsen)';
  readonly countryCode = 'DK';

  override get available(): boolean {
    return cvrCredentials() !== null;
  }

  protected override get unavailableReason(): string {
    return 'the CVR distribution endpoint requires a free account; set CVR_USER and CVR_PASSWORD to enable it';
  }

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const { user, password } = cvrCredentials()!;
    const headers = cvrAuthorization(user, password);

    // A live index without edition date, so the run is filed under today.
    await context.useArtefact({
      url: DISTRIBUTION,
      fileName: 'cvr-permanent/virksomhed',
      date: this.published(null, context),
    });

    const batch = this.batch(context, counters, PAGE_SIZE);
    let response = await postJson<CvrResponse>(
      `${DISTRIBUTION}?scroll=${SCROLL_WINDOW}`,
      { size: PAGE_SIZE, query: { match_all: {} } },
      { headers, timeoutMs: 60_000, retries: 2 },
    );

    while (response.hits?.hits?.length) {
      for (const hit of response.hits.hits) {
        const company = hit._source?.Vrvirksomhed;
        const record = company ? mapDanishCompany(company) : null;
        // Skip nameless rows.
        await batch.add(record?.name ? record : null);
      }
      await batch.flush();

      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Denmark: sample limit reached, stopping');
        break;
      }
      if (!response._scroll_id) break;

      response = await postJson<CvrResponse>(
        SCROLL_URL,
        { scroll: SCROLL_WINDOW, scroll_id: response._scroll_id },
        { headers, timeoutMs: 60_000, retries: 2 },
      );
    }

    await batch.flush();
  }
}

export const cvrBulk = new CvrBulkSource();
