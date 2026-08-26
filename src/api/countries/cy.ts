import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Cyprus has no source of its own reachable by VAT number. See `importNote`. */
export const cyprus = new BaseCountryAdapter({
  code: 'CY',
  name: 'Cyprus',
  live: [vies],
  importNote:
    'the Registrar of Companies publishes open data, but the VAT number is a separate Tax ' +
    'Department identifier that is not published next to the registration number',
});
