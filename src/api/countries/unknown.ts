import { vies } from '../sources/live/europe-vies.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Fallback adapter for an unknown prefix: VIES only.
 *
 * Unreachable today: `src/vat/rules.ts` and the registry cover the same prefixes, and
 * `parseVatNumber` rejects unknown ones with `UNKNOWN_COUNTRY`. It means `resolveCountry` never
 * returns `undefined`. Not listed in `COUNTRIES` nor in `GET /v1/countries`.
 *
 * Its code is `--` so it cannot collide with a real prefix.
 */
export const unknownCountry = new BaseCountryAdapter({
  code: '--',
  name: 'Unknown country',
  live: [vies],
  importNote: 'no adapter is registered for this country prefix',
});
