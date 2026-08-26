/**
 * Per-country content pages: what the tax number looks like in a country, which national
 * identifier it is built from, and how to find the company behind it.
 *
 * These are not i18n pages. Each file is written directly in its language, like the legal
 * documents. The language controls:
 *   - the first URL segment and `<html lang>`,
 *   - the `hreflang` alternates, which link the pages of one country together,
 *   - the locale of the header, footer and CTA (see CHROME_LOCALE).
 *
 * Adding a country: one entry below, one body file per language under `src/_countries/` (ending
 * with `<!-- @include partials/country/<lang>.html -->`), one line in each hub page, and
 * `npm run country-examples -- --only <code>` to record an example.
 */
import { site } from './site.config.js'
import { organizationLd, websiteLd, stripTags } from './pages.js'

/** Public URL of one country page. */
export const countryPageUrl = (page) => `/${page.lang}/${page.slug}/`

/**
 * Header, footer and CTA only exist in the site's two locales. Other languages use French chrome
 * for French and English for everything else.
 */
export const CHROME_LOCALE = {
  en: 'en',
  fr: 'fr',
  bg: 'en',
  cs: 'en',
  da: 'en',
  de: 'en',
  el: 'en',
  es: 'en',
  et: 'en',
  fi: 'en',
  hr: 'en',
  hu: 'en',
  it: 'en',
  ja: 'en',
  lt: 'en',
  lv: 'en',
  nl: 'en',
  pl: 'en',
  pt: 'en',
  'pt-br': 'en',
  ro: 'en',
  ru: 'en',
  sk: 'en',
  sl: 'en',
  sv: 'en',
  uk: 'en',
}

/** Language menu labels and `og:locale` for languages the site itself does not speak. */
export const LANGUAGES = {
  en: { flag: '🇬🇧', name: 'English', ogLocale: 'en_GB' },
  fr: { flag: '🇫🇷', name: 'Français', ogLocale: 'fr_FR' },
  bg: { flag: '🇧🇬', name: 'Български', ogLocale: 'bg_BG' },
  cs: { flag: '🇨🇿', name: 'Čeština', ogLocale: 'cs_CZ' },
  da: { flag: '🇩🇰', name: 'Dansk', ogLocale: 'da_DK' },
  de: { flag: '🇩🇪', name: 'Deutsch', ogLocale: 'de_DE' },
  el: { flag: '🇬🇷', name: 'Ελληνικά', ogLocale: 'el_GR' },
  es: { flag: '🇪🇸', name: 'Español', ogLocale: 'es_ES' },
  et: { flag: '🇪🇪', name: 'Eesti', ogLocale: 'et_EE' },
  fi: { flag: '🇫🇮', name: 'Suomi', ogLocale: 'fi_FI' },
  hr: { flag: '🇭🇷', name: 'Hrvatski', ogLocale: 'hr_HR' },
  hu: { flag: '🇭🇺', name: 'Magyar', ogLocale: 'hu_HU' },
  it: { flag: '🇮🇹', name: 'Italiano', ogLocale: 'it_IT' },
  ja: { flag: '🇯🇵', name: '日本語', ogLocale: 'ja_JP' },
  lt: { flag: '🇱🇹', name: 'Lietuvių', ogLocale: 'lt_LT' },
  lv: { flag: '🇱🇻', name: 'Latviešu', ogLocale: 'lv_LV' },
  nl: { flag: '🇳🇱', name: 'Nederlands', ogLocale: 'nl_NL' },
  pl: { flag: '🇵🇱', name: 'Polski', ogLocale: 'pl_PL' },
  pt: { flag: '🇵🇹', name: 'Português', ogLocale: 'pt_PT' },
  // Brazilian Portuguese has its own entry so it gets the right flag and `og:locale`. The key is the
  // URL segment, so it stays lowercase.
  'pt-br': { flag: '🇧🇷', name: 'Português (Brasil)', ogLocale: 'pt_BR' },
  ro: { flag: '🇷🇴', name: 'Română', ogLocale: 'ro_RO' },
  ru: { flag: '🇷🇺', name: 'Русский', ogLocale: 'ru_RU' },
  sk: { flag: '🇸🇰', name: 'Slovenčina', ogLocale: 'sk_SK' },
  sl: { flag: '🇸🇮', name: 'Slovenščina', ogLocale: 'sl_SI' },
  sv: { flag: '🇸🇪', name: 'Svenska', ogLocale: 'sv_SE' },
  uk: { flag: '🇺🇦', name: 'Українська', ogLocale: 'uk_UA' },
}

