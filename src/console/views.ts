import { config } from '../config.js';
import { maskedKey } from '../services/secretKeys.js';
import { PASSWORD_MAX, PASSWORD_MIN } from '../services/passwords.js';
import { legalUrls, TERMS_VERSION } from './legal.js';
import { STYLES } from './styles.js';
import { formatDate, formatDateTime, formatMonth, formatNumber, LOCALES, t, type Locale } from './i18n.js';
import { hasProof, renderAnswer, type AnswerContext } from '../lib/lookupHtml.js';
import type { AuditRow } from '../services/audit.js';
import { presentAll, presentLookup, type AllView, type LookupView } from '../lib/lookupView.js';
import { AUDIT_FREE_KEEP, AUDIT_PRO_DAYS } from '../services/retention.js';
import {
  EXPORT_ROW_CAP,
  SECTION_TIER,
  TIERS,
  isErasable,
  pageSections,
  type FieldValue,
  type PersonalDataRecord,
  type Section,
  type SectionId,
  type Tier,
} from '../services/personalData.js';

/**
 * Server-rendered HTML with template literals, no view engine or framework.
 *
 * Every interpolated value must go through {@link esc}: these pages render emails, key names and
 * billing details typed by users.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The pages the sidebar can highlight. */
export type Page =
  'dashboard' | 'lookup' | 'monitors' | 'lookups' | 'audit' | 'keys' | 'account' | 'data' | 'billing' | 'contact';

export interface NavOptions {
  current: Page;
  email: string;
  /**
   * Whether the Stripe portal can be opened: payments configured and a customer exists. An account
   * that never subscribed has nothing to manage.
   */
  portal: boolean;
  /** False until the address is verified: shows the verification banner on every page. */
  emailVerified: boolean;
}

interface LayoutOptions {
  locale: Locale;
  title: string;
  /** Absent on the sign-in page, which has no navigation. */
  nav?: NavOptions;
  body: string;
}

export function layout({ locale, title, nav, body }: LayoutOptions): string {
  const tr = t(locale);
  // Signed in: sidebar and content side by side. Signed out: one column.
  const main = nav
    ? `<div class="shell">${sidebar(locale, nav)}<main class="content">${nav.emailVerified ? '' : verifyBanner(locale)}${body}</main></div>`
    : `<main class="container">${body}</main>`;

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(tr('brand'))}</title>
<meta name="site-origin" content="${esc(new URL(config.siteUrl).origin)}">
${THEME_BOOTSTRAP}
<style>${STYLES}</style>
</head>
<body>
${header(locale, nav)}
${main}
${SCRIPTS}
</body>
</html>`;
}

/**
 * Shown on every signed-in page until the address is verified. Nothing is blocked, but the address
 * is where resets, invoices and security notices go.
 */
function verifyBanner(locale: Locale): string {
  const tr = t(locale);
  return `<div class="notice notice--warn verify-banner" role="status">
  <p>${esc(tr('verify.banner'))}</p>
  <form method="post" action="/verify-email/resend">
    <button class="btn btn--ghost btn--sm" type="submit">${esc(tr('verify.resend'))}</button>
  </form>
</div>`;
}

/**
 * Reads the same `localStorage` key as the site and applies the theme before the stylesheet, to
 * avoid a flash. Copied from `site/src/partials/head.html` rather than shared.
 *
 * The console is another origin with its own storage, so the theme travels in the link like the
 * language. `?theme=` wins over the stored value and is saved.
 *
 * Only an explicit choice is passed on.
 */
const THEME_BOOTSTRAP = `<script>
try {
  var incoming = new URLSearchParams(location.search).get('theme');
  var stored = incoming === 'light' || incoming === 'dark' ? incoming : localStorage.getItem('vatlas-theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
    localStorage.setItem('vatlas-theme', stored);
  }
} catch (e) {}
</script>`;

/**
 * The logo from `site/public/favicon.svg`, inlined. The console serves no static files, so a page is
 * a single request.
 */
const LOGO = `<svg class="brand__mark" viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
  <rect width="64" height="64" rx="15" fill="#0A0B0F"/>
  <path d="M14 17h9.6l8.4 22.3L40.4 17H50L36.6 50h-9.2L14 17Z" fill="#7C5CFF"/>
  <circle cx="32" cy="24" r="4.2" fill="#C6FF4D"/>
</svg>`;

/**
 * Logo, name and host label, then the links out of the console (docs, website), then the theme
 * toggle and language menu in the same order as on the site. The account menu is at the end.
 *
 * In-console navigation is in the sidebar.
 */
function header(locale: Locale, nav: LayoutOptions['nav']): string {
  const tr = t(locale);
  const navigation = `<nav>
    <a href="${config.siteUrl}/${locale}/docs/">${esc(tr('nav.docs'))}</a>
    <a class="bar__out" href="${config.siteUrl}/${locale}/">${esc(tr('nav.site'))}</a>
    ${nav ? accountMenu(locale, nav) : ''}
  </nav>`;

  return `<header class="bar"><div class="container bar__inner">
  <a class="brand" href="${nav ? '/' : `${config.siteUrl}/${locale}/`}">
    ${LOGO}<span class="brand__name">${esc(tr('brand'))}</span><span class="brand__sub">${esc(tr('nav.console'))}</span>
  </a>
  ${navigation}
  <div class="bar__tools">
    ${themeToggle(locale)}
    ${langMenu(locale)}
  </div>
</div></header>`;
}

/** Inline SVG. `currentColor` lets the icon follow its label's color. */
const ICON = {
  dashboard: `<path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z"/>`,
  lookup: `<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>`,
  audit: `<path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="17.5" x2="13" y2="17.5"/>`,
  keys: `<circle cx="7.5" cy="15.5" r="4"/><path d="M10.5 12.5 20 3"/><path d="M17 6l2.5 2.5"/>`,
  monitors: `<path d="M2 12h4l3-7 4 14 3-7h6"/>`,
  lookups: `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>`,
  account: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  data: `<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
  billing: `<rect x="2.5" y="5" width="19" height="14" rx="2"/><line x1="2.5" y1="10" x2="21.5" y2="10"/>`,
  invoices: `<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>`,
  contact: `<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7.5A8 8 0 1 1 21 12z"/><line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="8.5" y1="14.5" x2="13" y2="14.5"/>`,
  logout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
} as const;

function icon(name: keyof typeof ICON, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

/**
 * The console navigation, in blocks: the product first, then account settings.
 *
 * The invoices entry is a one-button form, since the Stripe portal session is created server-side.
 * It looks like the other links.
 *
 * Sign out is in the account menu, not here.
 *
 * Contact is alone in a last unlabelled block.
 */
function sidebar(locale: Locale, nav: NavOptions): string {
  const tr = t(locale);
  const item = (page: Page, href: string, name: keyof typeof ICON, label: string) =>
    `<a class="sidenav__item" href="${href}"${nav.current === page ? ' aria-current="page"' : ''}>${icon(name)}${esc(label)}</a>`;

  const invoices = nav.portal
    ? `<form method="post" action="/billing/portal">
        <button class="sidenav__item" type="submit">${icon('invoices')}${esc(tr('nav.invoices'))}</button>
      </form>`
    : '';

  return `<aside class="sidebar">
  <nav class="sidenav" aria-label="${esc(tr('nav.sections'))}">
    ${item('dashboard', '/', 'dashboard', tr('nav.dashboard'))}
    ${item('lookup', '/lookup', 'lookup', tr('nav.lookup'))}
    ${item('lookups', '/lookup-async', 'lookups', tr('nav.asyncLookups'))}
    ${item('monitors', '/monitor', 'monitors', tr('nav.monitors'))}
    ${item('audit', '/audits', 'audit', tr('nav.audit'))}
    ${item('keys', '/keys', 'keys', tr('nav.keys'))}
  </nav>
  <div class="sidenav__group">
    <p class="sidenav__title">${esc(tr('nav.settings'))}</p>
    <nav class="sidenav" aria-label="${esc(tr('nav.settings'))}">
      ${item('account', '/account', 'account', tr('nav.myAccount'))}
      ${item('data', '/data', 'data', tr('nav.personalData'))}
      ${item('billing', '/billing', 'billing', tr('nav.billing'))}
      ${invoices}
    </nav>
  </div>
  <nav class="sidenav sidenav__group" aria-label="${esc(tr('nav.contact'))}">
    ${item('contact', '/contact', 'contact', tr('nav.contact'))}
  </nav>
</aside>`;
}

/**
 * The light/dark switch. Rendered without JavaScript and wired by the script below. Without JS,
 * `prefers-color-scheme` already applies.
 */
function themeToggle(locale: Locale): string {
  const tr = t(locale);
  // `{mode}` stays a single brace with a manual replace: the same string is shipped in
  // `data-label-template` for theme.js, and i18next would consume a `{{mode}}`.
  const label = (mode: string) => esc(tr('nav.themeLabel').replace('{mode}', mode));
  return `<button
      class="iconbtn"
      type="button"
      data-theme-toggle
      data-label-dark="${esc(tr('nav.themeDark'))}"
      data-label-light="${esc(tr('nav.themeLight'))}"
      data-label-template="${esc(tr('nav.themeLabel'))}"
      aria-label="${label(tr('nav.themeDark'))}"
    ><span class="iconbtn__icon" data-theme-icon aria-hidden="true">◐</span></button>`;
}

/** The language's own name and its two-letter code, both from each locale file's `meta` block. */
const languageName = (locale: Locale) => t(locale)('meta.name');
const languageFlag = (locale: Locale) => t(locale)('meta.flag');

/**
 * The language menu in the header, with the same `<details>` markup and classes as the site.
 *
 * Entries are POST buttons, not links, since choosing a language writes to the account.
 */
function langMenu(locale: Locale): string {
  const tr = t(locale);
  const items = LOCALES.map((option) => {
    const active = option === locale;
    return `<button class="langmenu__item${active ? ' is-current' : ''}" type="submit" name="locale" value="${option}" lang="${option}"${
      active ? ' aria-current="true" disabled' : ''
    }><span class="langmenu__code">${esc(languageFlag(option))}</span>${esc(languageName(option))}</button>`;
  }).join('');

  return `<details class="langmenu" data-dropdown>
      <summary class="iconbtn iconbtn--wide" title="${esc(tr('nav.langLabel'))}">
        <span class="sr-only">${esc(tr('nav.langLabel'))}</span>
        <span class="langmenu__flag" aria-hidden="true">${esc(languageFlag(locale))}</span>
      </summary>
      <form method="post" action="/locale" class="langmenu__list" aria-label="${esc(tr('nav.langLabel'))}">${items}</form>
    </details>`;
}

/**
 * The signed-in account: an avatar, the address, and the session actions.
 *
 * A `<details>` element, so it works with the keyboard and without JavaScript. The script only adds
 * closing it on outside click or Escape.
 */
function accountMenu(locale: Locale, nav: NavOptions): string {
  const tr = t(locale);
  return `<details class="account" data-dropdown>
      <summary aria-label="${esc(tr('nav.account'))}">
        <span class="avatar" aria-hidden="true">${esc(initial(nav.email))}</span>
        <span class="account__email">${esc(nav.email)}</span>
        <span class="account__caret" aria-hidden="true"></span>
      </summary>
      <div class="menu">
        <p class="menu__head">${esc(nav.email)}</p>
        <a class="menu__item" href="/account"${nav.current === 'account' ? ' aria-current="page"' : ''}>${esc(tr('nav.myAccount'))}</a>
        <form method="post" action="/logout">
          <button class="menu__item menu__item--danger" type="submit">${icon('logout', 14)}${esc(tr('nav.logout'))}</button>
        </form>
      </div>
    </details>`;
}

/**
 * First character of the address, as a code point so characters outside the BMP are not cut in
 * half.
 */
function initial(email: string): string {
  return ([...email.trim()][0] ?? '?').toUpperCase();
}

/** A page title and a one-line description. */
function pageHead(title: string, lead?: string): string {
  return `<div class="page__head">
  <h1>${esc(title)}</h1>
  ${lead ? `<p class="dim">${esc(lead)}</p>` : ''}
</div>`;
}

/**
 * An `onsubmit="return confirm(...)"` attribute that works whatever the message contains.
 *
 * The attribute is JavaScript: the HTML parser decodes entities first, so an apostrophe in the
 * message (common in French) would break the script and the form would submit without
 * confirmation. `JSON.stringify` makes a valid JS string, then `esc` makes it a valid attribute.
 */
function confirmSubmit(message: string): string {
  return `onsubmit="return confirm(${esc(JSON.stringify(message))})"`;
}

/**
 * One row of a `<dl class="facts">`, where the value is already escaped HTML.
 *
 * Separate from the `fact` helper in {@link accountPage}, which escapes its input. One helper that
 * sometimes escapes would eventually leak an unescaped value.
 */
function factRow(label: string, html: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`;
}

/** A panel: a ruled header and a body. `flush` is for tables, which have their own padding. */
function panel(options: {
  title?: string;
  aside?: string;
  lead?: string;
  body: string;
  foot?: string;
  flush?: boolean;
  classes?: string;
  /** Extra attributes on the `<section>`. Written by the caller, never by a visitor. */
  attrs?: string;
}): string {
  const head = options.title
    ? `<div class="panel__head"><h2>${esc(options.title)}</h2>${options.aside ?? ''}</div>`
    : '';
  const lead = options.lead ? `<p class="muted">${esc(options.lead)}</p>` : '';
  return `<section class="panel${options.flush ? ' panel--flush' : ''}${options.classes ? ` ${options.classes}` : ''}"${options.attrs ? ` ${options.attrs}` : ''}>
  ${head}
  ${lead && options.flush ? `<div class="panel__body" style="padding:1rem 1rem 0">${lead}</div>` : ''}
  <div class="panel__body">${lead && !options.flush ? lead : ''}${options.body}</div>
  ${options.foot ? `<div class="panel__foot">${options.foot}</div>` : ''}
</section>`;
}

/**
 * All the JavaScript the console ships. Everything works without it: keys are selectable text, the
 * copy button is only added when it can work, the language menu is a form, and dropdowns are
 * `<details>`. The script adds outside click and Escape.
 *
 * The theme toggle needs it, since `localStorage` is the only place to store the choice. Mirrors
 * `site/src/js/theme.js`.
 */
const SCRIPTS = `<script>
document.querySelectorAll('[data-copy]').forEach(function (wrap) {
  if (!navigator.clipboard) return;
  var source = wrap.querySelector('[data-copy-source]');
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost btn--sm';
  btn.textContent = wrap.dataset.copyLabel;
  function copy() {
    // data-copy-value when the displayed text is not the value to copy (a masked key).
    var value = wrap.dataset.copyValue || source.textContent.trim();
    navigator.clipboard.writeText(value).then(function () {
      btn.textContent = wrap.dataset.copiedLabel;
      setTimeout(function () { btn.textContent = wrap.dataset.copyLabel; }, 1500);
    });
  }
  btn.addEventListener('click', copy);
  // Clicking the key text copies it too.
  if (source.getAttribute('role') === 'button') {
    source.addEventListener('click', copy);
    source.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copy(); }
    });
  }
  wrap.appendChild(btn);
});

