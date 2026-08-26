import { anaf } from '../sources/live/ro-anaf.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** The Romanian VAT number is `RO` + the CUI, so one ANAF call resolves it. */
export const romania = new BaseCountryAdapter({
  code: 'RO',
  name: 'Romania',
  live: [anaf, vies],
  importNote:
    'ANAF publishes no downloadable register: the taxpayer database is only exposed through its ' +
    'own endpoint, one request per second, so Romanian numbers are resolved on demand',
});