/** Breadcrumb labels per language. */
export const BREADCRUMB = {
  en: { home: 'Home', hub: 'VAT numbers' },
  fr: { home: 'Accueil', hub: 'Numéros de TVA' },
  bg: { home: 'Начало', hub: 'ДДС номера' },
  cs: { home: 'Domů', hub: 'DIČ' },
  da: { home: 'Forside', hub: 'Momsnumre' },
  de: { home: 'Startseite', hub: 'USt-IdNr.' },
  el: { home: 'Αρχική', hub: 'Αριθμοί ΦΠΑ' },
  es: { home: 'Inicio', hub: 'NIF-IVA' },
  et: { home: 'Avaleht', hub: 'KMKR numbrid' },
  fi: { home: 'Etusivu', hub: 'ALV-numerot' },
  hr: { home: 'Početna', hub: 'PDV brojevi' },
  hu: { home: 'Kezdőlap', hub: 'Közösségi adószám' },
  it: { home: 'Home', hub: 'Partita IVA' },
  ja: { home: 'ホーム', hub: '事業者番号' },
  lt: { home: 'Pradžia', hub: 'PVM kodai' },
  lv: { home: 'Sākums', hub: 'PVN numuri' },
  nl: { home: 'Home', hub: 'Btw-nummers' },
  pl: { home: 'Strona główna', hub: 'Numery VAT' },
  pt: { home: 'Início', hub: 'Números de IVA' },
  'pt-br': { home: 'Início', hub: 'Números de empresas' },
  ro: { home: 'Acasă', hub: 'Coduri de TVA' },
  // Russian pages point to the English hub, so the crumb names the ИНН instead of the hub title.
  ru: { home: 'Главная', hub: 'ИНН' },
  sk: { home: 'Domov', hub: 'IČ DPH' },
  sl: { home: 'Domov', hub: 'ID za DDV' },
  sv: { home: 'Start', hub: 'Momsnummer' },
  // Same as Russian: the crumb names the number instead of the hub title.
  uk: { home: 'Головна', hub: 'ЄДРПОУ' },
}

/**
 * The hub pages, one per site locale. Country pages link to the hub of their language, or the
 * English one.
 */
export const hubGroup = {
  key: 'hub',
  // The hub shows Italy's example, an answer from VIES with a consultation number.
  example: 'IT',
  pages: [
    { lang: 'en', slug: 'vat-number', body: 'en/index.html' },
    { lang: 'fr', slug: 'numero-tva-intracommunautaire', body: 'fr/index.html' },
  ],
}

/**
 * One entry per country. `pages[]` are translations of each other.
 *
 * `name` is per language, used for the breadcrumb, the language menu and `{{countryName}}` in
 * the closing block (see `partials/country/`).
 *
 * `key` is the VAT prefix (`EL`, not `GR`), used to find the example in
 * `data/country-examples.json`. A group can override it with `example`.
 */
