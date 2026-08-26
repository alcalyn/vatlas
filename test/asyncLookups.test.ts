import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { isAnswered, isReportUsable, nextRetryAt } from '../src/services/asyncLookups.js';
import { hasChanged, monitorLimitFor } from '../src/services/monitors.js';
import type { LookupOutcome } from '../src/api/resolve.js';
import type { AllLookupReport } from '../src/api/resolveAll.js';

const NOW = new Date('2026-09-08T12:00:00Z');
const MINUTE = 60_000;

/** The delay in minutes, which is how the ladder is specified. */
const minutes = (attempts: number, random: number): number =>
  (nextRetryAt(attempts, NOW, () => random).getTime() - NOW.getTime()) / MINUTE;

describe('nextRetryAt', () => {
  // `random() === 0.5` is the middle of the jitter: the bare ladder.
  it('doubles from ten minutes', () => {
    expect(minutes(1, 0.5)).toBe(10);
    expect(minutes(2, 0.5)).toBe(20);
    expect(minutes(3, 0.5)).toBe(40);
    expect(minutes(4, 0.5)).toBe(80);
  });

  /** +/- half the base, so retries do not all hit a recovering member state at once. */
  it('jitters by half the delay either way', () => {
    expect(minutes(1, 0)).toBe(5);
    expect(minutes(1, 1)).toBe(15);
    expect(minutes(3, 0)).toBe(20);
    expect(minutes(3, 1)).toBe(60);
  });

  it('never schedules the past, whatever the jitter', () => {
    for (let attempts = 1; attempts <= 40; attempts += 1) {
      expect(nextRetryAt(attempts, NOW, () => 0).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  const ceilingMinutes = config.asyncLookup.maxBackoffMs / MINUTE;

  it('stops doubling at the ceiling', () => {
    expect(minutes(20, 0.5)).toBe(ceilingMinutes);
    expect(minutes(200, 0.5)).toBe(ceilingMinutes);
  });

  /**
   * `2 ** 900` is Infinity. Capping it afterwards would give an Invalid Date and the row would never
   * be retried.
   */
  it('survives an attempt count that would overflow the shift', () => {
    const far = nextRetryAt(5_000, NOW, () => 0.5);
    expect(Number.isNaN(far.getTime())).toBe(false);
    expect((far.getTime() - NOW.getTime()) / MINUTE).toBe(ceilingMinutes);
  });
});

/** An answer is what `countsAgainstQuota` bills: the same thing ends the retry loop. */
describe('isAnswered', () => {
  const vat = { formatted: 'FR95884831538', countryCode: 'FR', nationalNumber: '95884831538' };
  const outcome = (status: string): LookupOutcome => ({ status, vat, consulted: [] }) as unknown as LookupOutcome;

  it('ends on a company, on a number reported unregistered, and on one nothing holds', () => {
    expect(isAnswered(outcome('found'))).toBe(true);
    // "Not registered" is the answer the caller was waiting for, not a failure.
    expect(isAnswered(outcome('not-registered'))).toBe(true);
    expect(isAnswered(outcome('not-found'))).toBe(true);
  });

  it('retries only an unreachable source, which is what the feature exists for', () => {
    expect(isAnswered(outcome('unavailable'))).toBe(false);
  });
});

/** A lookup-all answers 200 as soon as the number parses, so its content decides. */
describe('isReportUsable', () => {
  const report = (sources: unknown[]): AllLookupReport => ({ sources }) as unknown as AllLookupReport;

  it('accepts a report where a source has something stored', () => {
    expect(isReportUsable(report([{ history: [{}], call: undefined }]))).toBe(true);
  });

  it('accepts one where a source was called and did not fail', () => {
    expect(isReportUsable(report([{ history: [], call: { status: 'not-registered' } }]))).toBe(true);
  });

  it('retries a report in which every register failed and none has any history', () => {
    expect(
      isReportUsable(
        report([
          { history: [], call: { status: 'unavailable' } },
          { history: [], call: { status: 'unavailable' } },
        ]),
      ),
    ).toBe(false);
    expect(isReportUsable(report([]))).toBe(false);
  });
});

describe('hasChanged', () => {
  const a = Uint8Array.from([1, 2, 3]);
  const b = Uint8Array.from([1, 2, 4]);

  /** The first check never delivers: there is nothing to compare against yet. */
  it('says nothing on the first check', () => {
    expect(hasChanged(null, a)).toBe(false);
  });

  it('says nothing when the register repeats itself', () => {
    expect(hasChanged(Uint8Array.from(a), a)).toBe(false);
  });

  it('says so when a single byte moves', () => {
    expect(hasChanged(a, b)).toBe(true);
  });

  it('treats a different length as a change rather than reading past the end', () => {
    expect(hasChanged(Uint8Array.from([1, 2]), a)).toBe(true);
  });
});

describe('monitorLimitFor', () => {
  it('is the one thing the two plans differ by here', () => {
    expect(monitorLimitFor('free')).toBe(config.monitors.free);
    expect(monitorLimitFor('pro')).toBe(config.monitors.pro);
    expect(monitorLimitFor('pro')).toBeGreaterThan(monitorLimitFor('free'));
  });
});
