import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyStatement, StatementInput, StoredStatement } from '../src/api/types.js';

/**
 * The country adapter, where the resolution order lives.
 *
 * The sources are fakes: what is tested is which sources are asked, in which order, and which are
 * skipped. `lookup.test.ts` tests the same class with the real VIES parser.
 */

const written: StatementInput[] = [];
const stored = new Map<string, StoredStatement>();

vi.mock('../src/db/companyHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/companyHistory.js')>();
  return {
    ...actual,
    latestBySource: async () => stored,
    historyBySource: async () => new Map<string, StoredStatement[]>(),
    recordStatement: async (input: StatementInput): Promise<CompanyStatement> => {
      written.push(input);
      const { date, ...rest } = input;
      return { ...rest, dateStart: date, dateEnd: date };
    },
  };
});

vi.mock('../src/db/companyRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/companyRepository.js')>();
  return { ...actual, insertSourceCallLog: async () => {} };
});

const { BaseCountryAdapter } = await import('../src/api/countries/types.js');
const { LiveSource } = await import('../src/api/sources/types.js');
const { SourceTrace } = await import('../src/api/trace.js');
const { today } = await import('../src/api/types.js');
const { parseVatNumber } = await import('../src/vat/parse.js');

type LiveAnswer = import('../src/api/sources/types.js').LiveAnswer;

const vat = parseVatNumber('DK29979812');

const record = {
  vatNumber: 'DK29979812',
  nationalId: '29979812',
  name: 'ACME A/S',
  legalForm: null,
  status: 'active' as const,
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  addressCountry: 'DK',
  companyLastUpdatedAt: null,
};

/** A source that answers what it is told and counts its calls. */
class FakeSource extends LiveSource {
  readonly countryCode = 'DK';
  asked = 0;

  constructor(
    readonly id: string,
    private reply: LiveAnswer,
    readonly issuesProof = false,
    private configured = true,
  ) {
    super();
  }

  readonly name = 'a fake register';

  override get available(): boolean {
    return this.configured;
  }

  protected async query(): Promise<LiveAnswer> {
    this.asked += 1;
    return this.reply;
  }
}

