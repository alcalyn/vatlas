import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupLogEntry } from '../src/db/companyRepository.js';
import type { CompanyStatement, StatementInput, StoredStatement } from '../src/api/types.js';

/**
 * The resolution: which sources a country reads and which it asks.
 *
 * Storage is a map passed to `latestBySource`. VIES is stubbed at `fetch`, so the parser is
 * exercised too.
 */

const dbStub: {
  stored: Map<string, StoredStatement>;
  reads: string[];
  written: StatementInput[];
  logs: LookupLogEntry[];
} = { stored: new Map(), reads: [], written: [], logs: [] };

vi.mock('../src/db/companyHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/companyHistory.js')>();
  return {
    ...actual,
    latestBySource: async (vatNumber: string) => {
      dbStub.reads.push(vatNumber);
      return dbStub.stored;
    },
    // A first answer opens a plateau starting and ending today.
    recordStatement: async (input: StatementInput): Promise<CompanyStatement> => {
      dbStub.written.push(input);
      const { date, ...rest } = input;
      return { ...rest, dateStart: date, dateEnd: date };
    },
  };
});

vi.mock('../src/db/companyRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/companyRepository.js')>();
  return {
    ...actual,
    insertLookupLog: async (entry: LookupLogEntry) => {
      dbStub.logs.push(entry);
    },
    insertSourceCallLog: async () => {},
  };
});

const { lookupVat } = await import('../src/api/resolve.js');
const { resetMemberStateCooldowns } = await import('../src/api/sources/live/europe-vies.js');
const { asDay, today } = await import('../src/api/types.js');

/** A `checkVatApprox` reply, as VIES sends it. */
function soap(options: { valid?: boolean; name?: string; identifier?: string | null } = {}): Response {
  const { valid = true, name = 'ACME LIMITED', identifier = '908a3b38-e0dc-4502-8b06-d057eeac6861' } = options;
  return new Response(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
       <checkVatApproxResponse>
         <valid>${valid}</valid>
         <traderName>${name}</traderName>
         <traderAddress>---</traderAddress>
         <requestIdentifier>${identifier ?? ''}</requestIdentifier>
       </checkVatApproxResponse>
     </soap:Body></soap:Envelope>`,
    { status: 200 },
  );
}

/** A SOAP fault, which VIES sends with HTTP 200. */
function fault(name: string): Response {
  return new Response(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
       <soap:Fault><faultstring>${name}</faultstring></soap:Fault>
     </soap:Body></soap:Envelope>`,
    { status: 200 },
  );
}

/** Anything other than VIES answers 404, a plain miss. */
function stubVies(reply: () => Response): void {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('ec.europa.eu')) return reply();
    return new Response('{}', { status: 404 });
  });
}

const sireneRow: StoredStatement = {
  vatNumber: 'FR95884831538',
  nationalId: '884831538',
  name: 'SARL JULIEN MAULNY EURL',
  legalForm: null,
  status: 'active',
  addressLine1: '12 rue de la Paix',
  addressLine2: null,
  postalCode: '75002',
  city: 'Paris',
  addressCountry: 'FR',
  companyLastUpdatedAt: null,
  source: 'SIRENE',
  dateStart: asDay(new Date('2026-08-01T00:00:00.000Z')),
  dateEnd: asDay(new Date('2026-08-01T00:00:00.000Z')),
  bulkId: null,
  proof: null,
  bulk: null,
};

/** A plateau seen on one day only. */
function plateau(day: string): { dateStart: Date; dateEnd: Date } {
  return { dateStart: asDay(new Date(day)), dateEnd: asDay(new Date(day)) };
}

function reset(): void {
  dbStub.stored = new Map();
  dbStub.reads = [];
  dbStub.written = [];
  dbStub.logs = [];
  resetMemberStateCooldowns();
  stubVies(() => soap());
}

