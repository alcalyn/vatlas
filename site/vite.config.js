import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import i18next from 'i18next'
import { defineConfig } from 'vite'
import { site, locales, defaultLocale, assertPublishableUrls } from './site.config.js'
import { pages, pageUrl, jsonLdFor } from './pages.js'
import {
  contentPages,
  contentJsonLd,
  countryPageUrl,
  absoluteUrl,
  hubUrlFor,
  CHROME_LOCALE,
  LANGUAGES,
} from './countries.js'
import { articlePages, articleHubUrlFor } from './articles.js'
import { exampleFor, loadExamples } from './examples.js'

const here = import.meta.dirname
const root = resolve(here, 'src')
const templatesDir = resolve(root, '_pages')
const genDir = resolve(root, '.gen')
/** The shell every content page is rendered into. */
const contentShell = resolve(root, '_countries/_shell.html')

/**
 * Country pages and guides together. They only differ by `section` (body directory, breadcrumb
 * labels and hub).
 */
const allContentPages = [...contentPages, ...articlePages]

/**
 * Legal notice, terms, privacy policy and the data processing agreement: hand-written HTML under
 * `src/<slug>/<locale>/`, one document per language. Header and footer are included like on every
 * other page.
 *
 * Adding a document here wires both the dev route and the build entry. They are noindex and stay
 * out of the sitemap.
 */
const LEGAL_SLUGS = ['legal', 'terms', 'privacy', 'dpa']
const legalPages = LEGAL_SLUGS.flatMap((slug) => locales.map((locale) => ({ slug, locale })))
const legalUrl = (slug, locale) => `/${slug}/${locale}/`

const INCLUDE = /^([ \t]*)<!--\s*@include\s+([\w./-]+)\s*-->[ \t]*$/gm
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g
const MAX_INCLUDE_DEPTH = 8
const MAX_TOKEN_PASSES = 4

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '')

/**
 * Every locale file, keyed by code: { en: {...}, fr: {...} }.
 *
 * `locales/` is at the repository root because the console reads the same files. Keys are at most
 * two levels deep (`homeHero.title1`).
 */
function loadTranslations() {
  return Object.fromEntries(
    locales.map((code) => [code, JSON.parse(readFileSync(resolve(here, '..', 'locales', `${code}.json`), 'utf8'))]),
  )
}

/**
 * i18next over those files.
 *
 * `escapeValue: false`: this pipeline escapes where needed (title, description) and ships HTML
 * everywhere else, so escaping here would double-escape.
 *
 * `missingKeyHandler` throws, so a missing translation fails the build.
 */
function createI18n(t) {
  const instance = i18next.createInstance()
  instance.init({
    lng: defaultLocale,
    fallbackLng: false,
    supportedLngs: locales,
    resources: Object.fromEntries(locales.map((code) => [code, { translation: t[code] }])),
    interpolation: { escapeValue: false },
    saveMissing: true,
    missingKeyHandler: (lngs, _ns, key) => {
      throw new Error(`locales: unknown key "${key}" in ${lngs.join(', ')}`)
    },
  })
  return instance
}

function expandIncludes(html, depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error('partials: include nesting too deep (loop?)')
  return html.replace(INCLUDE, (_, indent, file) => {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\n$/, '')
    return expandIncludes(source, depth + 1)
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n')
  })
}

/**
 * `{{t.homeHero.lead}}` is a translation, resolved by i18next, which also fills `{{quotaFree}}`
 * and `{{pricePro}}` from `vars`. Other tokens are page variables (`{{docsUrl}}`, `{{title}}`,
 * `{{body}}`).
 *
 * Substitution repeats because a partial can expand to markup with more tokens.
 */
function substitute(html, vars, where) {
  let out = html
  for (let pass = 0; pass < MAX_TOKEN_PASSES; pass += 1) {
    const next = out.replace(TOKEN, (match, name) => {
      if (name.startsWith('t.')) return vars.$t(name.slice(2), { replace: vars })
      if (!(name in vars)) throw new Error(`partials: unknown token {{${name}}} in ${where}`)
      return vars[name]
    })
    if (next === out) return out
    out = next
  }
  return out
}

