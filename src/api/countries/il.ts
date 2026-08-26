import { rasham } from '../sources/live/il-registrar.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Israel, from the Registrar of Companies on the national open data portal. The nine-digit company
 * number is also the number used on invoices.
 */
export const israel = new BaseCountryAdapter({
  code: 'IL',
  name: 'Israel',
  live: [rasham],
  importNote:
    'the register is one CKAN resource of 730,000 rows and could be imported whole, but the same ' +
    'portal answers a single company number for free and unauthenticated, so it is asked directly',
});
