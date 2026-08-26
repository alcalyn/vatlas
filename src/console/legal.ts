import { config } from '../config.js';
import type { Locale } from './i18n.js';

/**
 * The published legal documents: which version is in force and where each one lives.
 *
 * The pages are hand-written static HTML under `site/src/{legal,terms,privacy}/`, one file per
 * language. This module is the only place that knows their URLs.
 */

/**
 * The version of the Terms currently published: the date the documents carry ("Last updated 27
 * August 2026").
 *
 * Change it only when the Terms change in substance. It is stored in `user.terms_version` at
 * sign-up as proof of what the customer accepted. Article 14 of the Terms separates minor changes
 * (effective on publication) from substantial ones (notified 30 days ahead): only the latter make a
 * new version.
 *
 * `YYYY-MM-DD` sorts and reads the same in every language.
 */
export const TERMS_VERSION = '2026-08-27';

/** Where each document lives, per language. */
export function legalUrls(locale: Locale): { terms: string; privacy: string; legal: string; dpa: string } {
  return {
    terms: `${config.siteUrl}/terms/${locale}/`,
    privacy: `${config.siteUrl}/privacy/${locale}/`,
    legal: `${config.siteUrl}/legal/${locale}/`,
    dpa: `${config.siteUrl}/dpa/${locale}/`,
  };
}