const found = (name: string): LiveAnswer => ({ status: 'found', record: { ...record, name }, checkedAt: new Date() });
/** VIES's usual answer for Germany and Spain: registered, with no company details. */
const nameless: LiveAnswer = {
  status: 'found',
  record: { ...record, name: null, nationalId: null, addressCountry: null },
  checkedAt: new Date(),
};
const missing: LiveAnswer = { status: 'not-found' };
const down: LiveAnswer = { status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE', attempts: 4 } };

function context(prefer: 'completeness' | 'proof' = 'completeness') {
  return { deadline: Date.now() + 20_000, trace: new SourceTrace(), prefer, history: false };
}

beforeEach(() => {
  written.length = 0;
  stored.clear();
});

describe('the order a country asks its sources in', () => {
  it('does not stop at a source that names nobody', async () => {
    // A nameless VIES answer must not stop the walk: the register behind it may have the full record.
    // The nameless answer is kept, and loses.
    const first = new FakeSource('FIRST', nameless);
    const second = new FakeSource('SECOND', found('FROM THE SECOND'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    const verdict = await country.resolve(vat, context());

    expect(second.asked).toBe(1);
    expect(verdict).toMatchObject({ status: 'found', statement: { source: 'SECOND', name: 'FROM THE SECOND' } });
  });

  it('answers with the nameless one when nothing else has anything to say', async () => {
    // A `valid` without name is still an answer. Refusing it would 404 every German number VIES just
    // confirmed.
    const first = new FakeSource('FIRST', nameless);
    const second = new FakeSource('SECOND', missing);
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    expect(await country.resolve(vat, context())).toMatchObject({
      status: 'found',
      statement: { source: 'FIRST', name: null },
    });
  });

  it('does not stop on a nameless statement already in the history either', async () => {
    // Same rule from storage: a stored nameless row must not skip the register behind it.
    stored.set('FIRST', {
      ...record,
      name: null,
      source: 'FIRST',
      dateStart: today(),
      dateEnd: today(),
      bulkId: null,
      proof: null,
      bulk: null,
    });
    const first = new FakeSource('FIRST', nameless);
    const second = new FakeSource('SECOND', found('FROM THE SECOND'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    const verdict = await country.resolve(vat, context());

    expect(first.asked).toBe(0);
    expect(second.asked).toBe(1);
    expect(verdict).toMatchObject({ statement: { source: 'SECOND' } });
  });

  it('stops at the first source that names a company', async () => {
    const first = new FakeSource('FIRST', found('FROM THE FIRST'));
    const second = new FakeSource('SECOND', found('FROM THE SECOND'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    const verdict = await country.resolve(vat, context());

    expect(verdict).toMatchObject({ status: 'found', statement: { name: 'FROM THE FIRST' } });
    expect(second.asked).toBe(0);
  });

  it('walks on to the next source when the first has never heard of the number', async () => {
    const first = new FakeSource('FIRST', missing);
    const second = new FakeSource('SECOND', found('FROM THE SECOND'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    const verdict = await country.resolve(vat, context());

    expect(verdict).toMatchObject({ status: 'found', statement: { name: 'FROM THE SECOND' } });
    expect(first.asked).toBe(1);
  });

  it('keeps walking past a "not registered" answer, because it is not a company', async () => {
    // A "no" is kept, but the next source is still asked, and `pick` chooses.
    const first = new FakeSource('FIRST', { status: 'not-registered', checkedAt: new Date() });
    const second = new FakeSource('SECOND', found('FROM THE SECOND'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [first, second] });

    await country.resolve(vat, context());

    expect(second.asked).toBe(1);
  });

  it('asks a late source only once the ones in front of it came back empty', async () => {
    // Greece: a register slower than VIES, only asked when VIES had nothing.
    const fast = new FakeSource('FAST', found('FROM THE FAST ONE'));
    const slow = new FakeSource('SLOW', found('FROM THE SLOW ONE'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [fast], lateLive: [slow] });

    await country.resolve(vat, context());
    expect(slow.asked).toBe(0);
  });

  it('does ask the late source when the fast one missed', async () => {
    const fast = new FakeSource('FAST', missing);
    const slow = new FakeSource('SLOW', found('FROM THE SLOW ONE'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [fast], lateLive: [slow] });

    const verdict = await country.resolve(vat, context());

    expect(verdict).toMatchObject({ status: 'found', statement: { name: 'FROM THE SLOW ONE' } });
  });

  it('skips a source this deployment has no credentials for, and leaves no trace of it', async () => {
    // An unavailable source is not listed as a miss.
    const unconfigured = new FakeSource('UNCONFIGURED', found('X'), false, false);
    const configured = new FakeSource('CONFIGURED', found('FROM THE CONFIGURED ONE'));
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [unconfigured, configured] });

    const verdict = await country.resolve(vat, context());

    expect(unconfigured.asked).toBe(0);
    expect(verdict.consulted).toEqual(['CONFIGURED']);
  });

  it('carries the fault of a source that would not answer', async () => {
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [new FakeSource('DOWN', down)] });

    const verdict = await country.resolve(vat, context());

    expect(verdict).toMatchObject({ status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE', attempts: 4 } });
  });

  it('reports a plain miss as a miss, which is not the same news as an outage', async () => {
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [new FakeSource('NONE', missing)] });

    expect(await country.resolve(vat, context())).toMatchObject({ status: 'not-found' });
  });
});

describe('what a country stores', () => {
  it('stores what a source named, dated by the day it said it', async () => {
    const country = new BaseCountryAdapter({
      code: 'DK',
      name: 'Denmark',
      live: [new FakeSource('CVR', found('ACME A/S'))],
    });

    await country.resolve(vat, context());

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ source: 'CVR', name: 'ACME A/S', date: today() });
  });

  it('stores a "not registered" answer, because it is a dated claim', async () => {
    const country = new BaseCountryAdapter({
      code: 'DK',
      name: 'Denmark',
      live: [new FakeSource('VIES', { status: 'not-registered', checkedAt: new Date() })],
    });

    await country.resolve(vat, context());

    expect(written[0]).toMatchObject({ status: 'not_registered', name: null });
  });

  it('stores nothing for a source that has never heard of the number', async () => {
    // A register without a record made no claim, so nothing is stored.
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [new FakeSource('NONE', missing)] });

    await country.resolve(vat, context());

    expect(written).toEqual([]);
  });

  it('stores and answers with a nameless positive answer', async () => {
    // Germany and Spain disclose neither name nor address through VIES. A `valid` with everything null
    // is their normal answer and must be stored.
    const nameless: LiveAnswer = { status: 'found', record: { ...record, name: null }, checkedAt: new Date() };
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [new FakeSource('X', nameless)] });

    const verdict = await country.resolve(vat, context());

    expect(verdict).toMatchObject({ status: 'found', statement: { name: null } });
    expect(written).toHaveLength(1);
  });
});

describe('a country asked for a proof', () => {
  it('consults only the sources that issue one', async () => {
    const register = new FakeSource('REGISTER', found('FROM THE REGISTER'));
    const prover = new FakeSource('VIES', { ...found('FROM VIES'), proof: 'abc' }, true);
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [register, prover] });

    const verdict = await country.resolve(vat, context('proof'));

    expect(register.asked).toBe(0);
    expect(verdict).toMatchObject({ status: 'found', statement: { source: 'VIES', proof: 'abc' } });
  });

  it('refuses an answer that came back without one', async () => {
    const prover = new FakeSource('VIES', found('FROM VIES'), true);
    const country = new BaseCountryAdapter({ code: 'DK', name: 'Denmark', live: [prover] });

    expect(await country.resolve(vat, context('proof'))).toMatchObject({
      status: 'unavailable',
      failure: { fault: 'NO_CONSULTATION_NUMBER' },
    });
  });

  it('reports a country with nothing that can prove anything as unable to prove it', async () => {
    const country = new BaseCountryAdapter({
      code: 'DK',
      name: 'Denmark',
      live: [new FakeSource('REGISTER', found('X'))],
    });

    expect(await country.resolve(vat, context('proof'))).toMatchObject({ status: 'not-found' });
  });
});
