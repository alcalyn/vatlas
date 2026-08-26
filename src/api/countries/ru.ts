import { rsmpBulk } from '../sources/bulk/ru-rsmp.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Russia, from the Federal Tax Service's register of small and medium-sized businesses, the free
 * dataset keyed by ИНН. The full register of legal entities is not free, so large companies are
 * missing.
 */
export const russia = new BaseCountryAdapter({
  code: 'RU',
  name: 'Russia',
  bulk: [rsmpBulk],
  importNote:
    'the free register is the МСП one and it holds small and medium-sized businesses only, so a ' +
    'company above the thresholds is not in it at all; the ЕГРЮЛ, which holds every legal entity ' +
    'and its full address, is sold by the ФНС for 150 000 ₽ a year and has no free bulk and no ' +
    'free API - egrul.nalog.ru answers one number at a time behind a captcha. The individual ' +
    'entrepreneurs in the file are dropped rather than imported: they are natural persons',
});
