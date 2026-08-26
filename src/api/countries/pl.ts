import { whiteList } from '../sources/live/pl-mfwl.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Resolved on demand, answers accumulate one lookup at a time. */
export const poland = new BaseCountryAdapter({
  code: 'PL',
  name: 'Poland',
  live: [whiteList, vies],
  importNote:
    'the Ministry of Finance flat file only carries hashed NIP / bank-account pairs, with no ' +
    'name or address; every Polish number is resolved on demand through the White List API',
});
