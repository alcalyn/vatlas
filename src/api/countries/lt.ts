import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Lithuania has no source of its own reachable by VAT number. See `importNote`. */
export const lithuania = new BaseCountryAdapter({
  code: 'LT',
  name: 'Lithuania',
  live: [vies],
  importNote:
    'Registru centras publishes the register of legal entities, but the PVM code is not the ' +
    "company code: VMI's daily XML of VAT registrations would have to be joined in first",
});
