import { edrBulk } from '../sources/bulk/ua-edr.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Ukraine, from the Ministry of Justice's Єдиний державний реєстр, published weekly under CC-BY.
 *
 * The twelve-digit ІПН on an invoice shares its first seven digits with the eight-digit ЄДРПОУ the
 * register is keyed by (the eighth is a check digit). The register has no address and no ПДВ
 * status: those registers were closed under martial law.
 */
export const ukraine = new BaseCountryAdapter({
  code: 'UA',
  name: 'Ukraine',
  bulk: [edrBulk],
  importNote:
    'the ЄДР publishes no address at all - місцезнаходження was withheld under martial law - ' +
    'and no ПДВ registration either: the ДПС register of VAT payers has been frozen in open ' +
    'data since 2022-02-23 and its live search answers «На період дії воєнного стану обмежено ' +
    'доступ до публічних електронних реєстрів». The sole traders in the companion FOP archive ' +
    'are not imported because they cannot be: that file publishes no identifier of any kind, ' +
    'and the one other register they appear in blanks their РНОКПП',
});
