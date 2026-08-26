import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Portugal has no source of its own reachable by VAT number. See `importNote`. */
export const portugal = new BaseCountryAdapter({
  code: 'PT',
  name: 'Portugal',
  live: [vies],
  importNote: 'no free source publishes the NIPC in bulk; the commercial register is fee-based per extract',
});
