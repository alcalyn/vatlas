import { describe, expect, it } from 'vitest';
import { summarizeBenchmark } from '../src/services/siteStats.js';

describe('summarizeBenchmark', () => {
  it('counts a stated non-registration as an answer', () => {
    const stats = summarizeBenchmark({
      lookups: {
        measured: 200,
        outcomes: { found: 150, 'not-registered': 30, unavailable: 20 },
        latencyMs: { p50: 345.2658979999833 },
      },
    });

    expect(stats.answeredPct).toBeCloseTo(90);
    expect(stats.latencyP50Ms).toBe(345);
  });

  it('leaves the rate below 100 when every answer is a hit but some lookups failed', () => {
    const stats = summarizeBenchmark({
      lookups: { measured: 1350, outcomes: { found: 1251, unavailable: 99 }, latencyMs: { p50: 12 } },
    });

    expect(stats.answeredPct).toBeCloseTo(92.666, 2);
  });

  it('answers null rather than zero when the run measured nothing', () => {
    expect(summarizeBenchmark({ lookups: { measured: 0, outcomes: {} } })).toEqual({
      answeredPct: null,
      latencyP50Ms: null,
    });
    expect(summarizeBenchmark({})).toEqual({ answeredPct: null, latencyP50Ms: null });
  });
});