function jsonLdScript(blocks) {
  const graph = { '@context': 'https://schema.org', '@graph': blocks }
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>`
}

/**
 * Thousands separators per language: 10,000 in English, 10 000 in French, from the locale's
 * `meta.intlLocale`.
 */
function formatThousands(value, locale, t) {
  return new Intl.NumberFormat(t[locale].meta.intlLocale).format(value)
}

function baseVars(locale, t, i18n) {
  return {
    // `$` is not allowed in template tokens, so this cannot collide with a page variable.
    $t: i18n.getFixedT(locale),
    lang: locale,
    siteName: site.name,
    domain: site.domain,
    email: site.email,
    discordUrl: site.discord,
    /** The invite URL without its scheme. */
    discordHandle: site.discord.replace(/^https?:\/\//, ''),
    githubUrl: site.github,
    apiBase: site.apiBase,
    // The console cannot read this site's storage, so the link carries the language.
    consoleUrl: `${site.consoleUrl}?lang=${locale}`,
    /** Where the "get a key" buttons go: the sign-up form. */
    signupUrl: `${site.consoleUrl}/signup?lang=${locale}`,
    /** Bare origin, used by the script that adds the theme to those links. */
    consoleOrigin: new URL(site.consoleUrl).origin,
    themeColor: site.themeColor,
    themeColorLight: site.themeColorLight,
    year: String(new Date().getFullYear()),
    pricePro: String(site.plans.pro.price),
    quotaFree: formatThousands(site.plans.free.quota, locale, t),
    quotaPro: formatThousands(site.plans.pro.quota, locale, t),
    monitorsFree: formatThousands(site.plans.free.monitors, locale, t),
    monitorsPro: formatThousands(site.plans.pro.monitors, locale, t),
    auditFreeKeep: String(site.audit.freeKeep),
    auditProDays: formatThousands(site.audit.proDays, locale, t),
    homeUrl: `/${locale}/`,
    docsUrl: `/${locale}/docs/`,
    pricingUrl: `/${locale}/pricing/`,
    contactUrl: `/${locale}/contact/`,
    benchmarksUrl: `/${locale}/benchmarks/`,
    versusUrl: `/${locale}/vs-vies/`,
    // One document per language, so the locale comes second in the URL. See LEGAL_SLUGS.
    legalUrl: legalUrl('legal', locale),
    termsUrl: legalUrl('terms', locale),
    privacyUrl: legalUrl('privacy', locale),
    dpaUrl: legalUrl('dpa', locale),
    faqUrl: `/${locale}/pricing/#faq`,
    tryUrl: `/${locale}/#try`,
    mailAccess: encodeURIComponent(t[locale].contact.mailSubjectAccess),
    mailTech: encodeURIComponent(t[locale].contact.mailSubjectTech),
    mailVolume: encodeURIComponent(t[locale].contact.mailSubjectVolume),
    coverageUrl: `/${locale}/#coverage`,
    // The hub of the country pages. Its slug is owned by countries.js and differs per language.
    countryHubUrl: hubUrlFor(locale),
    /** The hub of the guides. See articles.js. */
    guidesUrl: articleHubUrlFor(locale),
    /**
     * The whole `fmt` group as JSON, for the "try it" box.
     *
     * The answer is formatted in the browser by `src/lib/lookupView.ts`, which returns i18n keys.
     * i18next only runs at build time here, so the labels are passed in the page.
     */
    fmtLabels: escapeHtml(JSON.stringify(t[locale].fmt)),
  }
}

/** <link rel="alternate" hreflang="..."> for one page, in every locale. */
function alternates(page) {
  if (page.noIndex) return ''
  const links = locales.map(
    (code) => `<link rel="alternate" hreflang="${code}" href="${site.url}${pageUrl(page, code)}" />`,
  )
  links.push(`<link rel="alternate" hreflang="x-default" href="${site.url}${pageUrl(page, defaultLocale)}" />`)
  return links.join('\n    ')
}

/** The language menu, with the current locale marked. */
function langSwitcher(page, locale, t) {
  const items = locales
    .map((code) => {
      const current = code === locale
      return (
        `<a class="langmenu__item${current ? ' is-current' : ''}" hreflang="${code}" lang="${code}" ` +
        `href="${pageUrl(page, code)}"${current ? ' aria-current="true"' : ''}>` +
        `<span class="langmenu__code">${t[code].meta.flag}</span>${t[code].meta.name}</a>`
      )
    })
    .join('\n        ')
  return items
}

