import { describe, expect, it } from 'vitest';
import { parseUtcDate, parseUtcDayMonthYear, parseZonedDateTime } from '../src/lib/time.js';

describe('parseUtcDate', () => {
  it('reads a date-only value as UTC midnight', () => {
    expect(parseUtcDate('1976-04-23')?.toISOString()).toBe('1976-04-23T00:00:00.000Z');
  });

  it('keeps an explicit zone', () => {
    expect(parseUtcDate('2026-01-05T10:00:00+02:00')?.toISOString()).toBe('2026-01-05T08:00:00.000Z');
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseUtcDate(null)).toBeNull();
    expect(parseUtcDate('')).toBeNull();
    expect(parseUtcDate('not a date')).toBeNull();
  });
});

describe('parseUtcDayMonthYear', () => {
  it('reads the Estonian dd.mm.yyyy format as UTC', () => {
    expect(parseUtcDayMonthYear('30.07.2009')?.toISOString()).toBe('2009-07-30T00:00:00.000Z');
  });

  it('rejects anything else', () => {
    expect(parseUtcDayMonthYear('2009-07-30')).toBeNull();
    expect(parseUtcDayMonthYear(null)).toBeNull();
  });
});

describe('parseZonedDateTime', () => {
  // SIRENE publishes timestamps in Paris local time, without zone.
  it('converts winter time (UTC+1)', () => {
    expect(parseZonedDateTime('2025-12-06T10:06:34', 'Europe/Paris')?.toISOString()).toBe('2025-12-06T09:06:34.000Z');
  });

  it('converts summer time (UTC+2)', () => {
    expect(parseZonedDateTime('2026-07-15T10:06:34', 'Europe/Paris')?.toISOString()).toBe('2026-07-15T08:06:34.000Z');
  });

  it('does not shift a value that is already UTC wall-clock', () => {
    expect(parseZonedDateTime('2026-07-15T10:06:34', 'UTC')?.toISOString()).toBe('2026-07-15T10:06:34.000Z');
  });

  it('accepts a space instead of the T separator', () => {
    expect(parseZonedDateTime('2025-12-06 10:06:34', 'Europe/Paris')?.toISOString()).toBe('2025-12-06T09:06:34.000Z');
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseZonedDateTime(null, 'Europe/Paris')).toBeNull();
    expect(parseZonedDateTime('nope', 'Europe/Paris')).toBeNull();
  });
});
