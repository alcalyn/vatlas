import { sri } from '../sources/live/ec-sri.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Ecuador, from the SRI taxpayer register, through the REST service its portal uses (no key, no
 * quota).
 *
 * The RUC on an invoice is the register key. Identity and establishments are two endpoints, and
 * both are called, so Ecuadorian answers have an address.
 */
export const ecuador = new BaseCountryAdapter({
  code: 'EC',
  name: 'Ecuador',
  live: [sri],
  importNote:
    'the SRI publishes no dump of the catastro: the open path is the REST service behind its ' +
    'own portal, one RUC at a time',
});
