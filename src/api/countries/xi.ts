import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Northern Ireland has no source of its own reachable by VAT number. See `importNote`. */
export const northernIreland = new BaseCountryAdapter({
  code: 'XI',
  name: 'Northern Ireland',
  live: [vies],
  importNote:
    'Companies House covers Northern Irish companies but the XI VAT number is issued by HMRC; its ' +
    'public lookup API was withdrawn in February 2025 and the replacement is behind OAuth',
});
