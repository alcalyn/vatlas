import { aade } from '../sources/live/el-aade.js';
import { gemi } from '../sources/live/el-gemi.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Greece has two registers and VIES sits between them: AADE, then VIES, then GEMI. GEMI's search
 * by AFM takes about 2.3 s against 0.3 s for VIES, so it is only asked when VIES has nothing.
 *
 * AADE needs a TAXISnet account, available to Greek taxpayers only.
 *
 * Greece uses `EL`, the VAT prefix, as returned by `normalizeCountryCode`.
 */
export const greece = new BaseCountryAdapter({
  code: 'EL',
  name: 'Greece',
  live: [aade, vies],
  lateLive: [gemi],
  importNote:
    'neither the General Commercial Registry nor AADE publishes a bulk file, and the open-data ' +
    'API is capped at 8 requests a minute - paging its 1.7 million companies 200 at a time would ' +
    'take some eighteen hours, and would spend the same budget the lookups need',
});
