import { describe, expect, it } from 'vitest';
import { localeFromHeader, isLocale, formatMonth } from '../src/console/i18n.js';
import {
  accountPage,
  asyncLookupDetailPage,
  asyncLookupsPage,
  billingPage,
  dashboardPage,
  esc,
  isProfileComplete,
  loginPage,
  lookupPage,
  resetPasswordPage,
  signupPage,
  monitorDetailPage,
  monitorsPage,
} from '../src/console/views.js';
import { presentAll, presentLookup } from '../src/lib/lookupView.js';
import { backTo } from '../src/console/routes.js';
import { escapeHtml } from '../src/lib/email.js';
import { redactUrl } from '../src/lib/logger.js';

describe('localeFromHeader', () => {
  it.each([
    ['fr-FR,fr;q=0.9,en;q=0.8', 'fr'],
    ['en-GB,en;q=0.9', 'en'],
    ['FR', 'fr'],
  ])('reads %s as %s', (header, expected) => {
    expect(localeFromHeader(header)).toBe(expected);
  });

  it('falls back to English for a language we do not speak', () => {
    expect(localeFromHeader('de-DE,de;q=0.9')).toBe('en');
  });

  it('takes the first language it recognises, not the first listed', () => {
    // A browser asking for German then French should get French, not English.
    expect(localeFromHeader('de-DE,fr;q=0.8')).toBe('fr');
  });

  it('falls back when the header is absent', () => {
    expect(localeFromHeader(undefined)).toBe('en');
  });
});

