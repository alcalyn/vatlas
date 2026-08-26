import { describe, expect, it } from 'vitest';
import { normalizeValue, sameValue, verdictFor } from '../src/cli/agreement.js';

describe('normalizeValue', () => {
  it('drops case, accents and punctuation, which carry nothing here', () => {
    expect(normalizeValue('9, Rue des Colonnes')).toBe('9 RUE DES COLONNES');
    expect(normalizeValue('MÜNCHEN')).toBe('MUNCHEN');
  });

  it('treats a value made only of punctuation as no value at all', () => {
    expect(normalizeValue('---')).toBeNull();
    expect(normalizeValue('   ')).toBeNull();
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
  });
});

describe('sameValue', () => {
  it('ignores the order of the words, since the two sides place the legal form differently', () => {
    expect(sameValue('SARL DUPONT', 'DUPONT SARL')).toBe(true);
  });

  it('still separates two different companies', () => {
    expect(sameValue('DUPONT SARL', 'DURAND SARL')).toBe(false);
  });

  it('is never true of a missing value, which is a gap and not an agreement', () => {
    expect(sameValue(null, null)).toBe(false);
    expect(sameValue('DUPONT', null)).toBe(false);
  });
});

describe('verdictFor', () => {
  it('calls two spellings of one answer equal', () => {
    expect(verdictFor('9, Rue des Colonnes', '9 RUE DES COLONNES')).toBe('equal');
    expect(verdictFor('SARL Dupont', 'DUPONT S.A.R.L.')).toBe('equal');
  });

  it('calls two answers that really differ different', () => {
    expect(verdictFor('75002', '75008')).toBe('different');
    expect(verdictFor('PARIS', 'LYON')).toBe('different');
  });

  it('separates a coverage gap from a contradiction, on each side', () => {
    expect(verdictFor('PARIS', null)).toBe('onlyVatlas');
    expect(verdictFor(null, 'PARIS')).toBe('onlyVies');
    expect(verdictFor(null, null)).toBe('neither');
  });

  it('reads the "---" that several member states send as an empty field', () => {
    // VIES answers "---" instead of omitting the element. Read as a value, every German answer would
    // disagree.
    expect(verdictFor('Bayerischer Landtag', '---')).toBe('onlyVatlas');
  });
});

describe('verdictFor, abbreviations spelled with and without dots', () => {
  it('reads a dotted abbreviation as the word it abbreviates', () => {
    expect(verdictFor('DUPONT S.A.', 'DUPONT SA')).toBe('equal');
    expect(verdictFor('ACME SP. Z O.O.', 'ACME SP Z OO')).toBe('equal');
  });

  it('does not glue two whole words together', () => {
    expect(verdictFor('PARIS', 'PARIS SUD')).toBe('different');
  });
});
