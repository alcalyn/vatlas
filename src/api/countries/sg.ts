import { acraBulk } from '../sources/bulk/sg-acra.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Singapore, from ACRA's monthly open data.
 *
 * IRAS uses the UEN as the GST registration number, but this register has no GST status: an answer
 * says who the entity is, not whether it charges GST.
 */
export const singapore = new BaseCountryAdapter({
  code: 'SG',
  name: 'Singapore',
  bulk: [acraBulk],
});