// A whole table row as a click target. The click is forwarded to the row's link, which keyboards
// and screen readers use. Clicks on interactive elements or ending a text selection are ignored.
document.addEventListener('click', function (event) {
  var row = event.target.closest ? event.target.closest('tr.row-link') : null;
  if (!row) return;
  if (event.target.closest('a, button, input, label, summary, [role="button"]')) return;
  if (window.getSelection && String(window.getSelection())) return;
  var href = row.dataset.href;
  if (href) window.location.href = href;
});

document.addEventListener('click', function (event) {
  document.querySelectorAll('[data-dropdown][open]').forEach(function (menu) {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('[data-dropdown][open]').forEach(function (menu) {
    menu.open = false;
    menu.querySelector('summary').focus();
  });
});

// Like the site's link rewriting, so the theme travels back too.
function carryThemeToSite() {
  var meta = document.querySelector('meta[name="site-origin"]');
  if (!meta || !meta.content) return;
  var choice = null;
  try {
    var value = localStorage.getItem('vatlas-theme');
    choice = value === 'light' || value === 'dark' ? value : null;
  } catch (e) {}

  document.querySelectorAll('a[href^="' + meta.content + '"]').forEach(function (link) {
    try {
      var url = new URL(link.href);
      if (choice) url.searchParams.set('theme', choice);
      else url.searchParams.delete('theme');
      link.href = url.toString();
    } catch (e) {}
  });
}
carryThemeToSite();

(function () {
  var button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  var icon = button.querySelector('[data-theme-icon]');
  var ICONS = { light: '☀', dark: '☾' };
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try {
      var value = localStorage.getItem('vatlas-theme');
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) { return null; }
  }
  function current() {
    return document.documentElement.dataset.theme || (media && media.matches ? 'dark' : 'light');
  }
  function paint() {
    var active = current();
    var next = active === 'dark' ? 'light' : 'dark';
    var label = button.dataset.labelTemplate.replace(
      '{mode}',
      next === 'dark' ? button.dataset.labelDark : button.dataset.labelLight
    );
    button.setAttribute('aria-label', label);
    button.title = label;
    if (icon) icon.textContent = ICONS[active];
  }

  button.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('vatlas-theme', next); } catch (e) {}
    carryThemeToSite();
    paint();
  });

  // Follow the system until a choice is made.
  if (media) media.addEventListener('change', function () { if (!stored()) paint(); });

  paint();
})();

// Timestamps are rendered in UTC by the server and rewritten here in the browser's time zone. The
// language stays the page's, and the tooltip keeps the UTC time.
// (No backticks in here: this script is a template literal.)
document.querySelectorAll('time[data-local]').forEach(function (el) {
  var iso = el.getAttribute('datetime');
  if (!iso) return;
  var at = new Date(iso);
  if (isNaN(at.getTime())) return;
  try {
    var utc = el.textContent;
    el.textContent = new Intl.DateTimeFormat(document.documentElement.lang === 'fr' ? 'fr-FR' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(at);
    el.title = utc;
  } catch (e) {}
});
</script>`;

// -- sign in --

/**
 * The consent line, with `{terms}` and `{privacy}` replaced by links.
 *
 * The sentence is escaped before the links are inserted, and link labels are escaped on their own,
 * so the locale file cannot inject markup.
 */
function consentLine(locale: Locale): string {
  const tr = t(locale);
  const urls = legalUrls(locale);
  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;

  // Escaped first, links inserted after. i18next interpolation would run before escaping, so these
  // placeholders stay single braces and are replaced here.
  return esc(tr('login.termsConsent'))
    .replace('{terms}', link(urls.terms, tr('login.termsLinkLabel')))
    .replace('{privacy}', link(urls.privacy, tr('login.privacyLinkLabel')));
}

/** The error and notice lines at the top of signed-out forms. */
function formNotices(options: { error?: string; notice?: string }): string {
  return [
    options.notice ? `<div class="notice"><p>${esc(options.notice)}</p></div>` : '',
    options.error ? `<div class="notice notice--error"><p>${esc(options.error)}</p></div>` : '',
  ].join('');
}

function passwordField(
  locale: Locale,
  options: { name: string; label: string; autocomplete: string; hint?: boolean; autofocus?: boolean },
): string {
  const tr = t(locale);
  return `<div class="field">
    <label for="${options.name}">${esc(options.label)}</label>
    <input id="${options.name}" name="${options.name}" type="password" required autocomplete="${options.autocomplete}"${
      options.hint ? ` minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}"` : ''
    }${options.autofocus ? ' autofocus' : ''}>
    ${options.hint ? `<p class="dim field__hint">${esc(tr('password.hint', { min: PASSWORD_MIN }))}</p>` : ''}
  </div>`;
}

function emailField(locale: Locale, email: string | undefined, autofocus = true): string {
  const tr = t(locale);
  return `<div class="field">
    <label for="email">${esc(tr('login.emailLabel'))}</label>
    <input id="email" name="email" type="email" required${autofocus ? ' autofocus' : ''} autocomplete="email"
           placeholder="${esc(tr('login.emailPlaceholder'))}" value="${esc(email ?? '')}">
  </div>`;
}

/**
 * The note for old magic-link accounts is always on the page: showing it only on their failed
 * attempts would reveal which addresses had an account. Can be removed once those accounts are
 * gone.
 */
export function loginPage(locale: Locale, options: { error?: string; notice?: string; email?: string }): string {
  const tr = t(locale);
  const body = `<div class="center">
    <h1>${esc(tr('login.title'))}</h1>
    <p class="muted">${esc(tr('login.lead'))}</p>
    ${formNotices(options)}
    <form method="post" action="/login">
      ${emailField(locale, options.email, !options.email)}
      ${passwordField(locale, { name: 'password', label: tr('login.passwordLabel'), autocomplete: 'current-password', autofocus: Boolean(options.email) })}
      <p class="auth__aside"><a href="/password/forgot">${esc(tr('login.forgot'))}</a></p>
      <button class="btn btn--block" type="submit">${esc(tr('login.submit'))}</button>
    </form>
    <p class="auth__alt">${esc(tr('login.noAccount'))} <a href="/signup">${esc(tr('login.signupLink'))}</a></p>
    <div class="notice auth__migrated"><p>${esc(tr('login.migratedNote'))} <a href="/password/forgot">${esc(tr('login.migratedLink'))}</a></p></div>
  </div>`;

  return layout({ locale, title: tr('login.title'), body });
}

/**
 * The Terms are accepted at sign-up. The version is in the checkbox value, so what is stored is
 * what this page showed.
 */
export function signupPage(
  locale: Locale,
  options: { error?: string; email?: string; termsChecked?: boolean; exists?: boolean },
): string {
  const tr = t(locale);
  const exists = options.exists
    ? `<p class="auth__aside"><a href="/login">${esc(tr('signup.loginInstead'))}</a> · <a href="/password/forgot">${esc(tr('login.forgot'))}</a></p>`
    : '';
  const body = `<div class="center">
    <h1>${esc(tr('signup.title'))}</h1>
    <p class="muted">${esc(tr('signup.lead'))}</p>
    ${formNotices(options)}
    ${exists}
    <form method="post" action="/signup">
      ${emailField(locale, options.email)}
      ${passwordField(locale, { name: 'password', label: tr('login.passwordLabel'), autocomplete: 'new-password', hint: true })}
      <div class="field field--check">
        <label class="check">
          <input type="checkbox" name="terms" value="${esc(TERMS_VERSION)}" required${options.termsChecked ? ' checked' : ''}>
          <span>${consentLine(locale)}</span>
        </label>
      </div>
      <button class="btn btn--block" type="submit">${esc(tr('signup.submit'))}</button>
    </form>
    <p class="auth__alt">${esc(tr('signup.haveAccount'))} <a href="/login">${esc(tr('signup.loginLink'))}</a></p>
  </div>`;

  return layout({ locale, title: tr('signup.title'), body });
}

export function forgotPasswordPage(
  locale: Locale,
  options: { sent?: boolean; error?: string; email?: string },
): string {
  const tr = t(locale);
  const body = options.sent
    ? `<div class="center">
        <h1>${esc(tr('password.sentTitle'))}</h1>
        <p class="muted">${esc(tr('password.sentLead'))}</p>
        <p class="dim">${esc(tr('password.sentHint'))}</p>
        <p class="auth__alt"><a href="/login">${esc(tr('password.backToLogin'))}</a></p>
      </div>`
    : `<div class="center">
        <h1>${esc(tr('password.forgotTitle'))}</h1>
        <p class="muted">${esc(tr('password.forgotLead'))}</p>
        ${formNotices(options)}
        <form method="post" action="/password/forgot">
          ${emailField(locale, options.email)}
          <button class="btn btn--block" type="submit">${esc(tr('password.forgotSubmit'))}</button>
        </form>
        <p class="auth__alt"><a href="/login">${esc(tr('password.backToLogin'))}</a></p>
      </div>`;

  return layout({ locale, title: tr('password.forgotTitle'), body });
}

export function resetPasswordPage(
  locale: Locale,
  options: { token?: string; expired?: boolean; error?: string },
): string {
  const tr = t(locale);
  const body =
    options.expired || !options.token
      ? `<div class="center">
        <h1>${esc(tr('password.resetTitle'))}</h1>
        <div class="notice notice--error"><p>${esc(tr('password.resetExpired'))}</p></div>
        <a class="btn btn--block" href="/password/forgot">${esc(tr('password.resetAgain'))}</a>
      </div>`
      : `<div class="center">
        <h1>${esc(tr('password.resetTitle'))}</h1>
        <p class="muted">${esc(tr('password.resetLead'))}</p>
        ${formNotices(options)}
        <form method="post" action="/password/reset">
          <input type="hidden" name="token" value="${esc(options.token)}">
          ${passwordField(locale, { name: 'password', label: tr('password.newLabel'), autocomplete: 'new-password', hint: true, autofocus: true })}
          <button class="btn btn--block" type="submit">${esc(tr('password.resetSubmit'))}</button>
        </form>
      </div>`;

  return layout({ locale, title: tr('password.resetTitle'), body });
}

// -- shared pieces --

export interface KeyRow {
  id: bigint;
  name: string;
  prefix: string;
  last4: string;
  /** The key while it is live, or a masked form when it cannot be recovered. */
  key: string;
  /** False when `key` is masked. */
  copyable: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface HistoryRow {
  periodStart: Date;
  quota: number;
  used: number;
}

/**
 * How to call the API, with the account's own key.
 *
 * Shown on the dashboard and the lookup page. Without a recoverable key it uses `$VATLAS_KEY` like
 * the published docs.
 */
function samplePanel(locale: Locale, sampleKey: string | undefined): string {
  const tr = t(locale);
  return panel({
    title: tr('overview.quickStartTitle'),
    lead: sampleKey ? tr('overview.quickStartLead') : tr('overview.quickStartLeadPlaceholder'),
    body: sampleCommand(locale, sampleKey),
  });
}

/** The first call, copyable, with the account's key when it can be shown. */
function sampleCommand(locale: Locale, sampleKey: string | undefined): string {
  const tr = t(locale);
  const key = sampleKey ?? '$VATLAS_KEY';
  return `<div class="copywrap" data-copy data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
      <pre class="code" data-copy-source>curl <span class="str">"${esc(config.apiBaseUrl)}/v1/lookup/FR95884831538"</span> \\
  <span class="flag">-H</span> <span class="str">"Authorization: Bearer ${esc(key)}"</span></pre>
    </div>`;
}

// -- dashboard --

export interface DashboardData {
  locale: Locale;
  email: string;
  /**
   * The key for the sample command. Absent when no live key can be recovered, and the panel falls
   * back to the documented environment variable.
   */
  sampleKey?: string;
  used: number;
  quota: number;
  /** The current period and the day it resets. */
  periodStart: Date;
  resetAt: Date;
  plan: 'free' | 'pro';
  /** Same rule as the plan page: no Stripe, no button. */
  stripeReady: boolean;
  /** Whether Stripe already has a customer for this account, see {@link planButton}. */
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  history: HistoryRow[];
  /** Companies followed, and the plan limit. */
  monitorsUsed: number;
  monitorsLimit: number;
  /** Show the first-steps panel until it is dismissed. */
  onboarding?: boolean;
}

/**
 * The first-steps panel, shown after sign-up: it contains the sample command with the key, so the
 * quick-start panel is hidden while it is shown. Once dismissed, the quick-start panel returns.
 */
function onboardingPanel(locale: Locale, sampleKey: string | undefined): string {
  const tr = t(locale);
  const docs = `${config.siteUrl}/${locale}/docs/`;
  const step = (n: number, text: string, content: string) => `<li class="onboarding__step">
      <span class="onboarding__num" aria-hidden="true">${n}</span>
      <div class="onboarding__stepbody"><p>${esc(text)}</p>${content}</div>
    </li>`;

  return `<section class="onboarding" aria-labelledby="onboarding-title">
  <p class="onboarding__eyebrow">${esc(tr('onboarding.eyebrow'))}</p>
  <h2 id="onboarding-title">${esc(tr('onboarding.title'))}</h2>
  <p class="muted">${esc(tr('onboarding.body'))}</p>
  <ol class="onboarding__steps">
    ${step(1, tr('onboarding.stepTry'), sampleCommand(locale, sampleKey))}
    ${step(2, tr('onboarding.stepDocs'), `<a class="btn" href="${esc(docs)}">${esc(tr('onboarding.docsButton'))}</a>`)}
  </ol>
  <form class="onboarding__foot" method="post" action="/onboarding/dismiss">
    <button class="btn btn--ghost btn--sm" type="submit">${esc(tr('onboarding.dismiss'))}</button>
  </form>
</section>`;
}

/**
 * Upgrade, or manage the subscription, wherever the plan is shown. Same endpoints and labels on the
 * dashboard and the plan page.
 *
 * Which one depends on whether a Stripe customer exists, not on the plan alone.
 *
 * Nothing when payments are not configured. The plan page explains why.
 */
function planButton(
  locale: Locale,
  options: { plan: 'free' | 'pro'; stripeReady: boolean; hasBillingAccount: boolean; small?: boolean },
): string {
  if (!options.stripeReady) return '';
  const tr = t(locale);
  const manage = options.plan === 'pro' && options.hasBillingAccount;
  const label = manage ? tr('billing.manage') : tr('billing.upgrade');
  const size = options.small ? ' btn--sm' : '';
  const classes = manage ? `btn btn--ghost${size}` : `btn${size}`;
  return `<form method="post" action="${manage ? '/billing/portal' : '/billing/checkout'}">
        <button class="${classes}" type="submit">${esc(label)}</button>
      </form>`;
}

/** Plan, usage, history, and the sample command. */
export function dashboardPage(data: DashboardData): string {
  const { locale } = data;
  const tr = t(locale);
  const exhausted = data.used >= data.quota;
  const percent = data.quota === 0 ? 0 : Math.min(100, (data.used / data.quota) * 100);
  const planName = data.plan === 'pro' ? tr('billing.planPro') : tr('billing.planFree');

  const stats = `<section class="panel panel--flush">
  <div class="stats">
    <div class="stat">
      <p class="stat__label">${esc(tr('billing.currentPlan'))}</p>
      <p class="stat__value">${esc(planName)}</p>
      <p class="stat__foot">${esc(tr('overview.planQuota', { count: data.quota, n: formatNumber(data.quota, locale) }))}</p>
      <div class="stat__action">${planButton(locale, { ...data, small: true })}</div>
    </div>
    <div class="stat">
      <p class="stat__label">${esc(tr('overview.usageTitle'))}</p>
      <p class="stat__value">${esc(formatNumber(data.used, locale))} <small>${esc(tr('overview.usageOf'))} ${esc(formatNumber(data.quota, locale))}</small></p>
      <div class="meter"><div class="meter__fill${exhausted ? ' is-full' : ''}" style="width:${percent.toFixed(1)}%"></div></div>
    </div>
    <div class="stat">
      <p class="stat__label">${esc(tr('overview.usageResets'))}</p>
      <p class="stat__value">${esc(formatDate(data.resetAt, locale))}</p>
    </div>
    <div class="stat">
      <p class="stat__label">${esc(tr('nav.monitors'))}</p>
      <p class="stat__value">${esc(formatNumber(data.monitorsUsed, locale))} <small>${esc(tr('overview.usageOf'))} ${esc(formatNumber(data.monitorsLimit, locale))}</small></p>
      <div class="meter"><div class="meter__fill${data.monitorsUsed >= data.monitorsLimit ? ' is-full' : ''}" style="width:${(data.monitorsLimit === 0 ? 0 : Math.min(100, (data.monitorsUsed / data.monitorsLimit) * 100)).toFixed(1)}%"></div></div>
      <div class="stat__action"><a class="btn btn--ghost btn--sm" href="/monitor">${esc(tr('overview.monitorsManage'))}</a></div>
    </div>
  </div>
</section>`;

  const body = `
${pageHead(tr('overview.title'), `${tr('overview.greeting')} ${data.email}`)}
${data.onboarding ? onboardingPanel(locale, data.sampleKey) : ''}
${stats}
${exhausted ? `<div class="notice notice--error"><p>${esc(tr('overview.usageExhausted'))}</p></div>` : ''}
${data.onboarding ? '' : samplePanel(locale, data.sampleKey)}
${panel({
  title: tr('overview.historyTitle'),
  lead: tr('overview.historyLead'),
  body:
    data.history.length > 0
      ? historyChart(data.history, data.periodStart, locale)
      : `<p class="dim">${esc(tr('overview.historyEmpty'))}</p>`,
})}`;

  return layout({
    locale,
    title: tr('overview.title'),
    nav: {
      current: 'dashboard',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/**
 * Twelve bars in plain SVG, no chart library.
 *
 * Each bar is scaled against its own month's quota, so "nearly full" looks the same across plan
 * changes. The current month is included and drawn paler, since it is partial.
 */
function historyChart(history: HistoryRow[], periodStart: Date, locale: Locale): string {
  const tr = t(locale);
  const width = 720;
  const height = 160;
  const bottom = 24;
  const slot = width / history.length;
  const barWidth = Math.min(46, slot * 0.6);

  const bars = history
    .map((row, index) => {
      const x = index * slot + (slot - barWidth) / 2;
      const ratio = row.quota === 0 ? 0 : Math.min(1, row.used / row.quota);
      const full = height - bottom;
      const barHeight = Math.max(row.used > 0 ? 2 : 0, ratio * full);
      const label = formatMonth(row.periodStart, locale);
      const current = row.periodStart.getTime() === periodStart.getTime();
      const title = `${label} - ${formatNumber(row.used, locale)} / ${formatNumber(row.quota, locale)}${
        current ? ` (${tr('overview.historyCurrent')})` : ''
      }`;
      return `<g><title>${esc(title)}</title>
        <rect class="bar-bg" x="${x.toFixed(1)}" y="0" width="${barWidth.toFixed(1)}" height="${full}" rx="3"/>
        <rect class="bar${current ? ' bar--current' : ''}" x="${x.toFixed(1)}" y="${(full - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3"/>
        <text class="lbl" x="${(x + barWidth / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>
      </g>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

// -- lookup --

export interface LookupResult {
  /** The HTTP status the API answered (200, 404, 429...). */
  status: number;
  /** The response body, pretty-printed. */
  body: string;
  /** How long the call took, as the caller would measure it. */
  durationMs: number;
}

/** Which endpoint: one answer, or every source. `prefer` is a separate option below. */
export type LookupMode = 'single' | 'all';

/** The switch, in render order. `single` first, as the default. */
export const LOOKUP_MODES = ['single', 'all'] as const;

/** The API's `?prefer`, as radios. */
export type LookupPreference = 'completeness' | 'proof';

/** The two values, in render order. */
export const LOOKUP_PREFERENCES = ['completeness', 'proof'] as const;

/** One row of the per-source table above a lookup-all's raw response. */
export interface LookupSourceRow {
  source: string;
  /** `bulk`, `live`, or `both`. */
  kind: string;
  /** The result of the call this report made, or `stored` when it made none. */
  status: string;
  /** Day of the source's latest statement, `YYYY-MM-DD`. Null when it has none. */
  asOf: string | null;
  /** Number of statements in the source's history. */
  statements: number;
}

export interface LookupData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  sampleKey?: string;
  /** The submitted number, shown again in the field. */
  query: string;
  /** The selected mode: the last one run, or `single`. */
  mode: LookupMode;
  /** `?prefer`, as last selected. */
  prefer: LookupPreference;
  /** `?history`, as last selected. */
  history: boolean;
  result?: LookupResult;
  /**
   * The sources of a lookup-all, read from the response body. Undefined for a plain lookup or an
   * error response.
   */
  sources?: LookupSourceRow[];
  /**
   * The formatted answer, built by `src/lib/lookupView.ts`. Undefined when no call was made or the API
   * was unreachable.
   */
  view?: LookupView | AllView;
  /** A localized message: no key to call with, or the API could not be reached. */
  error?: string;
}

