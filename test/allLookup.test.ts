import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupLogEntry } from '../src/db/companyRepository.js';
import type { CompanyStatement, StatementInput, StoredStatement } from '../src/api/types.js';

/**
 * `/v1/lookup-all` is tested on what it must not leave out: which sources appear, which cannot,
 * and that a failing source becomes a line in the report rather than an exception.
 *
 * Storage and network are both stubbed, like in `lookup.test.ts`.
 */

const dbStub: {
  history: Map<string, StoredStatement[]>;
  reads: string[];
  latestReads: string[];
  written: StatementInput[];
  logs: LookupLogEntry[];
} = { history: new Map(), reads: [], latestReads: [], written: [], logs: [] };

vi.mock('../src/db/companyHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/companyHistory.js')>();
  return {
    ...actual,
    historyBySource: async (vatNumber: string) => {
      dbStub.reads.push(vatNumber);
      return dbStub.history;
    },
    latestBySource: async (vatNumber: string) => {
      dbStub.latestReads.push(vatNumber);
      return new Map([...dbStub.history].flatMap(([id, rows]) => (rows.at(-1) ? [[id, rows.at(-1)!] as const] : [])));
    },
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

const { lookupVatAll } = await import('../src/api/resolveAll.js');
const { resetMemberStateCooldowns } = await import('../src/api/sources/live/europe-vies.js');
const { asDay, today } = await import('../src/api/types.js');
const { config } = await import('../src/config.js');

function soap(options: { valid?: boolean } = {}): Response {
  const { valid = true } = options;
  return new Response(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
       <checkVatApproxResponse>
         <valid>${valid}</valid>
         <traderName>ACME LIMITED</traderName>
         <traderAddress>---</traderAddress>
         <requestIdentifier>908a3b38-e0dc-4502-8b06-d057eeac6861</requestIdentifier>
       </checkVatApproxResponse>
     </soap:Body></soap:Envelope>`,
    { status: 200 },
  );
}

function fault(name: string): Response {
  return new Response(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
       <soap:Fault><faultstring>${name}</faultstring></soap:Fault>
     </soap:Body></soap:Envelope>`,
    { status: 200 },
  );
}

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
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  addressCountry: 'FR',
  companyLastUpdatedAt: null,
  source: 'SIRENE',
  dateStart: asDay(new Date('2026-01-05T00:00:00.000Z')),
  dateEnd: asDay(new Date('2026-01-05T00:00:00.000Z')),
  bulkId: 1n,
  proof: null,
  bulk: {
    id: 1n,
    source: 'SIRENE',
    url: 'https://data.gouv.fr/…',
    fileName: 'StockUniteLegale_utf8.zip',
    date: asDay(new Date('2026-01-05T00:00:00.000Z')),
  },
};

function reset(): void {
  dbStub.history = new Map();
  dbStub.reads = [];
  dbStub.latestReads = [];
  dbStub.written = [];
  dbStub.logs = [];
  resetMemberStateCooldowns();
  stubVies(() => soap());
}

