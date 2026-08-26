import { firs } from '../sources/live/ng-firs.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Nigeria, from the Nigeria Revenue Service's public TIN verification.
 *
 * Other African registers were tried and are not reachable: CAC (Cloudflare challenge), South
 * Africa's CIPC (login since 2024), Kenya (captcha), Egypt (credentials required), Côte d'Ivoire
 * and Tunisia (captchas).
 *
 * It returns a name, both forms of the number and the tax office. No address, no status.
 */
export const nigeria = new BaseCountryAdapter({
  code: 'NG',
  name: 'Nigeria',
  live: [firs],
  importNote:
    'no Nigerian register publishes a dump reachable by tax number: the NRS verification page is ' +
    'the open path, and the CAC - which holds the companies - is behind a Cloudflare challenge ' +
    'on every path. The Joint Tax Board became the Joint Revenue Board on 2026-01-01 and the ' +
    'page has already been rebranded NRS, so its URL and form may yet move',
});
