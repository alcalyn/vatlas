import { streamXmlElements } from '../../../lib/xml.js';
import { mapPeppolCard, SOURCE } from '../live/de-peppol.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The daily EU-wide Peppol business card export, streamed through the mapper.
 *
 * Not cached: the file is 1.7 GB (Germany is a few hundred kB of it) and regenerated every night
 * at 02:00 UTC, so a cached copy would never be reused. The import must run after 02:00 UTC.
 */
const EXPORT_URL = 'https://directory.peppol.eu/export/businesscards-xml-no-doc-types';

export class PeppolBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Peppol Directory';
  readonly countryCode = 'DE';

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    context.logger.info({ url: EXPORT_URL }, 'streaming the Peppol business card export');
    const response = await fetch(EXPORT_URL, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Peppol export failed: HTTP ${response.status} ${response.statusText}`);
    }

    // Not cached, so the response header dates the snapshot.
    const header = response.headers.get('last-modified');
    const published = header ? new Date(header) : null;
    await context.useArtefact({
      url: EXPORT_URL,
      fileName: 'businesscards-xml-no-doc-types.xml',
      date: this.published(published && !Number.isNaN(published.getTime()) ? published : null, context),
    });

    const batch = this.batch(context, counters);
    for await (const card of streamXmlElements(response.body, 'businesscard')) {
      // Non-German cards map to null and count as `skipped`.
      await batch.add(mapPeppolCard(card));
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Germany: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
  }
}

export const peppolBulk = new PeppolBulkSource();