describe('the resolution order', () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  it('answers from the stored history without asking a single source', async () => {
    // The fast path: SIRENE's latest file is SIRENE's latest statement, so nothing is called. `fetch`
    // throwing would fail the test.
    dbStub.stored.set('SIRENE', sireneRow);
    vi.stubGlobal('fetch', async () => {
      throw new Error('no source should be consulted when the history already names the company');
    });

    const outcome = await lookupVat('FR95884831538');

    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    expect(outcome.statement.source).toBe('SIRENE');
    expect(dbStub.reads).toEqual(['FR95884831538']);
  });

  it('never lets a bulk statement go stale, however old the file is', async () => {
    // A file published in 2019 is still that register's latest publication, not stale.
    dbStub.stored.set('SIRENE', { ...sireneRow, ...plateau('2019-01-01T00:00:00.000Z') });
    vi.stubGlobal('fetch', async () => {
      throw new Error('a bulk statement has no freshness window');
    });

    await expect(lookupVat('FR95884831538')).resolves.toMatchObject({ status: 'found' });
  });

  it('asks a live source when nothing stored names the company', async () => {
    const outcome = await lookupVat('BG000670602');

    expect(outcome).toMatchObject({ status: 'found' });
    if (outcome.status !== 'found') return;
    expect(outcome.statement.source).toBe('VIES');
    expect(outcome.consulted).toEqual(['VIES']);
  });

  it('reads the history for every country, including the ones nothing imports', async () => {
    // Poland is never imported but accumulates rows one lookup at a time. Every country has a history.
    await lookupVat('PL5260250274');
    expect(dbStub.reads).toEqual(['PL5260250274']);
  });

  it('stores what a live source answered, VIES included', async () => {
    // A VIES answer is stored like any other, under its own source and dated by the call.
    await lookupVat('BG000670602');

    expect(dbStub.written).toHaveLength(1);
    expect(dbStub.written[0]).toMatchObject({
      source: 'VIES',
      vatNumber: 'BG000670602',
      name: 'ACME LIMITED',
      date: today(),
      proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
    });
  });

  it('serves a fresh stored VIES answer rather than asking again', async () => {
    // A fresh stored VIES answer is reused.
    dbStub.stored.set('VIES', {
      ...sireneRow,
      vatNumber: 'BG000670602',
      source: 'VIES',
      name: 'STORED BULGARIAN AD',
      dateStart: today(),
      dateEnd: today(),
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('a statement inside the freshness window must not be re-asked');
    });

    await expect(lookupVat('BG000670602')).resolves.toMatchObject({
      status: 'found',
      statement: { name: 'STORED BULGARIAN AD' },
    });
  });

  it('treats a long-standing plateau as fresh when it was confirmed today', async () => {
    // VIES has said the same since June and confirmed it this morning: `dateStart` is sixty days old,
    // `dateEnd` is today. Judging freshness on `dateStart` would call VIES on every lookup.
    dbStub.stored.set('VIES', {
      ...sireneRow,
      vatNumber: 'BG000670602',
      source: 'VIES',
      name: 'LONG-STANDING AD',
      dateStart: asDay(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)),
      dateEnd: today(),
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('a plateau confirmed today is fresh, whenever it opened');
    });

    await expect(lookupVat('BG000670602')).resolves.toMatchObject({
      status: 'found',
      statement: { name: 'LONG-STANDING AD' },
    });
  });

  it('asks again once a live statement has aged past the window', async () => {
    dbStub.stored.set('VIES', {
      ...sireneRow,
      vatNumber: 'BG000670602',
      source: 'VIES',
      name: 'STALE',
      dateStart: asDay(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
      dateEnd: asDay(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    });

    await expect(lookupVat('BG000670602')).resolves.toMatchObject({
      status: 'found',
      statement: { name: 'ACME LIMITED' },
    });
  });

  it('falls back to a stale statement when the source will not answer', async () => {
    // When the source does not answer, yesterday's answer beats none, and `dateEnd` gives its age.
    // Works for every live source.
    const old = asDay(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    dbStub.stored.set('VIES', {
      ...sireneRow,
      vatNumber: 'BG000670602',
      source: 'VIES',
      name: 'STALE',
      dateStart: old,
      dateEnd: old,
    });
    stubVies(() => fault('MS_UNAVAILABLE'));

    await expect(lookupVat('BG000670602')).resolves.toMatchObject({
      status: 'found',
      statement: { name: 'STALE', dateEnd: old },
    });
  });

  it('never pairs an old proof with a fresh date when the fallback is used', async () => {
    // A consultation number proves a check on a given day, so `proof` and `dateEnd` must stay together.
    // During an outage the old proof is published with the old date, never today's.
    const old = asDay(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    dbStub.stored.set('VIES', {
      ...sireneRow,
      vatNumber: 'BG000670602',
      source: 'VIES',
      name: 'STALE',
      dateStart: old,
      dateEnd: old,
      proof: 'the-proof-of-the-old-check',
    });
    stubVies(() => fault('MS_UNAVAILABLE'));

    const outcome = await lookupVat('BG000670602');

    expect(outcome).toMatchObject({
      status: 'found',
      statement: { proof: 'the-proof-of-the-old-check', dateEnd: old },
    });
    // Nothing written: the source made no new statement.
    expect(dbStub.written).toEqual([]);
  });

  it('reports a member state that would not answer as unavailable, with its fault', async () => {
    stubVies(() => fault('MS_UNAVAILABLE'));

    const outcome = await lookupVat('DK29979812');

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.failure.fault).toBe('MS_UNAVAILABLE');
    // The fault and attempts, needed to diagnose the 503.
    expect(dbStub.logs.at(-1)).toMatchObject({ fault: 'MS_UNAVAILABLE' });
  });

  it('stores a "not registered" answer, because it is a dated claim', async () => {
    stubVies(() => soap({ valid: false, identifier: null }));

    const outcome = await lookupVat('BG000670602');

    expect(outcome.status).toBe('not-registered');
    expect(dbStub.written[0]).toMatchObject({ source: 'VIES', status: 'not_registered', name: null });
  });
});

/** `?prefer=proof`: which sources are consulted and what is refused. */
describe('a lookup that prefers a proof', () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  it('skips the stored history even when it holds the answer', async () => {
    // The stored row may be right but proves nothing, so it is not read.
    dbStub.stored.set('SIRENE', sireneRow);

    const outcome = await lookupVat('FR95884831538', {}, { prefer: 'proof' });

    expect(dbStub.reads).toEqual([]);
    expect(outcome.consulted).toEqual(['VIES']);
    expect(outcome).toMatchObject({
      status: 'found',
      statement: { source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
    });
  });

  it('skips a source that issues no proof, and leaves no trace of one it never asked', async () => {
    // Poland's API would answer first on a plain lookup. Here it is skipped (`issuesProof` is false),
    // and the trace only names VIES.
    const outcome = await lookupVat('PL5260250274', {}, { prefer: 'proof' });

    expect(outcome.consulted).toEqual(['VIES']);
  });

  it('tags the row so the coverage aggregates can leave it out', async () => {
    // A proof lookup skips storage, so it is logged with its own kind.
    await lookupVat('FR95884831538', {}, { prefer: 'proof' });
    expect(dbStub.logs.at(-1)).toMatchObject({ kind: 'proof' });

    dbStub.stored.set('SIRENE', sireneRow);
    await lookupVat('FR95884831538');
    expect(dbStub.logs.at(-1)).toMatchObject({ kind: 'single' });
  });

  it('refuses a positive answer VIES issued no number for', async () => {
    // A valid answer without a proof: unavailable, not a miss.
    stubVies(() => soap({ identifier: null }));

    const outcome = await lookupVat('FR95884831538', {}, { prefer: 'proof' });

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.failure.fault).toBe('NO_CONSULTATION_NUMBER');
  });

  it('refuses an unproved "not registered" too', async () => {
    // VIES issues no identifier for an unregistered number, so a proof lookup answers 503 here.
    stubVies(() => soap({ valid: false, identifier: null }));

    const outcome = await lookupVat('FR95884831538', {}, { prefer: 'proof' });

    expect(outcome.status).toBe('unavailable');
    expect(dbStub.logs.at(-1)).toMatchObject({ fault: 'NO_CONSULTATION_NUMBER', kind: 'proof' });
  });

  it('still answers a plain lookup with no proof at all', async () => {
    // Without the parameter, an answer without proof is still served, without `meta.proof`.
    stubVies(() => soap({ identifier: null }));

    const outcome = await lookupVat('FR95884831538');

    expect(outcome).toMatchObject({ status: 'found', statement: { source: 'VIES', proof: null } });
  });
});
