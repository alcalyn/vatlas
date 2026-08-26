import { peppolBulk } from '../sources/bulk/de-peppol.js';
import { peppol } from '../sources/live/de-peppol.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Germany has no register keyed by USt-IdNr, and VIES returns `---` for name and address. The
 * Peppol Directory is used instead: participant scheme 9930 is the German VAT number. It covers
 * well under 1% of German taxable persons, so VIES stays as the fallback.
 */
export const germany = new BaseCountryAdapter({
  code: 'DE',
  name: 'Germany',
  bulk: [peppolBulk],
  live: [peppol, vies],
});
