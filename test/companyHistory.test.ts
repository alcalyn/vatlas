import { describe, expect, it } from 'vitest';
import { fitStatement, payloadHash, placeStatement } from '../src/db/companyHistory.js';
import { pick, completeness, type Candidate } from '../src/api/countries/pick.js';
import { asDay, type CompanyRecord, type CompanyStatement, type StatementInput } from '../src/api/types.js';

/**
 * The two rules of `company`: where a statement belongs in the history, and which source answers
 * when they disagree.
 *
 * Both are pure functions, tested without a database.
 */

const record: CompanyRecord = {
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
};

describe('payloadHash', () => {
  it('is sixteen bytes, which is what the column holds', () => {
    expect(payloadHash(record)).toHaveLength(16);
  });

  it('is the same for two rows that say the same thing', () => {
    expect(payloadHash(record)).toEqual(payloadHash({ ...record }));
  });

  it('changes when any data column changes', () => {
    expect(payloadHash({ ...record, city: 'LYON' })).not.toEqual(payloadHash(record));
    expect(payloadHash({ ...record, status: 'inactive' })).not.toEqual(payloadHash(record));
    expect(payloadHash({ ...record, name: null })).not.toEqual(payloadHash(record));
  });

  it('ignores when the register last touched the record, which is not a change to the company', () => {
    // The field that had to be removed from the hash. INSEE reprocesses in bulk (one pass stamped 29.8%
    // of `StockUniteLegale` with the same second), and VIES has no such date, so hashing it opened
    // plateaus for unchanged companies.
    expect(payloadHash({ ...record, companyLastUpdatedAt: new Date('2024-03-22T13:26:06Z') })).toEqual(
      payloadHash({ ...record, companyLastUpdatedAt: new Date('2026-05-13T09:00:00Z') }),
    );
    expect(payloadHash({ ...record, companyLastUpdatedAt: null })).toEqual(payloadHash(record));
  });

  it('does not distinguish a null from a missing field of the same name', () => {
    // A missing key and a null say the same thing, and must hash the same.
    const { addressLine2: _dropped, ...without } = record;
    expect(payloadHash(without as CompanyRecord)).toEqual(payloadHash(record));
  });

  it('tells apart values that differ only by where the separator falls', () => {
    // A single separator would let "AB" + "C" collide with "A" + "BC".
    expect(payloadHash({ ...record, city: 'PARIS', legalForm: 'SARL' })).not.toEqual(
      payloadHash({ ...record, city: 'PARISSARL', legalForm: '' }),
    );
  });
});

describe('fitStatement', () => {
  const statement: StatementInput = {
    ...record,
    source: 'NTA',
    date: asDay(new Date('2026-08-31')),
    bulkId: null,
    proof: null,
  };

  it('leaves a statement that fits alone', () => {
    expect(fitStatement(statement)).toEqual(statement);
  });

  it('cuts an address too long for its column, and marks the cut', () => {
    // A Japanese address in full-width characters, longer than the 512-character column.
    const fitted = fitStatement({ ...statement, addressLine1: 'Ｎ'.repeat(600) });
    expect(fitted.addressLine1).toHaveLength(512);
    expect(fitted.addressLine1?.endsWith('…')).toBe(true);
  });

  it('cuts every text column, so no one register can stop an import', () => {
    const fitted = fitStatement({
      ...statement,
      name: 'A'.repeat(300),
      legalForm: 'B'.repeat(200),
      city: 'C'.repeat(200),
      postalCode: 'D'.repeat(40),
      nationalId: 'E'.repeat(50),
      proof: 'F'.repeat(300),
    });
    expect(fitted.name).toHaveLength(255);
    expect(fitted.legalForm).toHaveLength(128);
    expect(fitted.city).toHaveLength(128);
    expect(fitted.postalCode).toHaveLength(16);
    expect(fitted.nationalId).toHaveLength(32);
    expect(fitted.proof).toHaveLength(255);
  });

  it('is idempotent, so a clamped row does not keep changing under the hash', () => {
    const once = fitStatement({ ...statement, addressLine1: 'Ｎ'.repeat(600) });
    expect(fitStatement(once)).toEqual(once);
    expect(payloadHash(fitStatement(once))).toEqual(payloadHash(once));
  });
});

