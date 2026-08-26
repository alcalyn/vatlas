import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Austria has no source of its own reachable by VAT number. See `importNote`. */
export const austria = new BaseCountryAdapter({
  code: 'AT',
  name: 'Austria',
  live: [vies],
  importNote:
    'the Firmenbuch is only sold through commercial clearing houses, and the UID is not published ' + 'at all',
});
