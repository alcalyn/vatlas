import { hacienda } from '../sources/live/cr-hacienda.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Costa Rica, from the Ministry of Finance's e-invoicing API, open to anyone. It returns a name and
 * a registration status, no address.
 */
export const costaRica = new BaseCountryAdapter({
  code: 'CR',
  name: 'Costa Rica',
  live: [hacienda],
  importNote:
    'Hacienda publishes no dump of the taxpayer register: the supported access path is its ' +
    'invoicing API, one identification at a time',
});
