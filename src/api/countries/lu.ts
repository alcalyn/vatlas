import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Luxembourg has no source of its own reachable by VAT number. See `importNote`. */
export const luxembourg = new BaseCountryAdapter({
  code: 'LU',
  name: 'Luxembourg',
  live: [vies],
  importNote:
    'the RCS is searchable for free but publishes no bulk file, and the VAT number is not the RCS ' + 'number',
});
