import { greenlandCvr } from '../sources/live/gl-cvr.js';
import { BaseCountryAdapter } from './types.js';

/** Greenland: not in the EU, so no VIES, and no VAT. The number is the CVR registration number. */
export const greenland = new BaseCountryAdapter({
  code: 'GL',
  name: 'Greenland',
  live: [greenlandCvr],
  importNote:
    'Greenlandic companies live in the Danish CVR, which is already imported under DK: the ' +
    'weekly file carries them, and a Greenlandic import would be the same rows a second time. ' +
    'What the country needs is not a file but a way to tell the two apart, and that is the ' +
    'seat, which only a lookup reads.',
});
