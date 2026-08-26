import { describe, expect, it } from 'vitest';
import { presentAll, presentLookup } from '../src/lib/lookupView.js';
// @ts-expect-error - the site is plain JS with no types, and this is deliberately the only
// place the two packages meet: what is asserted here is that its recorded answers still have
// the shape the API publishes.
import { recorded, samples } from '../site/src/js/demo-data.js';

/**
 * The home page samples are copied from real answers, and nothing fails when the API changes. This
 * test catches a sample that no longer produces a valid view.
 */

interface Sample {
  vat: string;
  single?: { status: number; latency: number; body: unknown };
  proof?: { status: number; latency: number; body: unknown };
  all?: { status: number; latency: number; body: unknown };
}

const list = samples as Sample[];
const answered = list.filter((sample) => sample.single);

describe('the home page samples', () => {
  it('offers at least one of each kind of source, which is what they are for', () => {
    const sources = answered.map((sample) => (sample.single!.body as { meta: { source: string } }).meta.source);

    // An imported register and a live one.
    expect(sources).toContain('SIRENE');
    expect(sources.some((source) => source !== 'SIRENE' && source !== 'VIES')).toBe(true);
  });

  it.each(answered.map((sample) => [sample.vat, sample] as const))(
    '%s answers all three calls, and each one still reads',
    (_vat, sample) => {
      for (const mode of ['single', 'proof', 'all'] as const) {
        expect(sample[mode], `${sample.vat} has no recorded ${mode}`).toBeDefined();
        expect(recorded(sample.vat, mode)).toBe(sample[mode]);
      }

      const single = presentLookup(sample.single!.status, sample.single!.body);
      expect(single.verdict.tone).toBe('ok');
      expect(single.source).toBeTruthy();
      // A sample must have something to show: a name, both identifiers, and an address.
      expect(single.company.name).toBeTruthy();
      expect(single.company.identifiers.length).toBeGreaterThan(0);
      expect(single.company.address.length).toBeGreaterThan(0);

      // A proof sample must come from VIES.
      const proof = presentLookup(sample.proof!.status, sample.proof!.body);
      expect(proof.source).toBe('VIES');
      expect(proof.proof?.type).toBe('vies_consultation_number');

      const all = presentAll(sample.all!.body);
      expect(all.vatNumber).toBe(sample.vat);
      expect(all.sources.length).toBeGreaterThan(0);
      for (const source of all.sources) {
        expect(source.source).toBeTruthy();
        expect(source.name).toBeTruthy();
      }
    },
  );

  it('shows at least one register changing its mind, or the history demonstrates nothing', () => {
    const changed = answered.some((sample) =>
      presentAll(sample.all!.body).sources.some((source) =>
        source.history.some((plateau) => plateau.changes.length > 0),
      ),
    );

    expect(changed).toBe(true);
  });

  it("keeps a sample with no recorded answer, so the rejected number is the API's own", () => {
    // `XX123456789` has no body on purpose: it goes to the real API.
    const live = list.filter((sample) => !sample.single);
    expect(live).toHaveLength(1);
    expect(recorded(live[0]!.vat, 'single')).toBeUndefined();
  });
});
