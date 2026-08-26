import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Malta has no source of its own reachable by VAT number. See `importNote`. */
export const malta = new BaseCountryAdapter({
  code: 'MT',
  name: 'Malta',
  live: [vies],
  importNote:
    'the Malta Business Registry offers search only, and the VAT number is a separate ' +
    'Commissioner for Revenue identifier',
});
