// Page definitions. One entry per template, each rendered once per locale.
import { site } from './site.config.js'

/** Public URL of a page in a given locale. */
export const pageUrl = (page, locale) =>
  page.key === 'notFound' ? `/${locale}/404.html` : `/${locale}/${page.slug ? page.slug + '/' : ''}`

export const pages = [
  { key: 'home', slug: '', nav: 'home', template: 'index.html', ns: 'home' },
  { key: 'pricing', slug: 'pricing', nav: 'pricing', template: 'pricing.html', ns: 'pricing' },
  { key: 'docs', slug: 'docs', nav: 'docs', template: 'docs.html', ns: 'docs' },
  { key: 'contact', slug: 'contact', nav: 'contact', template: 'contact.html', ns: 'contact' },
  { key: 'benchmarks', slug: 'benchmarks', nav: '', template: 'benchmarks.html', ns: 'benchmarks' },
  { key: 'versus', slug: 'vs-vies', nav: '', template: 'versus.html', ns: 'versus' },
  {
    key: 'notFound',
    slug: '404',
    nav: '',
    template: '404.html',
    ns: 'notFound',
    robots: 'noindex, follow',
    noIndex: true,
  },
]

export const organizationLd = (t, locale) => ({
  '@type': 'Organization',
  '@id': `${site.url}/#organization`,
  name: site.name,
  url: `${site.url}/${locale}/`,
  email: site.email,
  logo: `${site.url}/favicon.svg`,
  // The community Discord server, listed as a profile of the organization.
  sameAs: [site.discord],
  description: t[locale].home.description,
  // No `areaServed`: listing every country code on every page is not worth the bytes.
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'sales',
      email: site.email,
      availableLanguage: Object.keys(t).map((code) => t[code].meta.name),
    },
  ],
})

export const websiteLd = (t, locale) => ({
  '@type': 'WebSite',
  '@id': `${site.url}/#website`,
  name: site.name,
  url: `${site.url}/${locale}/`,
  inLanguage: locale,
  publisher: { '@id': `${site.url}/#organization` },
})

const softwareLd = (t, locale) => ({
  '@type': 'SoftwareApplication',
  '@id': `${site.url}/#api`,
  name: `${site.name} API`,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Any (HTTP)',
  url: `${site.url}/${locale}/`,
  provider: { '@id': `${site.url}/#organization` },
  offers: [
    {
      '@type': 'Offer',
      name: t[locale].pricingFree.name,
      price: String(site.plans.free.price),
      priceCurrency: site.plans.pro.currency,
      description: t[locale].pricingFree.pitch,
    },
    {
      '@type': 'Offer',
      name: t[locale].pricingPro.name,
      price: String(site.plans.pro.price),
      priceCurrency: site.plans.pro.currency,
      description: t[locale].pricingPro.pitch,
      url: `${site.url}/${locale}/pricing/`,
    },
  ],
})

export const stripTags = (html) => String(html).replace(/<[^>]+>/g, '')

/** Built from the locale file, so every question ends up in the structured data. */
const faqLd = (t, locale) => {
  const faq = t[locale].pricingFaq
  const numbers = Object.keys(faq)
    .map((key) => /^q(\d+)$/.exec(key)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)

  return {
    '@type': 'FAQPage',
    '@id': `${site.url}/${locale}/pricing/#faq`,
    mainEntity: numbers.map((n) => ({
      '@type': 'Question',
      name: stripTags(faq[`q${n}`]),
      acceptedAnswer: { '@type': 'Answer', text: stripTags(faq[`a${n}`]) },
    })),
  }
}

/** JSON-LD graph of one page in one locale. `t` maps every loaded locale. */
export function jsonLdFor(page, t, locale) {
  const graph = [organizationLd(t, locale), websiteLd(t, locale)]

  if (page.key === 'home') graph.push(softwareLd(t, locale))
  if (page.key === 'pricing') graph.push(softwareLd(t, locale), faqLd(t, locale))
  if (page.key === 'docs') {
    graph.push({
      '@type': 'TechArticle',
      '@id': `${site.url}/${locale}/docs/#article`,
      headline: stripTags(t[locale].docs.h1).replace('{{siteName}}', site.name),
      description: t[locale].docs.description,
      inLanguage: locale,
      author: { '@id': `${site.url}/#organization` },
      publisher: { '@id': `${site.url}/#organization` },
      about: { '@id': `${site.url}/#api` },
    })
  }
  if (page.key === 'contact') {
    graph.push({
      '@type': 'ContactPage',
      '@id': `${site.url}/${locale}/contact/#page`,
      name: stripTags(t[locale].contact.title).replace('{{siteName}}', site.name),
      inLanguage: locale,
      about: { '@id': `${site.url}/#organization` },
    })
  }

  return graph
}
