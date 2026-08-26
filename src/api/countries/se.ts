import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Sweden has no source of its own reachable by VAT number. See `importNote`. */
export const sweden = new BaseCountryAdapter({
  code: 'SE',
  name: 'Sweden',
  live: [vies],
  importNote:
    'the Swedish VAT number is the organisationsnummer plus 01, so the free Bolagsverket high- ' +
    'value datasets would key perfectly - the dataset itself simply has not been wired up yet',
});
