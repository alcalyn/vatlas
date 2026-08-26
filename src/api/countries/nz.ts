import { nzbn } from '../sources/live/nz-nzbn.js';
import { BaseCountryAdapter } from './types.js';

/**
 * New Zealand, from the NZBN register: names, types, statuses and addresses.
 *
 * The API needs a key. Without `NZBN_API_KEY` there is no fallback outside the EU, so this country
 * answers `unavailable`.
 */
export const newZealand = new BaseCountryAdapter({
  code: 'NZ',
  name: 'New Zealand',
  live: [nzbn],
  importNote:
    'the NZBN bulk extract is granted separately from the API key and on stricter terms, so New ' +
    'Zealand is resolved on demand through the API alone',
});
