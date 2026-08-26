import { uid } from '../sources/live/ch-uid.js';
import { BaseCountryAdapter } from './types.js';

/**
 * Switzerland, from the UID register of the Federal Statistical Office (public part of its web
 * service).
 *
 * A Swiss number (`CHE-116.281.710 MWST`) contains the nine digits the register is keyed by. The
 * register states the VAT status, so `not-registered` is a possible answer.
 *
 * No VIES: Switzerland is not an EU member state.
 */
export const switzerland = new BaseCountryAdapter({
  code: 'CH',
  name: 'Switzerland',
  live: [uid],
  importNote:
    'the BFS publishes no dump of the UID register: the open access path is PublicServices.svc, ' +
    'one UID at a time, and it is capped at twenty calls a minute',
});
