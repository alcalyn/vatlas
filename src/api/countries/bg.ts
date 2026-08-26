import { ViesSource } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Bulgaria often answers slowly. In a 50-number benchmark, half of the VIES answers came back
 * within 2.1 s and 90% within 3.9 s. A 5 s timeout keeps them, and one retry handles
 * MS_MAX_CONCURRENT_REQ, which fails fast.
 */
const bulgarianVies = new ViesSource({ maxRetries: 1, timeoutMs: 5_000 });

export const bulgaria = new BaseCountryAdapter({
  code: 'BG',
  name: 'Bulgaria',
  live: [bulgarianVies],
  importNote:
    'the Trade Register publishes daily open data and the VAT number is BG + the EIK, so this ' +
    'one is importable - the daily XML publications simply have not been wired up yet',
});