describe('isLocale', () => {
  it('guards what comes back out of the database', () => {
    // `accounts.locale` is a CHAR(2) and could hold anything.
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('esc', () => {
  // Every page renders user-typed values. Escaping is what prevents script injection.
  it('neutralises the characters that would break out of markup', () => {
    expect(esc('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('escapes the single quote, which the inline confirm() handler sits inside', () => {
    expect(esc("it's")).toBe('it&#39;s');
  });

  it('escapes the ampersand first, so an escape is not itself re-escaped', () => {
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('renders null and undefined as nothing rather than as words', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('protects the HTML part of a mail the same way', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('formatMonth', () => {
  it('labels a month in the reader language, from a UTC instant', () => {
    // The chart's x-axis: a machine in Europe/Paris must not label 1 August as July.
    expect(formatMonth(new Date('2026-08-01T00:00:00Z'), 'en')).toMatch(/Aug/);
    expect(formatMonth(new Date('2026-08-01T00:00:00Z'), 'fr')).toMatch(/ao/);
  });
});

describe('billingPage cancellation notice', () => {
  const base = {
    email: 'a@example.com',
    plan: 'pro' as const,
    quota: 10000,
    monitorsUsed: 2,
    monitorsLimit: 100,
    stripeReady: true,
    hasBillingAccount: true,
    profile: { companyName: '', vatNumber: '', line1: '', line2: '', postalCode: '', city: '', country: '' },
  };

  // A cancelled subscription keeps the paid plan until the end of the period, so the date is shown.
  it('announces the end date while the plan is still paid', () => {
    const html = billingPage({ ...base, locale: 'en', cancelAt: new Date('2026-09-27T07:57:07Z') });
    expect(html).toContain('Subscription cancelled.');
    expect(html).toContain('27 Sept 2026');
  });

  it('announces it in French too', () => {
    const html = billingPage({ ...base, locale: 'fr', cancelAt: new Date('2026-09-27T07:57:07Z') });
    expect(html).toContain('Abonnement résilié.');
    expect(html).toContain('27 sept. 2026');
  });

  it('says nothing when the subscription simply renews', () => {
    const html = billingPage({ ...base, locale: 'en' });
    expect(html).not.toContain('Subscription cancelled.');
  });
});

describe('billingPage company details', () => {
  const base = {
    locale: 'en' as const,
    email: 'a@example.com',
    plan: 'free' as const,
    quota: 100,
    monitorsUsed: 0,
    monitorsLimit: 3,
    stripeReady: true,
    hasBillingAccount: false,
  };
  const filled = {
    companyName: 'Acme',
    vatNumber: '',
    line1: '1 rue de la Paix',
    line2: '',
    postalCode: '75002',
    city: 'Paris',
    country: 'FR',
  };

  // The form is on the account page, and repeated here only while missing, since checkout needs it.
  it('offers the form while the address is missing', () => {
    const html = billingPage({
      ...base,
      profile: { ...filled, companyName: '', line1: '', postalCode: '', city: '', country: '' },
    });
    expect(html).toContain('action="/billing"');
    expect(html).toContain('name="from" value="billing"');
  });

  it('drops it once the address is complete', () => {
    const html = billingPage({ ...base, profile: filled });
    expect(html).not.toContain('name="companyName"');
  });

  // The VAT number is optional: most customers have none.
  it('does not count the VAT number as missing', () => {
    expect(isProfileComplete(filled)).toBe(true);
  });
});

describe('the plan button', () => {
  const base = {
    locale: 'en' as const,
    email: 'a@example.com',
    quota: 100,
    monitorsUsed: 0,
    monitorsLimit: 3,
    profile: {
      companyName: 'Acme',
      vatNumber: '',
      line1: '1 rue',
      line2: '',
      postalCode: '75002',
      city: 'Paris',
      country: 'FR',
    },
  };

  // An account without a Stripe customer must be offered Upgrade, not Manage.
  it('offers checkout, not the portal, to an account Stripe has never seen', () => {
    const html = billingPage({ ...base, plan: 'free', stripeReady: true, hasBillingAccount: false });
    expect(html).toContain('action="/billing/checkout"');
    expect(html).not.toContain('action="/billing/portal"');
  });

  it('offers the portal once there is a customer on a paid plan', () => {
    const html = billingPage({ ...base, plan: 'pro', stripeReady: true, hasBillingAccount: true });
    expect(html).toContain('action="/billing/portal"');
  });

  // A paid plan with no customer record goes to checkout, the recoverable path.
  it('falls back to checkout on a paid plan with no customer', () => {
    const html = billingPage({ ...base, plan: 'pro', stripeReady: true, hasBillingAccount: false });
    expect(html).toContain('action="/billing/checkout"');
  });

  it('says so plainly, with no button at all, when payments are not configured', () => {
    const html = billingPage({ ...base, plan: 'free', stripeReady: false, hasBillingAccount: false });
    expect(html).not.toContain('action="/billing/checkout"');
    expect(html).toContain('Payments are not configured on this instance yet.');
  });

  // The sidebar entry opens the same portal, so it is hidden by the same rule.
  it('keeps the invoices entry out of the sidebar until there is something in it', () => {
    const without = billingPage({ ...base, plan: 'free', stripeReady: true, hasBillingAccount: false });
    const with_ = billingPage({ ...base, plan: 'pro', stripeReady: true, hasBillingAccount: true });
    expect(without).not.toContain('Invoices');
    expect(with_).toContain('Invoices');
  });
});

describe('accountPage danger zone', () => {
  const base = {
    email: 'a@example.com',
    createdAt: new Date('2026-01-05T10:00:00Z'),
    plan: 'free' as const,
    quota: 100,
    status: 'active',
    activeKeys: 2,
    stripeReady: true,
    hasBillingAccount: true,
    hasPassword: true,
    profile: { companyName: '', vatNumber: '', line1: '', line2: '', postalCode: '', city: '', country: '' },
  };

  // Erasure is a collapsed line on the account page.
  it('renders folded shut', () => {
    const html = accountPage({ ...base, locale: 'en' });
    expect(html).toContain('<details class="panel panel--danger panel--fold">');
  });

  // A refused attempt keeps its explanation visible.
  it('unfolds when the last attempt was refused', () => {
    const html = accountPage({ ...base, locale: 'en', error: 'The confirmation word did not match.' });
    expect(html).toContain('panel--fold" open>');
    expect(html).toContain('The confirmation word did not match.');
  });

  // An account Stripe is still billing cannot be deleted.
  it('explains itself instead of offering the form while a subscription is live', () => {
    const html = accountPage({ ...base, locale: 'en', plan: 'pro', subscriptionStatus: 'active' });
    expect(html).not.toContain('action="/account/delete"');
    expect(html).toContain('Cancel it from the Billing page first');
  });

  it('no longer sits on the billing page', () => {
    const html = billingPage({
      locale: 'en',
      email: 'a@example.com',
      plan: 'free',
      quota: 100,
      monitorsUsed: 0,
      monitorsLimit: 3,
      stripeReady: true,
      hasBillingAccount: false,
      profile: { companyName: '', vatNumber: '', line1: '', line2: '', postalCode: '', city: '', country: '' },
    });
    expect(html).not.toContain('/account/delete');
  });
});

describe('lookupPage, the mode switch', () => {
  const base = {
    locale: 'en' as const,
    email: 'a@example.com',
    stripeReady: false,
    hasBillingAccount: false,
    query: '',
    prefer: 'completeness' as const,
    history: true,
  };

  it('offers the two endpoints on one field, and says what each answers', () => {
    const html = lookupPage({ ...base, mode: 'single' as const });

    for (const mode of ['single', 'all']) {
      expect(html).toContain(`id="mode-${mode}" name="mode" value="${mode}"`);
    }
    // One field for every mode.
    expect(html.match(/name="vatNumber"/g)).toHaveLength(1);
    // Both notes are in the page, and the stylesheet shows the checked one. Each names its endpoint.
    expect(html).toContain('<code>GET /v1/lookup/{vatNumber}</code>');
    expect(html).toContain('<code>GET /v1/lookup-all/{vatNumber}</code>');
  });

  it('carries prefer and history as the options they are on the API', () => {
    // One switch for the two calls, and the query parameters below it, named like in the docs.
    const html = lookupPage({ ...base, mode: 'single' as const, prefer: 'proof' as const, history: false });

    expect(html).toContain('name="prefer" value="completeness"');
    expect(html).toContain('name="prefer" value="proof" checked');
    expect(html).toContain('type="checkbox" name="history" value="true"');
    expect(html).not.toContain('type="checkbox" name="history" value="true" checked');
  });

  it('puts the switch on the mode that was run, and keeps the number in the one field', () => {
    const html = lookupPage({ ...base, mode: 'all' as const, query: 'FR95884831538' });

    expect(html).toContain('id="mode-all" name="mode" value="all" class="segmented__radio" checked');
    expect(html).not.toContain('value="single" class="segmented__radio" checked');
    expect(html).toContain(
      'id="vatNumber" name="vatNumber" type="text" maxlength="20" required\n               value="FR95884831538"',
    );
  });

  it('shows the proof call as the query parameter it really is', () => {
    const html = lookupPage({
      ...base,
      mode: 'single' as const,
      prefer: 'proof' as const,
      history: false,
      query: 'FR95884831538',
      result: { status: 200, body: '{}', durationMs: 412 },
    });

    expect(html).toContain('/v1/lookup/FR95884831538?prefer=proof');
    // A proof is one source's answer: no per-source table, and the plain lookup's docs anchor. Asserted
    // on the table heading, since the inlined stylesheet contains the class on every page.
    expect(html).not.toContain('<th>Source</th>');
    expect(html).toContain('docs/#lookup');
  });

  it('spells each option only when it changes what the endpoint would have done anyway', () => {
    const url = (over: Partial<typeof base> & { mode: 'single' | 'all' }) =>
      lookupPage({ ...base, query: 'FR95884831538', result: { status: 200, body: '{}', durationMs: 1 }, ...over });

    // `?history` is off on the plain lookup and on for lookup-all, so each URL only includes it when it
    // differs from the default.
    expect(url({ mode: 'single', history: true })).toContain('/v1/lookup/FR95884831538?history');
    expect(url({ mode: 'single', history: false })).toContain('GET http://localhost:3000/v1/lookup/FR95884831538<');
    expect(url({ mode: 'all', history: true })).toContain('/v1/lookup-all/FR95884831538<');
    expect(url({ mode: 'all', history: false })).toContain('/v1/lookup-all/FR95884831538?history=false');
  });

  it('summarises the sources above the raw response, with the register and its date', () => {
    const html = lookupPage({
      ...base,
      mode: 'all' as const,
      query: 'FR95884831538',
      result: { status: 200, body: '{}', durationMs: 812 },
      sources: [
        { source: 'SIRENE', kind: 'bulk', status: 'found', asOf: '2026-01-05T00:00:00.000Z', statements: 3 },
        { source: 'VIES', kind: 'live', status: 'unavailable', asOf: null, statements: 0 },
      ],
    });

    expect(html).toContain('/v1/lookup-all/FR95884831538');
    expect(html).toContain('SIRENE');
    expect(html).toContain('Did not answer');
    expect(html).toContain('docs/#lookup-all');
  });

  it('shows no table at all for a plain lookup', () => {
    const html = lookupPage({
      ...base,
      mode: 'single' as const,
      query: 'FR95884831538',
      result: { status: 200, body: '{}', durationMs: 143 },
    });

    expect(html).toContain('/v1/lookup/FR95884831538');
    expect(html).not.toContain('/v1/lookup-all/FR95884831538');
    expect(html).toContain('docs/#lookup');
  });

  it('says so plainly when a country has no source left to consult', () => {
    const html = lookupPage({
      ...base,
      mode: 'all' as const,
      query: 'BG000670602',
      result: { status: 200, body: '{}', durationMs: 12 },
      sources: [],
    });

    expect(html).toContain('No source could be consulted');
  });
});

describe('lookupPage, the formatted answer', () => {
  const base = {
    locale: 'en' as const,
    email: 'a@example.com',
    stripeReady: false,
    hasBillingAccount: false,
    query: 'FR95884831538',
    result: { status: 200, body: '{}', durationMs: 143 },
  };

  const found = {
    data: {
      vatNumber: 'FR95884831538',
      countryCode: 'FR',
      nationalNumber: '884831538',
      nationalId: '884831538',
      name: 'SARL JULIEN MAULNY EURL',
      legalForm: 'Autre société à responsabilité limitée',
      status: 'active',
      address: { line1: '9 RUE DES COLONNES', line2: null, postalCode: '75002', city: 'PARIS', country: 'FR' },
    },
    meta: { source: 'SIRENE', sourceDate: '2026-09-01', sourceSince: '2026-01-05', sourceUpdatedAt: null },
  };

  it('opens on the formatted answer and keeps the envelope one tab away', () => {
    const html = lookupPage({ ...base, mode: 'single' as const, view: presentLookup(200, found) });

    // The formatted tab is checked by default.
    expect(html).toContain('id="view-formatted" name="view" value="formatted" class="segmented__radio" checked');
    expect(html).toContain('id="view-json" name="view" value="json" class="segmented__radio">');
    // Both panes are in the HTML.
    expect(html).toContain('pane pane--formatted');
    expect(html).toContain('pane pane--json');
  });

  it('paints an active company green, names the register, and lists what it published', () => {
    const html = lookupPage({ ...base, mode: 'single' as const, view: presentLookup(200, found) });

    expect(html).toContain('verdict verdict--ok');
    expect(html).toContain('Active');
    // The register is on the verdict line.
    expect(html).toMatch(/verdict__label">Active<\/span>\s*<span class="badge">SIRENE<\/span>/);
    // The name is the card heading.
    expect(html).toContain('<p class="card__name">SARL JULIEN MAULNY EURL</p>');
    expect(html).toContain('Autre société à responsabilité limitée');
    // The address as written on an envelope.
    expect(html).toContain('<address>9 RUE DES COLONNES<br>75002 PARIS');
  });

  it('reads a number nobody registered as a verdict, not as a breakage', () => {
    const body = {
      error: { code: 'VAT_NOT_REGISTERED', message: 'The number is not registered for intra-community trade.' },
      meta: { checkedAt: '2026-09-04T22:01:59.219Z' },
    };
    const html = lookupPage({ ...base, mode: 'single' as const, view: presentLookup(404, body) });

    expect(html).toContain('verdict verdict--bad');
    expect(html).toContain('Not registered for intra-community trade');
    // The API's own sentence, as stored in the audit trail.
    expect(html).toContain('The number is not registered for intra-community trade.');
  });

  it('shows a proof when the answer carries one, and no proof line when it does not', () => {
    const proved = {
      ...found,
      meta: {
        source: 'VIES',
        sourceDate: '2026-09-04',
        sourceSince: '2026-09-04',
        sourceUpdatedAt: null,
        proof: { type: 'vies_consultation_number', value: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
      },
    };

    const withProof = lookupPage({ ...base, mode: 'proof' as const, view: presentLookup(200, proved) });
    expect(withProof).toContain('908a3b38-e0dc-4502-8b06-d057eeac6861');
    expect(withProof).toContain('<span class="badge badge--ok">Proof</span>');

    // Asserted on the badge, not the words: "With proof" is also a mode label on the page.
    const withoutProof = lookupPage({ ...base, mode: 'single' as const, view: presentLookup(200, found) });
    expect(withoutProof).not.toContain('<span class="badge badge--ok">Proof</span>');
  });

  it('reads the history as the days something moved', () => {
    const report = {
      data: {
        vatNumber: 'FR95884831538',
        countryCode: 'FR',
        nationalNumber: '884831538',
        sources: [
          {
            data: { vatNumber: 'FR95884831538', name: 'SARL JULIEN MAULNY EURL', status: 'active' },
            meta: { source: 'SIRENE', name: 'SIRENE (INSEE)', kind: 'bulk', sourceDate: '2026-09-01' },
            history: [
              {
                from: '2024-01-05',
                to: '2025-06-30',
                status: 'active',
                name: 'JULIEN MAULNY',
                address: {
                  line1: '51 RUE MARX DORMOY',
                  line2: null,
                  postalCode: '13004',
                  city: 'MARSEILLE',
                  country: 'FR',
                },
              },
              {
                from: '2026-01-05',
                to: '2026-09-01',
                status: 'active',
                name: 'SARL JULIEN MAULNY EURL',
                address: {
                  line1: '9 RUE DES COLONNES',
                  line2: null,
                  postalCode: '75002',
                  city: 'PARIS',
                  country: 'FR',
                },
                file: { name: 'StockUniteLegale_utf8.zip', url: 'https://www.data.gouv.fr/' },
              },
            ],
          },
        ],
      },
    };
    const html = lookupPage({ ...base, mode: 'all' as const, view: presentAll(report) });

    expect(html).toContain('SIRENE (INSEE)');
    // The timeline rail, one entry per statement.
    expect(html).toContain('<ol class="timeline">');
    // Changed fields as a diff: old value struck through, new value below.
    expect(html).toContain('<del>JULIEN MAULNY</del>');
    expect(html).toContain('<ins>SARL JULIEN MAULNY EURL</ins>');
    expect(html).toContain('<del>MARSEILLE</del>');
    // The first entry shows the company as first described, not an empty diff.
    expect(html).toContain('card__name');
    // Each entry shows its period, so gaps read from the dates.
    expect(html).toContain('5 Jan 2024 → 30 Jun 2025');
    expect(html).toContain('5 Jan 2026 → 1 Sept 2026');

    // Newest first: the API publishes oldest first and the page reverses it.
    expect(html.indexOf('5 Jan 2026')).toBeLessThan(html.indexOf('5 Jan 2024'));
    // The current entry is marked and shows the company.
    expect(html).toContain('timeline__item--latest');
    expect(html.indexOf('timeline__item--latest')).toBeLessThan(html.indexOf('5 Jan 2024'));

    // The source file is a footnote, not a link, one row per part.
    expect(html).toContain('<dt>Source URL</dt><dd>https://www.data.gouv.fr/</dd>');
    expect(html).toContain('<dt>Source file</dt><dd>StockUniteLegale_utf8.zip</dd>');
    expect(html.slice(html.indexOf('<ol class="timeline">'), html.indexOf('</ol>'))).not.toContain('<a ');

    // The diff is dated and headed.
    expect(html).toContain('<b>Change detected on</b> 5 Jan 2026');
    // The register name first and largest, under a small caption.
    expect(html).toContain('<span class="source__prefix">source</span>');
    expect(html).toContain('<code class="source__id">SIRENE</code>');
  });
});

describe('backTo', () => {
  const from = (referer: string | undefined) => backTo({ get: () => referer } as never);
  const base = 'http://localhost:3001';

  it('returns to the page the form was submitted from', () => {
    expect(from(`${base}/audits`)).toBe('/audits');
  });

  it('keeps the query the page needs', () => {
    expect(from(`${base}/audits?vatNumber=FR95884831538`)).toBe('/audits?vatNumber=FR95884831538');
  });

  /**
   * `?lang=` is consumed on arrival and saved. Leaving it in the URL would override every later
   * choice.
   */
  it('drops the lang it has already consumed, and only that', () => {
    expect(from(`${base}/?lang=fr`)).toBe('/');
    expect(from(`${base}/lookup?vat=FR95884831538&lang=en`)).toBe('/lookup?vat=FR95884831538');
  });

  it('refuses a referer that is not ours', () => {
    expect(from('https://example.com/audits')).toBe('/');
    expect(from(undefined)).toBe('/');
  });
});

/** The two callback pages, rendered in both languages, to catch missing translation keys. */
describe('the callback pages', () => {
  const base = {
    email: 'a@example.com',
    stripeReady: false,
    hasBillingAccount: false,
    apiBaseUrl: 'https://api.vatlas.dev',
  };

  const monitor = {
    publicId: '0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b',
    vatNumber: 'FR95884831538',
    url: null,
    lastSource: 'SIRENE',
    lastCheckedAt: new Date('2026-09-07T03:00:00Z'),
    lastChangedAt: null,
    lastDeliveredAt: null,
    createdAt: new Date('2026-09-01T09:00:00Z'),
  };

  const deliveries = [
    {
      publicId: 'd1',
      event: 'company.changed',
      url: 'https://example.test/hooks',
      attempt: 1,
      httpStatus: 200,
      error: null,
      durationMs: 42,
      sentAt: new Date('2026-09-07T03:00:01Z'),
    },
    // A failed attempt.
    {
      publicId: 'd2',
      event: 'monitor.test',
      url: 'https://example.test/hooks',
      attempt: 2,
      httpStatus: null,
      error: 'The operation was aborted due to timeout',
      durationMs: null,
      sentAt: new Date('2026-09-07T03:00:11Z'),
    },
  ];

  const lookup = {
    publicId: '0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5c',
    vatNumber: 'BG123456789',
    kind: 'proof',
    url: null,
    status: 'pending',
    attempts: 3,
    retryAfter: new Date('2026-09-08T12:00:00Z'),
    expiresAt: new Date('2026-09-14T12:00:00Z'),
    completedAt: null,
    deliveredAt: null,
    createdAt: new Date('2026-09-07T12:00:00Z'),
  };

  it.each(['en', 'fr'] as const)('renders every one of them in %s', (locale) => {
    const pages = [
      monitorsPage({
        ...base,
        locale,
        monitors: [monitor],
        limit: 3,
        monitorUrl: '',
        callbackSecret: 'vtl_sign_example',
      }),
      monitorDetailPage({
        ...base,
        locale,
        monitor: { ...monitor, last: { data: { name: 'EXAMPLE' } } },
        effectiveUrl: 'https://example.test/hooks',
        deliveries,
      }),
      // All three statuses, since each uses a different badge and translation key.
      asyncLookupsPage({
        ...base,
        locale,
        lookups: [lookup, { ...lookup, status: 'success' }, { ...lookup, status: 'failed' }],
        maxDays: 7,
        lookupAsyncUrl: '',
        callbackSecret: 'vtl_sign_example',
      }),
      asyncLookupDetailPage({
        ...base,
        locale,
        lookup: { ...lookup, response: { data: { name: 'EXAMPLE' } } },
        effectiveUrl: 'https://example.test/hooks',
        attempts: [
          {
            attemptedAt: new Date('2026-09-08T11:50:00Z'),
            outcome: 'unavailable',
            httpStatus: 503,
            errorCode: 'SOURCE_UNAVAILABLE',
            fault: 'MS_UNAVAILABLE',
            durationMs: 900,
          },
        ],
        deliveries: [],
      }),
    ];

    for (const html of pages) {
      expect(html).toContain('<!doctype html>');
      // A missing i18next key may render as the key itself, and a missing field as "undefined".
      expect(html).not.toMatch(/undefined|\[object Object\]/);
    }
  });

  it('says the list is full instead of offering a form that would be refused', () => {
    const full = monitorsPage({
      ...base,
      locale: 'en',
      monitors: [monitor, { ...monitor, publicId: 'b' }, { ...monitor, publicId: 'c' }],
      limit: 3,
      monitorUrl: 'https://example.test/hooks',
      callbackSecret: 'vtl_sign_example',
    });
    expect(full).toContain('This plan follows 3 companies');
    expect(full).not.toContain('name="vatNumber"');
  });

  // The signing secret must be readable, which is why it is encrypted rather than hashed.
  it('shows the signing secret in full', () => {
    const html = monitorsPage({
      ...base,
      locale: 'en',
      monitors: [],
      limit: 3,
      monitorUrl: '',
      callbackSecret: 'vtl_sign_example',
    });
    expect(html).toContain('vtl_sign_example');
  });

  // A monitor without its own URL uses the account's default, and the cell says so.
  it('marks a monitor that falls back to the default rather than leaving the cell empty', () => {
    const html = monitorsPage({
      ...base,
      locale: 'en',
      monitors: [monitor],
      limit: 3,
      monitorUrl: 'https://example.test/hooks',
      callbackSecret: 'vtl_sign_example',
    });
    expect(html).toContain('>Default<');
  });

  /**
   * Destructive buttons confirm through an `onsubmit` attribute, which is JavaScript: the HTML parser
   * decodes entities first, so an apostrophe in a French message used to break the script and the
   * form submitted without confirmation. This compiles every one of them.
   */
  it.each(['en', 'fr'] as const)('installs every confirmation handler in %s', (locale) => {
    const html =
      monitorsPage({
        ...base,
        locale,
        monitors: [monitor],
        limit: 3,
        monitorUrl: '',
        callbackSecret: 'vtl_sign_example',
      }) +
      asyncLookupsPage({
        ...base,
        locale,
        lookups: [lookup],
        maxDays: 7,
        lookupAsyncUrl: 'https://example.test/hooks',
        callbackSecret: 'vtl_sign_example',
      });

    const handlers = [...html.matchAll(/onsubmit="([^"]*)"/g)];
    expect(handlers.length).toBeGreaterThan(0);

    for (const [, attribute] of handlers) {
      // What the browser's HTML parser hands to the JavaScript compiler.
      const source = attribute!
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      expect(() => new Function(source)).not.toThrow();
    }
  });

  /**
   * A lookup that resolved but whose result the customer's endpoint refused must not show as
   * "Answered" in green.
   */
  it('does not call an undelivered answer a success', () => {
    const answered = { ...lookup, status: 'success' };
    const undelivered = asyncLookupsPage({
      ...base,
      locale: 'en',
      lookups: [answered],
      maxDays: 7,
      lookupAsyncUrl: 'https://example.test/hooks',
      callbackSecret: 'vtl_sign_example',
    });
    expect(undelivered).toContain('Not delivered');
    // On the badge text, not the class: `badge--ok` is also in the inlined stylesheet.
    expect(undelivered).not.toContain('>Answered<');

    const delivered = asyncLookupsPage({
      ...base,
      locale: 'en',
      lookups: [{ ...answered, deliveredAt: new Date('2026-09-08T12:00:00Z') }],
      maxDays: 7,
      lookupAsyncUrl: 'https://example.test/hooks',
      callbackSecret: 'vtl_sign_example',
    });
    expect(delivered).toContain('>Answered<');
    expect(delivered).not.toContain('Not delivered');
  });

  // Same for a monitor: the change happened, and nobody was told.
  it('flags a monitor whose last change never got through', () => {
    const changed = { ...monitor, lastChangedAt: new Date('2026-09-07T03:00:00Z') };
    const page = (row: typeof monitor) =>
      monitorsPage({
        ...base,
        locale: 'en',
        monitors: [row],
        limit: 3,
        monitorUrl: 'https://example.test/hooks',
        callbackSecret: 'vtl_sign_example',
      });

    expect(page(changed)).toContain('Not delivered');
    // Delivered after the change: nothing to flag.
    expect(page({ ...changed, lastDeliveredAt: new Date('2026-09-07T03:00:01Z') })).not.toContain('Not delivered');
    // Delivered, but before the change: this one did not get through.
    expect(page({ ...changed, lastDeliveredAt: new Date('2026-09-01T03:00:00Z') })).toContain('Not delivered');
  });

  // Only shown when something failed.
  it('offers a resend only when the last attempt failed', () => {
    const detail = (rows: typeof deliveries) =>
      monitorDetailPage({
        ...base,
        locale: 'en',
        monitor: { ...monitor, last: null },
        effectiveUrl: 'https://example.test/hooks',
        deliveries: rows,
      });

    // The service returns newest first, so `[0]` decides. The fixture is oldest first, hence the
    // reverse.
    const newestFirst = [...deliveries].reverse();
    expect(newestFirst[0]!.error).not.toBeNull();
    expect(detail(newestFirst)).toContain('/resend');
    expect(detail(deliveries)).not.toContain('/resend');
  });

  it('shows a failed delivery with what went wrong', () => {
    const html = monitorDetailPage({
      ...base,
      locale: 'en',
      monitor: { ...monitor, last: null },
      effectiveUrl: 'https://example.test/hooks',
      deliveries,
    });
    expect(html).toContain('No answer');
    expect(html).toContain('The operation was aborted due to timeout');
  });
});

describe('sign-in and sign-up pages', () => {
  // Consent is given once, at sign-up.
  it('asks for the Terms on sign-up and not on sign-in', () => {
    expect(signupPage('en', {})).toContain('name="terms"');
    expect(loginPage('en', {})).not.toContain('name="terms"');
  });

  // Always shown, otherwise it would reveal which addresses are old accounts.
  it('tells accounts from the magic-link days how to get a password', () => {
    const html = loginPage('fr', {});
    expect(html).toContain('Nous avons changé de mode de connexion');
    expect(html).toContain('href="/password/forgot"');
  });

  it('asks for a password on both forms', () => {
    expect(loginPage('en', {})).toContain('autocomplete="current-password"');
    expect(signupPage('en', {})).toContain('autocomplete="new-password"');
  });

  it('offers a fresh link rather than a form once a reset link is spent', () => {
    expect(resetPasswordPage('en', { expired: true })).not.toContain('action="/password/reset"');
    expect(resetPasswordPage('en', { token: 'abc' })).toContain('value="abc"');
  });
});

describe('email verification and onboarding', () => {
  const dashboard = {
    locale: 'en' as const,
    email: 'a@example.com',
    sampleKey: 'vtl_live_example',
    used: 0,
    quota: 100,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    resetAt: new Date('2026-10-01T00:00:00Z'),
    plan: 'free' as const,
    stripeReady: true,
    hasBillingAccount: false,
    history: [],
    monitorsUsed: 0,
    monitorsLimit: 1,
  };

  it('puts the banner on signed-in pages until the address is verified', () => {
    expect(dashboardPage({ ...dashboard, emailVerified: false })).toContain('role="status"');
    expect(dashboardPage({ ...dashboard, emailVerified: true })).not.toContain('role="status"');
  });

  it('shows the first steps, with the key, until they are dismissed', () => {
    const shown = dashboardPage({ ...dashboard, onboarding: true });
    expect(shown).toContain('action="/onboarding/dismiss"');
    expect(shown).toContain('Welcome to Vatlas');
    expect(shown).toContain('vtl_live_example');
    expect(dashboardPage({ ...dashboard, onboarding: false })).not.toContain('action="/onboarding/dismiss"');
  });

  // The card has the sample command, so the quick-start panel is hidden.
  it('shows the sample command once, in the card while it is there', () => {
    const count = (html: string) => html.split('/v1/lookup/FR95884831538').length - 1;
    expect(count(dashboardPage({ ...dashboard, onboarding: true }))).toBe(1);
    expect(count(dashboardPage({ ...dashboard, onboarding: false }))).toBe(1);
  });

  const account = {
    locale: 'en' as const,
    email: 'a@example.com',
    createdAt: new Date('2026-01-05T10:00:00Z'),
    plan: 'free' as const,
    quota: 100,
    status: 'active',
    activeKeys: 1,
    stripeReady: false,
    hasBillingAccount: false,
    hasPassword: true,
    profile: { companyName: '', vatNumber: '', line1: '', line2: '', postalCode: '', city: '', country: '' },
  };

  it('says on the account page whether the address is verified, with a way to verify it', () => {
    const unverified = accountPage({ ...account, emailVerified: false });
    expect(unverified).toContain('Not verified yet');
    expect(unverified).toContain('action="/verify-email/resend"');
    const verified = accountPage({ ...account, emailVerifiedAt: new Date('2026-09-02T00:00:00Z') });
    expect(verified).toContain('Verified on');
    expect(verified).not.toContain('action="/verify-email/resend"');
  });

  // An old magic-link account has no current password.
  it('asks for the current password only when there is one', () => {
    expect(accountPage(account)).toContain('name="current"');
    expect(accountPage({ ...account, hasPassword: false })).not.toContain('name="current"');
  });
});

describe('redactUrl', () => {
  it('keeps mailed tokens out of the request log', () => {
    expect(redactUrl('/password/reset?token=abc123&lang=fr')).toBe('/password/reset?token=[redacted]&lang=fr');
    expect(redactUrl('/verify-email?lang=en&token=xyz')).toBe('/verify-email?lang=en&token=[redacted]');
    expect(redactUrl('/keys')).toBe('/keys');
  });
});
