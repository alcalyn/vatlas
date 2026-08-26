import { sireneBulk } from '../sources/bulk/fr-sirene.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * France: SIRENE holds every French business, the VAT number is derived from the SIREN, and there
 * is no live source.
 */
export const france = new BaseCountryAdapter({
  code: 'FR',
  name: 'France',
  bulk: [sireneBulk],
  live: [vies],
});
