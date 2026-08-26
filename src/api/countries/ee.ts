import { rikBulk } from '../sources/bulk/ee-rik.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** The RIK file already contains the VAT number. */
export const estonia = new BaseCountryAdapter({
  code: 'EE',
  name: 'Estonia',
  bulk: [rikBulk],
  live: [vies],
});
