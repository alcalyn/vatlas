import { sudregBulk } from '../sources/bulk/hr-sudreg.js';
import { sudreg } from '../sources/live/hr-sudreg.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** The OIB in the court register is the Croatian VAT number. */
export const croatia = new BaseCountryAdapter({
  code: 'HR',
  name: 'Croatia',
  bulk: [sudregBulk],
  live: [sudreg, vies],
});