function renderPage(page, locale, t, i18n) {
  const template = readFileSync(resolve(templatesDir, page.template), 'utf8')
  const vars = baseVars(locale, t, i18n)
  const where = `${page.template} (${locale})`

  // Through i18next, so a missing namespace gives the usual unknown key error.
  const title = escapeHtml(stripTags(vars.$t(`${page.ns}.title`, { replace: vars })))
  const description = escapeHtml(stripTags(vars.$t(`${page.ns}.description`, { replace: vars })))

  Object.assign(vars, {
    title,
    description,
    ogLocale: t[locale].meta.ogLocale,
    ogType: page.key === 'home' ? 'website' : 'article',
    ogImage: `${site.url}/og-${locale}.png`,
    robots: page.robots ?? 'index, follow',
    canonical: site.url + pageUrl(page, locale),
    alternates: alternates(page),
    jsonld: jsonLdScript(jsonLdFor(page, t, locale)),
    langSwitcher: langSwitcher(page, locale, t),
    langCurrent: t[locale].meta.flag,
  })
  for (const name of ['home', 'pricing', 'docs', 'contact']) {
    vars[`nav_${name}`] = page.nav === name ? ' aria-current="page" class="nav__link is-active"' : ' class="nav__link"'
  }

  return substitute(expandIncludes(template), vars, where)
}

/**
 * A legal document: hand-written body, shared header and footer. Its language menu only links to
 * the other languages of the same document.
 */
function renderLegalPage({ slug, locale }, t, i18n) {
  const vars = baseVars(locale, t, i18n)
  const where = `${slug}/${locale}/index.html`

  vars.langCurrent = t[locale].meta.flag
  vars.langSwitcher = locales
    .map((code) => {
      const current = code === locale
      return (
        `<a class="langmenu__item${current ? ' is-current' : ''}" hreflang="${code}" lang="${code}" ` +
        `href="${legalUrl(slug, code)}"${current ? ' aria-current="true"' : ''}>` +
        `<span class="langmenu__code">${t[code].meta.flag}</span>${t[code].meta.name}</a>`
      )
    })
    .join('\n        ')
  // No current nav entry on legal documents.
  for (const name of ['home', 'pricing', 'docs', 'contact']) vars[`nav_${name}`] = ' class="nav__link"'

  const source = readFileSync(resolve(root, slug, locale, 'index.html'), 'utf8')
  return substitute(expandIncludes(source), vars, where)
}

/** `/` and `/404.html`: pick the visitor's language, or the default locale. */
function renderRoot(t, page) {
  const target = (suffix) => locales.map((code) => `    "${code}": "/${code}/${suffix}"`).join(',\n')
  const suffix = page ? '404.html' : ''
  const links = locales
    .map(
      (code) =>
        `      <li><a href="/${code}/${suffix}" hreflang="${code}" lang="${code}">${t[code].meta.name}</a></li>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="${defaultLocale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${site.name}</title>
    <meta name="robots" content="noindex, follow" />
${locales.map((code) => `    <link rel="alternate" hreflang="${code}" href="${site.url}/${code}/${suffix}" />`).join('\n')}
    <link rel="alternate" hreflang="x-default" href="${site.url}/${defaultLocale}/${suffix}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles/main.css" />
    <script>
      (function () {
        var targets = {
${target(suffix)}
        };
        var fallback = ${JSON.stringify(`/${defaultLocale}/${suffix}`)};
        var wanted = (navigator.languages || [navigator.language || '${defaultLocale}'])
          .map(function (tag) { return String(tag).toLowerCase().split('-')[0] });
        for (var i = 0; i < wanted.length; i += 1) {
          if (targets[wanted[i]]) { location.replace(targets[wanted[i]]); return }
        }
        location.replace(fallback);
      })();
    </script>
  </head>
  <body>
    <noscript>
      <ul>
${links}
      </ul>
    </noscript>
  </body>
</html>
`
}

/**
 * The country content pages (see countries.js). They share the partials, token substitution and
 * .gen tree, but not the i18n layer: their copy comes from one hand-written body file per language.
 *
 * A body file starts with a JSON metadata block, followed by the page's <main>:
 *
 *   <!-- @meta { "title": "...", "description": "...", "h1": "...", "term": "...", "updated": "..." } -->
 *   <main id="main"> ... </main>
 *
 * `title`, `description` and `updated` are required. `h1` and `term` refine the structured data.
 * A missing or malformed block fails the build.
 */
const META_BLOCK = /^\s*<!--\s*@meta\s*([\s\S]*?)-->/

function parseMeta(source, where) {
  const match = META_BLOCK.exec(source)
  if (!match) throw new Error(`countries: ${where} has no <!-- @meta { … } --> block`)
  let meta
  try {
    meta = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`countries: the @meta block of ${where} is not valid JSON - ${error.message}`)
  }
  for (const key of ['title', 'description', 'updated']) {
    if (!meta[key]) throw new Error(`countries: ${where} is missing "${key}" in its @meta block`)
  }
  return { meta, body: source.slice(match[0].length) }
}

