import { kboBulk } from '../sources/bulk/be-kbo.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * The Belgian VAT number is `BE` + the enterprise number, so every entity in the KBO extract is
 * reachable.
 */
export const belgium = new BaseCountryAdapter({
  code: 'BE',
  name: 'Belgium',
  bulk: [kboBulk],
  live: [vies],
});
