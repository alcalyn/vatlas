/**
 * The guides: content pages about a task rather than a country.
 *
 * Same pipeline as `countries.js`: one file per language, written in that language, starting
 * with an `<!-- @meta { ... } -->` block and rendered through the shared shell. Only the body
 * directory, the breadcrumb labels and the hub differ, see COUNTRIES_SECTION in `countries.js`.
 *
 * This file imports `countries.js`, never the other way round, to avoid a cycle.
 *
 * Only `en` and `fr`, the site's locales. Adding a guide is one entry below plus one body file per
 * language.
 */
import { countryPageUrl } from './countries.js'

/** Breadcrumb labels per language. */
export const ARTICLES_BREADCRUMB = {
  en: { home: 'Home', hub: 'Guides' },
  fr: { home: 'Accueil', hub: 'Guides' },
}

/** The hub, one page per language. */
export const articleHubGroup = {
  key: 'guides-hub',
  pages: [
    { lang: 'en', slug: 'guides', body: 'en/index.html', name: 'Guides' },
    { lang: 'fr', slug: 'guides', body: 'fr/index.html', name: 'Guides' },
  ],
}

/** One entry per guide. `pages[]` are translations of each other. */
export const articleGroups = [
  {
    key: 'autofill',
    pages: [
      {
        lang: 'en',
        slug: 'guides/autofill-company-form-from-vat-number',
        body: 'en/autofill-company-form.html',
        name: 'Autofill a company form',
      },
      {
        lang: 'fr',
        slug: 'guides/pre-remplir-formulaire-societe-numero-tva',
        body: 'fr/pre-remplir-formulaire-societe.html',
        name: 'Pré-remplir un formulaire société',
      },
    ],
  },
  {
    key: 'invoice-check',
    pages: [
      {
        lang: 'en',
        slug: 'guides/verify-a-vat-number-on-an-invoice',
        body: 'en/verify-invoice-vat-number.html',
        name: 'Verify an invoice’s VAT number',
      },
      {
        lang: 'fr',
        slug: 'guides/verifier-numero-tva-facture',
        body: 'fr/verifier-tva-facture.html',
        name: 'Vérifier le numéro de TVA d’une facture',
      },
    ],
  },
  {
    key: 'crm',
    pages: [
      {
        lang: 'en',
        slug: 'guides/enrich-a-crm-from-vat-numbers',
        body: 'en/enrich-crm.html',
        name: 'Enrich a CRM from VAT numbers',
      },
      {
        lang: 'fr',
        slug: 'guides/enrichir-un-crm-avec-les-numeros-tva',
        body: 'fr/enrichir-crm.html',
        name: 'Enrichir un CRM avec les numéros de TVA',
      },
    ],
  },
  {
    key: 'name-address',
    pages: [
      {
        lang: 'en',
        slug: 'guides/company-name-address-from-vat-number',
        body: 'en/company-name-address.html',
        name: 'Company name and address',
      },
      {
        lang: 'fr',
        slug: 'guides/nom-adresse-entreprise-numero-tva',
        body: 'fr/nom-adresse-entreprise.html',
        name: 'Nom et adresse d’une entreprise',
      },
    ],
  },
]

/** Hub first, so the sitemap lists the parent before its children. */
export const articleContentGroups = [articleHubGroup, ...articleGroups]

/** The hub of a language. */
export function articleHubUrlFor(lang) {
  const own = articleHubGroup.pages.find((page) => page.lang === lang)
  return countryPageUrl(own ?? articleHubGroup.pages[0])
}

/** The guides of one language in declaration order, used to build the hub's ItemList JSON-LD. */
export function articleSiblingsFor(lang) {
  return articleGroups
    .map((group) => group.pages.find((page) => page.lang === lang))
    .filter(Boolean)
    .map((page) => ({ name: page.name, url: countryPageUrl(page) }))
}

export const ARTICLES_SECTION = {
  key: 'articles',
  dir: '_articles',
  crumb: ARTICLES_BREADCRUMB,
  hubUrlFor: articleHubUrlFor,
  siblingsFor: articleSiblingsFor,
}

/** Every guide, flattened, with its group and section. */
export const articlePages = articleContentGroups.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group, section: ARTICLES_SECTION, isHub: group.key === 'guides-hub' })),
)
