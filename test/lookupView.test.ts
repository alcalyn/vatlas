import { describe, expect, it } from 'vitest';
import { presentAll, presentLookup } from '../src/lib/lookupView.js';

/**
 * The payloads below are the ones documented in `http/lookup.http` and `http/lookup-all.http`. The
 * console's formatted tab and the site's "try it" box use the same functions.
 */

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

describe('presentLookup', () => {
  it('reads an active company as the green verdict, and names the register that said so', () => {
    const view = presentLookup(200, found);

    expect(view.verdict).toEqual({ tone: 'ok', key: 'statusActive' });
    expect(view.source).toBe('SIRENE');
    expect(view.error).toBeUndefined();
  });

  it('keeps a name the source will not disclose, and drops what it simply does not have', () => {
    // Germany and Spain disclose neither name nor address through VIES. A missing address is dropped,
    // but a blank `name` is kept since it is what the register answered.
    const view = presentLookup(200, {
      data: { vatNumber: 'DE811907980', status: 'unknown', name: null, legalForm: null, nationalId: null, address: {} },
      meta: { source: 'VIES', sourceDate: '2026-09-04', sourceSince: '2026-09-04' },
    });

    expect(view.company.name).toBe('');
    expect(view.company.legalForm).toBeNull();
    expect(view.company.address).toEqual([]);
    expect(view.company.identifiers.map((field) => field.key)).toEqual(['vatNumber']);
  });

  it('lays the address out the way it is written, not as four labelled parts', () => {
    const view = presentLookup(200, found);

    expect(view.company.name).toBe('SARL JULIEN MAULNY EURL');
    expect(view.company.address).toEqual(['9 RUE DES COLONNES', '75002 PARIS']);
    expect(view.company.country).toBe('FR');
  });

  it('leaves a whole address in one line alone rather than inventing parts for it', () => {
    // Poland puts the whole address in `line1`. Joining blindly would add a stray comma.
    const view = presentLookup(200, {
      data: {
        vatNumber: 'PL7342867148',
        status: 'active',
        address: {
          line1: 'AL. JANA PAWŁA II 39A, 31-864 KRAKÓW',
          line2: null,
          postalCode: null,
          city: null,
          country: 'PL',
        },
      },
      meta: { source: 'MF_WL', sourceDate: '2026-08-28', sourceSince: '2026-08-28' },
    });

    expect(view.company.address).toEqual(['AL. JANA PAWŁA II 39A, 31-864 KRAKÓW']);
  });

  it('leaves an uncertified status neutral rather than doubtful, and says why', () => {
    const view = presentLookup(200, { data: { status: 'unknown' }, meta: { source: 'PEPPOL' } });

    expect(view.verdict.tone).toBe('neutral');
    expect(view.verdict.reasonKey).toBe('reasonUnknown');
  });

  it('tells a definitive no from an outage', () => {
    // A 404 is a "no" about this number and reads red. A 503 says nothing about the number.
    const no = presentLookup(404, { error: { code: 'VAT_NOT_REGISTERED', message: 'Not registered.' } });
    const down = presentLookup(503, { error: { code: 'SOURCE_UNAVAILABLE', message: 'No source answered.' } });

    expect(no.verdict.tone).toBe('bad');
    expect(no.verdict.key).toBe('verdictNotRegistered');
    expect(down.verdict.tone).toBe('neutral');
  });

  it('keeps the proof and the day of the check on a negative answer', () => {
    const view = presentLookup(404, {
      error: { code: 'VAT_NOT_REGISTERED', message: 'Not registered.' },
      meta: {
        checkedAt: '2026-09-04T22:01:59.219Z',
        proof: { type: 'vies_consultation_number', value: '908a3b38' },
      },
    });

    expect(view.proof).toEqual({ type: 'vies_consultation_number', value: '908a3b38' });
    expect(view.provenance.map((field) => field.key)).toContain('checkedAt');
  });

  it('does not repeat the first day when the register was seen saying it once', () => {
    const view = presentLookup(200, {
      data: { status: 'active' },
      meta: { source: 'VIES', sourceDate: '2026-09-04', sourceSince: '2026-09-04' },
    });

    expect(view.provenance.map((field) => field.key)).toEqual(['sourceDate']);
  });

  it('survives a body that is not an answer at all', () => {
    // The site restores answers from localStorage, which may hold anything. Show less, never throw.
    for (const body of [null, 'nonsense', [], { data: 'not an object' }]) {
      expect(() => presentLookup(200, body)).not.toThrow();
    }
  });
});

describe('presentAll', () => {
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
              legalForm: 'Personne physique',
              address: { line1: '51 RUE MARX DORMOY', postalCode: '13004', city: 'MARSEILLE', country: 'FR' },
            },
            {
              from: '2025-07-01',
              to: '2026-09-01',
              status: 'active',
              name: 'SARL JULIEN MAULNY EURL',
              address: { line1: '9 RUE DES COLONNES', postalCode: '75002', city: 'PARIS', country: 'FR' },
              file: { name: 'StockUniteLegale_utf8.zip', url: 'https://www.data.gouv.fr/' },
            },
          ],
        },
        {
          error: {
            code: 'SOURCE_UNAVAILABLE',
            message: 'The source did not answer.',
            fault: 'MS_UNAVAILABLE',
            attempts: 3,
          },
          meta: {
            source: 'VIES',
            name: 'VIES (European Commission)',
            kind: 'live',
            call: {
              status: 'unavailable',
              error: {
                code: 'SOURCE_UNAVAILABLE',
                message: 'The source did not answer.',
                fault: 'MS_UNAVAILABLE',
                attempts: 3,
              },
            },
          },
          history: [],
        },
      ],
    },
  };

  it('publishes every source, including the one that never held the number', () => {
    const view = presentAll(report);

    expect(view.sources.map((source) => source.source)).toEqual(['SIRENE', 'VIES']);
    expect(view.sources[1]!.history).toHaveLength(0);
  });

  it('carries a failed call with what made it fail', () => {
    // An unreachable source must appear in the report, and `fault` tells an outage from a rate limit.
    const call = presentAll(report).sources[1]!.call!;

    expect(call.key).toBe('callUnavailable');
    expect(call.error).toMatchObject({ fault: 'MS_UNAVAILABLE', attempts: 3 });
  });

  it('says what changed between two plateaux, and nothing on the first', () => {
    const history = presentAll(report).sources[0]!.history;

    expect(history[0]!.changes).toEqual([]);
    expect(history[1]!.changes).toEqual(
      expect.arrayContaining([
        { key: 'name', before: 'JULIEN MAULNY', after: 'SARL JULIEN MAULNY EURL' },
        { key: 'city', before: 'MARSEILLE', after: 'PARIS' },
        // A field that disappears is a change too.
        { key: 'legalForm', before: 'Personne physique', after: null },
      ]),
    );
  });

  it('keeps the artefact a plateau was read out of', () => {
    expect(presentAll(report).sources[0]!.history[1]!.file).toEqual({
      name: 'StockUniteLegale_utf8.zip',
      url: 'https://www.data.gouv.fr/',
    });
  });

  it('reads a malformed number as an error rather than an empty report', () => {
    const view = presentAll({
      error: { code: 'INVALID_VAT_FORMAT', message: 'Bad checksum.', reason: 'BAD_CHECKSUM' },
    });

    expect(view.error).toEqual({ code: 'INVALID_VAT_FORMAT', message: 'Bad checksum.', reason: 'BAD_CHECKSUM' });
    expect(view.sources).toEqual([]);
  });
});
