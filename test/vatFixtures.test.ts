import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVatNumber } from '../src/vat/parse.js';
import { VAT_RULES } from '../src/vat/rules.js';

/**
 * The 27 member states, with their VAT prefix (EL for Greece, not GR). Northern Ireland (XI) is
 * covered by VIES but is not an EU country.
 */
const EU_VAT_PREFIXES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'EL',
  'ES',
  'FI',
  'FR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

/**
 * Real VAT numbers, each confirmed valid by VIES when collected, to test syntax and checksum rules
 * on real data.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'valid-vat-numbers.txt');

/**
 * Countries outside the EU, in a separate file: there is no VIES to confirm them. Each number was
 * read from the register's own data instead.
 */
const NON_EU_FIXTURE = join(import.meta.dirname, 'fixtures', 'valid-tax-numbers-non-eu.txt');

const read = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const numbers = read(FIXTURE);
const nonEuNumbers = read(NON_EU_FIXTURE);

describe('valid-vat-numbers.txt', () => {
  it('is a non-empty list, one number per line', () => {
    expect(numbers.length).toBeGreaterThan(300);
  });

  it('holds at least one number for every one of the 27 member states', () => {
    const byCountry = new Set(numbers.map((number) => number.slice(0, 2)));
    const missing = EU_VAT_PREFIXES.filter((prefix) => !byCountry.has(prefix));

    expect(missing).toEqual([]);
  });

  it('uses the VAT prefix, not the ISO code, for Greece', () => {
    expect(numbers.some((number) => number.startsWith('EL'))).toBe(true);
    expect(numbers.some((number) => number.startsWith('GR'))).toBe(false);
  });

  it('holds no duplicates', () => {
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('accepts every number, syntax and checksum alike', () => {
    const rejected = numbers.filter((number) => {
      try {
        parseVatNumber(number);
        return false;
      } catch {
        return true;
      }
    });

    expect(rejected).toEqual([]);
  });

  it('round-trips each number to its canonical form', () => {
    for (const number of numbers) {
      expect(parseVatNumber(number).formatted).toBe(number);
    }
  });
});

describe('valid-tax-numbers-non-eu.txt', () => {
  it('accepts every number, syntax and checksum alike', () => {
    const rejected = nonEuNumbers.filter((number) => {
      try {
        parseVatNumber(number);
        return false;
      } catch {
        return true;
      }
    });

    expect(rejected).toEqual([]);
  });

  it('round-trips each number to its canonical form', () => {
    for (const number of nonEuNumbers) {
      expect(parseVatNumber(number).formatted).toBe(number);
    }
  });

  it('holds no duplicates', () => {
    expect(new Set(nonEuNumbers).size).toBe(nonEuNumbers.length);
  });
});

describe('the two fixtures together', () => {
  it('hold at least one number for every prefix the parser accepts', () => {
    // Northern Ireland is the exception: VIES answers for XI, but no numbers were collected for it.
    const seen = new Set([...numbers, ...nonEuNumbers].map((number) => number.slice(0, 2)));
    const missing = Object.keys(VAT_RULES).filter((prefix) => prefix !== 'XI' && !seen.has(prefix));

    expect(missing).toEqual([]);
  });
});
