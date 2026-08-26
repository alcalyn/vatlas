import { sunatBulk } from '../sources/bulk/pe-sunat.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Peru, from SUNAT's padrón reducido: 18 million RUCs in one file, rebuilt daily, no account
 * needed. A RUC missing from the file is `not-found`.
 */
export const peru = new BaseCountryAdapter({
  code: 'PE',
  name: 'Peru',
  bulk: [sunatBulk],
});
