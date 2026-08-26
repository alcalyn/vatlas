import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Spain has no source of its own reachable by VAT number. See `importNote`. */
export const spain = new BaseCountryAdapter({
  code: 'ES',
  name: 'Spain',
  live: [vies],
  importNote:
    'the NIF is the VAT number, but no free bulk source publishes it: the Registro Mercantil ' +
    'sells its data, and VIES answers dashes for Spain',
});
