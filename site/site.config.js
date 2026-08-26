import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// The site reads the same `.env` as the API and the console, one directory up.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true })

/** A value from the environment, or the production default. */
const env = (name, fallback) => {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : value.trim().replace(/\/$/, '')
}

/** A positive integer from the environment, or the fallback. */
const quota = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

// Everything language independent: brand, URLs, contact address, prices.
export const site = {
  name: 'Vatlas',
  url: env('SITE_URL', 'https://vatlas.dev'),
  email: process.env.CONTACT_EMAIL?.trim() || 'contact@vatlas.dev',
  // The community server. The Pro support invite is only shown in the console, which knows the plan.
  discord: env('DISCORD_INVITE_URL', 'https://discord.gg/R28nneW5xU'),
  apiBase: env('API_BASE_URL', 'https://api.vatlas.dev'),
  // The developer console: sign-up, keys, usage, billing.
  consoleUrl: env('CONSOLE_BASE_URL', 'https://console.vatlas.dev'),
  themeColor: '#0b0d12',
  themeColorLight: '#ffffff',
  // Umami analytics, website only (never the console). An empty id emits no script tag. The URL
  // selects the Umami Cloud region (eu.umami.is keeps the data in the EU).
  umami: {
    websiteId: process.env.UMAMI_WEBSITE_ID?.trim() || '',
    scriptUrl: env('UMAMI_SCRIPT_URL', 'https://cloud.umami.is/script.js'),
  },
  twitter: '@vatlas_dev',
  // Monthly quotas, read from the same variables as `src/config.ts`.
  plans: {
    // Monitor limits, read from the same variables as the API.
    free: { name: 'Free', price: 0, quota: quota('PLAN_FREE_QUOTA', 100), monitors: quota('MONITOR_FREE_MAX', 3) },
    pro: {
      name: 'Pro',
      price: 29,
      currency: 'EUR',
      quota: quota('PLAN_PRO_QUOTA', 5000),
      monitors: quota('MONITOR_PRO_MAX', 100),
    },
  },
  // Audit retention, read from the same variables as `src/config.ts`. Quoted on the pricing page
  // and in the privacy policy.
  audit: {
    freeKeep: quota('AUDIT_FREE_KEEP', 3),
    proDays: quota('AUDIT_PRO_DAYS', 730),
  },
}

/** Derived from `url`. */
site.domain = new URL(site.url).host

/**
 * Hostnames allowed to report analytics, comma-separated: `UMAMI_DOMAINS=vatlas.dev,www.vatlas.dev`.
 *
 * Optional. When empty, `data-domains` is removed from the tag (the build strips empty
 * attributes).
 */
site.umami.domains = process.env.UMAMI_DOMAINS?.trim() || ''

/**
 * Locales in menu order. The first is the default and the hreflang x-default.
 *
 * Discovered from `locales/` at the repository root, shared with the console.
 */
const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'locales')
export const defaultLocale = 'en'
export const locales = readdirSync(localesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort((a, b) => (a === defaultLocale ? -1 : b === defaultLocale ? 1 : a.localeCompare(b)))

/**
 * The build refuses localhost URLs: it bakes them into `docs/`, and a localhost link in
 * production would be broken. `npm run dev` accepts them since it writes nothing.
 */
export function assertPublishableUrls() {
  const local = /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local(:|$))/i
  const offenders = [
    ['SITE_URL', site.url],
    ['API_BASE_URL', site.apiBase],
    ['CONSOLE_BASE_URL', site.consoleUrl],
  ].filter(([, value]) => local.test(value))

  if (offenders.length === 0) return

  throw new Error(
    'Refusing to build the site with local URLs, which would be committed to docs/ and ' +
      'published:\n' +
      offenders.map(([name, value]) => `  ${name} = ${value}`).join('\n') +
      '\nSet them to their public values for a build, or use `npm run dev` to preview ' +
      'against a local server.',
  )
}