/**
 * A VAT number, its answer, and the exact `curl` that produced it.
 *
 * The call goes to the public API over HTTP with the account's key, so it is metered, logged and
 * audited like a call from the customer's code.
 */
/**
 * The mode switch and options, shared by `/lookup` (runs the call) and `/lookup-async` (queues it).
 *
 * Radios and a checkbox, no select or JavaScript: the console renders server-side.
 *
 * The radios are at the top of the form because the stylesheet reaches labels, notes and options
 * with `~`, which only works on siblings. They are moved off-screen, never `display:none`, which
 * would remove them from the tab order.
 */
function lookupControls(options: {
  mode: LookupMode;
  prefer: LookupPreference;
  /** Omitted when queuing: async lookups do not take `?history`. */
  history?: boolean;
  /** The endpoint of each mode, shown in its note. */
  endpoints: Record<LookupMode, string>;
  tr: ReturnType<typeof t>;
}): { radios: string; switcher: string; options: string; notes: string } {
  const { mode, prefer, tr } = options;

  const radios = LOOKUP_MODES.map(
    (value) =>
      `<input type="radio" id="mode-${value}" name="mode" value="${value}" class="segmented__radio"` +
      `${mode === value ? ' checked' : ''}>`,
  ).join('\n    ');

  const switcher = LOOKUP_MODES.map(
    (value) => `<label class="segmented__item" for="mode-${value}">${esc(tr(`lookup.mode${cap(value)}`))}</label>`,
  ).join('\n      ');

  // `prefer` only applies to the single lookup. Always rendered and hidden by CSS, so switching back
  // keeps the choice.
  const preference = LOOKUP_PREFERENCES.map(
    (value) =>
      `<label class="options__choice"><input type="radio" name="prefer" value="${value}"` +
      `${prefer === value ? ' checked' : ''}> ${esc(tr(`lookup.prefer${cap(value)}`))}</label>`,
  ).join('\n        ');

  // The checkbox label is the parameter name.
  const history =
    options.history === undefined
      ? ''
      : `<div class="options__group">
        <span class="options__label" id="option-history">${esc(tr('lookup.historyLabel'))}</span>
        <span class="options__choices">
          <label class="options__choice"><input type="checkbox" name="history" value="true"` +
        `${options.history ? ' checked' : ''} aria-labelledby="option-history"></label>
        </span>
      </div>`;

  // Two columns: parameter name, then its values.
  const optionsBlock = `<div class="options">
      <div class="options__group options__group--prefer">
        <span class="options__label">${esc(tr('lookup.preferLabel'))}</span>
        <span class="options__choices">
          ${preference}
        </span>
      </div>
      ${history}
    </div>`;

  // Every note is rendered and CSS shows the selected one, so it updates as the switch moves.
  const notes = LOOKUP_MODES.map(
    (value) =>
      `<p class="note note--${value} dim"><code>${esc(options.endpoints[value])}</code> - ` +
      `${esc(tr(`lookup.mode${cap(value)}Hint`))}</p>`,
  ).join('\n    ');

  return { radios, switcher, options: optionsBlock, notes };
}

/**
 * A VAT number, its answer, and the exact `curl` that produced it.
 *
 * The call goes to the public API over HTTP with the account's key, so it is metered, logged and
 * audited like a call from the customer's code.
 */
