import { vietqr } from '../sources/live/vn-vietqr.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Vietnam, the only country not served by its own register.
 *
 * The tax administration's lookup (`tracuunnt.gdt.gov.vn`) and the business registration portal
 * are behind captchas and publish no dump. VietQR republishes the tax data as open JSON.
 *
 * `meta.source` says VIETQR, so the answer does not claim to come from the register.
 */
export const vietnam = new BaseCountryAdapter({
  code: 'VN',
  name: 'Vietnam',
  live: [vietqr],
  importNote:
    'the Tổng cục Thuế publishes no dump and puts a captcha on its own lookup, so Vietnamese ' +
    'rows come from VietQR, which republishes the same data openly - an aggregator, and named ' +
    'as one',
});