/** hreflang across the languages of one country, x-default on the English page. */
function contentAlternates(page) {
  const links = page.group.pages.map(
    (other) => `<link rel="alternate" hreflang="${other.lang}" href="${absoluteUrl(other)}" />`,
  )
  const fallback = page.group.pages.find((other) => other.lang === 'en') ?? page.group.pages[0]
  links.push(`<link rel="alternate" hreflang="x-default" href="${absoluteUrl(fallback)}" />`)
  return links.join('\n    ')
}

/** The language menu of a country page switches between that country's languages. */
function contentLangSwitcher(page) {
  return page.group.pages
    .map((other) => {
      const current = other.lang === page.lang
      const label = LANGUAGES[other.lang]
      return (
        `<a class="langmenu__item${current ? ' is-current' : ''}" hreflang="${other.lang}" ` +
        `lang="${other.lang}" href="${countryPageUrl(other)}"${current ? ' aria-current="true"' : ''}>` +
        `<span class="langmenu__code">${label.flag}</span>${label.name}</a>`
      )
    })
    .join('\n        ')
}

function breadcrumbItems(page, meta) {
  const locale = CHROME_LOCALE[page.lang]
  const crumbs = page.section.crumb[page.lang]
  const trail = [{ name: crumbs.home, href: `/${locale}/` }]
  if (!page.isHub) trail.push({ name: crumbs.hub, href: page.section.hubUrlFor(page.lang) })
  trail.push({ name: page.name ?? meta.h1 ?? meta.title, href: null })

  return trail
    .map((entry) =>
      entry.href
        ? `<li><a href="${entry.href}">${escapeHtml(entry.name)}</a></li>`
        : `<li><span aria-current="page">${escapeHtml(entry.name)}</span></li>`,
    )
    .join('\n          ')
}

/**
 * The example a country page ends with, rendered with the sample template of the page's
 * language.
 *
 * Read here rather than `@include`d because it is optional: a country without a recorded example
 * ends without one.
 */
function renderExample(page, examples, vars, where) {
  const code = page.group.example ?? page.group.key
  const example = exampleFor(examples, code)
  if (!example) return { example: '', missing: code }
  const template = readFileSync(resolve(root, 'partials/country/example', `${page.lang}.html`), 'utf8')
  return { example: substitute(template.replace(/\n$/, ''), { ...vars, ...example }, where) }
}

function renderContentPage(page, t, i18n, examples) {
  const where = `${page.section.dir}/${page.body}`
  const source = readFileSync(resolve(root, page.section.dir, page.body), 'utf8')
  const { meta, body } = parseMeta(source, where)

  // The chrome uses the nearest site locale. The body is already in its own language.
  const locale = CHROME_LOCALE[page.lang]
  const vars = baseVars(locale, t, i18n)
  const expandedBody = expandIncludes(body)

  if (page.section.key === 'countries') {
    const { example, missing } = renderExample(page, examples, vars, where)
    Object.assign(vars, { example, countryName: page.name ?? '' })
    if (missing) missingExamples.add(missing)
  }

  Object.assign(vars, {
    pageLang: page.lang,
    body: expandedBody,
    title: escapeHtml(stripTags(substitute(meta.title, vars, where))),
    description: escapeHtml(stripTags(substitute(meta.description, vars, where))),
    ogLocale: LANGUAGES[page.lang].ogLocale,
    ogType: page.isHub ? 'website' : 'article',
    // Only one image per site locale exists. Other languages use the English one.
    ogImage: `${site.url}/og-${locale}.png`,
    robots: 'index, follow',
    canonical: absoluteUrl(page),
    alternates: contentAlternates(page),
    jsonld: jsonLdScript(contentJsonLd(page, meta, expandedBody, t)),
    langSwitcher: contentLangSwitcher(page),
    langCurrent: LANGUAGES[page.lang].flag,
    breadcrumbLabel: page.section.crumb[page.lang].hub,
    breadcrumbItems: breadcrumbItems(page, meta),
  })
  for (const name of ['home', 'pricing', 'docs', 'contact']) vars[`nav_${name}`] = ' class="nav__link"'

  return substitute(expandIncludes(readFileSync(contentShell, 'utf8')), vars, where)
}