export function lookupPage(data: LookupData): string {
  const { locale } = data;
  const tr = t(locale);

  const controls = lookupControls({
    mode: data.mode,
    prefer: data.prefer,
    history: data.history,
    endpoints: MODE_ENDPOINT,
    tr,
  });

  const form = `<form method="post" action="/lookup" class="lookupform">
    ${controls.radios}
    <div class="segmented" role="group" aria-label="${esc(tr('lookup.formTitle'))}">
      ${controls.switcher}
    </div>
    <div class="row">
      <div class="field">
        <label for="vatNumber">${esc(tr('lookup.label'))}</label>
        <input id="vatNumber" name="vatNumber" type="text" maxlength="20" required
               value="${esc(data.query)}" placeholder="${esc(tr('lookup.placeholder'))}"
               autocomplete="off" spellcheck="false"${data.query ? '' : ' autofocus'}>
      </div>
      <button class="btn" type="submit">${esc(tr('lookup.submit'))}</button>
    </div>
    ${controls.options}
    ${controls.notes}
    <p class="dim" style="margin:.6rem 0 0">${esc(tr('lookup.metered'))}</p>
  </form>`;

  const path = lookupPath(data.query, data);
  // Two tabs, formatted first. Same radio and `~` mechanism as the mode switch. The tab resets on
  // every submission.
  const raw = `<p class="dim" style="margin:0 0 .6rem">GET ${esc(config.apiBaseUrl)}${esc(path)}</p>
          ${data.mode === 'all' ? sourcesTable(data.sources, tr, locale) : ''}
          <pre class="code">${esc(data.result?.body ?? '')}</pre>`;

  const result = data.result
    ? panel({
        title: tr('lookup.resultTitle'),
        aside: `<span class="dim">${esc(statusLine(data.result, tr))}</span>`,
        body: answerTabs({
          group: 'view',
          title: tr('lookup.resultTitle'),
          formatted: formattedPane(data.view, tr, locale),
          json: raw,
          tr,
        }),
      })
    : '';

  const anchor = data.mode === 'all' ? 'lookup-all' : 'lookup';
  const body = `
${pageHead(tr('lookup.title'), tr('lookup.lead'))}
${data.error ? `<div class="notice notice--error"><p>${esc(data.error)}</p></div>` : ''}
${panel({ title: tr('lookup.formTitle'), body: form })}
${result}
${samplePanel(locale, data.sampleKey)}
<p><a href="${config.siteUrl}/${locale}/docs/#${anchor}">${esc(tr('lookup.docs'))} →</a></p>`;

  return layout({
    locale,
    title: tr('lookup.title'),
    nav: {
      current: 'lookup',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/**
 * The URL the options compose, as the documentation writes it.
 *
 * Parameters only appear when they change something: `?prefer=completeness` is the default, and
 * `?history` is implied on lookup-all. The result is the shortest URL giving this answer.
 */
export function lookupPath(
  vatNumber: string,
  options: { mode: LookupMode; prefer: LookupPreference; history: boolean },
): string {
  const number = encodeURIComponent(vatNumber);
  const query =
    options.mode === 'all'
      ? options.history
        ? []
        : ['history=false']
      : [...(options.prefer === 'proof' ? ['prefer=proof'] : []), ...(options.history ? ['history'] : [])];
  const path = options.mode === 'all' ? `/v1/lookup-all/${number}` : `/v1/lookup/${number}`;
  return query.length > 0 ? `${path}?${query.join('&')}` : path;
}

/** The endpoint of each mode, with a `{vatNumber}` placeholder. */
const MODE_ENDPOINT: Record<LookupMode, string> = {
  single: 'GET /v1/lookup/{vatNumber}',
  all: 'GET /v1/lookup-all/{vatNumber}',
};

/** The same two calls, queued. */
const ASYNC_MODE_ENDPOINT: Record<LookupMode, string> = {
  single: 'POST /v1/lookup-async/{vatNumber}',
  all: 'POST /v1/lookup-async-all/{vatNumber}',
};

/** `single` -> `Single`, to build the `lookup.modeSingle` key. */
function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `200 · 143 ms`: status and duration. */
function statusLine(result: LookupResult, tr: ReturnType<typeof t>): string {
  return `${result.status} · ${tr('lookup.duration', { ms: result.durationMs })}`;
}

/**
 * A summary of the lookup-all above the JSON: which sources the country has, when each last said
 * something, and how many times it changed. The raw body stays below.
 */
function sourcesTable(sources: LookupSourceRow[] | undefined, tr: ReturnType<typeof t>, locale: Locale): string {
  if (!sources) return '';
  if (sources.length === 0) {
    return `<p class="dim" style="margin:0 0 .6rem">${esc(tr('lookup.fullNoSources'))}</p>`;
  }

  const rows = sources
    .map((source) => {
      const { label, tone } = SOURCE_STATUS[source.status] ?? SOURCE_STATUS_UNKNOWN;
      const kind = tr(`lookup.${KIND_LABEL[source.kind] ?? 'fullKindLive'}`);
      return `<tr>
      <td class="mono">${esc(source.source)}</td>
      <td class="dim">${esc(kind)}</td>
      <td><span class="${tone}">${esc(tr(`lookup.${label}`))}</span></td>
      <td>${source.asOf ? esc(formatDate(new Date(source.asOf), locale)) : '<span class="dim">-</span>'}</td>
      <td>${source.statements}</td>
    </tr>`;
    })
    .join('');

  return `<div class="table-wrap" style="margin:0 0 1rem">
  <table>
    <thead><tr>
      <th>${esc(tr('lookup.fullColSource'))}</th>
      <th>${esc(tr('lookup.fullColKind'))}</th>
      <th>${esc(tr('lookup.fullColStatus'))}</th>
      <th>${esc(tr('lookup.fullColAsOf'))}</th>
      <th>${esc(tr('lookup.fullColStatements'))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>`;
}

// -- formatted answer --

/**
 * The formatted answer: a colored verdict, then the company.
 *
 * Meaning is decided by `src/lib/lookupView.ts` and markup by `src/lib/lookupHtml.ts`, shared with
 * the site. This file only provides translations and date formatting.
 */
function formattedPane(view: LookupView | AllView | undefined, tr: ReturnType<typeof t>, locale: Locale): string {
  return view ? renderAnswer(view, answerContext(tr, locale)) : '';
}

/**
 * The two views of an answer behind a switch: formatted first, raw envelope second.
 *
 * Radios and `~`, no script. `group` makes ids and radio names unique, so the audit trail can have
 * one per row.
 */
function answerTabs(options: {
  group: string;
  title: string;
  formatted: string;
  json: string;
  tr: ReturnType<typeof t>;
}): string {
  const { group, title, formatted, json, tr } = options;
  return `<input type="radio" id="${esc(group)}-formatted" name="${esc(group)}" value="formatted" class="segmented__radio" checked>
    <input type="radio" id="${esc(group)}-json" name="${esc(group)}" value="json" class="segmented__radio">
    <div class="segmented" role="group" aria-label="${esc(title)}">
      <label class="segmented__item segmented__item--formatted" for="${esc(group)}-formatted">${esc(tr('lookup.tabFormatted'))}</label>
      <label class="segmented__item segmented__item--json" for="${esc(group)}-json">${esc(tr('lookup.tabJson'))}</label>
    </div>
    <div class="pane pane--formatted">${formatted}</div>
    <div class="pane pane--json">${json}</div>`;
}

/**
 * The console side of the shared template: i18next for the `fmt` group and the console's date
 * formatters. A missing key returns the key itself, which the template uses to fall back to a
 * generic heading.
 */
function answerContext(tr: ReturnType<typeof t>, locale: Locale): AnswerContext {
  return {
    label: (key) => tr(`fmt.${key}`),
    day: (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? value : formatDate(parsed, locale);
    },
    instant: (value) => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : formatDateTime(parsed, locale);
    },
  };
}

type SourceStatusLabel =
  | 'fullStatusFound'
  | 'fullStatusStored'
  | 'fullStatusNotFound'
  | 'fullStatusNotRegistered'
  | 'fullStatusUnavailable'
  | 'fullStatusError';

/** How the register is reached, in one word. */
const KIND_LABEL: Record<string, string> = {
  bulk: 'fullKindBulk',
  live: 'fullKindLive',
  both: 'fullKindBoth',
};

const SOURCE_STATUS_UNKNOWN = { label: 'fullStatusError', tone: 'badge' } as const;

/** Same tones as the audit trail. */
const SOURCE_STATUS: Record<string, { label: SourceStatusLabel; tone: string }> = {
  found: { label: 'fullStatusFound', tone: 'badge badge--ok' },
  // No call made: the stored statement was recent enough.
  stored: { label: 'fullStatusStored', tone: 'badge badge--ok' },
  'not-found': { label: 'fullStatusNotFound', tone: 'badge' },
  'not-registered': { label: 'fullStatusNotRegistered', tone: 'badge badge--warn' },
  unavailable: { label: 'fullStatusUnavailable', tone: 'badge badge--danger' },
  error: { label: 'fullStatusError', tone: 'badge badge--danger' },
};

// -- keys --

export interface KeysData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  keys: KeyRow[];
  requestsByKey: Map<string, number>;
}

/** The keys page. */
export function keysPage(data: KeysData): string {
  const { locale } = data;
  const tr = t(locale);

  const table = `<div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('overview.keyName'))}</th>
      <th>${esc(tr('overview.keyValue'))}</th>
      <th>${esc(tr('overview.keyRequests'))}</th>
      <th>${esc(tr('overview.keyCreated'))}</th>
      <th>${esc(tr('overview.keyLastUsed'))}</th>
      <th><span class="sr-only">${esc(tr('overview.keyRevoke'))}</span></th>
    </tr></thead>
    <tbody>${data.keys.map((key) => keyRow(key, data, tr, locale)).join('')}</tbody>
  </table>
  </div>`;

  const create = `<h3>${esc(tr('overview.keyCreateTitle'))}</h3>
    <p class="muted">${esc(tr('overview.keyCreateLead'))}</p>
    <form method="post" action="/keys" class="row">
      <div class="field">
        <label for="name">${esc(tr('overview.keyName'))}</label>
        <input id="name" name="name" type="text" maxlength="64" required placeholder="${esc(tr('overview.keyCreatePlaceholder'))}">
      </div>
      <button class="btn" type="submit">${esc(tr('overview.keyCreateSubmit'))}</button>
    </form>`;

  const body = `
${pageHead(tr('overview.keysTitle'), tr('overview.keysLead'))}
${panel({ body: table, foot: create, flush: true })}
<p class="dim">${esc(tr('overview.revocationDelay'))}</p>`;

  return layout({
    locale,
    title: tr('overview.keysTitle'),
    nav: {
      current: 'keys',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

function keyRow(row: KeyRow, data: KeysData, tr: ReturnType<typeof t>, locale: Locale): string {
  const requests = data.requestsByKey.get(row.id.toString()) ?? 0;
  const revoked = row.revokedAt !== null;

  // Shown masked even while live: a full key is 40-odd monospace characters and would widen the
  // table. The prefix gives the environment and the last four identify the key. `data-copy-value`
  // holds the real key for copying.
  //
  // A key that cannot be recovered looks the same but has no copy button, and a title explains why.
  const key = row.copyable
    ? `<span class="copywrap copywrap--inline" data-copy data-copy-value="${esc(row.key)}" data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
         <code class="key key--copy" data-copy-source tabindex="0" role="button" title="${esc(tr('overview.copy'))}">${esc(maskedKey(row.prefix, row.last4))}</code>
       </span>`
    : `<code class="key key--masked" title="${esc(tr('overview.keyUnrecoverable'))}">${esc(row.key)}</code>`;

  return `<tr${revoked ? ' class="is-revoked"' : ''}>
    <td>${esc(row.name)}${revoked ? ` <span class="badge">${esc(tr('overview.keyRevoked'))}</span>` : ''}</td>
    <td>${key}</td>
    <td>${esc(formatNumber(requests, locale))}</td>
    <td>${esc(formatDate(row.createdAt, locale))}</td>
    <td>${row.lastUsedAt ? esc(formatDate(row.lastUsedAt, locale)) : `<span class="dim">${esc(tr('overview.keyNever'))}</span>`}</td>
    <td>${
      revoked
        ? ''
        : `<form method="post" action="/keys/${row.id}/revoke" ${confirmSubmit(tr('overview.keyRevokeConfirm'))}>
             <button class="btn btn--danger btn--sm" type="submit">${esc(tr('overview.keyRevoke'))}</button>
           </form>`
    }</td>
  </tr>`;
}

// -- audit --

export interface AuditData {
  locale: Locale;
  email: string;
  /** The normalized search. Empty for the plain listing. */
  query: string;
  /** Set when the query is not a valid VAT number. The listing still renders. */
  queryError: boolean;
  /** Answers for `query`, newest first. Empty when nothing was searched. */
  matches: AuditRow[];
  /** The account's recent calls, newest first. */
  recent: AuditRow[];
  /** Public id of the last row on this page, absent when there is no next page. */
  olderThan?: string;
  plan: 'free' | 'pro';
  /** Retention: rows kept on the free plan, days on the paid plan. */
  retentionKeep: number;
  retentionDays: number;
  /** Same rule as elsewhere: no Stripe, no upgrade button. */
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  /** The API base URL, for the sample command. */
  apiBaseUrl: string;
  /** A live key for it, when one can be recovered. */
  sampleKey?: string;
}

/**
 * The audit trail: what the API answered about a number, and when.
 *
 * Search first, then the recent listing. Answers render as blocks, since a JSON body never fits a
 * table cell.
 *
 * The retention line is always shown, even when the page is empty.
 */
export function auditPage(data: AuditData): string {
  const { locale } = data;
  const tr = t(locale);

  // No panel heading: the field label and page title say enough.
  const search = panel({
    body: `<form method="get" action="/audits" class="row">
    <div class="field">
      <label for="q">${esc(tr('audit.searchLabel'))}</label>
      <input id="q" name="q" type="text" maxlength="20" value="${esc(data.query)}" placeholder="${esc(tr('audit.searchPlaceholder'))}" autocomplete="off" spellcheck="false">
    </div>
    <button class="btn" type="submit">${esc(tr('audit.searchSubmit'))}</button>
  </form>
  ${data.queryError ? `<p class="notice notice--error" style="margin:1rem 0 0">${esc(tr('audit.invalidNumber'))}</p>` : ''}`,
  });

  const results =
    data.query && !data.queryError
      ? panel({
          title: tr('audit.resultsTitle', { vat: data.query }),
          flush: data.matches.length > 0,
          body:
            data.matches.length > 0
              ? callsTable(data.matches, tr, locale)
              : `<p class="dim">${esc(tr('audit.resultsEmpty', { vat: data.query }))}</p>`,
        })
      : '';

  const listing =
    data.recent.length > 0
      ? callsTable(data.recent, tr, locale)
      : `<div class="panel__body"><p class="dim" style="margin:0">${esc(tr('audit.recentEmpty'))}</p></div>`;

  const older =
    data.olderThan !== undefined
      ? `<a href="/audits?before=${encodeURIComponent(data.olderThan)}">${esc(tr('audit.older'))} →</a>`
      : '';

  const recent = `<section class="panel panel--flush">
  <div class="panel__head">
    <h2>${esc(tr('audit.recentTitle'))}</h2>
    ${older}
  </div>
  ${listing}
  ${retentionNote(data, tr)}
</section>`;

  const body = `
${pageHead(tr('audit.title'), tr('audit.lead'))}
${search}
${results}
${recent}
${apiPanel(data, tr)}`;

  return layout({
    locale,
    title: tr('audit.title'),
    nav: {
      current: 'audit',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/** What this account keeps, stated on the page so a short history is not mistaken for data loss. */
function retentionNote(data: AuditData, tr: ReturnType<typeof t>): string {
  if (data.plan === 'pro') {
    return `<div class="panel__foot"><p class="dim" style="margin:0">${esc(tr('audit.retentionPro', { count: data.retentionDays }))}</p></div>`;
  }

  const text = tr('audit.retentionFree', { count: data.retentionKeep, days: data.retentionDays });
  return `<div class="panel__foot">
    <p class="muted">${esc(text)}</p>
    ${
      data.stripeReady
        ? `<form method="post" action="/billing/checkout">
        <button class="btn btn--sm" type="submit">${esc(tr('audit.upgrade'))}</button>
      </form>`
        : ''
    }
  </div>`;
}

/**
 * The same trail over HTTP. Same text for both plans. Uses `sampleKey`, so the command can be run as
 * is.
 */
function apiPanel(data: AuditData, tr: ReturnType<typeof t>): string {
  const key = data.sampleKey ?? '$VATLAS_KEY';
  return panel({
    title: tr('audit.apiTitle'),
    lead: tr('audit.apiLead'),
    body: `<div class="copywrap" data-copy data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
    <pre class="code" data-copy-source>curl <span class="str">"${esc(data.apiBaseUrl)}/v1/audit?vatNumber=FR95884831538"</span> \\
  <span class="flag">-H</span> <span class="str">"Authorization: Bearer ${esc(key)}"</span></pre>
  </div>
  <p class="dim" style="margin:1rem 0 0">${esc(tr('audit.apiFields'))}</p>
  <p style="margin:.5rem 0 0"><a href="${config.siteUrl}/${data.locale}/docs/#audit">${esc(tr('audit.apiDocs'))} →</a></p>`,
  });
}

/**
 * Date and time to the minute.
 *
 * Rendered in UTC and labelled so. The `[data-local]` handler in {@link SCRIPTS} converts it to the
 * browser's time zone. The `datetime` attribute holds the exact instant.
 */
function localTime(at: Date, locale: Locale): string {
  return `<time class="dim" datetime="${esc(at.toISOString())}" data-local>${esc(formatDateTime(at, locale))}</time>`;
}

/**
 * One recorded answer, shown with the same two tabs and template as the lookup page.
 *
 * The switch needs page-unique ids, so `publicId` is used (the internal id never leaves the
 * database).
 */
function entryCard(row: AuditRow, tr: ReturnType<typeof t>, locale: Locale): string {
  const facts = [
    row.source ? `<span><b>${esc(tr('audit.colSource'))}</b> ${esc(row.source)}</span>` : '',
    row.sourceDate
      ? `<span><b>${esc(tr('audit.sourceDate'))}</b> ${esc(formatDate(row.sourceDate, locale))}</span>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const answer = answerTabs({
    group: `entry-${row.publicId}`,
    title: tr('audit.showResponse'),
    formatted: renderAnswer(auditView(row), answerContext(tr, locale)),
    json: `<pre class="code">${esc(JSON.stringify(row.response, null, 2))}</pre>`,
    tr,
  });

  return `<article class="entry">
  <div class="entry__head">
    ${resultBadge(row, tr)}
    ${localTime(row.fetchedAt, locale)}
    <code class="key">${esc(row.vatNumber)}</code>
    ${sourceLabels(row)}
  </div>
  ${row.companyName ? `<p class="entry__name">${esc(row.companyName)}</p>` : ''}
  ${facts ? `<div class="entry__facts">${facts}</div>` : ''}
  ${answer}
</article>`;
}

/** The calls listing, used by the recent panel and search results. */
function callsTable(rows: AuditRow[], tr: ReturnType<typeof t>, locale: Locale): string {
  return `<div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('audit.colDate'))}</th>
      <th>${esc(tr('audit.colVat'))}</th>
      <th>${esc(tr('audit.colCompany'))}</th>
      <th>${esc(tr('audit.colSource'))}</th>
      <th>${esc(tr('audit.colStatus'))}</th>
      <th><span class="sr-only">${esc(tr('audit.colAction'))}</span></th>
    </tr></thead>
    <tbody>${rows.map((row) => recentRow(row, tr, locale)).join('')}</tbody>
  </table>
  </div>`;
}

/**
 * The row reads: when, which number, which company, which register, then the verdict at the end.
 *
 * The row opens this answer only. The link is in its own last column; the whole row forwards
 * clicks to it, and the link serves keyboards and screen readers.
 */
function recentRow(row: AuditRow, tr: ReturnType<typeof t>, locale: Locale): string {
  return `<tr class="row-link" data-href="/audits/${esc(encodeURIComponent(row.publicId))}">
    <td>${localTime(row.fetchedAt, locale)}</td>
    <td class="mono">${esc(row.vatNumber)}</td>
    <td>${row.companyName ? `<span class="row-company" title="${esc(row.companyName)}">${esc(row.companyName)}</span>` : '<span class="dim">-</span>'}</td>
    <td>${row.source ? esc(row.source) : '<span class="dim">-</span>'}</td>
    <td class="row-result">${resultBadge(row, tr)}</td>
    ${openCell(row, tr)}
  </tr>`;
}

/** The link at the end of a row, also the target of the row's click. */
function openCell(row: AuditRow, tr: ReturnType<typeof t>): string {
  return `<td class="row-action"><a href="/audits/${encodeURIComponent(row.publicId)}">${esc(tr('audit.open'))} →</a></td>`;
}

export interface AuditEntryData {
  locale: Locale;
  email: string;
  /** The answer this page is about. */
  row: AuditRow;
  /** Other answers for the same number, newest first, one page. */
  history: AuditRow[];
  /** Public id to pass as `before`, absent when there is no older page. */
  olderThan?: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
}

/**
 * One recorded answer on its own page, with the rest of the number's history listed below as
 * dates.
 *
 * The history includes this row, marked rather than removed, so pages keep their size and the
 * cursor stays correct.
 */
export function auditEntryPage(data: AuditEntryData): string {
  const { locale, row } = data;
  const tr = t(locale);

  const entry = panel({
    title: tr('audit.entryTitle'),
    aside: `<a href="/audits">← ${esc(tr('audit.back'))}</a>`,
    flush: true,
    body: entryCard(row, tr, locale),
  });

  const older =
    data.olderThan !== undefined
      ? `<a href="/audits/${encodeURIComponent(row.publicId)}?before=${encodeURIComponent(data.olderThan)}">${esc(tr('audit.older'))} →</a>`
      : '';

  const history = `<section class="panel panel--flush">
  <div class="panel__head">
    <h2>${esc(tr('audit.historyTitle', { vat: row.vatNumber }))}</h2>
    ${older}
  </div>
  ${
    data.history.length > 0
      ? `<div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('audit.colDate'))}</th>
      <th>${esc(tr('audit.colCompany'))}</th>
      <th>${esc(tr('audit.colSource'))}</th>
      <th>${esc(tr('audit.colStatus'))}</th>
      <th><span class="sr-only">${esc(tr('audit.colAction'))}</span></th>
    </tr></thead>
    <tbody>${data.history.map((entryRow) => historyRow(entryRow, row.publicId, tr, locale)).join('')}</tbody>
  </table>
  </div>`
      : `<div class="panel__body"><p class="dim" style="margin:0">${esc(tr('audit.historyEmpty'))}</p></div>`
  }
</section>`;

  const body = `
${pageHead(row.vatNumber, tr('audit.entryLead'))}
${entry}
${history}`;

  return layout({
    locale,
    title: `${row.vatNumber} - ${tr('audit.title')}`,
    nav: {
      current: 'audit',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/** One line of the number's history. The current row is marked, not linked. */
function historyRow(row: AuditRow, currentId: string, tr: ReturnType<typeof t>, locale: Locale): string {
  const current = row.publicId === currentId;
  return `<tr${current ? ' aria-current="true"' : ` class="row-link" data-href="/audits/${esc(encodeURIComponent(row.publicId))}"`}>
    <td>${localTime(row.fetchedAt, locale)}</td>
    <td>${row.companyName ? `<span class="row-company" title="${esc(row.companyName)}">${esc(row.companyName)}</span>` : '<span class="dim">-</span>'}</td>
    <td>${row.source ? esc(row.source) : '<span class="dim">-</span>'}</td>
    <td class="row-result">${resultBadge(row, tr)}</td>
    <td class="row-action">${current ? `<span class="dim">${esc(tr('audit.thisEntry'))}</span>` : `<a href="/audits/${encodeURIComponent(row.publicId)}">${esc(tr('audit.open'))} →</a>`}</td>
  </tr>`;
}

/** The status as the caller saw it, read from `error_code`: the three misses are different answers. */
function statusBadge(row: AuditRow, tr: ReturnType<typeof t>): string {
  const { label, tone } = STATUS_LABELS[row.errorCode ?? 'OK'] ?? FOUND;
  return `<span class="${tone}">${esc(tr(`audit.${label}`))}</span>`;
}

/**
 * The result column: the verdict and its tags.
 *
 * A plain lookup has one verdict, rendered by `statusBadge`. A lookup-all has one per source and
 * its flat columns always say 200, so it only shows its tag. The verdicts are in the stored
 * response.
 */
function resultBadge(row: AuditRow, tr: ReturnType<typeof t>): string {
  // `full` is the old name of `all`. Audit rows keep what was recorded, and both read the same.
  const verdict = row.kind === 'all' || row.kind === 'full' ? '' : statusBadge(row, tr);
  const tags = resultTags(row, tr);
  return [verdict, tags].filter(Boolean).join(' ') || '<span class="dim">-</span>';
}

/**
 * What kind of call this row was, and whether it carries a proof.
 *
 * Tags rather than columns, which would be empty on most rows.
 *
 * The proof tag reads the stored response, not `kind`: a plain lookup answered by VIES also has a
 * consultation number, and a lookup-all can have several.
 */
function resultTags(row: AuditRow, tr: ReturnType<typeof t>): string {
  return [
    row.kind === 'all' || row.kind === 'full' ? `<span class="badge">${esc(tr('audit.tagAll'))}</span>` : '',
    rowHasProof(row) ? `<span class="badge badge--ok">${esc(tr('audit.tagProof'))}</span>` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether the answer has a consultation number anywhere.
 *
 * The flat `proof` column first (indexed, free), then the stored envelope, since the column holds
 * at most one proof.
 */
function rowHasProof(row: AuditRow): boolean {
  return row.proof !== null || hasProof(auditView(row));
}

/** The stored envelope as an answer, same view as the lookup page. */
function auditView(row: AuditRow): LookupView | AllView {
  return row.kind === 'all' || row.kind === 'full'
    ? presentAll(row.response)
    : presentLookup(row.httpStatus, row.response);
}

type StatusLabel = 'statusFound' | 'statusNotRegistered' | 'statusUnavailable' | 'statusNotFound' | 'statusNoProof';

const FOUND = { label: 'statusFound', tone: 'badge badge--ok' } as const;

const STATUS_LABELS: Record<string, { label: StatusLabel; tone: string }> = {
  OK: FOUND,
  VAT_NOT_REGISTERED: { label: 'statusNotRegistered', tone: 'badge badge--warn' },
  SOURCE_UNAVAILABLE: { label: 'statusUnavailable', tone: 'badge badge--danger' },
  // A proof was asked and VIES issued none. Its own label: the source may have answered.
  PROOF_UNAVAILABLE: { label: 'statusNoProof', tone: 'badge badge--danger' },
  COMPANY_NOT_FOUND: { label: 'statusNotFound', tone: 'badge' },
};

/** The registers the answer was built from. A lookup-all lists all of them. */
function sourceLabels(row: AuditRow): string {
  if (row.sources.length === 0) return '';
  return `<span class="dim">${esc(row.sources.join(', '))}</span>`;
}

// -- billing --

/** The invoice address and the VAT number that decides the tax treatment. */
export interface BillingProfile {
  companyName: string;
  vatNumber: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  country: string;
}

/**
 * Whether the profile has every field Stripe Tax needs. The VAT number is not required: most
 * customers have none.
 */
export function isProfileComplete(profile: BillingProfile): boolean {
  return (['companyName', 'line1', 'postalCode', 'city', 'country'] as const).every(
    (field) => profile[field].trim() !== '',
  );
}

/**
 * The company details form.
 *
 * On the account page, and on the plan page only while they are missing, since checkout needs
 * them.
 *
 * `from` is where the save returns to: one of two fixed values, never the browser's, to avoid an
 * open redirect.
 */
function profilePanel(locale: Locale, profile: BillingProfile, from: 'account' | 'billing'): string {
  const tr = t(locale);

  const field = (
    name: keyof BillingProfile,
    label: string,
    required: boolean,
    hint?: string,
    placeholder?: string,
    iconTitle?: string,
  ) => `
    <div class="field">
      <label for="${name}">${esc(label)}${iconTitle ? ` <span class="field__icon" title="${esc(iconTitle)}" aria-hidden="true">&#x2728;</span>` : ''}</label>
      <input id="${name}" name="${name}" type="text" value="${esc(profile[name])}"${required ? ' required' : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>
      ${hint ? `<p class="dim">${esc(hint)}</p>` : ''}
    </div>`;

  return panel({
    title: tr('billing.detailsTitle'),
    body: `<form method="post" action="/billing">
    <input type="hidden" name="from" value="${from}">
    ${field('vatNumber', tr('billing.vatNumber'), false, tr('billing.vatNumberHint'), tr('billing.vatNumberPlaceholder'), tr('billing.vatLookupIconTitle'))}
    <p id="vat-lookup-status" class="dim" aria-live="polite"></p>
    <div class="grid2">
      ${field('companyName', tr('billing.companyName'), true)}
      ${field('country', tr('billing.country'), true)}
    </div>
    ${field('line1', tr('billing.line1'), true)}
    ${field('line2', tr('billing.line2'), false)}
    <div class="grid2">
      ${field('postalCode', tr('billing.postalCode'), true)}
      ${field('city', tr('billing.city'), true)}
    </div>
    <button class="btn" type="submit">${esc(tr('billing.save'))}</button>
  </form>
  ${vatLookupScript(locale)}`,
  });
}

/**
 * Fills the address from the VAT number, with the same in-process `lookupVat` as the API (no key,
 * no quota). Runs on `blur` and never overwrites filled fields.
 */
function vatLookupScript(locale: Locale): string {
  const tr = t(locale);
  return `
    <script>
    (function () {
      var input = document.getElementById('vatNumber');
      var status = document.getElementById('vat-lookup-status');
      if (!input || !status) return;
      var MESSAGES = {
        checking: ${JSON.stringify(tr('billing.vatLookupChecking'))},
        notFound: ${JSON.stringify(tr('billing.vatLookupNotFound'))},
        rateLimited: ${JSON.stringify(tr('billing.vatLookupRateLimited'))},
        failed: ${JSON.stringify(tr('billing.vatLookupFailed'))}
      };
      var FIELDS = ['companyName', 'line1', 'line2', 'postalCode', 'city', 'country'];

      input.addEventListener('blur', function () {
        var value = input.value.trim();
        if (value.length < 4) return;
        status.textContent = MESSAGES.checking;

        fetch('/billing/vat-lookup/' + encodeURIComponent(value))
          .then(function (res) {
            if (res.status === 429) { status.textContent = MESSAGES.rateLimited; return null; }
            if (res.status === 404) { status.textContent = MESSAGES.notFound; return null; }
            if (!res.ok) { status.textContent = MESSAGES.failed; return null; }
            return res.json();
          })
          .then(function (body) {
            if (!body) return;
            status.textContent = '';
            FIELDS.forEach(function (name) {
              var target = document.getElementById(name);
              if (target && body.data[name] !== undefined) target.value = body.data[name];
            });
          })
          .catch(function () { status.textContent = MESSAGES.failed; });
      });
    })();
    </script>`;
}

export interface BillingData {
  locale: Locale;
  email: string;
  plan: 'free' | 'pro';
  profile: BillingProfile;
  quota: number;
  /** Plan limits besides the quota: monitors allowed and used. */
  monitorsUsed: number;
  monitorsLimit: number;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  /** Set when the subscription is scheduled to stop. The plan stays paid until then. */
  cancelAt?: Date;
  currentPeriodEnd?: Date;
  saved?: boolean;
  error?: string;
}

/**
 * The plan, and the company details checkout needs, only while they are missing. Otherwise they
 * are on the account page.
 */
export function billingPage(data: BillingData): string {
  const { locale } = data;
  const tr = t(locale);
  const planName = data.plan === 'pro' ? tr('billing.planPro') : tr('billing.planFree');

  const plan = panel({
    title: tr('billing.currentPlan'),
    aside: `<span class="badge">${esc(planName)}</span>`,
    body: `<p class="stat__value">${esc(formatNumber(data.quota, locale))} <small>${esc(tr('billing.requestsPerMonth'))}</small></p>
  <p class="stat__value" style="margin-top:.5rem">${esc(formatNumber(data.monitorsLimit, locale))} <small>${esc(tr('billing.monitorsIncluded'))}</small></p>
  <p class="dim">${esc(tr('billing.monitorsUsed', { used: String(data.monitorsUsed), limit: String(data.monitorsLimit) }))}</p>
  ${
    // A cancelled subscription stays active and paid until the end of the period, so the date is shown.
    data.cancelAt
      ? `<p class="notice">${esc(tr('billing.cancelled'))} ${esc(tr('billing.cancelledUntil', { date: formatDate(data.cancelAt, locale) }))}</p>`
      : ''
  }
  ${planButton(locale, data) || `<p class="dim">${esc(tr('billing.unavailable'))}</p>`}`,
  });

  const body = `
${pageHead(tr('billing.title'), tr('billing.lead'))}
${data.saved ? `<div class="notice"><p>${esc(tr('billing.saved'))}</p></div>` : ''}
${data.error ? `<div class="notice notice--error"><p>${esc(data.error)}</p></div>` : ''}
${plan}
${isProfileComplete(data.profile) ? '' : profilePanel(locale, data.profile, 'billing')}`;

  return layout({
    locale,
    title: tr('billing.title'),
    nav: {
      current: 'billing',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

// -- account --

export interface AccountData {
  locale: Locale;
  email: string;
  createdAt: Date;
  plan: 'free' | 'pro';
  quota: number;
  /** `accounts.status`, `active` for anyone who can see this page. */
  status: string;
  /** Number of keys not revoked. */
  activeKeys: number;
  /** The company details, edited on this page. */
  profile: BillingProfile;
  /** Set after saving from this page. */
  saved?: boolean;
  /** Same rule as elsewhere: no Stripe, no invoices entry. */
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  /** Latest Stripe subscription status: active, past_due, canceled... */
  subscriptionStatus?: string;
  currentPeriodEnd?: Date;
  /** Set when the subscription is scheduled to stop. The plan stays paid until then. */
  cancelAt?: Date;
  termsVersion?: string;
  termsAcceptedAt?: Date;
  /** When the address was verified, absent otherwise. */
  emailVerifiedAt?: Date;
  /** False for an old magic-link account without password. */
  hasPassword: boolean;
  passwordChangedAt?: Date;
  /** Only set by a refused erasure, which also opens the danger zone. */
  error?: string;
  /** A success notice at the top of the page (verified, password changed...). */
  notice?: string;
  /** An error notice at the same place (expired verification link...). */
  alert?: string;
  /** Set by a refused password change, shown inside that form. */
  passwordError?: string;
}

/**
 * The account page: address, creation date, plan and subscription, accepted Terms version, and the
 * editable company details. Other facts are read-only.
 *
 * Erasure is at the bottom, collapsed.
 */
export function accountPage(data: AccountData): string {
  const { locale } = data;
  const tr = t(locale);

  const fact = (label: string, value: unknown) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  const facts = [
    fact(tr('account.email'), data.email),
    `<div><dt>${esc(tr('account.emailVerification'))}</dt><dd>${verificationFact(data)}</dd></div>`,
    fact(tr('account.createdAt'), formatDate(data.createdAt, locale)),
    fact(tr('account.status'), data.status === 'active' ? tr('account.statusActive') : data.status),
    fact(tr('account.plan'), data.plan === 'pro' ? tr('billing.planPro') : tr('billing.planFree')),
    // The label says "each month", so the number is enough.
    fact(tr('account.quota'), formatNumber(data.quota, locale)),
    fact(tr('account.subscription'), subscriptionFact(data)),
    fact(tr('account.keysActive'), formatNumber(data.activeKeys, locale)),
    fact(tr('account.language'), languageName(locale)),
    fact(tr('account.terms'), termsFact(data)),
  ].join('');

  const body = `
${pageHead(tr('account.title'), tr('account.lead'))}
${data.saved ? `<div class="notice"><p>${esc(tr('billing.saved'))}</p></div>` : ''}
${data.notice ? `<div class="notice"><p>${esc(data.notice)}</p></div>` : ''}
${data.alert ? `<div class="notice notice--error"><p>${esc(data.alert)}</p></div>` : ''}
${panel({ title: tr('account.detailsTitle'), body: `<dl class="facts">${facts}</dl>` })}
${passwordPanel(data)}
${profilePanel(locale, data.profile, 'account')}
${dangerZone(data)}`;

  return layout({
    locale,
    title: tr('account.title'),
    nav: {
      current: 'account',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/** Verified with its date, or not yet with the resend button. */
function verificationFact(data: AccountData): string {
  const tr = t(data.locale);
  if (data.emailVerifiedAt) {
    return esc(tr('account.emailVerifiedOn', { date: formatDate(data.emailVerifiedAt, data.locale) }));
  }
  return `${esc(tr('account.emailUnverified'))}
    <form method="post" action="/verify-email/resend" class="inline-form">
      <button class="btn btn--ghost btn--sm" type="submit">${esc(tr('verify.resend'))}</button>
    </form>`;
}

/**
 * The current password is required, so an open session is not enough to lock the holder out. Old
 * magic-link accounts have none, and are told they are setting one.
 */
function passwordPanel(data: AccountData): string {
  const { locale } = data;
  const tr = t(locale);
  const lead = data.hasPassword
    ? data.passwordChangedAt
      ? tr('password.lastChanged', { date: formatDate(data.passwordChangedAt, locale) })
      : undefined
    : tr('password.noneYet');
  const current = data.hasPassword
    ? passwordField(locale, { name: 'current', label: tr('password.currentLabel'), autocomplete: 'current-password' })
    : '';

  return panel({
    title: data.hasPassword ? tr('password.changeTitle') : tr('password.setTitle'),
    lead,
    body: `${data.passwordError ? `<div class="notice notice--error"><p>${esc(data.passwordError)}</p></div>` : ''}
    <form method="post" action="/account/password">
      <input type="email" name="email" autocomplete="username" value="${esc(data.email)}" hidden>
      ${current}
      ${passwordField(locale, { name: 'password', label: tr('password.newLabel'), autocomplete: 'new-password', hint: true })}
      <button class="btn" type="submit">${esc(data.hasPassword ? tr('password.changeSubmit') : tr('password.setSubmit'))}</button>
    </form>`,
  });
}

/** The subscription, with its end date when cancelled. */
function subscriptionFact(data: AccountData): string {
  const tr = t(data.locale);
  if (!data.subscriptionStatus) return tr('account.subscriptionNone');
  const date = data.cancelAt
    ? tr('account.subscriptionEnds', { date: formatDate(data.cancelAt, data.locale) })
    : data.currentPeriodEnd
      ? tr('account.subscriptionRenews', { date: formatDate(data.currentPeriodEnd, data.locale) })
      : '';
  return date ? `${data.subscriptionStatus} - ${date}` : data.subscriptionStatus;
}

/**
 * Which Terms version was accepted and when. The Terms promise this can be provided on request.
 * Accounts predating the checkbox say so explicitly.
 */
function termsFact(data: AccountData): string {
  const tr = t(data.locale);
  if (!data.termsVersion || !data.termsAcceptedAt) return tr('account.termsUnknown');
  return tr('account.termsAcceptedOn', {
    version: data.termsVersion,
    date: formatDate(data.termsAcceptedAt, data.locale),
  });
}

/**
 * Erasure (GDPR Article 17), collapsed in a `<details>`. Opened when the last attempt was refused,
 * so the reason is visible.
 *
 * While a subscription is live, an explanation replaces the form.
 */
function dangerZone(data: AccountData): string {
  const { locale } = data;
  const tr = t(locale);
  const liveSubscription =
    data.plan === 'pro' ||
    (data.subscriptionStatus !== undefined && !['canceled', 'incomplete_expired'].includes(data.subscriptionStatus));

  const form = liveSubscription
    ? `<p class="notice">${esc(tr('account.deleteBlockedPaid', { email: config.contact.email }))}</p>`
    : `<form method="post" action="/account/delete"
             ${confirmSubmit(tr('account.deleteConfirmPrompt'))}>
        <div class="field">
          <label for="confirm">${esc(tr('account.deleteConfirmLabel', { word: tr('account.deleteConfirmWord') }))}</label>
          <input id="confirm" name="confirm" type="text" required autocomplete="off"
                 placeholder="${esc(tr('account.deleteConfirmWord'))}">
        </div>
        <button class="btn btn--danger" type="submit">${esc(tr('account.deleteSubmit'))}</button>
      </form>`;

  return `<details class="panel panel--danger panel--fold"${data.error ? ' open' : ''}>
  <summary>${esc(tr('account.dangerZone'))}</summary>
  <div class="panel__body">
    <h2>${esc(tr('account.deleteTitle'))}</h2>
    <p class="muted">${esc(tr('account.deleteLead'))}</p>
    <ul class="plain">
      <li>${esc(tr('account.deleteWhatGoes'))}</li>
      <li>${esc(tr('account.deleteWhatStays'))}</li>
    </ul>
    ${data.error ? `<div class="notice notice--error"><p>${esc(data.error)}</p></div>` : ''}
    ${form}
  </div>
</details>`;
}

/** Shown once after erasure, to a visitor without session. */
export function accountDeletedPage(locale: Locale): string {
  const tr = t(locale);
  return layout({
    locale,
    title: tr('account.deleteDoneTitle'),
    body: `<div class="center">
      <h1>${esc(tr('account.deleteDoneTitle'))}</h1>
      <p class="muted">${esc(tr('account.deleteDoneLead'))}</p>
    </div>`,
  });
}

// -- personal data --

/** Where a category is edited, when it is edited on another page. */
const SECTION_LINK: Partial<Record<SectionId, { href: string; label: string }>> = {
  identity: { href: '/account', label: 'nav.myAccount' },
  consent: { href: '/account', label: 'nav.myAccount' },
  billing: { href: '/account', label: 'nav.myAccount' },
  payment: { href: '/billing', label: 'nav.billing' },
  keys: { href: '/keys', label: 'nav.keys' },
  callbacks: { href: '/monitor', label: 'nav.monitors' },
  monitors: { href: '/monitor', label: 'nav.monitors' },
  async: { href: '/lookup-async', label: 'nav.asyncLookups' },
  deliveries: { href: '/monitor', label: 'nav.monitors' },
  audit: { href: '/audits', label: 'nav.audit' },
  usage: { href: '/', label: 'nav.dashboard' },
};

export interface PersonalDataPageData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  record: PersonalDataRecord;
  /** What the last erasure did, when this render follows one. */
  notice?: string;
  error?: string;
}

/**
 * Everything held about the account holder: the values, why each is held, on what legal basis, for
 * how long, and what is done with it. Then the two exports, and an erase button under each category
 * that allows it.
 *
 * Built from {@link collectPersonalData}'s inventory, so a new table with `user_id` appears here
 * automatically. The prose (purpose, basis) is in `locales/*.json` by section id, and a missing one
 * throws at render.
 */
export function personalDataPage(data: PersonalDataPageData): string {
  const { locale, record } = data;
  const tr = t(locale);
  const urls = legalUrls(locale);

  const body = `
${pageHead(tr('data.title'), tr('data.lead'))}
${data.error ? `<div class="notice notice--error"><p>${esc(data.error)}</p></div>` : ''}
${data.notice ? `<div class="notice"><p>${esc(data.notice)}</p></div>` : ''}
${panel({
  title: tr('data.exportTitle'),
  lead: tr('data.exportLead'),
  body: `<p class="dim">${esc(tr('data.exportNote', { cap: EXPORT_ROW_CAP }))}</p>
  <div class="actions">
    <a class="btn" href="/data/export.json" download>${esc(tr('data.exportJson'))}</a>
    <a class="btn btn--ghost" href="/data/export.txt" download>${esc(tr('data.exportText'))}</a>
  </div>`,
})}
${tierBlocks(record, locale)}
${panel({
  title: tr('data.rightsTitle'),
  lead: tr('data.rightsLead'),
  body: `<ul class="plain">
    <li>${esc(tr('data.rightAccess'))}</li>
    <li>${esc(tr('data.rightRectify'))}</li>
    <li>${esc(tr('data.rightErase'))}</li>
    <li>${esc(tr('data.rightPortability'))}</li>
    <li>${esc(tr('data.rightObject'))}</li>
    <li>${esc(tr('data.rightComplain'))}</li>
  </ul>
  <div class="actions">
    <a class="btn btn--ghost btn--sm" href="${esc(urls.privacy)}" target="_blank" rel="noopener noreferrer">${esc(tr('data.privacyPolicy'))}</a>
    <a class="btn btn--ghost btn--sm" href="mailto:${esc(config.contact.email)}">${esc(config.contact.email)}</a>
    <a class="btn btn--danger btn--sm" href="/account">${esc(tr('data.deleteAccount'))}</a>
  </div>`,
})}`;

  return layout({
    locale,
    title: tr('data.title'),
    nav: {
      current: 'data',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/**
 * The three blocks, each with its heading. The inventory collects everything reachable from an
 * account; sorting it puts actual personal data first, above contract terms, timestamps and other
 * companies' names.
 */
function tierBlocks(record: PersonalDataRecord, locale: Locale): string {
  const tr = t(locale);
  const sections = pageSections(record);

  return TIERS.map((tier: Tier) => {
    const own = sections.filter((section) => SECTION_TIER[section.id] === tier);
    if (own.length === 0) return '';
    return `<div class="tier">
  <h2>${esc(tr(`data.tier${tier[0]!.toUpperCase()}${tier.slice(1)}Title`))}</h2>
  <p class="dim">${esc(tr(`data.tier${tier[0]!.toUpperCase()}${tier.slice(1)}Lead`))}</p>
</div>
${own.map((section) => sectionPanel(section, locale)).join('')}`;
  }).join('');
}

/** One category: what is held, why, and what can be done. */
function sectionPanel(section: Section, locale: Locale): string {
  const tr = t(locale);
  const count = section.total ?? section.rows?.length ?? 0;

  // `count` picks the plural form, `n` is the formatted number.
  const aside =
    section.kind === 'fields'
      ? ''
      : `<span class="badge">${esc(tr('data.records', { count, n: formatNumber(count, locale) }))}</span>`;

  // The retention figures come from the same constants the nightly job enforces
  // (`AUDIT_PRO_DAYS`, `AUDIT_FREE_KEEP`).
  const vars = { days: AUDIT_PRO_DAYS, free: AUDIT_FREE_KEEP };

  return panel({
    // The section id in the markup, read by `test/personalData.test.ts`.
    attrs: `data-section="${esc(section.id)}"`,
    title: tr(`data.${section.id}Title`),
    aside,
    body: `${sectionValues(section, locale)}
  <div class="why">
    ${whyRow(tr('data.why'), tr(`data.${section.id}Why`, vars))}
    ${whyRow(tr('data.basis'), tr(`data.${section.id}Basis`, vars))}
    ${whyRow(tr('data.keep'), tr(`data.${section.id}Keep`, vars))}
    ${whyRow(tr('data.use'), tr(`data.${section.id}Use`, vars))}
  </div>
  ${sectionActions(section, locale)}`,
  });
}

function whyRow(label: string, value: string): string {
  return `<div class="why__row"><span class="why__label">${esc(label)}</span><span class="why__value">${esc(value)}</span></div>`;
}

/** The values, as a record, a table or a count. */
function sectionValues(section: Section, locale: Locale): string {
  const tr = t(locale);

  if (section.kind === 'summary') {
    return `<dl class="datagrid">
      ${valueRow(tr('data.fTotal'), formatNumber(section.total ?? 0, locale))}
      ${valueRow(tr('data.fOldest'), section.from ? formatDateTime(new Date(section.from), locale) : '')}
      ${valueRow(tr('data.fNewest'), section.to ? formatDateTime(new Date(section.to), locale) : '')}
    </dl>`;
  }

  if (section.kind === 'fields') {
    const fields = Object.entries(section.fields ?? {});
    if (fields.length === 0) return `<p class="muted">${esc(tr('data.empty'))}</p>`;
    return `<dl class="datagrid">${fields
      .map(([name, value]) => valueRow(fieldLabel(name, locale), renderValue(name, value, locale)))
      .join('')}</dl>`;
  }

  const rows = section.rows ?? [];
  if (rows.length === 0) return `<p class="muted">${esc(tr('data.empty'))}</p>`;

  const columns = Object.keys(rows[0]!);
  // Five rows, then how many more. The exports have everything.
  const more = (section.total ?? rows.length) - rows.length;
  // `count` picks the plural form, `n` is printed with the reader's thousands separator.
  const capped =
    more > 0 ? `<p class="dim">${esc(tr('data.andMore', { count: more, n: formatNumber(more, locale) }))}</p>` : '';

  return `<div class="table-wrap">
  <table>
    <thead><tr>${columns.map((name) => `<th>${esc(fieldLabel(name, locale))}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${columns.map((name) => `<td>${renderValue(name, row[name] ?? null, locale)}</td>`).join('')}</tr>`,
        )
        .join('')}
    </tbody>
  </table>
</div>
${capped}`;
}

function valueRow(label: string, html: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${html || `<span class="is-empty">-</span>`}</dd></div>`;
}

/**
 * The label of a field, from its export name: `lastSeenAt` reads `data.fLastSeenAt`. A new field
 * without a label throws at render.
 */
function fieldLabel(name: string, locale: Locale): string {
  return t(locale)(`data.f${name.charAt(0).toUpperCase()}${name.slice(1)}`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

/** Escaped HTML for one value: a localized date, a boolean in words, or the text. */
function renderValue(name: string, value: FieldValue, locale: Locale): string {
  const tr = t(locale);
  if (value === null || value === '') return `<span class="is-empty">-</span>`;
  if (typeof value === 'boolean') return esc(value ? tr('data.yes') : tr('data.no'));
  if (typeof value === 'number') return esc(formatNumber(value, locale));
  if (ISO_DATE_TIME.test(value))
    return `<time datetime="${esc(value)}">${esc(formatDateTime(new Date(value), locale))}</time>`;
  if (ISO_DATE.test(value)) return `<time datetime="${esc(value)}">${esc(formatDate(new Date(value), locale))}</time>`;
  // VAT numbers, key fragments and identifiers in monospace.
  const mono = ['vatNumber', 'key', 'id', 'proof', 'stripeCustomerId', 'stripeSubscriptionId'].includes(name);
  return mono ? `<span class="key">${esc(value)}</span>` : esc(value);
}

/**
 * What can be done about a category: the page that edits it, and an erase button where allowed.
 *
 * Erasure is a POST with the section in the body, and the confirmation names the category.
 */
function sectionActions(section: Section, locale: Locale): string {
  const tr = t(locale);
  const link = SECTION_LINK[section.id];
  const empty =
    section.kind === 'fields'
      ? Object.values(section.fields ?? {}).every((value) => value === null || value === '' || value === false)
      : (section.total ?? 0) === 0;

  const manage = link
    ? `<a class="btn btn--ghost btn--sm" href="${link.href}">${esc(tr('data.manageOn', { page: tr(link.label) }))}</a>`
    : '';

  // Three cases: erasable with data, erasable but empty (no button), and not erasable (explain what
  // depends on it).
  const erase = !isErasable(section.id)
    ? `<span class="dim">${esc(tr(`data.${section.id}NoErase`))}</span>`
    : empty
      ? `<span class="dim">${esc(tr('data.eraseNothing'))}</span>`
      : `<form method="post" action="/data/erase" ${confirmSubmit(tr('data.eraseConfirm', { section: tr(`data.${section.id}Title`) }))}>
      <input type="hidden" name="section" value="${esc(section.id)}">
      <button class="btn btn--danger btn--sm" type="submit">${esc(tr('data.erase'))}</button>
    </form>`;

  return `<div class="actions">${manage}${erase}</div>`;
}

// -- contact --

export interface ContactData {
  locale: Locale;
  email: string;
  plan: 'free' | 'pro';
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
}

/**
 * Support: one Discord invite, then the email address.
 *
 * The community server for free accounts, the private server for Pro, never both. The paid invite
 * is never rendered for a free account.
 */
export function contactPage(data: ContactData): string {
  const { locale } = data;
  const tr = t(locale);
  const pro = data.plan === 'pro';

  const discord = panel({
    title: pro ? tr('support.proTitle') : tr('support.communityTitle'),
    aside: pro ? `<span class="badge">${esc(tr('billing.planPro'))}</span>` : '',
    lead: pro ? tr('support.proLead') : tr('support.communityLead'),
    body: `<p><a class="btn" href="${esc(pro ? config.contact.discordPro : config.contact.discord)}" target="_blank" rel="noopener noreferrer">${esc(
      pro ? tr('support.proJoin') : tr('support.communityJoin'),
    )}</a></p>`,
  });

  const mail = panel({
    title: tr('support.emailTitle'),
    lead: tr('support.emailLead'),
    body: `<p><a href="mailto:${esc(config.contact.email)}">${esc(config.contact.email)}</a></p>`,
  });

  return layout({
    locale,
    title: tr('support.title'),
    nav: {
      current: 'contact',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body: `${pageHead(tr('support.title'), tr('support.lead'))}${discord}${mail}`,
  });
}

/** Used by the email templates, which need the absolute origin. */
export const consoleUrl = config.console.baseUrl;

// -- monitors --

/** One delivery attempt, as both detail pages render it. */
export interface DeliveryRow {
  publicId: string;
  event: string;
  url: string;
  attempt: number;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  sentAt: Date;
}

export interface MonitorRow {
  publicId: string;
  vatNumber: string;
  /** Null uses the account's default, and the table says so. */
  url: string | null;
  lastSource: string | null;
  lastCheckedAt: Date | null;
  lastChangedAt: Date | null;
  /** Older than `lastChangedAt` (or null while it is set) means the last change was never delivered. */
  lastDeliveredAt: Date | null;
  createdAt: Date;
}

export interface MonitorsData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  monitors: MonitorRow[];
  /** The plan limit, which decides whether the form is offered. */
  limit: number;
  /** This feature's default callback URL. Async lookups have their own. */
  monitorUrl: string;
  /** The signing secret, shared by both features. */
  callbackSecret?: string;
  saved?: boolean;
  error?: string;
  apiBaseUrl: string;
  sampleKey?: string;
}

/**
 * The followed companies.
 *
 * The list first, then a settings panel (default callback URL and signing secret). The add form is
 * at the foot of the list.
 *
 * The limit is always shown ("2 of 3").
 */
export function monitorsPage(data: MonitorsData): string {
  const { locale } = data;
  const tr = t(locale);
  const full = data.monitors.length >= data.limit;

  const table =
    data.monitors.length > 0
      ? `<div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('monitors.colVat'))}</th>
      <th>${esc(tr('monitors.colUrl'))}</th>
      <th>${esc(tr('monitors.colChecked'))}</th>
      <th>${esc(tr('monitors.colChanged'))}</th>
      <th><span class="sr-only">${esc(tr('monitors.colActions'))}</span></th>
    </tr></thead>
    <tbody>${data.monitors.map((row) => monitorRow(row, tr, locale)).join('')}</tbody>
  </table>
  </div>`
      : emptyState(tr('monitors.empty'), tr('monitors.emptyHint'));

  // Disabled rather than hidden at the limit, with the reason.
  const add = full
    ? `<p class="muted" style="margin:0">${esc(tr('monitors.limitReached', { limit: String(data.limit) }))}</p>`
    : `<h3>${esc(tr('monitors.addTitle'))}</h3>
    <p class="muted">${esc(tr('monitors.addLead'))}</p>
    <form method="post" action="/monitor" class="row">
      <div class="field">
        <label for="vatNumber">${esc(tr('monitors.addVat'))}</label>
        <input id="vatNumber" name="vatNumber" type="text" maxlength="20" required
               placeholder="${esc(tr('monitors.addVatPlaceholder'))}" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="url">${esc(tr('monitors.addUrl'))}</label>
        <input id="url" name="url" type="url" maxlength="2048"
               placeholder="${esc(tr('monitors.addUrlPlaceholder'))}" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn" type="submit">${esc(tr('monitors.addSubmit'))}</button>
    </form>`;

  const body = `
${pageHead(tr('monitors.title'), tr('monitors.lead'))}
${data.error ? `<div class="notice notice--error">${esc(data.error)}</div>` : ''}
${data.saved ? `<div class="notice">${esc(tr('monitors.saved'))}</div>` : ''}
<section class="panel panel--flush">
  <div class="panel__head">
    <h2>${esc(tr('monitors.listTitle'))}</h2>
    ${countOf(data.monitors.length, data.limit, tr('monitors.countOf'))}
  </div>
  ${table}
  <div class="panel__foot">${add}</div>
</section>
${callbackPanel({ locale, defaultUrl: data.monitorUrl, callbackSecret: data.callbackSecret }, tr, 'monitor')}
${monitorsApiPanel(data, tr)}`;

  return layout({
    locale,
    title: tr('monitors.title'),
    nav: {
      current: 'monitors',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/**
 * The default callback URL of this feature, and the signing secret.
 *
 * One URL panel per feature, since monitors and async lookups are independent.
 *
 * The secret has its own panel: it identifies the sender and is shared, so rolling it from either
 * page rolls the same secret. It is shown in full and copyable, like an API key. Rolling breaks
 * every receiver using the old one, hence a confirmation.
 */
function callbackPanel(
  data: { locale: Locale; defaultUrl: string; callbackSecret?: string },
  tr: ReturnType<typeof t>,
  feature: 'monitor' | 'lookupAsync',
): string {
  const action = feature === 'monitor' ? '/monitor/settings' : '/lookup-async/settings';

  const urlPanel = panel({
    title: tr('monitors.settingsTitle'),
    lead: tr(feature === 'monitor' ? 'monitors.settingsLead' : 'asyncLookups.settingsLead'),
    body: `<form method="post" action="${action}">
    <div class="field">
      <label for="defaultUrl">${esc(tr('monitors.defaultUrl'))}</label>
      <input id="defaultUrl" name="defaultUrl" type="url" maxlength="2048" value="${esc(data.defaultUrl)}"
             placeholder="${esc(tr('monitors.addUrlPlaceholder'))}" autocomplete="off" spellcheck="false">
      <p class="dim">${esc(tr('monitors.defaultUrlHelp'))}</p>
    </div>
    <button class="btn" type="submit">${esc(tr('monitors.save'))}</button>
  </form>`,
  });

  const secret = data.callbackSecret
    ? `<span class="copywrap copywrap--inline" data-copy data-copy-value="${esc(data.callbackSecret)}"
             data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
        <code class="key key--copy" data-copy-source tabindex="0" role="button" title="${esc(tr('overview.copy'))}">${esc(data.callbackSecret)}</code>
      </span>`
    : `<p class="dim">${esc(tr('monitors.secretNone'))}</p>`;

  const secretPanel = panel({
    title: tr('monitors.secret'),
    lead: tr('monitors.secretLead'),
    body: `${secret}
  <p style="margin:1rem 0 0"><a href="${config.siteUrl}/${data.locale}/docs/#callbacks-signature">${esc(tr('monitors.secretDocs'))} →</a></p>
  <form method="post" action="/callbacks/rotate" ${confirmSubmit(tr('monitors.rotateConfirm'))} style="margin-top:1rem">
    <input type="hidden" name="from" value="${feature}">
    <button class="btn btn--ghost btn--sm" type="submit">${esc(tr('monitors.rotate'))}</button>
  </form>`,
  });

  return `${urlPanel}
${secretPanel}`;
}

/** A count against its limit, shown large. */
function countOf(used: number, limit: number, label: string): string {
  return `<span class="count${used >= limit ? ' count--full' : ''}" title="${esc(label)}">
    <span class="count__value">${used}</span><span class="count__of">/ ${limit}</span>
  </span>`;
}

/** An empty table: what is missing and what to do next. */
function emptyState(title: string, hint: string): string {
  return `<div class="empty">
    <p class="empty__title">${esc(title)}</p>
    <p class="empty__hint">${esc(hint)}</p>
  </div>`;
}

function monitorsApiPanel(data: MonitorsData, tr: ReturnType<typeof t>): string {
  const key = data.sampleKey ?? '$VATLAS_KEY';
  return panel({
    title: tr('monitors.apiTitle'),
    lead: tr('monitors.apiLead'),
    body: `<div class="copywrap" data-copy data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
    <pre class="code" data-copy-source>curl <span class="str">"${esc(data.apiBaseUrl)}/v1/monitors"</span> \\
  <span class="flag">-H</span> <span class="str">"Authorization: Bearer ${esc(key)}"</span> \\
  <span class="flag">-H</span> <span class="str">"Content-Type: application/json"</span> \\
  <span class="flag">-d</span> <span class="str">'{"vatNumber": "FR95884831538"}'</span></pre>
  </div>
  <p style="margin:1rem 0 0"><a href="${config.siteUrl}/${data.locale}/docs/#monitor">${esc(tr('monitors.apiDocs'))} →</a></p>`,
  });
}

function monitorRow(row: MonitorRow, tr: ReturnType<typeof t>, locale: Locale): string {
  return `<tr>
    <td><a href="/monitor/${encodeURIComponent(row.vatNumber)}"><code>${esc(row.vatNumber)}</code></a></td>
    <td>${row.url ? `<span class="dim">${esc(row.url)}</span>` : `<span class="badge">${esc(tr('monitors.useDefault'))}</span>`}</td>
    <td>${row.lastCheckedAt ? localTime(row.lastCheckedAt, locale) : `<span class="dim">${esc(tr('monitors.never'))}</span>`}</td>
    <td>${row.lastChangedAt ? localTime(row.lastChangedAt, locale) : `<span class="dim">${esc(tr('monitors.never'))}</span>`}${
      monitorUndelivered(row) ? ` <span class="badge badge--warn">${esc(tr('monitors.undelivered'))}</span>` : ''
    }</td>
    <td><form method="post" action="/monitor/${encodeURIComponent(row.vatNumber)}/delete" ${confirmSubmit(tr('monitors.deleteConfirm'))}>
      <button class="btn btn--danger btn--sm" type="submit">${esc(tr('monitors.delete'))}</button>
    </form></td>
  </tr>`;
}

export interface MonitorDetailData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  monitor: MonitorRow & { last: unknown };
  /** The URL this monitor really uses: its own, or the account default. */
  effectiveUrl: string;
  deliveries: DeliveryRow[];
  tested?: boolean;
  error?: string;
  /** Set after a resend, to show the result. */
  resent?: boolean;
  resendError?: string;
}

/**
 * One monitor: what it follows, where it delivers, what it last saw, and every callback.
 *
 * The test button is here rather than on the listing, since it sends a real request.
 */
export function monitorDetailPage(data: MonitorDetailData): string {
  const { locale, monitor } = data;
  const tr = t(locale);

  const facts = panel({
    title: tr('monitors.detailTitle'),
    aside: `<a href="/monitor">← ${esc(tr('monitors.back'))}</a>`,
    body: `<dl class="facts">
    ${factRow(tr('monitors.colVat'), `<code>${esc(monitor.vatNumber)}</code>`)}
    ${factRow(tr('monitors.colUrl'), `<span class="dim">${esc(data.effectiveUrl)}</span>${monitor.url ? '' : ` <span class="badge">${esc(tr('monitors.useDefault'))}</span>`}`)}
    ${factRow(tr('monitors.added'), formatDateTime(monitor.createdAt, locale))}
    ${factRow(tr('monitors.colChecked'), monitor.lastCheckedAt ? localTime(monitor.lastCheckedAt, locale) : `<span class="dim">${esc(tr('monitors.never'))}</span>`)}
    ${factRow(tr('monitors.colChanged'), monitor.lastChangedAt ? localTime(monitor.lastChangedAt, locale) : `<span class="dim">${esc(tr('monitors.never'))}</span>`)}
    ${factRow(tr('monitors.colSource'), monitor.lastSource ? esc(monitor.lastSource) : `<span class="dim">-</span>`)}
  </dl>
  <form method="post" action="/monitor/${encodeURIComponent(monitor.vatNumber)}/test" style="margin-top:1rem">
    <button class="btn btn--ghost" type="submit">${esc(tr('monitors.test'))}</button>
  </form>
  <p class="dim" style="margin:.5rem 0 0">${esc(tr('monitors.testHelp'))}</p>`,
  });

  const last = monitor.last
    ? panel({
        title: tr('monitors.lastTitle'),
        lead: tr('monitors.lastLead'),
        body: `<pre class="code">${esc(JSON.stringify(monitor.last, null, 2))}</pre>`,
      })
    : '';

  const body = `
${pageHead(monitor.vatNumber, tr('monitors.detailLead'))}
${data.error ? `<div class="notice notice--error">${esc(data.error)}</div>` : ''}
${data.tested ? `<div class="notice">${esc(tr('monitors.testSent'))}</div>` : ''}
${facts}
${deliveriesPanel(data.deliveries, tr, locale, {
  action: `/monitor/${encodeURIComponent(monitor.vatNumber)}/resend`,
  ...(data.resent === true ? { sent: true } : {}),
  ...(data.resendError !== undefined ? { error: data.resendError } : {}),
})}
${last}`;

  return layout({
    locale,
    title: `${monitor.vatNumber} - ${tr('monitors.title')}`,
    nav: {
      current: 'monitors',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

/** Every delivery attempt, failures included. */
function deliveriesPanel(
  rows: DeliveryRow[],
  tr: ReturnType<typeof t>,
  locale: Locale,
  resend?: { action: string; sent?: boolean; error?: string },
): string {
  if (rows.length === 0) {
    return panel({
      title: tr('monitors.deliveriesTitle'),
      body: `<p class="dim" style="margin:0">${esc(tr('monitors.deliveriesEmpty'))}</p>`,
    });
  }

  // Only shown when the last attempt failed.
  const stuck = rows[0]?.error !== null;
  const button =
    resend && stuck
      ? `<form method="post" action="${resend.action}">
        <button class="btn btn--ghost btn--sm" type="submit">${esc(tr('monitors.resend'))}</button>
      </form>`
      : '';

  return `<section class="panel panel--flush">
  <div class="panel__head"><h2>${esc(tr('monitors.deliveriesTitle'))}</h2>${button}</div>
  ${resend?.sent ? `<div class="panel__body"><p class="notice" style="margin:0">${esc(tr('monitors.resendSent'))}</p></div>` : ''}
  ${resend?.error ? `<div class="panel__body"><p class="notice notice--error" style="margin:0">${esc(resend.error)}</p></div>` : ''}
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('monitors.colDate'))}</th>
      <th>${esc(tr('monitors.colEvent'))}</th>
      <th>${esc(tr('monitors.colAttempt'))}</th>
      <th>${esc(tr('monitors.colResult'))}</th>
      <th>${esc(tr('monitors.colDuration'))}</th>
    </tr></thead>
    <tbody>${rows.map((row) => deliveryRow(row, tr, locale)).join('')}</tbody>
  </table>
  </div>
</section>`;
}

function deliveryRow(row: DeliveryRow, tr: ReturnType<typeof t>, locale: Locale): string {
  const ok = row.error === null;
  const result = ok
    ? `<span class="badge badge--ok">${esc(String(row.httpStatus ?? 200))}</span>`
    : `<span class="badge badge--danger">${esc(row.httpStatus === null ? tr('monitors.noAnswer') : String(row.httpStatus))}</span> <span class="dim">${esc(row.error ?? '')}</span>`;

  return `<tr>
    <td>${localTime(row.sentAt, locale)}</td>
    <td><code>${esc(row.event)}</code></td>
    <td>${esc(formatNumber(row.attempt, locale))}</td>
    <td>${result}</td>
    <td>${row.durationMs === null ? '<span class="dim">-</span>' : esc(`${formatNumber(row.durationMs, locale)} ms`)}</td>
  </tr>`;
}

// -- async lookups --

export interface AsyncLookupRow {
  publicId: string;
  vatNumber: string;
  kind: string;
  url: string | null;
  status: string;
  attempts: number;
  retryAfter: Date;
  expiresAt: Date;
  completedAt: Date | null;
  /** Null on a finished lookup means the answer was never delivered. */
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface AsyncLookupsData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  lookups: AsyncLookupRow[];
  /** Retry duration, stated on the page. */
  maxDays: number;
  /** This feature's default callback URL. Monitors have their own. */
  lookupAsyncUrl: string;
  /** The signing secret, shared by both features. */
  callbackSecret?: string;
  saved?: boolean;
  error?: string;
  apiBaseUrl: string;
  sampleKey?: string;
  /** The switch as the last queued lookup left it, same control as `/lookup`. */
  mode: LookupMode;
  prefer: LookupPreference;
}

/** Async lookups, pending and finished, in one table with status as a column. */
export function asyncLookupsPage(data: AsyncLookupsData): string {
  const { locale } = data;
  const tr = t(locale);

  const table =
    data.lookups.length > 0
      ? `<div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('asyncLookups.colVat'))}</th>
      <th>${esc(tr('asyncLookups.colKind'))}</th>
      <th>${esc(tr('asyncLookups.colStatus'))}</th>
      <th>${esc(tr('asyncLookups.colAttempts'))}</th>
      <th>${esc(tr('asyncLookups.colNext'))}</th>
      <th><span class="sr-only">${esc(tr('asyncLookups.colActions'))}</span></th>
    </tr></thead>
    <tbody>${data.lookups.map((row) => asyncLookupRow(row, tr, locale)).join('')}</tbody>
  </table>
  </div>`
      : emptyState(tr('asyncLookups.empty'), tr('asyncLookups.emptyHint'));

  // Same control as `/lookup` without `?history`, which the queue does not take (lookup-all delivers
  // the history anyway).
  const controls = lookupControls({
    mode: data.mode,
    prefer: data.prefer,
    endpoints: ASYNC_MODE_ENDPOINT,
    tr,
  });

  const create = `<h3>${esc(tr('asyncLookups.createTitle'))}</h3>
    <p class="muted">${esc(tr('asyncLookups.createLead', { days: String(data.maxDays) }))}</p>
    <form method="post" action="/lookup-async" class="lookupform">
      ${controls.radios}
      <div class="segmented" role="group" aria-label="${esc(tr('asyncLookups.createTitle'))}">
        ${controls.switcher}
      </div>
      <div class="row">
        <div class="field">
          <label for="vatNumber">${esc(tr('asyncLookups.createVat'))}</label>
          <input id="vatNumber" name="vatNumber" type="text" maxlength="20" required
                 placeholder="${esc(tr('asyncLookups.createVatPlaceholder'))}" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="url">${esc(tr('monitors.addUrl'))}</label>
          <input id="url" name="url" type="url" maxlength="2048"
                 placeholder="${esc(tr('monitors.addUrlPlaceholder'))}" autocomplete="off" spellcheck="false">
        </div>
        <button class="btn" type="submit">${esc(tr('asyncLookups.createSubmit'))}</button>
      </div>
      ${controls.options}
      ${controls.notes}
    </form>
    <p class="dim" style="margin:.75rem 0 0">${esc(tr('asyncLookups.costNote'))}</p>`;

  const body = `
${pageHead(tr('asyncLookups.title'), tr('asyncLookups.lead'))}
${data.error ? `<div class="notice notice--error">${esc(data.error)}</div>` : ''}
${data.saved ? `<div class="notice">${esc(tr('asyncLookups.createdNotice'))}</div>` : ''}
<section class="panel panel--flush">
  <div class="panel__head"><h2>${esc(tr('asyncLookups.listTitle'))}</h2></div>
  ${table}
  <div class="panel__foot">${create}</div>
</section>
${callbackPanel({ locale, defaultUrl: data.lookupAsyncUrl, callbackSecret: data.callbackSecret }, tr, 'lookupAsync')}
${asyncApiPanel(data, tr)}`;

  return layout({
    locale,
    title: tr('asyncLookups.title'),
    nav: {
      current: 'lookups',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

function asyncApiPanel(data: AsyncLookupsData, tr: ReturnType<typeof t>): string {
  const key = data.sampleKey ?? '$VATLAS_KEY';
  return panel({
    title: tr('asyncLookups.apiTitle'),
    lead: tr('asyncLookups.apiLead'),
    body: `<div class="copywrap" data-copy data-copy-label="${esc(tr('overview.copy'))}" data-copied-label="${esc(tr('overview.copied'))}">
    <pre class="code" data-copy-source>curl <span class="str">"${esc(data.apiBaseUrl)}/v1/lookups"</span> \\
  <span class="flag">-H</span> <span class="str">"Authorization: Bearer ${esc(key)}"</span> \\
  <span class="flag">-H</span> <span class="str">"Content-Type: application/json"</span> \\
  <span class="flag">-d</span> <span class="str">'{"vatNumber": "FR95884831538"}'</span></pre>
  </div>
  <p style="margin:1rem 0 0"><a href="${config.siteUrl}/${data.locale}/docs/#lookup-async">${esc(tr('asyncLookups.apiDocs'))} →</a></p>`,
  });
}

/**
 * Where a lookup stands, in four states.
 *
 * A finished lookup whose result was refused by the endpoint (no `deliveredAt`) gets its own amber
 * state, since "answered" in green would hide that the answer was never delivered.
 *
 * Separate from the audit trail's `statusBadge`, which shows how an HTTP call ended.
 */
function asyncStatusBadge(row: { status: string; deliveredAt: Date | null }, tr: ReturnType<typeof t>): string {
  if (row.status === 'success' && row.deliveredAt === null) {
    return `<span class="badge badge--warn">${esc(tr('asyncLookups.status_undelivered'))}</span>`;
  }
  const tone = row.status === 'success' ? ' badge--ok' : row.status === 'failed' ? ' badge--danger' : ' badge--warn';
  return `<span class="badge${tone}">${esc(tr(`asyncLookups.status_${row.status}`))}</span>`;
}

/** Same question for a monitor: was the last change delivered. */
function monitorUndelivered(row: { lastChangedAt: Date | null; lastDeliveredAt: Date | null }): boolean {
  if (row.lastChangedAt === null) return false;
  return row.lastDeliveredAt === null || row.lastDeliveredAt < row.lastChangedAt;
}

function asyncLookupRow(row: AsyncLookupRow, tr: ReturnType<typeof t>, locale: Locale): string {
  return `<tr>
    <td><a href="/lookup-async/${encodeURIComponent(row.publicId)}"><code>${esc(row.vatNumber)}</code></a></td>
    <td>${esc(tr(`asyncLookups.kind_${row.kind}`))}</td>
    <td>${asyncStatusBadge(row, tr)}</td>
    <td>${esc(formatNumber(row.attempts, locale))}</td>
    <td>${row.status === 'pending' ? localTime(row.retryAfter, locale) : `<span class="dim">-</span>`}</td>
    <td><form method="post" action="/lookup-async/${encodeURIComponent(row.publicId)}/delete" ${confirmSubmit(tr('asyncLookups.deleteConfirm'))}>
      <button class="btn btn--danger btn--sm" type="submit">${esc(tr('asyncLookups.delete'))}</button>
    </form></td>
  </tr>`;
}

export interface AsyncAttemptRow {
  attemptedAt: Date;
  outcome: string;
  httpStatus: number | null;
  errorCode: string | null;
  fault: string | null;
  durationMs: number | null;
}

export interface AsyncLookupDetailData {
  locale: Locale;
  email: string;
  stripeReady: boolean;
  hasBillingAccount: boolean;
  /** False shows the verification banner. Absent means verified. */
  emailVerified?: boolean;
  lookup: AsyncLookupRow & { response: unknown };
  effectiveUrl: string;
  attempts: AsyncAttemptRow[];
  deliveries: DeliveryRow[];
  resent?: boolean;
  resendError?: string;
}

/**
 * One async lookup: its status, every attempt, the answer when there is one, and its deliveries.
 *
 * The attempt list shows what failed and since when (for example MS_UNAVAILABLE from Bulgaria since
 * Tuesday).
 */
export function asyncLookupDetailPage(data: AsyncLookupDetailData): string {
  const { locale, lookup } = data;
  const tr = t(locale);

  const facts = panel({
    title: tr('asyncLookups.detailTitle'),
    aside: `<a href="/lookup-async">← ${esc(tr('asyncLookups.back'))}</a>`,
    body: `<dl class="facts">
    ${factRow(tr('asyncLookups.colVat'), `<code>${esc(lookup.vatNumber)}</code>`)}
    ${factRow(tr('asyncLookups.colKind'), esc(tr(`asyncLookups.kind_${lookup.kind}`)))}
    ${factRow(tr('asyncLookups.colStatus'), asyncStatusBadge(lookup, tr))}
    ${factRow(tr('asyncLookups.colAttempts'), esc(formatNumber(lookup.attempts, locale)))}
    ${factRow(tr('monitors.colUrl'), `<span class="dim">${esc(data.effectiveUrl)}</span>`)}
    ${factRow(tr('asyncLookups.created'), formatDateTime(lookup.createdAt, locale))}
    ${
      lookup.status === 'pending'
        ? `${factRow(tr('asyncLookups.colNext'), localTime(lookup.retryAfter, locale))}
           ${factRow(tr('asyncLookups.givesUpAt'), localTime(lookup.expiresAt, locale))}`
        : factRow(
            tr('asyncLookups.finished'),
            lookup.completedAt ? localTime(lookup.completedAt, locale) : '<span class="dim">-</span>',
          )
    }
  </dl>`,
  });

  const attempts =
    data.attempts.length > 0
      ? `<section class="panel panel--flush">
  <div class="panel__head"><h2>${esc(tr('asyncLookups.attemptsTitle'))}</h2></div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>${esc(tr('monitors.colDate'))}</th>
      <th>${esc(tr('asyncLookups.colOutcome'))}</th>
      <th>${esc(tr('asyncLookups.colFault'))}</th>
      <th>${esc(tr('monitors.colDuration'))}</th>
    </tr></thead>
    <tbody>${data.attempts.map((row) => attemptRow(row, locale)).join('')}</tbody>
  </table>
  </div>
</section>`
      : panel({
          title: tr('asyncLookups.attemptsTitle'),
          body: `<p class="dim" style="margin:0">${esc(tr('asyncLookups.attemptsEmpty'))}</p>`,
        });

  const response = lookup.response
    ? panel({
        title: tr('asyncLookups.responseTitle'),
        lead: tr('asyncLookups.responseLead'),
        body: `<pre class="code">${esc(JSON.stringify(lookup.response, null, 2))}</pre>`,
      })
    : '';

  const body = `
${pageHead(lookup.vatNumber, tr('asyncLookups.detailLead'))}
${facts}
${deliveriesPanel(data.deliveries, tr, locale, {
  action: `/lookup-async/${encodeURIComponent(lookup.publicId)}/resend`,
  ...(data.resent === true ? { sent: true } : {}),
  ...(data.resendError !== undefined ? { error: data.resendError } : {}),
})}
${attempts}
${response}`;

  return layout({
    locale,
    title: `${lookup.vatNumber} - ${tr('asyncLookups.title')}`,
    nav: {
      current: 'lookups',
      email: data.email,
      portal: data.stripeReady && data.hasBillingAccount,
      emailVerified: data.emailVerified !== false,
    },
    body,
  });
}

function attemptRow(row: AsyncAttemptRow, locale: Locale): string {
  const ok = row.outcome === 'found' || row.outcome === 'not-registered';
  return `<tr>
    <td>${localTime(row.attemptedAt, locale)}</td>
    <td><span class="badge${ok ? ' badge--ok' : ' badge--warn'}">${esc(row.outcome)}</span>${
      row.errorCode ? ` <code>${esc(row.errorCode)}</code>` : ''
    }</td>
    <td>${row.fault ? `<code>${esc(row.fault)}</code>` : '<span class="dim">-</span>'}</td>
    <td>${row.durationMs === null ? '<span class="dim">-</span>' : esc(`${formatNumber(row.durationMs, locale)} ms`)}</td>
  </tr>`;
}
