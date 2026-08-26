import { describe, expect, it } from 'vitest';
import { serialize, serializeAll, toApiError } from '../src/api/routes.js';
import type { SourceHistory } from '../src/api/countries/types.js';
import type { LookupOutcome } from '../src/api/resolve.js';
import { asDay, type CompanyStatement, type StoredStatement } from '../src/api/types.js';

/**
 * The response envelope. `http/*.http` checks it against a live service but is not run by
 * `npm test`. One shape whatever the source, and `meta.proof` only when there is a proof.
 */
const vat = { formatted: 'FR95884831538', countryCode: 'FR', nationalNumber: '884831538' } as const;

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
  companyLastUpdatedAt: new Date('2025-12-06T09:43:55.000Z'),
  source: 'SIRENE',
  dateStart: asDay(new Date('2026-01-05T00:00:00.000Z')),
  dateEnd: asDay(new Date('2026-01-05T00:00:00.000Z')),
  bulkId: null,
  proof: null,
};

const found = (over: Partial<CompanyStatement> = {}): Extract<LookupOutcome, { status: 'found' }> => ({
  status: 'found',
  vat,
  statement: { ...statement, ...over },
  consulted: [],
});

describe('the success envelope', () => {
  it('publishes a VIES answer with its consultation number, under an abstract proof object', () => {
    // `{ type, value }` rather than a string, so another kind of proof would be a new type.
    const body = serialize(found({ source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' }));

    expect(body.meta).toEqual({
      source: 'VIES',
      sourceDate: '2026-01-05',
      sourceSince: '2026-01-05',
      sourceUpdatedAt: statement.companyLastUpdatedAt,
      proof: { type: 'vies_consultation_number', value: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
    });
  });

  it('leaves proof out entirely on a source that issues none', () => {
    // Absent, not null.
    expect(serialize(found()).meta).not.toHaveProperty('proof');
  });

  it('names no origin any more, only the register and the date it spoke', () => {
    // `meta.origin` was removed.
    expect(serialize(found()).meta).not.toHaveProperty('origin');
  });

  it('dates the answer by when the source last confirmed it, and says since when separately', () => {
    // The two ends of the plateau: `sourceSince` and `sourceDate` (freshness). Publishing only
    // `dateStart` would make every long-standing record look stale.
    const body = serialize(found({ dateStart: asDay(new Date('2026-01-05')), dateEnd: asDay(new Date('2026-09-01')) }));

    expect(body.meta).toMatchObject({ sourceDate: '2026-09-01', sourceSince: '2026-01-05' });
  });

  it('publishes the history beside the answer, and only when it was asked for', () => {
    // `?history` on the single lookup: the winning source's plateaus, in the `/v1/lookup-all` shape, next
    // to `data` and `meta`.
    const plain = serialize(found());
    expect(plain).not.toHaveProperty('history');

    const withHistory = serialize({ ...found(), history: [{ ...statement, bulk: null }] }) as {
      history: Record<string, unknown>[];
    };
    expect(withHistory.history[0]).toMatchObject({
      from: '2026-01-05',
      to: '2026-01-05',
      name: 'SARL JULIEN MAULNY EURL',
    });
  });

  it('keeps the data half identical whatever the source', () => {
    expect(serialize(found({ source: 'VIES', proof: 'x' })).data).toEqual(serialize(found()).data);
  });
});

describe("every source's answer envelope", () => {
  const stored: StoredStatement = { ...statement, bulk: null };

  const history = (over: Partial<SourceHistory> = {}): SourceHistory => ({
    source: 'SIRENE',
    name: 'SIRENE (INSEE)',
    kind: 'bulk',
    history: [stored],
    ...over,
  });

  const report = (sources: SourceHistory[], published = true) => ({ vat, history: published, sources });

  it('publishes one entry per source, under data.sources and nothing else', () => {
    // No `meta` and no summary: every statement has its own date.
    const body = serializeAll(report([history()]));

    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data).toMatchObject({ vatNumber: 'FR95884831538', countryCode: 'FR', nationalNumber: '884831538' });
  });

  it('publishes each statement with the day the source said it and the file it said it in', () => {
    const body = serializeAll(
      report([
        history({
          history: [
            { ...stored, bulk: { id: 1n, source: 'SIRENE', url: 'https://data.gouv.fr/x', fileName: 'Stock.zip' } },
          ],
        }),
      ]),
    ) as { data: { sources: { history: Record<string, unknown>[] }[] } };

    expect(body.data.sources[0]?.history[0]).toMatchObject({
      from: '2026-01-05',
      to: '2026-01-05',
      name: 'SARL JULIEN MAULNY EURL',
      file: { name: 'Stock.zip', url: 'https://data.gouv.fr/x' },
    });
  });

  it('gives a statement the same company shape the plain lookup publishes', () => {
    // Without the number (stated once on the report), with the interval.
    const plain = serialize(found()).data as Record<string, unknown>;
    const body = serializeAll(report([history()])) as {
      data: { sources: { history: Record<string, unknown>[] }[] };
    };
    const entry = body.data.sources[0]!.history[0]!;

    expect(entry.name).toEqual(plain.name);
    expect(entry.address).toEqual(plain.address);
    expect(entry.status).toEqual(plain.status);
  });

  it('carries the proof on the statement that has one, in the same abstract shape', () => {
    const body = serializeAll(
      report([
        history({
          source: 'VIES',
          kind: 'live',
          history: [{ ...stored, source: 'VIES', proof: '908a3b38-e0dc-4502-8b06-d057eeac6861' }],
        }),
      ]),
    ) as { data: { sources: { history: Record<string, unknown>[] }[] } };

    expect(body.data.sources[0]?.history[0]?.proof).toEqual({
      type: 'vies_consultation_number',
      value: '908a3b38-e0dc-4502-8b06-d057eeac6861',
    });
  });

  it('publishes the call it made, failure included - the reason the endpoint exists', () => {
    const body = serializeAll(
      report([
        history({
          source: 'VIES',
          kind: 'live',
          history: [],
          call: { status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE', attempts: 4 } },
        }),
      ]),
    ) as { data: { sources: Record<string, unknown>[] } };
    const item = body.data.sources[0] as { error: unknown; meta: Record<string, unknown>; history: unknown[] };

    // The item reads like a failed lookup: an `error` instead of the company, with the register still
    // named in `meta`.
    expect(item.error).toEqual({
      code: 'SOURCE_UNAVAILABLE',
      message: 'The source did not answer. Registers are regularly unavailable for short periods.',
      fault: 'MS_UNAVAILABLE',
      attempts: 4,
    });
    expect(item.meta).toMatchObject({ source: 'VIES', kind: 'live', call: { status: 'unavailable' } });
    expect(item).not.toHaveProperty('data');
    expect(item.history).toEqual([]);
  });

  it('leaves the call out entirely when the stored history was fresh enough', () => {
    expect(serializeAll(report([history()]))).toMatchObject({
      data: { sources: [{ meta: expect.not.objectContaining({ call: expect.anything() }) }] },
    });
  });

  it('gives every item the shape of a lookup: data and meta, the register named in meta', () => {
    // Each item parses like `/v1/lookup/:vatNumber`.
    const plain = serialize(found()) as { data: unknown; meta: Record<string, unknown> };
    const body = serializeAll(report([history()])) as {
      data: { sources: { data: unknown; meta: Record<string, unknown> }[] };
    };
    const item = body.data.sources[0]!;

    expect(item.data).toEqual(plain.data);
    expect(item.meta).toMatchObject({ ...plain.meta, name: 'SIRENE (INSEE)', kind: 'bulk' });
  });

  it('publishes the plateau in force and not the first thing the source ever said', () => {
    const older = { ...stored, name: 'AN OLDER NAME', dateEnd: asDay(new Date('2025-06-01')) };
    const body = serializeAll(report([history({ history: [older, stored] })])) as {
      data: { sources: { data: { name: string }; history: unknown[] }[] };
    };

    expect(body.data.sources[0]?.data.name).toBe('SARL JULIEN MAULNY EURL');
    expect(body.data.sources[0]?.history).toHaveLength(2);
  });

  it('reads a source that says the number is not registered as an error, not as a company', () => {
    const body = serializeAll(
      report([history({ history: [{ ...stored, status: 'not_registered', name: null }] })]),
    ) as { data: { sources: { error: { code: string }; meta: Record<string, unknown> }[] } };

    expect(body.data.sources[0]?.error.code).toBe('VAT_NOT_REGISTERED');
    // The provenance is kept.
    expect(body.data.sources[0]?.meta).toMatchObject({ source: 'SIRENE', sourceDate: '2026-01-05' });
  });

  it('says COMPANY_NOT_FOUND for a source that has never said anything and was not called', () => {
    const body = serializeAll(report([history({ history: [] })])) as {
      data: { sources: { error: { code: string } }[] };
    };

    expect(body.data.sources[0]?.error.code).toBe('COMPANY_NOT_FOUND');
  });

  it('drops the history node from every item when it was not read', () => {
    const body = serializeAll(report([history()], false)) as { data: { sources: unknown[] } };

    expect(body.data.sources[0]).not.toHaveProperty('history');
  });

  it('is still a report when every source is gone', () => {
    // A country only served by VIES, with VIES disabled. Empty.
    const body = serializeAll(report([])) as { data: { sources: unknown[] } };

    expect(body.data.sources).toEqual([]);
  });
});

describe('the error envelope', () => {
  it('proves a "not registered" answer too, alongside the instant it was given', () => {
    const error = toApiError({
      status: 'not-registered',
      vat,
      consulted: [],
      checkedAt: new Date('2026-08-26T12:42:53.581Z'),
      statement: {
        ...statement,
        source: 'VIES',
        status: 'not_registered',
        name: null,
        proof: '908a3b38-e0dc-4502-8b06-d057eeac6861',
      },
    });

    expect(error.status).toBe(404);
    expect(error.toBody()).toMatchObject({
      error: { code: 'VAT_NOT_REGISTERED' },
      meta: {
        checkedAt: new Date('2026-08-26T12:42:53.581Z'),
        proof: { type: 'vies_consultation_number', value: '908a3b38-e0dc-4502-8b06-d057eeac6861' },
      },
    });
  });

  it('carries no meta on the two misses that have nothing to add', () => {
    const unavailable = toApiError({
      status: 'unavailable',
      vat,
      consulted: [],
      failure: { fault: 'MS_UNAVAILABLE', attempts: 4 },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.toBody()).not.toHaveProperty('meta');

    expect(toApiError({ status: 'not-found', vat, consulted: [] }).toBody()).not.toHaveProperty('meta');
  });

  it('tells a proof that could not be produced from a source that would not answer', () => {
    const unproved = {
      status: 'unavailable' as const,
      vat,
      consulted: ['VIES'],
      failure: { fault: 'NO_CONSULTATION_NUMBER', attempts: 1 },
    };

    // Both are 503 and say nothing about the number, but this one may have come with a valid answer,
    // refused because a proof was required.
    expect(toApiError(unproved, 'proof').toBody()).toMatchObject({ error: { code: 'PROOF_UNAVAILABLE' } });
    expect(toApiError(unproved, 'proof').status).toBe(503);

    // A deployment without any proof-issuing source gives the same answer. `log_lookup.fault` tells
    // them apart.
    const notConfigured = { ...unproved, failure: { fault: 'SOURCE_NOT_CONFIGURED', attempts: 0 } };
    expect(toApiError(notConfigured, 'proof').toBody()).toMatchObject({ error: { code: 'PROOF_UNAVAILABLE' } });

    // A member state that did not answer keeps its usual code.
    const outage = { ...unproved, failure: { fault: 'MS_UNAVAILABLE', attempts: 4 } };
    expect(toApiError(outage, 'proof').toBody()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });

    // Without the parameter nothing changes.
    expect(toApiError(unproved).toBody()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
  });
});
