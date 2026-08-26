import { brreg } from '../sources/live/no-brreg.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Norway, from Enhetsregisteret (Brønnøysund registers), through an open REST API without a key.
 *
 * Each entity carries a flag from the VAT register (Merverdiavgiftsregisteret), so a Norwegian
 * number can come back `not-registered`.
 *
 * A nightly dump exists but is not imported: the API is fast and a live source only stores the
 * numbers actually asked.
 */
export const norway = new BaseCountryAdapter({
  code: 'NO',
  name: 'Norway',
  live: [brreg],
  importNote:
    'Enhetsregisteret is bulk-downloadable and deliberately not imported: the register answers ' +
    'by organisasjonsnummer in under a second, so the file would buy disk and a cron window and ' +
    'nothing else',
});
