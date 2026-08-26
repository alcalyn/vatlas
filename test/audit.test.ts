import { describe, expect, it } from 'vitest';
import { auditEntryFrom, allAuditEntryFrom } from '../src/services/audit.js';
import { ApiError } from '../src/api/errors.js';
import { parseAuditPruneArgs } from '../src/cli/auditPruneArgs.js';
import { auditPage } from '../src/console/views.js';
import type { LookupOutcome } from '../src/api/resolve.js';
import { asDay, type CompanyStatement, type StoredStatement } from '../src/api/types.js';
import type { SourceHistory } from '../src/api/countries/types.js';
import type { AuditRow } from '../src/services/audit.js';

const vat = { formatted: 'FR95884831538', countryCode: 'FR', nationalNumber: '884831538' } as const;
const caller = { userId: 7n, secretKeyId: 3n };

const statement: CompanyStatement = {
  vatNumber: 'FR95884831538',
  nationalId: '884831538',
  name: 'SARL JULIEN MAULNY EURL',
  legalForm: 'SARL',
  status: 'active',
  addressLine1: '9 RUE DES COLONNES',
  addressLine2: null,
  postalCode: '75002',
  city: 'PARIS',
  addressCountry: 'FR',
  companyLastUpdatedAt: null,
  source: 'SIRENE',
  dateStart: asDay(new Date('2026-08-01')),
  dateEnd: asDay(new Date('2026-08-01')),
  bulkId: null,
  proof: null,
};