/**
 * Countries rendered without an example, reported once at the end. Not a failure: run
 * `npm run country-examples` to record them.
 */
const missingExamples = new Set()

/** Writes src/.gen: one directory per locale, plus the two root entry points. */
function generate() {
  const t = loadTranslations()
  const i18n = createI18n(t)
  const examples = loadExamples()
  missingExamples.clear()
  rmSync(genDir, { recursive: true, force: true })

  const entries = {}
  const write = (relative, html) => {
    const file = resolve(genDir, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, html)
    return file
  }

  for (const locale of locales) {
    for (const page of pages) {
      const relative =
        page.key === 'notFound' ? `${locale}/404.html` : `${locale}/${page.slug ? page.slug + '/' : ''}index.html`
      entries[`${locale}-${page.key}`] = write(relative, renderPage(page, locale, t, i18n))
    }
  }

  for (const page of allContentPages) {
    entries[`content-${page.lang}-${page.slug.replace(/\//g, '-')}`] = write(
      `${page.lang}/${page.slug}/index.html`,
      renderContentPage(page, t, i18n, examples),
    )
  }

  for (const page of legalPages) {
    entries[`legal-${page.slug}-${page.locale}`] = write(
      `${page.slug}/${page.locale}/index.html`,
      renderLegalPage(page, t, i18n),
    )
  }

  entries.root = write('index.html', renderRoot(t, false))
  entries.root404 = write('404.html', renderRoot(t, true))

  if (missingExamples.size > 0) {
    const codes = [...missingExamples].sort().join(', ')
    console.warn(
      `countries: no worked example on file for ${codes} - those pages end without a sample. ` +
        'Run `VATLAS_KEY=… npm run country-examples -- --only <code>` to record one.',
    )
  }
  return entries
}

/** sitemap.xml, with the hreflang alternates of every page. */
function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10)
  const body = pages
    .filter((page) => !page.noIndex)
    .flatMap((page) =>
      locales.map((locale) => {
        const links = [...locales, 'x-default']
          .map((code) => {
            const href = site.url + pageUrl(page, code === 'x-default' ? defaultLocale : code)
            return `    <xhtml:link rel="alternate" hreflang="${code}" href="${href}" />`
          })
          .join('\n')
        return (
          `  <url>\n    <loc>${site.url}${pageUrl(page, locale)}</loc>\n` +
          `${links}\n    <lastmod>${today}</lastmod>\n` +
          `    <changefreq>monthly</changefreq>\n` +
          `    <priority>${page.key === 'home' ? '1.0' : '0.8'}</priority>\n  </url>`
        )
      }),
    )
    .join('\n')

  // Legal documents are noindex, so they stay out of the sitemap.

  // Country pages have their own hreflang cluster: the other languages of the same country.
  const contentBody = allContentPages
    .map((page) => {
      const links = page.group.pages
        .map((other) => `    <xhtml:link rel="alternate" hreflang="${other.lang}" href="${absoluteUrl(other)}" />`)
        .join('\n')
      const fallback = page.group.pages.find((other) => other.lang === 'en') ?? page.group.pages[0]
      return (
        `  <url>\n    <loc>${absoluteUrl(page)}</loc>\n${links}\n` +
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${absoluteUrl(fallback)}" />\n` +
        `    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n` +
        `    <priority>${page.isHub ? '0.8' : '0.7'}</priority>\n  </url>`
      )
    })
    .join('\n')

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    body +
    '\n' +
    contentBody +
    '\n</urlset>\n'
  )
}

