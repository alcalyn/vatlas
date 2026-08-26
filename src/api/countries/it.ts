import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Italy has no source of its own reachable by VAT number. See `importNote`. */
export const italy = new BaseCountryAdapter({
  code: 'IT',
  name: 'Italy',
  live: [vies],
  importNote:
    "the Agenzia delle Entrate's free API returns validity and the trading name but no address, " +
    'while VIES already returns both for Italy; the Registro Imprese itself is commercial',
});
