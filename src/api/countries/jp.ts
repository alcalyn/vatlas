import { invoiceRegistryBulk } from '../sources/bulk/jp-invoice.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Japan, from the National Tax Agency's register of qualified invoice issuers. Being in that file
 * means being registered for consumption tax.
 */
export const japan = new BaseCountryAdapter({
  code: 'JP',
  name: 'Japan',
  bulk: [invoiceRegistryBulk],
});