describe('auditEntryFrom', () => {
  it('names the register that answered even when no source was called', () => {
    // A lookup served from storage makes no call, so the trace is empty. The answering register comes
    // first, then the others consulted.
    const stored: LookupOutcome = { status: 'found', vat, statement, consulted: [] };
    expect(auditEntryFrom(stored, {}, 200, caller)).toMatchObject({ sources: ['SIRENE'] });

    const alsoAsked: LookupOutcome = { status: 'found', vat, statement, consulted: ['VIES'] };
    expect(auditEntryFrom(alsoAsked, {}, 200, caller)).toMatchObject({ sources: ['SIRENE', 'VIES'] });
  });

  it('records the provenance of a hit, copied off the statement that answered', () => {
    const outcome: LookupOutcome = { status: 'found', vat, statement, consulted: ['SIRENE'] };
    const body = { data: { name: statement.name }, meta: { source: 'SIRENE' } };

    const entry = auditEntryFrom(outcome, body, 200, caller);

    expect(entry).toMatchObject({
      userId: 7n,
      secretKeyId: 3n,
      vatNumber: 'FR95884831538',
      httpStatus: 200,
      errorCode: null,
      companyName: 'SARL JULIEN MAULNY EURL',
      source: 'SIRENE',
      sourceDate: asDay(new Date('2026-08-01')),
      sources: ['SIRENE'],
    });
    // The envelope is stored as is, not rebuilt from the columns.
    expect(entry?.response).toBe(body);
  });

  it.each([
    ['not-registered', 404, 'VAT_NOT_REGISTERED'],
    ['unavailable', 503, 'SOURCE_UNAVAILABLE'],
    ['not-found', 404, 'COMPANY_NOT_FOUND'],
  ] as const)('labels a %s answer %s %s', (status, httpStatus, code) => {
    // The three misses are three different answers.
    const outcome = {
      status,
      vat,
      consulted: ['SIRENE', 'VIES'],
      statement: { ...statement, source: 'VIES', status: 'not_registered', name: null },
      failure: { fault: 'MS_MAX_CONCURRENT_REQ', attempts: 3 },
    } as unknown as LookupOutcome;

    const entry = auditEntryFrom(outcome, { error: { code } }, httpStatus, caller);

    expect(entry).toMatchObject({ httpStatus, errorCode: code, companyName: null });
  });

  it('keeps the verification code of an answer that carries one, and only of one', () => {
    // The searchable copy of `meta.proof`.
    const proved: LookupOutcome = {
      status: 'found',
      vat,
      statement: { ...statement, source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
      consulted: ['VIES'],
    };
    expect(auditEntryFrom(proved, {}, 200, caller)).toMatchObject({
      proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
    });

    const fromRegister: LookupOutcome = { status: 'found', vat, statement, consulted: ['SIRENE'] };
    expect(auditEntryFrom(fromRegister, {}, 200, caller)).toMatchObject({ proof: null });
  });

  it('keeps the verification code of a number a source reports as unregistered', () => {
    // The proof that a supplier was told "no" on that date.
    const outcome: LookupOutcome = {
      status: 'not-registered',
      vat,
      consulted: ['VIES'],
      statement: {
        ...statement,
        source: 'VIES',
        status: 'not_registered',
        name: null,
        proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
      },
    };

    expect(auditEntryFrom(outcome, {}, 404, caller)).toMatchObject({
      errorCode: 'VAT_NOT_REGISTERED',
      proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
      // A "no" keeps its provenance.
      source: 'VIES',
    });
  });

  it('records nothing for a caller with no account', () => {
    // The CLI has no account and no history.
    const outcome: LookupOutcome = { status: 'found', vat, statement, consulted: ['SIRENE'] };
    expect(auditEntryFrom(outcome, {}, 200, {})).toBeNull();
  });

  it('tags a proof lookup, so the history says which answers can be shown to somebody else', () => {
    // A plain lookup row. Only `kind` says a proof was required.
    const outcome: LookupOutcome = {
      status: 'found',
      vat,
      statement: { ...statement, source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
      consulted: ['VIES'],
    };

    expect(auditEntryFrom(outcome, {}, 200, caller, { prefer: 'proof' })).toMatchObject({ kind: 'proof' });
    expect(auditEntryFrom(outcome, {}, 200, caller)).toMatchObject({ kind: 'single' });
  });
});

describe('allAuditEntryFrom', () => {
  const stored: StoredStatement = { ...statement, bulk: null };
  const sources: SourceHistory[] = [
    { source: 'SIRENE', name: 'SIRENE (INSEE)', kind: 'bulk', history: [stored] },
    {
      source: 'VIES',
      name: 'VIES (European Commission)',
      kind: 'live',
      history: [{ ...stored, source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' }],
    },
  ];

  it('tags the row all and keeps the two columns the history is searched on', () => {
    const body = { data: { sources: [] } };

    const entry = allAuditEntryFrom({ vat, sources }, body, caller);

    expect(entry).toMatchObject({
      userId: 7n,
      vatNumber: 'FR95884831538',
      kind: 'all',
      httpStatus: 200,
      companyName: 'SARL JULIEN MAULNY EURL',
      proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
      sources: ['SIRENE', 'VIES'],
      response: body,
    });
  });

  it('names no single provenance, because the report deliberately picks no winner', () => {
    const entry = allAuditEntryFrom({ vat, sources }, {}, caller);

    expect(entry).toMatchObject({ errorCode: null, source: null, sourceDate: null });
  });

  it('is still a 200 when every source failed - the report was produced', () => {
    const failed: SourceHistory[] = [
      {
        source: 'VIES',
        name: 'VIES (European Commission)',
        kind: 'live',
        history: [],
        call: { status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE', attempts: 4 } },
      },
    ];

    expect(allAuditEntryFrom({ vat, sources: failed }, {}, caller)).toMatchObject({
      httpStatus: 200,
      companyName: null,
      proof: null,
      sources: ['VIES'],
    });
  });

  it('records nothing for a caller with no account', () => {
    expect(allAuditEntryFrom({ vat, sources }, {}, {})).toBeNull();
  });
});

describe('ApiError.toBody', () => {
  it('produces the envelope the error handler sends', () => {
    const error = new ApiError(503, 'SOURCE_UNAVAILABLE', 'VIES did not answer', { checked: ['VIES'] });
    expect(error.toBody()).toEqual({
      error: { code: 'SOURCE_UNAVAILABLE', message: 'VIES did not answer' },
      meta: { checked: ['VIES'] },
    });
  });

  it('omits meta entirely when there is none, rather than sending a null', () => {
    expect(new ApiError(404, 'COMPANY_NOT_FOUND', 'nope').toBody()).toEqual({
      error: { code: 'COMPANY_NOT_FOUND', message: 'nope' },
    });
  });
});

describe('parseAuditPruneArgs', () => {
  it('refuses to run with no criterion at all', () => {
    // A purge with no window and no cap would empty the table.
    expect(parseAuditPruneArgs([])).toEqual({ error: 'Nothing to do: pass --older-than, --keep or --policy' });
  });

  it('reads a window, a cap and a plan', () => {
    expect(parseAuditPruneArgs(['--plan', 'free', '--older-than', '90', '--keep', '1000'])).toEqual({
      plans: ['free'],
      olderThanDays: 90,
      keepPerAccount: 1000,
      dryRun: false,
    });
  });

  it('walks both plans by default', () => {
    expect(parseAuditPruneArgs(['--older-than', '30', '--dry-run'])).toMatchObject({
      plans: ['free', 'pro'],
      dryRun: true,
    });
  });

  it('applies the published windows with --policy, and only on its own', () => {
    expect(parseAuditPruneArgs(['--policy'])).toEqual({
      plans: ['free', 'pro'],
      olderThanDays: undefined,
      keepPerAccount: undefined,
      dryRun: false,
    });
    expect(parseAuditPruneArgs(['--policy', '--keep', '10'])).toMatchObject({
      error: expect.stringContaining('--policy'),
    });
  });

  it.each([
    [['--plan', 'gold', '--keep', '5'], '--plan'],
    [['--older-than', 'ninety'], '--older-than'],
    [['--keep', '-3'], '--keep'],
    [['--purge-everything'], 'Unknown argument'],
  ])('rejects %s', (args, mention) => {
    // An unknown flag is an error: ignoring it on a delete command could widen the purge.
    const parsed = parseAuditPruneArgs(args);
    expect('error' in parsed && parsed.error).toContain(mention);
  });
});

describe('auditPage', () => {
  const base = {
    locale: 'en' as const,
    email: 'dev@example.com',
    query: '',
    queryError: false,
    matches: [],
    recent: [],
    retentionKeep: 3,
    retentionDays: 730,
    stripeReady: true,
    apiBaseUrl: 'https://api.vatlas.dev',
  };

  it('tells a free account that three rows is the whole of it', () => {
    // A history that stops after three rows without explanation looks like data loss.
    const html = auditPage({ ...base, plan: 'free' });
    expect(html).toContain('only your last 3 answers');
    expect(html).toContain('/billing/checkout');
    expect(html).not.toContain('keeps this history for 730 days');
  });

  it('states the window on the paid plan, and does not try to sell it again', () => {
    const html = auditPage({ ...base, plan: 'pro' });
    expect(html).toContain('keeps this history for 730 days');
    expect(html).not.toContain('/billing/checkout');
  });

  it('offers a runnable command, with the account’s own key when there is one', () => {
    const html = auditPage({ ...base, plan: 'pro', sampleKey: 'vtl_live_abc' });
    expect(html).toContain('https://api.vatlas.dev/v1/audit?vatNumber=FR95884831538');
    expect(html).toContain('Authorization: Bearer vtl_live_abc');
  });

  it('falls back to the documented variable rather than a key that would 401', () => {
    expect(auditPage({ ...base, plan: 'free' })).toContain('Bearer $VATLAS_KEY');
  });

  it('escapes a searched number rather than reflecting it into the page', () => {
    // `query` is echoed into the search field and comes from the URL.
    const html = auditPage({ ...base, plan: 'free', query: '<script>x</script>', queryError: true });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('the internal id never reaches a page or a payload', () => {
  it('is not part of the row type the console and the API are handed', () => {
    // `AuditRow` only has `publicId` as identifier. This is a type test too: adding `id` back breaks it.
    const row: AuditRow = {
      publicId: '01a0570f-5f96-77a0-9bf3-b990b0368c0c',
      vatNumber: 'FR95884831538',
      kind: 'single',
      httpStatus: 200,
      errorCode: null,
      origin: 'database',
      companyName: 'ACME',
      source: 'SIRENE',
      sourceFile: null,
      sourceDate: null,
      response: {},
      fetchedAt: new Date('2026-06-14T09:12:03Z'),
    };
    expect(Object.keys(row)).not.toContain('id');
  });
});

describe('the audit listing tells the two kinds of call apart', () => {
  const base = {
    locale: 'en' as const,
    email: 'dev@example.com',
    query: '',
    queryError: false,
    matches: [],
    retentionKeep: 3,
    retentionDays: 730,
    stripeReady: true,
    apiBaseUrl: 'https://api.vatlas.dev',
    plan: 'pro' as const,
  };

  const row = (over: Partial<AuditRow>): AuditRow => ({
    publicId: '01a0570f-5f96-77a0-9bf3-b990b0368c0c',
    vatNumber: 'FR95884831538',
    kind: 'single',
    httpStatus: 200,
    errorCode: null,
    origin: 'database',
    companyName: 'ACME',
    source: 'SIRENE',
    sourceFile: null,
    sourceDate: null,
    viesConsultationNumber: null,
    response: {},
    fetchedAt: new Date('2026-06-14T09:12:03Z'),
    ...over,
  });

  it('shows the verdict of a plain lookup', () => {
    expect(auditPage({ ...base, recent: [row({})] })).toContain('Found');
  });

  it('tags a complete report instead of claiming a verdict it does not have', () => {
    // Its flat columns say 200 whatever the sources said, so a status badge would read "Found" even if
    // every source failed.
    const html = auditPage({ ...base, recent: [row({ kind: 'all', companyName: null, origin: null })] });

    expect(html).toContain('>all<');
    expect(html).not.toContain('Found');
  });
});
