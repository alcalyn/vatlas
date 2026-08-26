import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The quota counter: what a call of a given cost does to it.
 *
 * Only the two database writes are stubbed (opening the month, flushing), since the arithmetic is
 * what is tested.
 */
const period = { used: 0, quota: 100 };
const increments: number[] = [];

vi.mock('../src/db/prisma.js', () => ({
  getPrisma: () => ({
    usagePeriod: {
      upsert: async () => ({
        periodStart: new Date(Date.UTC(2026, 8, 1)),
        periodEnd: new Date(Date.UTC(2026, 9, 1)),
        quota: period.quota,
        used: period.used,
      }),
      update: async ({ data }: { data: { used: { increment: number } } }) => {
        increments.push(data.used.increment);
      },
    },
  }),
}));

const { consume, flushAll, peek, resetUsageCounters } = await import('../src/services/usage.js');

describe('what one call spends', () => {
  beforeEach(() => {
    resetUsageCounters();
    period.used = 0;
    period.quota = 100;
    increments.length = 0;
  });

  it('spends one unit by default, which is every endpoint but the complete report', async () => {
    await peek(1n, 'free');

    expect(consume(1n)?.remaining).toBe(99);
  });

  it('spends the units it is given, which is how a complete lookup costs three', async () => {
    await peek(1n, 'free');

    expect(consume(1n, 3)?.remaining).toBe(97);
  });

  it('flushes the whole amount to the database, not one row per unit', async () => {
    await peek(1n, 'free');
    consume(1n, 3);
    await flushAll();

    expect(increments).toEqual([3]);
  });
});

describe('the last call of the month', () => {
  beforeEach(() => {
    resetUsageCounters();
    increments.length = 0;
  });

  it('goes through with two units left, and ends the month a little over', async () => {
    // The gate is `used >= quota` and does not know the call's cost, so a caller with units left is
    // never refused. The overshoot is at most one call.
    period.quota = 100;
    period.used = 98;
    const before = await peek(1n, 'free');
    expect(before.exceeded).toBe(false);

    const after = consume(1n, 3);

    expect(after?.remaining).toBe(0);
    expect(after?.exceeded).toBe(true);
  });

  it('is the next call that is refused, cleanly', async () => {
    period.quota = 100;
    period.used = 101;

    expect((await peek(1n, 'free')).exceeded).toBe(true);
  });
});
