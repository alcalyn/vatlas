import { australia } from './au.js';
import { austria } from './at.js';
import { belgium } from './be.js';
import { brazil } from './br.js';
import { bulgaria } from './bg.js';
import { canada } from './ca.js';
import { croatia } from './hr.js';
import { costaRica } from './cr.js';
import { cyprus } from './cy.js';
import { czechia } from './cz.js';
import { denmark } from './dk.js';
import { ecuador } from './ec.js';
import { estonia } from './ee.js';
import { finland } from './fi.js';
import { france } from './fr.js';
import { germany } from './de.js';
import { greece } from './el.js';
import { greenland } from './gl.js';
import { hungary } from './hu.js';
import { ireland } from './ie.js';
import { israel } from './il.js';
import { italy } from './it.js';
import { japan } from './jp.js';
import { latvia } from './lv.js';
import { lithuania } from './lt.js';
import { luxembourg } from './lu.js';
import { malta } from './mt.js';
import { netherlands } from './nl.js';
import { nigeria } from './ng.js';
import { norway } from './no.js';
import { newZealand } from './nz.js';
import { northernIreland } from './xi.js';
import { poland } from './pl.js';
import { peru } from './pe.js';
import { portugal } from './pt.js';
import { romania } from './ro.js';
import { russia } from './ru.js';
import { singapore } from './sg.js';
import { slovakia } from './sk.js';
import { slovenia } from './si.js';
import { spain } from './es.js';
import { sweden } from './se.js';
import { switzerland } from './ch.js';
import { taiwan } from './tw.js';
import type { CountryAdapterInterface } from './types.js';
import { ukraine } from './ua.js';
import { vietnam } from './vn.js';
import { unknownCountry } from './unknown.js';

/**
 * Every country the service answers for has an adapter, so `import -- all` and
 * `GET /v1/countries` cover them all: the 27 member states, Northern Ireland, and countries outside
 * Europe with a reachable register. Countries with their own source come first; the rest answer
 * through VIES and explain why in `importNote`.
 *
 * VIES is a source, declared by European countries. Countries outside the EU have their own
 * register instead.
 *
 * What matters is not whether a register is open, but whether a row can be reached by VAT number.
 * Ireland's company register is open, but the VAT number cannot be derived from the CRO number, so
 * it is useless here.
 */
export const COUNTRIES: CountryAdapterInterface[] = [
  france,
  poland,
  finland,
  estonia,
  latvia,
  belgium,
  czechia,
  denmark,
  romania,
  croatia,
  greece,
  germany,
  austria,
  bulgaria,
  cyprus,
  spain,
  hungary,
  ireland,
  italy,
  lithuania,
  luxembourg,
  malta,
  netherlands,
  portugal,
  sweden,
  slovenia,
  slovakia,
  northernIreland,
  australia,
  japan,
  singapore,
  brazil,
  taiwan,
  israel,
  costaRica,
  newZealand,
  peru,
  canada,
  russia,
  ukraine,
  norway,
  switzerland,
  vietnam,
  nigeria,
  ecuador,
  greenland,
];

const byCode = new Map(COUNTRIES.map((country) => [country.code, country]));

/**
 * Resolves a two-letter country code (`fr`), or `undefined` when none is registered. Use it to
 * validate a code. `GR` is not registered: the parser turns it into `EL`.
 */
export function getCountry(countryCode: string): CountryAdapterInterface | undefined {
  return byCode.get(countryCode.trim().toUpperCase());
}

/**
 * Same as `getCountry` for resolution: an unknown prefix falls back to VIES. Use `getCountry` to
 * check whether a country is known.
 */
export function resolveCountry(countryCode: string): CountryAdapterInterface {
  return getCountry(countryCode) ?? unknownCountry;
}

/**
 * How a country is served, derived from its sources:
 *
 * - `bulk` - imported file, no live register: France, Belgium, Estonia, Latvia...
 * - `on-demand` - live register, nothing to import: Poland, Czechia, Romania, Greece...
 * - `both` - Denmark, Finland, Germany, Croatia...
 * - `vies` - nothing of its own.
 */
export type CountryStrategy = 'bulk' | 'on-demand' | 'both' | 'vies';

export function strategyOf(country: CountryAdapterInterface): CountryStrategy {
  // VIES does not count as a live source of the country's own.
  const own = country.liveSources.some((source) => source.countryCode !== null);
  if (country.bulkSources.length > 0) return own ? 'both' : 'bulk';
  return own ? 'on-demand' : 'vies';
}

/**
 * The main register of a country, as published by `GET /v1/countries`: the first bulk source,
 * else the first own live source, else VIES.
 *
 * Greece is listed under GEMI rather than AADE, since AADE needs a Greek TAXISnet account.
 */
export function primarySourceOf(country: CountryAdapterInterface): string {
  const own = country.liveSources.filter((source) => source.countryCode !== null);
  return country.bulkSources[0]?.id ?? own.at(-1)?.id ?? 'VIES';
}
