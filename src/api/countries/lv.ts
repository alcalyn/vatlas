import { latviaBulk } from '../sources/bulk/lv-urvid.js';
import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/** Several open-data files joined into one register, see the importer. */
export const latvia = new BaseCountryAdapter({
  code: 'LV',
  name: 'Latvia',
  bulk: [latviaBulk],
  live: [vies],
});
