import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Slovenia has no source of its own reachable by VAT number. See `importNote`. */
export const slovenia = new BaseCountryAdapter({
  code: 'SI',
  name: 'Slovenia',
  live: [vies],
  importNote:
    'AJPES publishes the whole business register for free, but the extract carries the maticna ' +
    'stevilka and not the davcna stevilka, so no row can be keyed by a VAT number without joining ' +
    'in the FURS list of DDV payers',
});
