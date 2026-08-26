import { cvrBulk } from '../sources/bulk/dk-cvr.js';
import { cvr } from '../sources/live/dk-cvr.js';
import { ViesSource } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Danish VIES answers either come or not, and retrying does not help. In a 50-number benchmark,
 * the 5 answers took 8.3 s to 10.0 s and the other 45 never came. So one attempt with a 12 s
 * timeout.
 */
const danishVies = new ViesSource({ maxRetries: 0, timeoutMs: 12_000 });

export const denmark = new BaseCountryAdapter({
  code: 'DK',
  name: 'Denmark',
  bulk: [cvrBulk],
  live: [cvr, danishVies],
});
