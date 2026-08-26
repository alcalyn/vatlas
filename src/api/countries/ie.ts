import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Ireland has no source of its own reachable by VAT number. See `importNote`. */
export const ireland = new BaseCountryAdapter({
  code: 'IE',
  name: 'Ireland',
  live: [vies],
  importNote:
    'the CRO publishes the whole register daily under CC BY 4.0, but it is keyed by the CRO ' +
    'number and the Irish VAT number is assigned by Revenue, so no row can be reached by it',
});