describe("which sources every source's answer holds", () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  it('lists the bulk source and the live one, in the order the country ranks them', async () => {
    dbStub.history.set('SIRENE', [sireneRow]);

    const report = await lookupVatAll('FR95884831538');

    expect(report.sources.map((source) => source.source)).toEqual(['SIRENE', 'VIES']);
    expect(report.sources[0]).toMatchObject({ kind: 'bulk' });
    // The source file is published, and the date is the file's edition, not the time of this call.
    expect(report.sources[0]?.history[0]).toMatchObject({
      dateStart: asDay(new Date('2026-01-05T00:00:00.000Z')),
      bulk: { fileName: 'StockUniteLegale_utf8.zip' },
    });
    expect(report.sources[1]).toMatchObject({ kind: 'live' });
  });

  it('lists a source with an empty history rather than leaving it out', async () => {
    // A register holding nothing for this number is still reported.
    const report = await lookupVatAll('FR95884831538');

    expect(report.sources[0]).toMatchObject({ source: 'SIRENE', kind: 'bulk', history: [] });
  });

  it('omits a bulk source for a country that has none', async () => {
    // Bulgaria imports nothing, so there is no bulk entry.
    const report = await lookupVatAll('BG000670602');

    expect(report.sources.map((source) => source.source)).toEqual(['VIES']);
  });

  it('omits a source this deployment cannot reach at all', async () => {
    const enabled = config.vies.enabled;
    Object.defineProperty(config.vies, 'enabled', { value: false, configurable: true });
    try {
      const report = await lookupVatAll('BG000670602');

      // Nothing left to ask for Bulgaria, still a report and still a 200.
      expect(report.sources).toEqual([]);
    } finally {
      Object.defineProperty(config.vies, 'enabled', { value: enabled, configurable: true });
    }
  });

  it('asks every live source, where a plain lookup would have stopped at the first', async () => {
    // Poland has its own API. Unlike `lookupVat`, this asks both, and the White List's miss must appear.
    const report = await lookupVatAll('PL5260250274');

    expect(report.sources.map((source) => source.source)).toEqual(['MF_WL', 'VIES']);
    expect(report.sources[0]?.call).toMatchObject({ status: 'not-found' });
    expect(report.sources[1]?.call).toMatchObject({ status: 'found' });
  });

  it('reads the plateau in force and not the whole history under history: false', async () => {
    // The option saves a query, not only a field.
    dbStub.history.set('SIRENE', [{ ...sireneRow, dateStart: asDay(new Date('2025-01-05T00:00:00.000Z')) }, sireneRow]);

    const report = await lookupVatAll('FR95884831538', {}, { history: false });

    expect(dbStub.reads).toEqual([]);
    expect(dbStub.latestReads).toEqual(['FR95884831538']);
    expect(report.history).toBe(false);
    expect(report.sources[0]?.history).toHaveLength(1);
  });

  it('does not call a live source whose stored statement is still fresh', async () => {
    dbStub.history.set('VIES', [
      {
        ...sireneRow,
        vatNumber: 'BG000670602',
        source: 'VIES',
        bulkId: null,
        bulk: null,
        dateStart: today(),
        dateEnd: today(),
      },
    ]);
    vi.stubGlobal('fetch', async () => {
      throw new Error('a statement inside the freshness window must not be re-asked');
    });

    const report = await lookupVatAll('BG000670602');

    expect(report.sources[0]?.call).toBeUndefined();
    expect(report.sources[0]?.history).toHaveLength(1);
  });
});

describe('a source that fails', () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  // MS_UNAVAILABLE is transient, so VIES runs its full retry ladder (four attempts, about six seconds).
  // The test timeout is raised rather than the ladder shortened.
  it('becomes a line in the report, and does not take the other sources with it', { timeout: 20_000 }, async () => {
    dbStub.history.set('SIRENE', [sireneRow]);
    stubVies(() => fault('MS_UNAVAILABLE'));

    const report = await lookupVatAll('FR95884831538');

    // The stored SIRENE statement still comes back, with the failure published next to it.
    expect(report.sources[0]?.history).toHaveLength(1);
    expect(report.sources[1]).toMatchObject({
      source: 'VIES',
      call: { status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE' } },
    });
  });

  it('carries the fault and the attempt count, which is what tells an outage from a throttle', async () => {
    stubVies(() => fault('MS_MAX_CONCURRENT_REQ'));

    const report = await lookupVatAll('BG000670602');

    expect(report.sources[0]?.call).toMatchObject({
      status: 'unavailable',
      failure: { fault: 'MS_MAX_CONCURRENT_REQ', attempts: 2 },
    });
  });

  it('reports a number a source says is not registered as that, and not as a miss', async () => {
    stubVies(() => soap({ valid: false }));

    const report = await lookupVatAll('BG000670602');

    expect(report.sources[0]?.call).toMatchObject({ status: 'not-registered' });
    // And it is stored, since it is a dated claim.
    expect(report.sources[0]?.history.at(-1)).toMatchObject({ status: 'not_registered' });
  });
});

describe('what a lookup-all leaves behind', () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  it('writes one lookup log row for the whole report, marked all', async () => {
    dbStub.history.set('SIRENE', [sireneRow]);

    await lookupVatAll('FR95884831538');

    expect(dbStub.logs).toHaveLength(1);
    expect(dbStub.logs[0]).toMatchObject({ kind: 'all', status: 'found' });
    // No single source is named: several answered.
    expect(dbStub.logs[0]?.source).toBeUndefined();
  });

  it('stores what the live sources answered, so the next report starts from a fuller history', async () => {
    await lookupVatAll('BG000670602');

    expect(dbStub.written).toHaveLength(1);
    expect(dbStub.written[0]).toMatchObject({ source: 'VIES', vatNumber: 'BG000670602', date: today() });
  });

  it('counts a malformed number without consulting a single source', async () => {
    await expect(lookupVatAll('FR123')).rejects.toThrow();

    expect(dbStub.reads).toEqual([]);
    expect(dbStub.logs[0]).toMatchObject({ kind: 'all', status: 'invalid', success: false });
  });
});
