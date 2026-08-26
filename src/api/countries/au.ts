import { abrBulk } from '../sources/bulk/au-abr.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Australia has no live source: the ABR publishes the whole register weekly, and a number missing
 * from the file is not an ABN. No VIES outside the EU.
 */
export const australia = new BaseCountryAdapter({
  code: 'AU',
  name: 'Australia',
  bulk: [abrBulk],
});
