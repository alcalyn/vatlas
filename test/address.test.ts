import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/lib/address.js';

describe('parseAddress', () => {
  it('splits the two-line form most member states send', () => {
    // Exactly what VIES returns for FR95884831538.
    expect(parseAddress('9 RUE DES COLONNES\n75002 PARIS', 'FR')).toEqual({
      line1: '9 RUE DES COLONNES',
      line2: null,
      postalCode: '75002',
      city: 'PARIS',
    });
  });

  it('splits a single line separated by a run of spaces, as Greece sends', () => {
    expect(parseAddress('ΑΙΟΛΟΥ 86        10559 - ΑΘΗΝΑ', 'EL')).toEqual({
      line1: 'ΑΙΟΛΟΥ 86',
      line2: null,
      postalCode: '10559',
      city: 'ΑΘΗΝΑ',
    });
  });

  it('drops the Italian province appended to the town', () => {
    expect(parseAddress('LARGO FRANCESCO RICHINI 6 \n20122 MILANO MI\n', 'IT')).toEqual({
      line1: 'LARGO FRANCESCO RICHINI 6',
      line2: null,
      postalCode: '20122',
      city: 'MILANO',
    });
  });

  it('keeps every extra street line in line2', () => {
    expect(parseAddress('ACME BUILDING\nFLOOR 3\n1 MAIN ROAD\n1000 BRUSSELS', 'BE')).toEqual({
      line1: 'ACME BUILDING',
      line2: 'FLOOR 3, 1 MAIN ROAD',
      postalCode: '1000',
      city: 'BRUSSELS',
    });
  });

  it('handles the postal code written after the town', () => {
    expect(parseAddress('1 ST STEPHENS GREEN\nDUBLIN D02 H950', 'IE')).toEqual({
      line1: '1 ST STEPHENS GREEN',
      line2: null,
      postalCode: 'D02 H950',
      city: 'DUBLIN',
    });
  });

  it('handles a postal code with letters', () => {
    expect(parseAddress('PRINSENGRACHT 10\n1015 DV AMSTERDAM', 'NL')).toEqual({
      line1: 'PRINSENGRACHT 10',
      line2: null,
      postalCode: '1015 DV',
      city: 'AMSTERDAM',
    });
  });

  it('handles the Polish dashed format', () => {
    expect(parseAddress('UL. PROSTA 51\n00-838 WARSZAWA', 'PL')).toEqual({
      line1: 'UL. PROSTA 51',
      line2: null,
      postalCode: '00-838',
      city: 'WARSZAWA',
    });
  });

  it('leaves an unrecognisable address whole rather than guessing', () => {
    expect(parseAddress('SOMEWHERE IN PARTICULAR', 'FR')).toEqual({
      line1: 'SOMEWHERE IN PARTICULAR',
      line2: null,
      postalCode: null,
      city: null,
    });
  });

  it('falls back to plain lines for a country with no postal rule', () => {
    expect(parseAddress('STREET 1\nSOMETOWN', 'ZZ')).toEqual({
      line1: 'STREET 1',
      line2: 'SOMETOWN',
      postalCode: null,
      city: null,
    });
  });

  it('returns nothing for an empty or withheld address', () => {
    const empty = { line1: null, line2: null, postalCode: null, city: null };
    expect(parseAddress(null, 'DE')).toEqual(empty);
    expect(parseAddress('', 'DE')).toEqual(empty);
    expect(parseAddress('   \n  ', 'DE')).toEqual(empty);
  });
});

describe('parseAddress, postal code embedded in a line', () => {
  it('splits an address written entirely on one line', () => {
    expect(parseAddress('9 RUE DES COLONNES 75002 PARIS', 'FR')).toEqual({
      line1: '9 RUE DES COLONNES',
      line2: null,
      postalCode: '75002',
      city: 'PARIS',
    });
  });

  it('prefers the last candidate, so a street number is not taken for a postal code', () => {
    expect(parseAddress('12345 STREET 75002 PARIS', 'FR')).toMatchObject({
      postalCode: '75002',
      city: 'PARIS',
      line1: '12345 STREET',
    });
  });

  it('ignores a trailing number with no town after it', () => {
    expect(parseAddress('RUE DE LA PAIX 75002', 'FR')).toEqual({
      line1: 'RUE DE LA PAIX 75002',
      line2: null,
      postalCode: null,
      city: null,
    });
  });
});

describe('parseAddress, Bulgaria', () => {
  it('reads the town after гр. and the postal code closing the line', () => {
    // Exactly what VIES returns for BG205503979.
    expect(
      parseAddress('пл. Позитано  №1, Виторио Позитано Бизнес Център ет.3 обл.СОФИЯ, гр.СОФИЯ 1000', 'BG'),
    ).toEqual({
      line1: 'пл. Позитано',
      line2: '№1, Виторио Позитано Бизнес Център ет.3',
      postalCode: '1000',
      city: 'СОФИЯ',
    });
  });

  it('drops the province written before the town', () => {
    expect(parseAddress('ГЕО МИЛЕВ  №13А обл.СОФИЯ, гр.СОФИЯ 1111', 'BG')).toEqual({
      line1: 'ГЕО МИЛЕВ',
      line2: '№13А',
      postalCode: '1111',
      city: 'СОФИЯ',
    });
  });

  it('reads a town of several words', () => {
    expect(parseAddress('УЛ. ЦАР СИМЕОН 4 обл.СТАРА ЗАГОРА, гр.СТАРА ЗАГОРА 6000', 'BG')).toEqual({
      line1: 'УЛ. ЦАР СИМЕОН 4',
      line2: null,
      postalCode: '6000',
      city: 'СТАРА ЗАГОРА',
    });
  });

  it('reads a village written with с.', () => {
    expect(parseAddress('УЛ. ПЪРВА 2 обл.ПЕРНИК, с.ДРАГИЧЕВО 2351', 'BG')).toEqual({
      line1: 'УЛ. ПЪРВА 2',
      line2: null,
      postalCode: '2351',
      city: 'ДРАГИЧЕВО',
    });
  });

  it('still reads the postal code when no town is labelled', () => {
    expect(parseAddress('УЛ. ПЪРВА 2 обл.ПЕРНИК 2351', 'BG')).toEqual({
      line1: 'УЛ. ПЪРВА 2 обл.ПЕРНИК',
      line2: null,
      postalCode: '2351',
      city: null,
    });
  });

  it('keeps reading the usual continental form', () => {
    expect(parseAddress('УЛ. ПЪРВА 2\n1000 СОФИЯ', 'BG')).toEqual({
      line1: 'УЛ. ПЪРВА 2',
      line2: null,
      postalCode: '1000',
      city: 'СОФИЯ',
    });
  });
});
