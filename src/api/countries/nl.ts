import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Netherlands has no source of its own reachable by VAT number. See `importNote`. */
export const netherlands = new BaseCountryAdapter({
  code: 'NL',
  name: 'Netherlands',
  live: [vies],
  importNote:
    'the KVK sells its register and the btw-id has been decoupled from the RSIN since 2020, so no ' +
    'free source keys a company by its VAT number. VIES itself does return the name and the ' +
    'address for the Netherlands - verified 2026-08-28, and it did not always',
});
