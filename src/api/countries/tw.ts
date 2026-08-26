import { gcis } from '../sources/live/tw-gcis.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Taiwan, from GCIS: no key, no quota, and the address in the answer. The 統一編號 is the number on
 * every Taiwanese invoice.
 */
export const taiwan = new BaseCountryAdapter({
  code: 'TW',
  name: 'Taiwan',
  live: [gcis],
  importNote:
    'GCIS publishes the whole register as a file too, but its API is unkeyed and uncapped and ' +
    'answers by 統一編號 directly, so Taiwanese numbers are resolved on demand rather than imported',
});