export const countryGroups = [
  {
    key: 'FR',
    pages: [
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/france', body: 'fr/france.html', name: 'France' },
      { lang: 'en', slug: 'vat-number/france', body: 'en/france.html', name: 'France' },
    ],
  },
  {
    key: 'DE',
    pages: [
      {
        lang: 'de',
        slug: 'umsatzsteuer-identifikationsnummer/deutschland',
        body: 'de/deutschland.html',
        name: 'Deutschland',
      },
      { lang: 'en', slug: 'vat-number/germany', body: 'en/germany.html', name: 'Germany' },
    ],
  },
  {
    key: 'IT',
    pages: [
      { lang: 'it', slug: 'partita-iva/italia', body: 'it/italia.html', name: 'Italia' },
      { lang: 'en', slug: 'vat-number/italy', body: 'en/italy.html', name: 'Italy' },
    ],
  },
  {
    key: 'ES',
    pages: [
      { lang: 'es', slug: 'numero-iva-intracomunitario/espana', body: 'es/espana.html', name: 'España' },
      { lang: 'en', slug: 'vat-number/spain', body: 'en/spain.html', name: 'Spain' },
    ],
  },
  {
    key: 'BE',
    pages: [
      { lang: 'nl', slug: 'btw-nummer/belgie', body: 'nl/belgie.html', name: 'België' },
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/belgique', body: 'fr/belgique.html', name: 'Belgique' },
      { lang: 'en', slug: 'vat-number/belgium', body: 'en/belgium.html', name: 'Belgium' },
    ],
  },
  {
    key: 'AT',
    pages: [
      { lang: 'de', slug: 'uid-nummer/oesterreich', body: 'de/oesterreich.html', name: 'Österreich' },
      { lang: 'en', slug: 'vat-number/austria', body: 'en/austria.html', name: 'Austria' },
    ],
  },
  {
    key: 'BG',
    pages: [
      { lang: 'bg', slug: 'dds-nomer/balgariya', body: 'bg/balgariya.html', name: 'България' },
      { lang: 'en', slug: 'vat-number/bulgaria', body: 'en/bulgaria.html', name: 'Bulgaria' },
    ],
  },
  {
    key: 'HR',
    pages: [
      { lang: 'hr', slug: 'pdv-broj/hrvatska', body: 'hr/hrvatska.html', name: 'Hrvatska' },
      { lang: 'en', slug: 'vat-number/croatia', body: 'en/croatia.html', name: 'Croatia' },
    ],
  },
  {
    key: 'CY',
    pages: [
      { lang: 'el', slug: 'arithmos-fpa/kypros', body: 'el/kypros.html', name: 'Κύπρος' },
      { lang: 'en', slug: 'vat-number/cyprus', body: 'en/cyprus.html', name: 'Cyprus' },
    ],
  },
  {
    key: 'CZ',
    pages: [
      { lang: 'cs', slug: 'dic/cesko', body: 'cs/cesko.html', name: 'Česko' },
      { lang: 'en', slug: 'vat-number/czechia', body: 'en/czechia.html', name: 'Czechia' },
    ],
  },
  {
    key: 'DK',
    pages: [
      { lang: 'da', slug: 'momsnummer/danmark', body: 'da/danmark.html', name: 'Danmark' },
      { lang: 'en', slug: 'vat-number/denmark', body: 'en/denmark.html', name: 'Denmark' },
    ],
  },
  {
    key: 'EE',
    pages: [
      { lang: 'et', slug: 'kmkr-number/eesti', body: 'et/eesti.html', name: 'Eesti' },
      { lang: 'en', slug: 'vat-number/estonia', body: 'en/estonia.html', name: 'Estonia' },
    ],
  },
  {
    key: 'FI',
    pages: [
      { lang: 'fi', slug: 'alv-numero/suomi', body: 'fi/suomi.html', name: 'Suomi' },
      { lang: 'en', slug: 'vat-number/finland', body: 'en/finland.html', name: 'Finland' },
    ],
  },
  {
    key: 'EL',
    pages: [
      { lang: 'el', slug: 'arithmos-fpa/ellada', body: 'el/ellada.html', name: 'Ελλάδα' },
      { lang: 'en', slug: 'vat-number/greece', body: 'en/greece.html', name: 'Greece' },
    ],
  },
  {
    key: 'HU',
    pages: [
      { lang: 'hu', slug: 'kozossegi-adoszam/magyarorszag', body: 'hu/magyarorszag.html', name: 'Magyarország' },
      { lang: 'en', slug: 'vat-number/hungary', body: 'en/hungary.html', name: 'Hungary' },
    ],
  },
  {
    // English-speaking: one page each, in English.
    key: 'IE',
    pages: [{ lang: 'en', slug: 'vat-number/ireland', body: 'en/ireland.html', name: 'Ireland' }],
  },
  {
    key: 'LV',
    pages: [
      { lang: 'lv', slug: 'pvn-numurs/latvija', body: 'lv/latvija.html', name: 'Latvija' },
      { lang: 'en', slug: 'vat-number/latvia', body: 'en/latvia.html', name: 'Latvia' },
    ],
  },
  {
    key: 'LT',
    pages: [
      { lang: 'lt', slug: 'pvm-kodas/lietuva', body: 'lt/lietuva.html', name: 'Lietuva' },
      { lang: 'en', slug: 'vat-number/lithuania', body: 'en/lithuania.html', name: 'Lithuania' },
    ],
  },
  {
    key: 'LU',
    pages: [
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/luxembourg', body: 'fr/luxembourg.html', name: 'Luxembourg' },
      { lang: 'en', slug: 'vat-number/luxembourg', body: 'en/luxembourg.html', name: 'Luxembourg' },
    ],
  },
  {
    key: 'MT',
    pages: [{ lang: 'en', slug: 'vat-number/malta', body: 'en/malta.html', name: 'Malta' }],
  },
  {
    key: 'NL',
    pages: [
      { lang: 'nl', slug: 'btw-nummer/nederland', body: 'nl/nederland.html', name: 'Nederland' },
      { lang: 'en', slug: 'vat-number/netherlands', body: 'en/netherlands.html', name: 'Netherlands' },
    ],
  },
  {
    key: 'PL',
    pages: [
      { lang: 'pl', slug: 'numer-vat-ue/polska', body: 'pl/polska.html', name: 'Polska' },
      { lang: 'en', slug: 'vat-number/poland', body: 'en/poland.html', name: 'Poland' },
    ],
  },
  {
    key: 'PT',
    pages: [
      { lang: 'pt', slug: 'numero-de-iva/portugal', body: 'pt/portugal.html', name: 'Portugal' },
      { lang: 'en', slug: 'vat-number/portugal', body: 'en/portugal.html', name: 'Portugal' },
    ],
  },
  {
    key: 'RO',
    pages: [
      { lang: 'ro', slug: 'cod-tva/romania', body: 'ro/romania.html', name: 'România' },
      { lang: 'en', slug: 'vat-number/romania', body: 'en/romania.html', name: 'Romania' },
    ],
  },
  {
    key: 'SK',
    pages: [
      { lang: 'sk', slug: 'ic-dph/slovensko', body: 'sk/slovensko.html', name: 'Slovensko' },
      { lang: 'en', slug: 'vat-number/slovakia', body: 'en/slovakia.html', name: 'Slovakia' },
    ],
  },
  {
    key: 'SI',
    pages: [
      { lang: 'sl', slug: 'id-za-ddv/slovenija', body: 'sl/slovenija.html', name: 'Slovenija' },
      { lang: 'en', slug: 'vat-number/slovenia', body: 'en/slovenia.html', name: 'Slovenia' },
    ],
  },
  {
    key: 'SE',
    pages: [
      { lang: 'sv', slug: 'momsregistreringsnummer/sverige', body: 'sv/sverige.html', name: 'Sverige' },
      { lang: 'en', slug: 'vat-number/sweden', body: 'en/sweden.html', name: 'Sweden' },
    ],
  },
  {
    key: 'XI',
    pages: [
      { lang: 'en', slug: 'vat-number/northern-ireland', body: 'en/northern-ireland.html', name: 'Northern Ireland' },
    ],
  },
  {
    // Countries outside the EU. Australia and Singapore are English only since their registers are in
    // English. Japan, Brazil, Canada (French), Russia and Ukraine have a native page. Taiwan, Israel,
    // Costa Rica and Peru are English only for now.
    key: 'AU',
    pages: [{ lang: 'en', slug: 'vat-number/australia', body: 'en/australia.html', name: 'Australia' }],
  },
  {
    key: 'CA',
    pages: [
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/canada', body: 'fr/canada.html', name: 'Canada' },
      { lang: 'en', slug: 'vat-number/canada', body: 'en/canada.html', name: 'Canada' },
    ],
  },
  {
    key: 'UA',
    pages: [
      { lang: 'uk', slug: 'yedrpou/ukrayina', body: 'uk/ukrayina.html', name: 'Україна' },
      { lang: 'en', slug: 'vat-number/ukraine', body: 'en/ukraine.html', name: 'Ukraine' },
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/ukraine', body: 'fr/ukraine.html', name: 'Ukraine' },
    ],
  },
  {
    key: 'JP',
    pages: [
      { lang: 'ja', slug: 'inboisu-toroku-bango/nihon', body: 'ja/nihon.html', name: '日本' },
      { lang: 'en', slug: 'vat-number/japan', body: 'en/japan.html', name: 'Japan' },
    ],
  },
  {
    key: 'SG',
    pages: [{ lang: 'en', slug: 'vat-number/singapore', body: 'en/singapore.html', name: 'Singapore' }],
  },
  {
    key: 'BR',
    pages: [
      { lang: 'pt-br', slug: 'cnpj/brasil', body: 'pt-br/brasil.html', name: 'Brasil' },
      { lang: 'en', slug: 'vat-number/brazil', body: 'en/brazil.html', name: 'Brazil' },
    ],
  },
  {
    key: 'TW',
    pages: [{ lang: 'en', slug: 'vat-number/taiwan', body: 'en/taiwan.html', name: 'Taiwan' }],
  },
  {
    key: 'IL',
    pages: [{ lang: 'en', slug: 'vat-number/israel', body: 'en/israel.html', name: 'Israel' }],
  },
  {
    key: 'CR',
    pages: [{ lang: 'en', slug: 'vat-number/costa-rica', body: 'en/costa-rica.html', name: 'Costa Rica' }],
  },
  {
    key: 'PE',
    pages: [{ lang: 'en', slug: 'vat-number/peru', body: 'en/peru.html', name: 'Peru' }],
  },
  {
    key: 'RU',
    pages: [
      { lang: 'ru', slug: 'inn/rossiya', body: 'ru/rossiya.html', name: 'Россия' },
      { lang: 'en', slug: 'vat-number/russia', body: 'en/russia.html', name: 'Russia' },
    ],
  },
  {
    key: 'EC',
    pages: [
      { lang: 'es', slug: 'numero-iva-intracomunitario/ecuador', body: 'es/ecuador.html', name: 'Ecuador' },
      { lang: 'en', slug: 'vat-number/ecuador', body: 'en/ecuador.html', name: 'Ecuador' },
    ],
  },
  {
    key: 'GL',
    pages: [
      { lang: 'da', slug: 'momsnummer/groenland', body: 'da/groenland.html', name: 'Grønland' },
      { lang: 'en', slug: 'vat-number/greenland', body: 'en/greenland.html', name: 'Greenland' },
    ],
  },
  {
    key: 'NO',
    pages: [{ lang: 'en', slug: 'vat-number/norway', body: 'en/norway.html', name: 'Norway' }],
  },
  {
    key: 'CH',
    pages: [
      { lang: 'de', slug: 'uid-nummer/schweiz', body: 'de/schweiz.html', name: 'Schweiz' },
      { lang: 'fr', slug: 'numero-tva-intracommunautaire/suisse', body: 'fr/suisse.html', name: 'Suisse' },
      { lang: 'en', slug: 'vat-number/switzerland', body: 'en/switzerland.html', name: 'Switzerland' },
    ],
  },
  {
    key: 'VN',
    pages: [{ lang: 'en', slug: 'vat-number/vietnam', body: 'en/vietnam.html', name: 'Vietnam' }],
  },
  {
    key: 'NG',
    pages: [{ lang: 'en', slug: 'vat-number/nigeria', body: 'en/nigeria.html', name: 'Nigeria' }],
  },
  {
    // English only: the NZBN register does not publish in te reo Māori.
    key: 'NZ',
    pages: [{ lang: 'en', slug: 'vat-number/new-zealand', body: 'en/new-zealand.html', name: 'New Zealand' }],
  },
]

