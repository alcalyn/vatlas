import { describe, expect, it } from 'vitest';
import { InvalidVatError, normalizeVatInput, parseVatNumber } from '../src/vat/parse.js';
import { edrpouCheckDigit, frenchVatKey, frenchVatNumber, VAT_RULES } from '../src/vat/rules.js';

describe('normalizeVatInput', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeVatInput(' fr 95 884.831-538 ')).toBe('FR95884831538');
  });
});

describe('French VAT key', () => {
  it('derives the key from the SIREN', () => {
    expect(frenchVatKey('884831538')).toBe('95');
    expect(frenchVatNumber('884831538')).toBe('95884831538');
  });

  it('left-pads keys below ten', () => {
    expect(frenchVatKey('000000097')).toHaveLength(2);
  });
});

describe('parseVatNumber', () => {
  it('parses a valid French number', () => {
    const parsed = parseVatNumber('FR95884831538');
    expect(parsed).toEqual({
      countryCode: 'FR',
      nationalNumber: '95884831538',
      formatted: 'FR95884831538',
    });
  });

  it('maps the Greek ISO prefix onto the VAT prefix', () => {
    expect(parseVatNumber('GR123456789').countryCode).toBe('EL');
  });

  it.each([
    ['FI20774740', 'Finland'],
    ['PL5252248481', 'Poland'],
    ['LV40003010053', 'Latvia'],
    ['EE101335276', 'Estonia'],
    ['DE811907980', 'Germany'],
    ['NL123456789B01', 'Netherlands'],
  ])('accepts %s (%s)', (vatNumber) => {
    expect(() => parseVatNumber(vatNumber)).not.toThrow();
  });

  it('rejects an unknown country prefix', () => {
    expect(() => parseVatNumber('ZZ123456789')).toThrow(expect.objectContaining({ reason: 'UNKNOWN_COUNTRY' }));
  });

  it('rejects a malformed national part', () => {
    expect(() => parseVatNumber('XX123')).toThrow(InvalidVatError);
    expect(() => parseVatNumber('FR123')).toThrow(expect.objectContaining({ reason: 'BAD_FORMAT' }));
  });

  it('rejects a broken French checksum', () => {
    expect(() => parseVatNumber('FR01884831538')).toThrow(expect.objectContaining({ reason: 'BAD_CHECKSUM' }));
  });

  it('rejects a broken Polish checksum', () => {
    expect(() => parseVatNumber('PL5252248480')).toThrow(expect.objectContaining({ reason: 'BAD_CHECKSUM' }));
  });

  it.each([
    ['AU11000000948', 'Australia'],
    ['BR07396865000168', 'Brazil'],
    ['CA106679285', 'Canada'],
    ['CHE105805313', 'Switzerland'],
    ['EC1790016919001', 'Ecuador'],
    ['GL12608950', 'Greenland, a Danish CVR number under its own prefix'],
    ['JPT1010001001359', 'Japan'],
    ['NG1002183661', 'Nigeria, the JTB number'],
    ['NG009690090001', 'Nigeria, the older FIRS one'],
    ['NO923609016', 'Norway'],
    ['RU7707083893', 'Russia'],
    ['SG00022100K', 'Singapore'],
    ['UA03777114', 'Ukraine'],
    ['VN0100109106', 'Vietnam'],
  ])('accepts %s (%s)', (taxNumber) => {
    expect(() => parseVatNumber(taxNumber)).not.toThrow();
  });

  it('keeps the T of a Japanese registration number, which is part of it', () => {
    expect(parseVatNumber('JP T1010001001359').nationalNumber).toBe('T1010001001359');
  });

  it.each([
    ['CA106679285RT0001', 'the sales-tax account'],
    ['CA 106 679 285 RT 0001', 'the same, written out'],
    ['CA106679285RC0001', 'the corporate income tax account'],
  ])('drops the program account of a Canadian number: %s (%s)', (written) => {
    // Both forms are the same company, with one history.
    expect(parseVatNumber(written).formatted).toBe('CA106679285');
  });

  it.each([
    ['UA037771118081', '03777114'],
    ['UA336801219184', '33680120'],
    ['UA000321026651', '00032106'],
    ['UA 011801115450', '01180116'],
  ])('reduces a Ukrainian ІПН to the ЄДРПОУ it was built from: %s → %s', (written, edrpou) => {
    // The ІПН keeps the first seven digits of the ЄДРПОУ, and the eighth (check digit) is recomputed.
    // Both forms are one company.
    expect(parseVatNumber(written).formatted).toBe(`UA${edrpou}`);
  });

  it.each([
    ['CHE-105.805.313 MWST', 'German'],
    ['CHE-105.805.313 TVA', 'French'],
    ['CHE-105.805.313 IVA', 'Italian'],
    ['CHE-105.805.313', 'no suffix at all'],
  ])('reads a Swiss UID however the invoice spells it: %s (%s)', (written) => {
    // `CH` is the prefix, leaving the `E` of `CHE` and the tax suffix around the number. All four forms
    // are one company.
    expect(parseVatNumber(written).formatted).toBe('CH105805313');
  });

  it.each([
    ['NO 974 760 673 MVA', 'the register suffix'],
    ['NO974760673', 'without it'],
  ])('drops the MVA a Norwegian number is written with: %s (%s)', (written) => {
    expect(parseVatNumber(written).formatted).toBe('NO974760673');
  });

  it('rejects a broken Swiss or Norwegian check digit', () => {
    expect(() => parseVatNumber('CHE-105.805.314 MWST')).toThrow(expect.objectContaining({ reason: 'BAD_CHECKSUM' }));
    expect(() => parseVatNumber('NO923609017')).toThrow(expect.objectContaining({ reason: 'BAD_CHECKSUM' }));
  });

  it('accepts a ЄДРПОУ whose check digit the published rule does not produce', () => {
    // Thirteen real codes out of 14,662 fail the rule (`00000006`, `00000008`, old farms), so no
    // Ukrainian checksum is declared.
    expect(() => parseVatNumber('UA00000006')).not.toThrow();
    expect(edrpouCheckDigit('0000000')).not.toBe('6');
  });

  it.each([
    ['AU11000000949', 'an ABN'],
    ['BR07396865000169', 'a CNPJ'],
    ['JPT5010001004238', 'a 法人番号'],
    ['TW22099132', 'a 統一編號'],
    ['IL520000473', 'an Israeli company number'],
    ['CA106679286', 'a business number'],
    ['NZ9429040402544', 'an NZBN'],
    ['RU7707083894', 'a ten-digit ИНН'],
    ['RU500100732258', 'a twelve-digit ИНН'],
    ['PE20100017492', 'a RUC'],
  ])('rejects a broken checksum in %s (%s)', (taxNumber) => {
    expect(() => parseVatNumber(taxNumber)).toThrow(expect.objectContaining({ reason: 'BAD_CHECKSUM' }));
  });

  it('covers every member state, Northern Ireland and countries outside Europe', () => {
    // The member states and XI are fixed. The rest grows with every new country, so this checks what
    // must be there rather than a total.
    const memberStates = [
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
    ];
    for (const code of [...memberStates, 'XI']) expect(VAT_RULES[code]).toBeDefined();
    expect(Object.keys(VAT_RULES).length).toBeGreaterThan(memberStates.length + 1);
  });
});
