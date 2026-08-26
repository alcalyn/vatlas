import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Hungary has no source of its own reachable by VAT number. See `importNote`. */
export const hungary = new BaseCountryAdapter({
  code: 'HU',
  name: 'Hungary',
  live: [vies],
  importNote:
    "NAV's queryTaxpayer returns the identity but requires a registered technical user and a " +
    'signed request, which is a heavier onboarding than a free account',
});
