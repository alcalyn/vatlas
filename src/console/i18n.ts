/**
 * The console speaks the same languages as the site, so a visitor coming from `/fr/pricing/` stays
 * in French.
 *
 * Both read `locales/*.json` through i18next.
 *
 * The files are read at runtime rather than imported, since `rootDir` is `src`. `../../locales`
 * resolves the same from `src/console` (tsx) and `dist/console` (pm2).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next, { type TFunction } from 'i18next';

const localesDir = resolve(import.meta.dirname, '..', '..', 'locales');

/**
 * The site discovers its languages from `locales/`. TypeScript cannot, so the list is written here
 * and checked against the directory at startup. Adding a language means adding the file and this
 * entry, otherwise the process refuses to start.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

const onDisk = readdirSync(localesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();
if (onDisk.join(',') !== [...LOCALES].sort().join(',')) {
  throw new Error(`locales: ${localesDir} holds ${onDisk.join(', ')}, but LOCALES declares ${LOCALES.join(', ')}`);
}

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

const resources = Object.fromEntries(
  LOCALES.map((code) => [
    code,
    { translation: JSON.parse(readFileSync(resolve(localesDir, `${code}.json`), 'utf8')) as Record<string, unknown> },
  ]),
);

/**
 * `escapeValue: false`: views escape with `esc()` where needed, and some strings are markup.
 *
 * A missing key throws. `test/console.test.ts` renders every page in every language, so missing
 * keys fail the tests.
 */
i18next.init({
  lng: DEFAULT_LOCALE,
  fallbackLng: false,
  supportedLngs: LOCALES,
  resources,
  interpolation: { escapeValue: false },
  saveMissing: true,
  missingKeyHandler: (lngs, _ns, key) => {
    throw new Error(`locales: unknown key "${key}" in ${lngs.join(', ')}`);
  },
});

/** The translator for one language: `t('audit.title')`, `t('overview.planQuota', { n: 100 })`. */
export function t(locale: Locale): TFunction {
  return i18next.getFixedT(locale);
}

/**
 * Picks a language from `Accept-Language`, for a first visit only. After that the choice is stored
 * on the account, so the console and the emails agree.
 */
export function localeFromHeader(header: string | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().slice(0, 2).toLowerCase();
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

/** The BCP 47 tag for `Intl`, from the locale file. */
function intlLocale(locale: Locale): string {
  return t(locale)('meta.intlLocale');
}

/** Dates in the reader's language. Values are UTC. */
export function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Date and time, for the audit trail.
 *
 * Rendered in UTC and labelled so, since the server does not know the reader's time zone. An
 * inline script in `views.ts` switches it to local time in the browser.
 */
export function formatDateTime(date: Date, locale: Locale): string {
  const formatted = new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
}

export function formatMonth(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short', timeZone: 'UTC' }).format(date);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}