/** Hub first, so the sitemap lists the parent before its children. */
export const contentGroups = [hubGroup, ...countryGroups]

/**
 * What differs between families of content pages: body directory, breadcrumb labels and hub.
 * Everything else (shell, `@meta`, tokens, canonical, hreflang, sitemap) is shared.
 *
 * `site/articles.js` declares the second family. `hubUrlFor` is a hoisted function declaration.
 */
export const COUNTRIES_SECTION = {
  key: 'countries',
  dir: '_countries',
  crumb: BREADCRUMB,
  hubUrlFor,
}

/** Every page, flattened, with its group and section. */
export const contentPages = contentGroups.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group, section: COUNTRIES_SECTION, isHub: group.key === 'hub' })),
)

/** The hub of a language. Only `en` and `fr` have one, other languages use the English hub. */
export function hubUrlFor(lang) {
  const own = hubGroup.pages.find((page) => page.lang === lang)
  return countryPageUrl(own ?? hubGroup.pages[0])
}

/** Absolute URL, for canonical, hreflang, sitemap and JSON-LD `@id`. */
export const absoluteUrl = (page) => site.url + countryPageUrl(page)

/**
 * The FAQ, read from the page's own `<details><summary>` markup so the visible questions and the
 * FAQPage structured data cannot drift apart.
 */
