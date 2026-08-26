import { corporationsCanadaBulk } from '../sources/bulk/ca-corporations.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Canada, from Corporations Canada's open data. The GST/HST number on an invoice is the nine-digit
 * business number followed by `RT0001`. The file publishes the nine digits, and the parser drops
 * the suffix, so both spellings share one history.
 */
export const canada = new BaseCountryAdapter({
  code: 'CA',
  name: 'Canada',
  bulk: [corporationsCanadaBulk],
  importNote:
    'the federal register is imported whole, and it is federal only: a company incorporated in ' +
    'Ontario, Quebec or British Columbia holds a business number like any other and is not in ' +
    'that file. Nothing covers the gap - the provincial registries key on their own numbers, and ' +
    "the CRA's GST/HST registry confirms a number against a name and a transaction date rather " +
    'than answering with a company, so it cannot serve as a live source behind the import',
});
