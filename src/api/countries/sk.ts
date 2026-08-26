import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Slovakia has no source of its own reachable by VAT number. See `importNote`. */
export const slovakia = new BaseCountryAdapter({
  code: 'SK',
  name: 'Slovakia',
  live: [vies],
  importNote:
    'the RPO API is free and complete but is keyed by ICO, and the Slovak IC DPH is assigned by ' +
    'the tax office and is not derivable from it',
});