describe('placeStatement', () => {
  const day = (n: number) => asDay(new Date(Date.UTC(2026, 0, n)));
  const A = payloadHash(record);
  const B = payloadHash({ ...record, city: 'LYON' });
  const plateau = (from: number, to: number, hash: Buffer) => ({
    dateStart: day(from),
    dateEnd: day(to),
    payloadHash: hash,
  });

  it('opens a plateau when the source has never said anything about this number', () => {
    expect(placeStatement(null, null, { date: day(5), payloadHash: A })).toEqual({ action: 'open' });
  });

  it('extends the plateau when the source says the same thing later', () => {
    // 95 to 98% of an import.
    expect(placeStatement(plateau(1, 3, A), null, { date: day(4), payloadHash: A })).toEqual({
      action: 'extend',
      dateStart: day(1),
    });
  });

  it('writes nothing at all for a day the plateau already covers', () => {
    // Re-reading an imported edition touches no row, so a retried cron run is idempotent.
    expect(placeStatement(plateau(1, 5, A), null, { date: day(3), payloadHash: A })).toEqual({ action: 'none' });
    expect(placeStatement(plateau(1, 5, A), null, { date: day(5), payloadHash: A })).toEqual({ action: 'none' });
  });

  it('opens a new plateau when the source changes its mind', () => {
    expect(placeStatement(plateau(1, 3, A), null, { date: day(6), payloadHash: B })).toEqual({ action: 'open' });
  });

  it('leaves the gap between two plateaus alone, because the gap is the truth', () => {
    // The change happened between the 3rd and the 6th: no file was read in between.
    const placement = placeStatement(plateau(1, 3, A), null, { date: day(6), payloadHash: B });
    expect(placement).not.toMatchObject({ action: 'extend' });
  });

  it('replaces the plateau when a second answer lands on the day it opened', () => {
    // Two live calls on one day that disagree: the later answer replaces the earlier one.
    expect(placeStatement(plateau(4, 4, A), null, { date: day(4), payloadHash: B })).toEqual({ action: 'replace' });
  });

  it('splits a plateau when an older edition contradicts it from the inside', () => {
    // Only happens when importing an old edition after a newer one. The plateau is cut at the previous
    // day, so they never overlap.
    expect(placeStatement(plateau(1, 10, A), null, { date: day(4), payloadHash: B })).toEqual({
      action: 'split',
      truncateTo: day(3),
    });
  });

  it('extends into the gap before a plateau that says something else', () => {
    // `before` is the last plateau starting on or before this day, so extending to this day cannot
    // reach a disagreeing neighbour.
    expect(placeStatement(plateau(1, 2, A), plateau(8, 9, B), { date: day(4), payloadHash: A })).toEqual({
      action: 'extend',
      dateStart: day(1),
    });
  });

  it('closes the gap when the day agrees with the plateaus on both sides', () => {
    // Importing September, then 6 August, then 7 August: the 7th extends August's plateau and
    // September's says the same thing a month later. Imported in order it would be one row, so it must
    // be one row.
    expect(placeStatement(plateau(1, 1, A), plateau(9, 9, A), { date: day(2), payloadHash: A })).toEqual({
      action: 'merge',
      dateStart: day(1),
      dateEnd: day(9),
      absorbed: day(9),
    });
  });

  it('moves a plateau back to an older edition that already agreed with it', () => {
    // September imported first, then August: the plateau started in August. The row moves, nothing is
    // inserted.
    expect(placeStatement(null, plateau(9, 9, A), { date: day(2), payloadHash: A })).toEqual({
      action: 'reopen',
      from: day(9),
      dateEnd: day(9),
      truncateTo: null,
    });
  });

  it('reopens across a plateau that disagrees, cutting it short', () => {
    // A split with somewhere to land: the older edition contradicts the plateau it falls in and agrees
    // with the next one, so the first is truncated and the second extends back to meet it.
    expect(placeStatement(plateau(1, 10, A), plateau(20, 25, B), { date: day(4), payloadHash: B })).toEqual({
      action: 'reopen',
      from: day(20),
      dateEnd: day(25),
      truncateTo: day(3),
    });
  });

  it('is the same history whichever order the editions are read in', () => {
    // The goal of the above: three days saying the same thing are one plateau, whatever the import
    // order.
    const days = [day(1), day(4), day(9)];
    for (const order of [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
      [2, 1, 0],
    ]) {
      let plateaus: { dateStart: Date; dateEnd: Date; payloadHash: Buffer }[] = [];
      for (const index of order) {
        const date = days[index];
        const before = [...plateaus].reverse().find((p) => p.dateStart <= date) ?? null;
        const after = plateaus.find((p) => p.dateStart > date) ?? null;
        const placement = placeStatement(before, after, { date, payloadHash: A });

        switch (placement.action) {
          case 'none':
            break;
          case 'open':
            plateaus.push({ dateStart: date, dateEnd: date, payloadHash: A });
            break;
          case 'extend':
            before!.dateEnd = date;
            break;
          case 'merge':
            before!.dateEnd = placement.dateEnd;
            plateaus = plateaus.filter((p) => p.dateStart !== placement.absorbed);
            break;
          case 'reopen':
            after!.dateStart = date;
            break;
          default:
            throw new Error(`unexpected ${placement.action} for ${date.toISOString()}`);
        }
        plateaus.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
      }

      expect(plateaus).toEqual([{ dateStart: day(1), dateEnd: day(9), payloadHash: A }]);
    }
  });
});