const FAQ_SECTION = /<section[^>]*\bid="faq"[\s\S]*?<\/section>/
const FAQ_ITEM = /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/g

export function faqFromBody(html) {
  const section = FAQ_SECTION.exec(html)
  if (!section) return []
  return [...section[0].matchAll(FAQ_ITEM)].map(([, question, answer]) => ({
    '@type': 'Question',
    name: stripTags(question).replace(/\s+/g, ' ').trim(),
    acceptedAnswer: {
      '@type': 'Answer',
      text: stripTags(answer).replace(/\s+/g, ' ').trim(),
    },
  }))
}

/** JSON-LD graph of a country or hub page: Organization, WebSite, Article, breadcrumb and FAQPage. */
export function contentJsonLd(page, meta, body, t) {
  const locale = CHROME_LOCALE[page.lang]
  const url = absoluteUrl(page)
  const crumbs = page.section.crumb[page.lang]
  const graph = [organizationLd(t, locale), websiteLd(t, locale)]

  // Every Article has an image: the demo poster when the page shows a demo, otherwise the locale's
  // social card.
  const image = meta.video ? `${site.url}/demos/${meta.video.file}.jpg` : `${site.url}/og-${locale}.png`

  graph.push({
    // A hub is a CollectionPage, anything else an Article unless its @meta says otherwise (for example
    // TechArticle).
    '@type': page.isHub ? 'CollectionPage' : (meta.articleType ?? 'Article'),
    '@id': `${url}#article`,
    headline: meta.h1 ?? meta.title,
    name: meta.title,
    description: meta.description,
    inLanguage: page.lang,
    url,
    image,
    datePublished: meta.published ?? meta.updated,
    dateModified: meta.updated,
    author: { '@id': `${site.url}/#organization` },
    publisher: { '@id': `${site.url}/#organization` },
    isPartOf: { '@id': `${site.url}/#website` },
    // The DefinedTerm is the identifier the page is about. Pages without a `term` (hubs, guides) have
    // none.
    ...(meta.term
      ? {
          about: {
            '@type': 'DefinedTerm',
            name: meta.term,
            description: meta.termDescription ?? meta.description,
            inDefinedTermSet: {
              '@type': 'DefinedTermSet',
              name: 'Business tax identification numbers',
            },
          },
        }
      : {}),
  })

  const trail = [{ name: crumbs.home, item: `${site.url}/${locale}/` }]
  if (!page.isHub) trail.push({ name: crumbs.hub, item: site.url + page.section.hubUrlFor(page.lang) })
  trail.push({ name: page.name ?? meta.h1, item: url })

  graph.push({
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: trail.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: entry.item,
    })),
  })

  // The screen recording shown on the page. `file` names the mp4 and its poster under /demos.
  if (meta.video) {
    graph.push({
      '@type': 'VideoObject',
      '@id': `${url}#video`,
      name: meta.video.name,
      description: meta.video.description,
      contentUrl: `${site.url}/demos/${meta.video.file}.mp4`,
      thumbnailUrl: `${site.url}/demos/${meta.video.file}.jpg`,
      duration: meta.video.duration,
      uploadDate: meta.updated,
      inLanguage: page.lang,
      isPartOf: { '@id': `${url}#article` },
      publisher: { '@id': `${site.url}/#organization` },
    })
  }

  // The pages a hub lists, in display order.
  const siblings = page.isHub ? (page.section.siblingsFor?.(page.lang) ?? []) : []
  if (siblings.length > 0) {
    graph.push({
      '@type': 'ItemList',
      '@id': `${url}#list`,
      itemListElement: siblings.map((sibling, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: sibling.name,
        url: site.url + sibling.url,
      })),
    })
  }

  const questions = faqFromBody(body)
  if (questions.length > 0) {
    graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: questions })
  }

  return graph
}
