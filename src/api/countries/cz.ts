import { ares } from '../sources/live/cz-ares.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** ARES publishes the DIČ next to the company identity, free and without authentication. */
export const czechia = new BaseCountryAdapter({
  code: 'CZ',
  name: 'Czechia',
  live: [ares, vies],
  importNote:
    'ARES publishes no single bulk file of every subject: the supported access path is its REST ' +
    'API, capped at 500 requests per minute, so Czech numbers are resolved on demand',
});