describe('pick', () => {
  /** A plateau that opened and ended on the same day. */
  const on = (day: string) => ({ dateStart: asDay(new Date(day)), dateEnd: asDay(new Date(day)) });

  const statement = (over: Partial<CompanyStatement>): CompanyStatement => ({
    ...record,
    source: 'SIRENE',
    ...on('2026-08-01'),
    bulkId: null,
    proof: null,
    ...over,
  });

  const bulk = (over: Partial<CompanyStatement> = {}): Candidate => ({
    statement: statement(over),
    stored: true,
    bulk: true,
  });

  const live = (over: Partial<CompanyStatement> = {}): Candidate => ({
    statement: statement({ source: 'VIES', ...over }),
    stored: false,
    bulk: false,
  });

  const negative = (over: Partial<CompanyStatement> = {}): Candidate =>
    live({ status: 'not_registered', name: null, addressLine1: null, city: null, postalCode: null, ...over });

  it('answers with nothing when nobody said anything', () => {
    expect(pick([])).toBeNull();
  });

  it('prefers a source that names the company to one that names nobody', () => {
    expect(pick([negative({ ...on('2026-07-01') }), bulk()])?.statement.source).toBe('SIRENE');
  });

  it('prefers the more complete of two statements, not the more recent', () => {
    // Otherwise every French lookup would answer from VIES, which is always more recent but much less
    // complete.
    const thin = live({ ...on('2026-09-01'), addressLine1: null, city: null, postalCode: null });
    expect(pick([thin, bulk()])?.statement.source).toBe('SIRENE');
  });

  it('breaks a tie on completeness by taking the most recent', () => {
    const older = bulk({ ...on('2026-01-01') });
    const newer = bulk({ source: 'KBO', ...on('2026-08-01') });
    expect(pick([older, newer])?.statement.source).toBe('KBO');
  });

  it('lets a live "not registered" beat an older statement that names the company', () => {
    // A recent deregistration from a live source beats an older, richer bulk statement: the caller may
    // be about to issue a reverse-charge invoice.
    const stale = bulk({ ...on('2026-05-01') });
    const today = negative({ ...on('2026-09-01') });

    expect(pick([stale, today])?.statement.status).toBe('not_registered');
  });

  it('does not let a stale "not registered" override a fresher name', () => {
    const named = bulk({ ...on('2026-09-01') });
    const old = negative({ ...on('2026-05-01') });

    expect(pick([named, old])?.statement.source).toBe('SIRENE');
  });

  it('never lets a bulk "not registered" override anything', () => {
    // A file cannot report a deregistration made after it was published, so the rule above only applies
    // to live sources.
    const named = bulk({ ...on('2026-05-01') });
    const fromFile: Candidate = {
      statement: statement({ status: 'not_registered', name: null, ...on('2026-09-01') }),
      stored: true,
      bulk: true,
    };

    expect(pick([named, fromFile])?.statement.status).toBe('active');
  });

  it('ranks on when a source last confirmed it, not on when it first said it', () => {
    // SIRENE has said the same thing since January and confirmed it in September. VIES said something
    // thinner in August. Ranking on `dateStart` would make SIRENE look older and pick the staler answer.
    const long = bulk({ dateStart: asDay(new Date('2026-01-01')), dateEnd: asDay(new Date('2026-09-01')) });
    const short = bulk({ source: 'KBO', ...on('2026-08-01') });

    expect(pick([short, long])?.statement.source).toBe('SIRENE');
  });

  it('answers with a "not registered" when that is all anybody said', () => {
    expect(pick([negative()])?.statement.status).toBe('not_registered');
  });
});

describe('completeness', () => {
  it('weighs the name above everything, because that is what most callers ask for', () => {
    const named = { ...record, source: 'X', dateStart: new Date(), dateEnd: new Date(), bulkId: null, proof: null };
    const nameless = { ...named, name: null };
    const addressless = { ...named, addressLine1: null, city: null, postalCode: null };

    expect(completeness(named)).toBeGreaterThan(completeness(addressless));
    expect(completeness(addressless)).toBeGreaterThan(completeness(nameless));
  });
});
