import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCALES, formatNumber } from '../src/console/i18n.js';
import { personalDataPage } from '../src/console/views.js';
import {
  ERASABLE,
  EXPORT_ROW_CAP,
  PAGE_ROW_CAP,
  SECTION_IDS,
  SECTION_TIER,
  isErasable,
  pageSections,
  toJsonExport,
  toTextExport,
  type PersonalDataRecord,
  type Section,
} from '../src/services/personalData.js';

/** A record with something in every section, so the page and the exports render real values. */
const record: PersonalDataRecord = {
  email: 'julien@example.com',
  generatedAt: '2026-09-09T10:00:00.000Z',
  sections: [
    {
      id: 'identity',
      kind: 'fields',
      fields: {
        email: 'julien@example.com',
        language: 'fr',
        plan: 'free',
        status: 'active',
        createdAt: '2026-01-05T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        deletedAt: null,
        inactivityWarnedAt: null,
      },
    },
    {
      id: 'consent',
      kind: 'fields',
      fields: {
        termsVersion: '2026-08-27',
        termsAcceptedAt: '2026-01-05T10:00:00.000Z',
        termsAcceptedIp: '203.0.113.4',
      },
    },
    {
      id: 'billing',
      kind: 'fields',
      fields: {
        companyName: 'ACME EURL',
        vatNumber: 'FR95884831538',
        line1: '9 rue des Colonnes',
        line2: null,
        postalCode: '75002',
        city: 'Paris',
        country: 'FR',
        createdAt: '2026-02-01T09:00:00.000Z',
        updatedAt: '2026-02-01T09:00:00.000Z',
      },
    },
    {
      id: 'payment',
      kind: 'fields',
      fields: {
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAt: null,
      },
    },
    {
      id: 'keys',
      kind: 'rows',
      total: 1,
      rows: [
        {
          name: 'default',
          key: 'vtl_live…ab12',
          createdAt: '2026-01-05T10:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    },
    {
      id: 'sessions',
      kind: 'rows',
      total: 1,
      rows: [
        {
          current: true,
          ip: '203.0.113.4',
          userAgent: 'Mozilla/5.0',
          createdAt: '2026-09-01T10:00:00.000Z',
          lastSeenAt: '2026-09-09T09:00:00.000Z',
          expiresAt: '2026-10-01T10:00:00.000Z',
        },
      ],
    },
    {
      id: 'links',
      kind: 'rows',
      total: 1,
      rows: [
        {
          purpose: 'reset_password',
          ip: '203.0.113.4',
          createdAt: '2026-09-01T10:00:00.000Z',
          expiresAt: '2026-09-01T10:30:00.000Z',
          consumedAt: '2026-09-01T10:01:00.000Z',
        },
      ],
    },
    {
      id: 'signins',
      kind: 'rows',
      total: 1,
      rows: [{ ip: '198.51.100.7', createdAt: '2026-09-02T08:00:00.000Z' }],
    },
    {
      id: 'callbacks',
      kind: 'fields',
      fields: { monitorUrl: 'https://example.com/hooks', lookupAsyncUrl: null, signingSecret: true },
    },
    {
      id: 'monitors',
      kind: 'rows',
      total: 1,
      rows: [
        {
          vatNumber: 'FR95884831538',
          url: null,
          lastSource: 'SIRENE',
          lastCheckedAt: '2026-09-08T02:00:00.000Z',
          lastChangedAt: null,
          lastDeliveredAt: null,
          createdAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    },
    {
      id: 'async',
      kind: 'rows',
      total: 1,
      rows: [
        {
          id: '0199a0f0-0000-7000-8000-000000000001',
          vatNumber: 'PL5252248481',
          kind: 'single',
          status: 'success',
          url: null,
          attempts: 2,
          createdAt: '2026-09-01T10:00:00.000Z',
          completedAt: '2026-09-01T10:10:00.000Z',
          deliveredAt: '2026-09-01T10:10:01.000Z',
        },
      ],
    },
    {
      id: 'deliveries',
      kind: 'rows',
      total: 1,
      rows: [
        {
          event: 'company.changed',
          url: 'https://example.com/hooks',
          attempt: 1,
          httpStatus: 200,
          error: null,
          sentAt: '2026-09-01T10:10:01.000Z',
        },
      ],
    },
    {
      id: 'audit',
      kind: 'rows',
      total: 4200,
      from: '2026-01-05T10:00:00.000Z',
      to: '2026-09-09T09:00:00.000Z',
      rows: [
        {
          id: '0199a0f0-0000-7000-8000-000000000002',
          fetchedAt: '2026-09-09T09:00:00.000Z',
          vatNumber: 'FR95884831538',
          kind: 'single',
          httpStatus: 200,
          errorCode: null,
          companyName: 'JULIEN MAULNY',
          source: 'SIRENE',
          sourceDate: '2026-09-01',
          proof: null,
        },
      ],
    },
    {
      id: 'usage',
      kind: 'rows',
      total: 1,
      rows: [
        {
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-10-01T00:00:00.000Z',
          plan: 'free',
          quota: 100,
          used: 12,
        },
      ],
    },
    { id: 'logs', kind: 'summary', total: 5312, from: '2026-06-11T10:00:00.000Z', to: '2026-09-09T09:00:00.000Z' },
  ],
};

const page = (locale: (typeof LOCALES)[number]) =>
  personalDataPage({ locale, email: record.email, stripeReady: true, hasBillingAccount: true, record });

describe('the inventory', () => {
  // Every section with a tier needs its five prose strings. A missing `data.*` key throws at render,
  // caught here.
  it('covers every shown section in every language', () => {
    for (const locale of LOCALES) {
      const html = page(locale);
      for (const id of SECTION_IDS) {
        if (SECTION_TIER[id] === null) expect(html).not.toContain(`data-section="${id}"`);
        else expect(html).toContain(`data-section="${id}"`);
      }
    }
  });

  /** The page sorts sections: personal data first, then account data, then data about other companies. */
  it('puts what is personal data above what is merely attached to the account', () => {
    const html = page('en');
    const at = (id: string) => html.indexOf(`data-section="${id}"`);

    expect(at('sessions')).toBeLessThan(at('keys'));
    expect(at('keys')).toBeLessThan(at('audit'));
    expect(html.indexOf('Your personal data')).toBeLessThan(html.indexOf('Your account data'));
    expect(html.indexOf('Your account data')).toBeLessThan(html.indexOf('Data about the companies you looked up'));
  });

  // Delivery records and callback URLs contain no personal data: in the exports, not on the page.
  it('drops the sections with nothing personal in them, and keeps them in the exports', () => {
    const html = page('en');
    for (const id of ['deliveries', 'callbacks'] as const) {
      expect(SECTION_TIER[id]).toBeNull();
      expect(html).not.toContain(`data-section="${id}"`);
      expect(JSON.parse(toJsonExport(record)).data[id]).toBeDefined();
      expect(toTextExport(record)).toContain(id.toUpperCase());
    }
  });

  // Row mechanics are hidden on the page and kept in the exports.
  it('hides the row mechanics from the page but not from the exports', () => {
    const shown = pageSections(record).find((section) => section.id === 'identity')!;
    expect(shown.fields).not.toHaveProperty('updatedAt');
    expect(shown.fields).toHaveProperty('email');
    expect(toJsonExport(record)).toContain('inactivityWarnedAt');
  });

  it('renders every field label in both languages', () => {
    // `fieldLabel` derives the key from the field name, so a field without a label throws.
    for (const locale of LOCALES) expect(() => page(locale)).not.toThrow();
  });

  it('says what is held, not only that something is', () => {
    const html = page('en');
    expect(html).toContain('julien@example.com');
    expect(html).toContain('9 rue des Colonnes');
    expect(html).toContain('203.0.113.4');
    // The legal basis is shown next to the value.
    expect(html).toContain('Performance of the contract.');
    expect(html).toContain('Legal basis');
  });

  it('quotes the audit retention from the configuration rather than from prose', () => {
    const html = page('en');
    // AUDIT_PRO_DAYS / AUDIT_FREE_KEEP are what the nightly job enforces.
    expect(html).toMatch(/\d+ days on the Pro plan/);
  });
});

describe('long listings', () => {
  const many: PersonalDataRecord = {
    ...record,
    sections: record.sections.map((section): Section =>
      section.id === 'audit'
        ? {
            ...section,
            total: 4200,
            rows: Array.from({ length: 12 }, (_, index) => ({
              ...section.rows![0]!,
              vatNumber: `FR9588483153${index}`,
            })),
          }
        : section,
    ),
  };

  it('shows five rows and says how many more there are', () => {
    const shown = pageSections(many).find((section) => section.id === 'audit')!;
    expect(shown.rows).toHaveLength(PAGE_ROW_CAP);
    // `total` is kept, so the page counts what it is not showing.
    expect(shown.total).toBe(4200);

    const html = personalDataPage({
      locale: 'en',
      email: record.email,
      stripeReady: false,
      hasBillingAccount: false,
      record: many,
    });
    expect(html).toContain(`and ${formatNumber(4195, 'en')} more`);
    expect(html).toContain('FR95884831534');
    expect(html).not.toContain('FR95884831535');
  });

  it('says it in French too', () => {
    const html = personalDataPage({
      locale: 'fr',
      email: record.email,
      stripeReady: false,
      hasBillingAccount: false,
      record: many,
    });
    // A narrow no-break space, the French thousands separator. Built with the same formatter.
    expect(html).toContain(`et ${formatNumber(4195, 'fr')} autres`);
  });

  // The exports still carry everything.
  it('leaves the exports untouched', () => {
    const parsed = JSON.parse(toJsonExport(many)) as { data: Record<string, { rows?: unknown[] }> };
    expect(parsed.data.audit?.rows).toHaveLength(12);
    expect(toTextExport(many)).toContain('FR95884831535');
  });
});

describe('erasure', () => {
  it('offers a button for every erasable section and an explanation for the others', () => {
    const html = page('en');
    for (const id of SECTION_IDS) {
      if (SECTION_TIER[id] === null) continue;
      const panel = html.slice(html.indexOf(`data-section="${id}"`));
      const own = panel.slice(0, panel.indexOf('</section>'));
      if (isErasable(id)) expect(own).toContain(`name="section" value="${id}"`);
      else expect(own).not.toContain('action="/data/erase"');
    }
  });

  // Counters, invoices and the account address are not erasable here, and each explains why.
  it('never offers to erase what the service has to keep', () => {
    for (const id of ['identity', 'consent', 'payment', 'keys', 'monitors', 'usage', 'logs'] as const) {
      expect(ERASABLE as readonly string[]).not.toContain(id);
    }
  });

  it('refuses a section name that is not on the list', () => {
    expect(isErasable('account')).toBe(false);
    expect(isErasable('__proto__')).toBe(false);
  });

  it('has nothing to delete rather than a button that deletes nothing', () => {
    const empty: PersonalDataRecord = {
      ...record,
      sections: record.sections.map((section): Section =>
        section.kind === 'rows' ? { ...section, rows: [], total: 0 } : section,
      ),
    };
    const html = personalDataPage({
      locale: 'en',
      email: record.email,
      stripeReady: false,
      hasBillingAccount: false,
      record: empty,
    });
    const panel = html.slice(html.indexOf('data-section="audit"'));
    expect(panel.slice(0, panel.indexOf('</section>'))).not.toContain('action="/data/erase"');
  });
});

describe('the exports', () => {
  it('carries every section in the JSON, with the count beside a capped listing', () => {
    const parsed = JSON.parse(toJsonExport(record)) as {
      export: { account: string; generatedAt: string };
      data: Record<string, { total?: number; included?: number; rows?: unknown[] }>;
    };

    expect(parsed.export.account).toBe('julien@example.com');
    for (const id of SECTION_IDS) expect(parsed.data[id]).toBeDefined();
    // The audit trail can overflow: the file says how many rows exist.
    expect(parsed.data.audit?.total).toBe(4200);
    expect(parsed.data.audit?.included).toBe(1);
    expect(parsed.data.logs).toEqual({ total: 5312, from: '2026-06-11T10:00:00.000Z', to: '2026-09-09T09:00:00.000Z' });
  });

  it('says the same thing in the text version', () => {
    const text = toTextExport(record);
    for (const id of SECTION_IDS) expect(text).toContain(id.toUpperCase());
    expect(text).toContain('julien@example.com');
    expect(text).toContain('9 rue des Colonnes');
    expect(text).toContain('4200 record(s), 1 listed below.');
    expect(text).toContain(String(EXPORT_ROW_CAP));
  });

  // No live credential in a downloaded file. Both are shown in the console instead.
  it('leaves the secrets out of both', () => {
    const json = toJsonExport(record);
    const text = toTextExport(record);
    for (const output of [json, text]) {
      expect(output).not.toContain('secretSealed');
      expect(output).not.toContain('callbackSecretSealed');
      expect(output).not.toContain('tokenHash');
    }
  });
});

describe('the inventory against the schema', () => {
  /**
   * Every table with `user_id` must be in the inventory. Reads the schema, so a forgotten table fails
   * here.
   */
  it('accounts for every table that carries a user id', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /\buserId\s+BigInt/.test(body!))
      .map(([, name]) => name!);

    // Every model and where it is covered. `Account` is split across four sections.
    const answered: Record<string, string> = {
      SecretKey: 'keys',
      Session: 'sessions',
      LoginToken: 'links',
      AuthAttempt: 'signins',
      UsagePeriod: 'usage',
      BillingProfile: 'billing',
      Monitor: 'monitors',
      AsyncLookup: 'async',
      Delivery: 'deliveries',
      AuditLookup: 'audit',
      LookupLog: 'logs',
    };

    for (const model of models) {
      expect(answered[model], `${model} carries user_id and is not in the inventory`).toBeDefined();
      expect(SECTION_IDS as readonly string[]).toContain(answered[model]!);
    }
  });
});
