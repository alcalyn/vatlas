import { prhBulk } from '../sources/bulk/fi-prh.js';
import { prh } from '../sources/live/fi-prh.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * PRH has a daily dump and an API. Both adapters share the same `id`: one register, one history.
 * VIES is the fallback.
 */
export const finland = new BaseCountryAdapter({
  code: 'FI',
  name: 'Finland',
  bulk: [prhBulk],
  live: [prh, vies],
});