/**
 * Umami analytics, injected into every page here rather than included from head.html: the root
 * redirects and the legal documents have no head partial.
 *
 * Read on every call so the dev server picks up edits.
 *
 * With UMAMI_WEBSITE_ID empty (the default) nothing is emitted.
 */
function analyticsSnippet() {
  if (!site.umami.websiteId) return ''
  const tokens = {
    umamiScriptUrl: site.umami.scriptUrl,
    umamiWebsiteId: site.umami.websiteId,
    umamiDomains: site.umami.domains,
  }
  return (
    readFileSync(resolve(root, 'partials/analytics.html'), 'utf8')
      .trim()
      .replace(TOKEN, (match, name) => (name in tokens ? tokens[name] : match))
      // Empty optional attributes are removed instead of shipped as `attr=""`. The partial has one
      // attribute per line, so the whole line goes.
      .replace(/^[ \t]*[\w-]+=""[ \t]*\r?\n/gm, '')
      .replace(/[ \t]*[\w-]+=""/g, '')
  )
}

const input = generate()

function vatlasPlugin() {
  return {
    name: 'vatlas-pages',

    // Analytics is added last. A page without </head> is left alone.
    transformIndexHtml(html) {
      const snippet = analyticsSnippet()
      if (!snippet || !html.includes('</head>')) return html
      return html.replace('</head>', () => `  ${snippet}\n  </head>`)
    },

    // src/.gen/en/pricing/index.html -> en/pricing/index.html in docs/.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const key of Object.keys(bundle)) {
          if (!key.startsWith('.gen/')) continue
          const chunk = bundle[key]
          delete bundle[key]
          chunk.fileName = key.slice('.gen/'.length)
          bundle[chunk.fileName] = chunk
        }
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() })
      },
    },

    configureServer(server) {
      // Dev URLs mirror production: /fr/pricing/ -> /.gen/fr/pricing/index.html
      server.middlewares.use((req, _res, next) => {
        const [path, query = ''] = req.url.split('?')
        if (!path.startsWith('/.gen/') && !path.startsWith('/@') && !path.includes('.')) {
          const clean = path.endsWith('/') ? path : `${path}/`
          req.url = `/.gen${clean}index.html${query ? `?${query}` : ''}`
        } else if (path === '/404.html' || locales.some((code) => path === `/${code}/404.html`)) {
          req.url = `/.gen${path}`
        }
        next()
      })

      // dotenv reads the root .env once and never overwrites existing variables, so editing values
      // baked into the HTML needs a dev server restart. Print a reminder.
      const envFile = resolve(here, '..', '.env')
      server.watcher.add(envFile)
      server.watcher.on('change', (file) => {
        if (file !== envFile) return
        server.config.logger.warn(
          `\n  .env changed - restart the dev server for it to take effect.\n` +
            `  It is read once at startup, so this page is still serving the previous values.\n`,
        )
      })

      const sources = [
        templatesDir,
        resolve(root, '_countries'),
        resolve(root, '_articles'),
        resolve(root, 'partials'),
        resolve(here, 'locales'),
        // Watched so a `country-examples` run reloads the browser.
        resolve(here, '..', 'data'),
        ...LEGAL_SLUGS.map((slug) => resolve(root, slug)),
      ]
      sources.forEach((dir) => server.watcher.add(dir))
      server.watcher.on('all', (_event, file) => {
        if (!sources.some((dir) => file.startsWith(dir)) && !/(pages|countries|articles)\.js$/.test(file)) return
        generate()
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}

export default defineConfig(({ command }) => {
  // A build writes docs/, which is published. Dev writes nothing. See assertPublishableUrls.
  if (command === 'build') assertPublishableUrls()

  return {
    root,
    publicDir: resolve(here, 'public'),
    base: '/',
    appType: 'mpa',
    plugins: [vatlasPlugin()],
    /**
     * `data/` is at the repository root, next to `locales/`. The dev server must be allowed to serve
     * it for the home page map.
     */
    resolve: { alias: { '@data': resolve(here, '..', 'data') } },
    server: { fs: { allow: [here, resolve(here, '..', 'data')] } },
    build: {
      outDir: resolve(here, '..', 'docs'),
      emptyOutDir: true,
      rollupOptions: { input },
    },
  }
})
