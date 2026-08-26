import { cnpjBulk } from '../sources/bulk/br-cnpj.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Brazil, from the Receita Federal's open CNPJ data. Monthly editions are archived and can be
 * imported with `--history`. Each edition is 6.7 GB and 118 million rows.
 */
export const brazil = new BaseCountryAdapter({
  code: 'BR',
  name: 'Brazil',
  bulk: [cnpjBulk],
});
