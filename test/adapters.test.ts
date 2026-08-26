import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { streamCsv, streamCsvRows, type CsvRow } from '../src/lib/csv.js';
import { toText } from '../src/lib/parquet.js';
import { streamJsonArray } from '../src/lib/jsonArrayStream.js';
import { mapEstonianRow } from '../src/api/sources/bulk/ee-rik.js';
import { mapFinnishCompany } from '../src/api/sources/live/fi-prh.js';
import { frenchName, mapHeadOfficeRow, mapLegalUnitRow } from '../src/api/sources/bulk/fr-sirene.js';
import { FRENCH_LEGAL_FORM_COUNT, frenchLegalForm } from '../src/api/sources/bulk/frenchLegalForms.js';
import {
  mapPublicBody,
  mapRegisterRow,
  mapVatPayerOnly,
  parsePublicBodyAddress,
  parseVatPayerRow,
  splitLatvianAddress,
} from '../src/api/sources/bulk/lv-urvid.js';
import { mapPolishSubject, polishLegalForm } from '../src/api/sources/live/pl-mfwl.js';
import {
  fullFileDate,
  kboVatNumber,
  languageRank,
  mapBelgianAddress,
  mapBelgianEnterprise,
  pickFullFile,
} from '../src/api/sources/bulk/be-kbo.js';
import { mapCroatianSubject } from '../src/api/sources/live/hr-sudreg.js';
import { mapNorwegianUnit, type BrregUnit } from '../src/api/sources/live/no-brreg.js';
import {
  firstOrganisation,
  isVatRegistered,
  legalAddress,
  mapSwissOrganisation,
  swissLegalForm,
} from '../src/api/sources/live/ch-uid.js';
import { mapVietnameseBusiness, type VietQrResponse } from '../src/api/sources/live/vn-vietqr.js';
import { formField, mapNigerianTaxpayer, spellTin } from '../src/api/sources/live/ng-firs.js';
import {
  headOffice,
  mapEcuadorianTaxpayer,
  splitEcuadorianAddress,
  type SriEstablishment,
  type SriTaxpayer,
} from '../src/api/sources/live/ec-sri.js';
import { czechLegalForm, mapCzechSubject } from '../src/api/sources/live/cz-ares.js';
import { mapDanishCompany } from '../src/api/sources/live/dk-cvr.js';
import { isGreenlandic } from '../src/api/sources/live/gl-cvr.js';
import { mapGreekFields, parseAadeResponse } from '../src/api/sources/live/el-aade.js';
import { mapGemiCompany } from '../src/api/sources/live/el-gemi.js';
import { mapPeppolCard, mapPeppolEntity } from '../src/api/sources/live/de-peppol.js';
import { streamXmlElements } from '../src/lib/xml.js';
import { mapRomanianEntry } from '../src/api/sources/live/ro-anaf.js';
import { mapAbrRecord } from '../src/api/sources/bulk/au-abr.js';
import { mapAcraRow } from '../src/api/sources/bulk/sg-acra.js';
import { editionDateOf, mapInvoiceRow, parseDownloadIds } from '../src/api/sources/bulk/jp-invoice.js';
import { mapEstablishmentRow, parseEditionFolders, readLabels } from '../src/api/sources/bulk/br-cnpj.js';
import { mapTaiwanCompany, parseMinguoDate } from '../src/api/sources/live/tw-gcis.js';
import { mapIsraeliCompany, restoreQuotes } from '../src/api/sources/live/il-registrar.js';
import { costaRicanLegalForm, mapCostaRicanTaxpayer } from '../src/api/sources/live/cr-hacienda.js';
import { currentAddress, mapNewZealandEntity } from '../src/api/sources/live/nz-nzbn.js';
import { departmentOf, mapPaddedRucRow, peruvianStatus } from '../src/api/sources/bulk/pe-sunat.js';
import { mapCorporation, parseActCodes, parseEditionDate } from '../src/api/sources/bulk/ca-corporations.js';
import { mapRsmpDocument, parseEditions } from '../src/api/sources/bulk/ru-rsmp.js';
import { mapEdrSubject, ukrainianStatus } from '../src/api/sources/bulk/ua-edr.js';
import { COUNTRIES, getCountry, resolveCountry, strategyOf } from '../src/api/countries/registry.js';
import { VAT_RULES } from '../src/vat/rules.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('Estonia', () => {
  it('maps the register dump and skips companies without a VAT number', async () => {
    const rows: CsvRow[] = [];
    for await (const row of streamCsv(createReadStream(join(FIXTURES, 'ee_lihtandmed_sample.csv')), {
      delimiter: ';',
    })) {
      rows.push(row);
    }
    expect(rows).toHaveLength(3);

    expect(mapEstonianRow(rows[0]!)).toBeNull();

    const mapped = mapEstonianRow(rows[1]!);
    expect(mapped).toMatchObject({
      vatNumber: 'EE101335276',
      nationalId: '11694365',
      name: '007 Autohaus osaühing',
      legalForm: 'Osaühing',
      status: 'active',
      postalCode: '51004',
      city: 'Tartu linn, Tartu linn, Tartu maakond',
    });
    expect(mapped?.companyLastUpdatedAt?.toISOString()).toBe('2009-07-30T00:00:00.000Z');

    expect(mapEstonianRow(rows[2]!)?.status).toBe('inactive');
  });
});

describe('Finland', () => {
  const company = {
    businessId: { value: '0100002-9', registrationDate: '1976-04-23' },
    names: [
      { name: 'Vanha Oy', type: '1', endDate: '2005-12-19' },
      { name: 'Nykyinen Oy', type: '1' },
    ],
    companyForms: [{ descriptions: [{ languageCode: '3', description: 'Limited company' }] }],
    addresses: [
      {
        type: 2,
        street: 'Laukkakatu',
        buildingNumber: '6',
        postCode: '15830',
        postOffices: [{ city: 'LAHTI', languageCode: '1' }],
      },
    ],
    registrationDate: '1976-04-23',
  };

  it('derives the VAT number from the Business ID', () => {
    expect(mapFinnishCompany(company)).toMatchObject({
      vatNumber: 'FI01000029',
      nationalId: '0100002-9',
      name: 'Nykyinen Oy',
      legalForm: 'Limited company',
      status: 'active',
      addressLine1: 'Laukkakatu 6',
      postalCode: '15830',
      city: 'LAHTI',
    });
  });

  it('reports a company with an end date as inactive', () => {
    expect(mapFinnishCompany({ ...company, endDate: '2005-12-19' })?.status).toBe('inactive');
  });

  it('ignores an unusable Business ID', () => {
    expect(mapFinnishCompany({ businessId: { value: 'not-an-id' } })).toBeNull();
  });
});

describe('France', () => {
  const row: CsvRow = {
    siren: '884831538',
    denominationUniteLegale: 'JULIEN MAULNY',
    categorieJuridiqueUniteLegale: '5499',
    etatAdministratifUniteLegale: 'A',
    dateDernierTraitementUniteLegale: '2026-01-05T10:00:00',
    nomUniteLegale: '',
    prenom1UniteLegale: '',
  };

  it('computes the VAT number from the SIREN', () => {
    expect(mapLegalUnitRow(row)).toMatchObject({
      vatNumber: 'FR95884831538',
      nationalId: '884831538',
      name: 'JULIEN MAULNY',
      legalForm: 'Autre société à responsabilité limitée',
      status: 'active',
    });
  });

  it('resolves the INSEE legal-category code to a label, at every nomenclature level', () => {
    expect(frenchLegalForm('1000')).toBe('Personne physique');
    expect(frenchLegalForm('5400')).toBe('Société à responsabilité limitée (SARL)');
    expect(frenchLegalForm('5710')).toBe('Société par actions simplifiée (SAS)');
    expect(frenchLegalForm('9220')).toBe('Association déclarée');
    expect(FRENCH_LEGAL_FORM_COUNT).toBeGreaterThan(250);
  });

  it('keeps an unknown code rather than dropping it', () => {
    expect(frenchLegalForm('5669')).toBeNull();
    expect(mapLegalUnitRow({ ...row, categorieJuridiqueUniteLegale: '5669' })?.legalForm).toBe('5669');
  });

  it('falls back to the person name for sole traders', () => {
    expect(frenchName({ denominationUniteLegale: '', prenomUsuelUniteLegale: 'Marie', nomUniteLegale: 'Durand' })).toBe(
      'Marie Durand',
    );
  });

  it('rejects rows without a usable SIREN or name', () => {
    expect(mapLegalUnitRow({ ...row, siren: '42' })).toBeNull();
    expect(mapLegalUnitRow({ ...row, denominationUniteLegale: '' })).toBeNull();
  });

  const headOfficeRow: CsvRow = {
    siren: '884831538',
    etablissementSiege: 'true',
    numeroVoieEtablissement: '12',
    typeVoieEtablissement: 'RUE',
    libelleVoieEtablissement: 'DE LA PAIX',
    codePostalEtablissement: '75002',
    libelleCommuneEtablissement: 'PARIS',
    complementAdresseEtablissement: 'BAT B',
  };

  it('keeps head offices only, keyed by the derived VAT number', () => {
    expect(mapHeadOfficeRow(headOfficeRow)).toEqual({
      siren: '884831538',
      address: {
        addressLine1: '12 RUE DE LA PAIX',
        addressLine2: 'BAT B',
        postalCode: '75002',
        city: 'PARIS',
        addressCountry: 'FR',
      },
    });

    expect(mapHeadOfficeRow({ ...headOfficeRow, etablissementSiege: 'false' })).toBeNull();
  });

  /**
   * The Parquet files are typed (boolean head office flag, integer legal category, timestamp), unlike
   * the CSV. `streamParquet` converts them back to text, so the same three rows must produce the same
   * records as the CSV cases above.
   */
  it('maps the typed values the Parquet edition publishes', () => {
    const parquet = (raw: Record<string, unknown>): CsvRow =>
      Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, toText(value)]));

    expect(
      mapLegalUnitRow(
        parquet({
          siren: '884831538',
          denominationUniteLegale: 'JULIEN MAULNY',
          categorieJuridiqueUniteLegale: 5499n,
          etatAdministratifUniteLegale: 'A',
          dateDernierTraitementUniteLegale: new Date('2026-01-05T10:00:00Z'),
        }),
      ),
    ).toEqual(mapLegalUnitRow(row));

    expect(
      mapHeadOfficeRow(
        parquet({
          siren: '884831538',
          etablissementSiege: true,
          numeroVoieEtablissement: '12',
          typeVoieEtablissement: 'RUE',
          libelleVoieEtablissement: 'DE LA PAIX',
          codePostalEtablissement: '75002',
          libelleCommuneEtablissement: 'PARIS',
          complementAdresseEtablissement: 'BAT B',
        }),
      ),
    ).toEqual(mapHeadOfficeRow(headOfficeRow));

    expect(mapHeadOfficeRow(parquet({ ...headOfficeRow, etablissementSiege: false }))).toBeNull();
  });
});

describe('Latvia', () => {
  const vatRow: CsvRow = {
    Numurs: 'LV40003010053',
    Nosaukums: 'TURSONS SIA',
    Aktivs: 'ir',
    Registrets: ' 01.01.1996 ',
    Izslegts: '',
  };

  it('splits the LV prefix off the VAT payers file', () => {
    const parsed = parseVatPayerRow(vatRow);
    expect(parsed?.registrationCode).toBe('40003010053');
    expect(parsed?.entry).toMatchObject({ vatNumber: '40003010053', name: 'TURSONS SIA', active: true });
  });

  it('joins the register row with its VAT payer entry', () => {
    const entry = parseVatPayerRow(vatRow)!.entry;
    const registerRow: CsvRow = {
      regcode: '40003010053',
      name: 'TURSONS SIA',
      type_text: 'Sabiedrība ar ierobežotu atbildību',
      address: 'Rīga, Latgales iela 180 - 5',
      index: '1019',
      terminated: '',
    };

    expect(mapRegisterRow(registerRow, entry)).toMatchObject({
      vatNumber: 'LV40003010053',
      nationalId: '40003010053',
      legalForm: 'Sabiedrība ar ierobežotu atbildību',
      status: 'active',
      addressLine1: 'Latgales iela 180 - 5',
      postalCode: 'LV-1019',
      city: 'Rīga',
    });

    expect(mapRegisterRow({ ...registerRow, terminated: '2014-04-10' }, entry).status).toBe('inactive');
  });

  it('places a public body from the institutions list', () => {
    const entry = parseVatPayerRow({ ...vatRow, Numurs: 'LV90000076669', Nosaukums: 'Latvijas Universitāte' })!.entry;

    expect(
      mapPublicBody('90000076669', entry, {
        name: 'Latvijas Universitāte',
        address: 'Raiņa bulvāris 19, Rīga, LV-1050',
      }),
    ).toMatchObject({
      vatNumber: 'LV90000076669',
      nationalId: '90000076669',
      name: 'Latvijas Universitāte',
      // Its authorityType is an English enumeration, not a Latvian legal form.
      legalForm: null,
      status: 'active',
      addressLine1: 'Raiņa bulvāris 19',
      postalCode: 'LV-1050',
      city: 'Rīga',
    });
  });

  it('still stores VAT payers missing from the register', () => {
    const entry = parseVatPayerRow({ ...vatRow, Aktivs: 'nav' })!.entry;
    expect(mapVatPayerOnly('40003010053', entry)).toMatchObject({
      vatNumber: 'LV40003010053',
      status: 'inactive',
      addressLine1: null,
    });
  });

  it('ignores rows whose number is not a Latvian VAT number', () => {
    expect(parseVatPayerRow({ ...vatRow, Numurs: '' })).toBeNull();
    expect(parseVatPayerRow({ ...vatRow, Numurs: 'EE101335276' })).toBeNull();
  });
});

describe('Poland', () => {
  it('maps a White List subject, splitting the one address string it sends', () => {
    expect(
      mapPolishSubject({
        name: 'ACME sp. z o.o.',
        nip: '5252248481',
        statusVat: 'Czynny',
        regon: '140000000',
        krs: '0000123456',
        workingAddress: 'ul. Prosta 51, 00-838 Warszawa',
      }),
    ).toMatchObject({
      vatNumber: 'PL5252248481',
      nationalId: '140000000',
      status: 'active',
      legalForm: 'Spółka z ograniczoną odpowiedzialnością',
      addressLine1: 'ul. Prosta 51',
      postalCode: '00-838',
      city: 'Warszawa',
    });
  });

  it('falls back to the residence address when there is no working one', () => {
    expect(
      mapPolishSubject({ nip: '5252248481', statusVat: 'Czynny', residenceAddress: 'Mickiewicza 1 30-059 Kraków' }),
    ).toMatchObject({ addressLine1: 'Mickiewicza 1', postalCode: '30-059', city: 'Kraków' });
  });

  it('reads the legal form off the end of the name, in full or abbreviated', () => {
    expect(polishLegalForm('ACME SPÓŁKA AKCYJNA')).toBe('Spółka akcyjna');
    expect(polishLegalForm('Orlen S.A.')).toBe('Spółka akcyjna');
    expect(polishLegalForm('ACME sp. z o.o. sp. k.')).toBe(
      'Spółka z ograniczoną odpowiedzialnością spółka komandytowa',
    );
    expect(polishLegalForm('Fundacja Dobra Wola')).toBe('Fundacja');
  });

  it('does not read a legal form out of the middle of a word', () => {
    // An unanchored "SA" would make this a joint-stock company.
    expect(polishLegalForm('PRZEDSIEBIORSTWO WISA')).toBeNull();
    expect(polishLegalForm('Jan Kowalski')).toBeNull();
    expect(polishLegalForm(null)).toBeNull();
  });

  it('treats any other VAT status as inactive', () => {
    expect(mapPolishSubject({ nip: '5252248481', statusVat: 'Niezarejestrowany' })?.status).toBe('inactive');
  });
});

describe('Latvia', () => {
  it('takes the locality from a city address', () => {
    expect(splitLatvianAddress('Rīga, Avotu iela 17')).toEqual({ line1: 'Avotu iela 17', city: 'Rīga' });
  });

  it('skips the novads and the pagasts to reach the village', () => {
    expect(splitLatvianAddress('Jelgavas nov., Cenu pag., Brankas, Spartaka iela 9 - 13')).toEqual({
      line1: 'Spartaka iela 9 - 13',
      city: 'Brankas',
    });
  });

  it('keeps a property name as the street when there is no street', () => {
    expect(splitLatvianAddress('Dundagas nov., Kolkas pag., Kolka, "Krastnieki"')).toEqual({
      line1: '"Krastnieki"',
      city: 'Kolka',
    });
  });

  it('keeps an address made only of administrative units rather than dropping it', () => {
    expect(splitLatvianAddress('Ogres nov., Madlienas pag.')).toEqual({
      line1: 'Ogres nov., Madlienas pag.',
      city: null,
    });
  });

  it('has nothing to say about an empty address', () => {
    expect(splitLatvianAddress(null)).toEqual({ line1: null, city: null });
  });

  it('reads the institutions list the other way round, street first and postal code last', () => {
    expect(parsePublicBodyAddress('Ķengaraga iela 8, Rīga, LV-1063')).toEqual({
      line1: 'Ķengaraga iela 8',
      city: 'Rīga',
      postalCode: 'LV-1063',
    });
  });

  it('walks back past the administrative units to the town', () => {
    expect(parsePublicBodyAddress('Zinātnes iela 2, Priekuļi, Priekuļu pag., Cēsu nov., LV-4126')).toEqual({
      line1: 'Zinātnes iela 2',
      city: 'Priekuļi',
      postalCode: 'LV-4126',
    });
  });

  it('keeps a locality with no street and no postal code', () => {
    expect(parsePublicBodyAddress('Adamova, Vērēmu pag., Rēzeknes nov.')).toEqual({
      line1: null,
      city: 'Adamova',
      postalCode: null,
    });
    expect(parsePublicBodyAddress('Rīga')).toEqual({ line1: null, city: 'Rīga', postalCode: null });
  });

  it('does not read the street as the town when the register order is reversed', () => {
    // Why this exists next to splitLatvianAddress.
    expect(splitLatvianAddress('Ķengaraga iela 8, Rīga, LV-1063').city).toBe('Ķengaraga iela 8');
  });

  it('has nothing to say about an empty institutions address', () => {
    expect(parsePublicBodyAddress(null)).toEqual({ line1: null, city: null, postalCode: null });
  });
});

describe('streamJsonArray', () => {
  it('yields the elements of a top-level array without buffering the whole document', async () => {
    const source = Readable.from(['[{"a":1,"nested":{"b":"}"}},', '{"a":2,"text":"quote \\" and brace {"}', ']']);

    const items: unknown[] = [];
    for await (const item of streamJsonArray(source)) items.push(item);

    expect(items).toEqual([
      { a: 1, nested: { b: '}' } },
      { a: 2, text: 'quote " and brace {' },
    ]);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const encoded = Buffer.from('[{"name":"Osaühiö"}]', 'utf8');
    const source = Readable.from([encoded.subarray(0, 14), encoded.subarray(14)]);

    const items: { name: string }[] = [];
    for await (const item of streamJsonArray<{ name: string }>(source)) items.push(item);

    expect(items).toEqual([{ name: 'Osaühiö' }]);
  });
});

describe('Czechia', () => {
  const subject = {
    ico: '00177041',
    dic: 'CZ00177041',
    obchodniJmeno: 'Škoda Auto a.s.',
    pravniForma: '121',
    datumAktualizace: '2026-08-22',
    sidlo: {
      kodStatu: 'CZ',
      nazevObce: 'Mladá Boleslav',
      nazevCastiObce: 'Mladá Boleslav II',
      nazevUlice: 'tř. Václava Klementa',
      cisloDomovni: 869,
      psc: 29301,
    },
  };

  it('takes the VAT number straight from the DIČ', () => {
    expect(mapCzechSubject(subject)).toMatchObject({
      vatNumber: 'CZ00177041',
      nationalId: '00177041',
      name: 'Škoda Auto a.s.',
      legalForm: 'Akciová společnost (a.s.)',
      status: 'active',
      addressLine1: 'tř. Václava Klementa 869',
      postalCode: '293 01',
      city: 'Mladá Boleslav',
    });
  });

  it('resolves the legal-form code and keeps an unknown one', () => {
    expect(czechLegalForm('112')).toBe('Společnost s ručením omezeným (s.r.o.)');
    expect(czechLegalForm('999')).toBe('999');
    expect(czechLegalForm(null)).toBeNull();
  });

  it('rejects a subject that carries no DIČ, which means it is not VAT registered', () => {
    expect(mapCzechSubject({ ...subject, dic: undefined })).toBeNull();
  });

  it('reports a struck-off subject as inactive', () => {
    expect(mapCzechSubject({ ...subject, datumZaniku: '2020-01-01' })?.status).toBe('inactive');
  });
});

describe('Romania', () => {
  const entry = {
    date_generale: {
      cui: 14399840,
      denumire: 'DANTE INTERNATIONAL SA',
      adresa: 'MUNICIPIUL BUCUREŞTI, SECTOR 2, STR. GARA HERĂSTRĂU, NR.6',
      nrRegCom: 'J2002000372404',
      forma_juridica: 'SOCIETATE COMERCIALĂ PE ACŢIUNI',
      data_inregistrare: '2002-01-23',
    },
    adresa_sediu_social: {
      sdenumire_Strada: 'Şos. Virtuţii',
      snumar_Strada: '148',
      sdetalii_Adresa: 'spatiul E47',
      scod_Postal: '60787',
      sdenumire_Localitate: 'Sector 6 Mun. Bucureşti',
    },
    inregistrare_scop_Tva: { scpTVA: true },
    stare_inactiv: { statusInactivi: false },
  };

  it('prefers the structured seat over the free-text address', () => {
    expect(mapRomanianEntry(entry)).toMatchObject({
      vatNumber: 'RO14399840',
      nationalId: 'J2002000372404',
      name: 'DANTE INTERNATIONAL SA',
      status: 'active',
      addressLine1: 'Şos. Virtuţii nr. 148',
      addressLine2: 'spatiul E47',
      postalCode: '60787',
      city: 'Sector 6 Mun. Bucureşti',
    });
  });

  it('falls back to the free-text address when the seat is empty', () => {
    const record = mapRomanianEntry({ ...entry, adresa_sediu_social: {} });
    expect(record?.addressLine1).toBe(entry.date_generale.adresa);
  });

  it('rejects a CUI that exists but is not registered for VAT', () => {
    expect(mapRomanianEntry({ ...entry, inregistrare_scop_Tva: { scpTVA: false } })).toBeNull();
  });
});

describe('Belgium', () => {
  it('reads the extract date out of the file name', () => {
    // The KBO file name carries its date, so it wins over the HTTP header.
    expect(fullFileDate('KboOpenData_0142_2026_08_29_Full.zip')?.toISOString()).toBe('2026-08-29T00:00:00.000Z');
    expect(fullFileDate('KboOpenData_0142_2026_08_29_Update.zip')).toBeNull();
    expect(fullFileDate('not-a-kbo-file.zip')).toBeNull();
  });

  const names = new Map([['0203201340', 'Proximus']]);
  const labels = new Map([['JuridicalForm:015', 'Société anonyme']]);
  const addresses = new Map([
    [
      '0203201340',
      { addressLine1: 'Boulevard du Roi Albert II 27', addressLine2: null, postalCode: '1030', city: 'Bruxelles' },
    ],
  ]);
  const row: CsvRow = {
    EnterpriseNumber: '0203.201.340',
    Status: 'AC',
    JuridicalForm: '015',
    StartDate: '01-01-1930',
  };

  it('turns the dotted enterprise number into the VAT number', () => {
    expect(kboVatNumber('0203.201.340')).toBe('0203201340');
    // Establishment numbers start with 2 and have no VAT number.
    expect(kboVatNumber('2.100.000.001')).toBeNull();
    expect(kboVatNumber(null)).toBeNull();
  });

  it('joins the denomination and the legal-form label onto the enterprise row', () => {
    expect(mapBelgianEnterprise(row, names, labels, addresses)).toMatchObject({
      vatNumber: 'BE0203201340',
      name: 'Proximus',
      legalForm: 'Société anonyme',
      status: 'active',
      // Joined before writing, so the stored row is complete.
      addressLine1: 'Boulevard du Roi Albert II 27',
      city: 'Bruxelles',
    });
  });

  it('keeps an unknown legal-form code and reports a stopped enterprise as inactive', () => {
    expect(mapBelgianEnterprise({ ...row, JuridicalForm: '999' }, names, labels, addresses)?.legalForm).toBe('999');
    expect(mapBelgianEnterprise({ ...row, Status: 'ST' }, names, labels, addresses)?.status).toBe('inactive');
  });

  it('keeps the registered office only', () => {
    const address: CsvRow = {
      EntityNumber: '0203.201.340',
      TypeOfAddress: 'REGO',
      StreetFR: 'Boulevard du Roi Albert II',
      HouseNumber: '27',
      Box: '1',
      Zipcode: '1030',
      MunicipalityFR: 'Bruxelles',
    };

    expect(mapBelgianAddress(address)).toEqual({
      vatNumber: '0203201340',
      address: {
        addressLine1: 'Boulevard du Roi Albert II 27',
        addressLine2: 'bte 1',
        postalCode: '1030',
        city: 'Bruxelles',
      },
    });

    expect(mapBelgianAddress({ ...address, TypeOfAddress: 'BAET' })).toBeNull();
  });

  it('picks the newest full extract off the portal page', () => {
    // The full file is published daily and kept 31 days, so its name is read from the portal's list.
    // Markup copied from the real page.
    const html = `
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0461_2026_08_24_Full.zip">Full</a>
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0461_2026_08_24_Update.zip">Update</a>
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0463_2026_08_26_Full.zip">Full</a>
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0463_2026_08_26_Update.zip">Update</a>
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0462_2026_08_25_Full.zip">Full</a>
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0462_2026_08_25_Update.zip">Update</a>`;

    expect(pickFullFile(html)).toBe('KboOpenData_0463_2026_08_26_Full.zip');
  });

  it('ranks the two language conventions the dump mixes', () => {
    // denomination.csv uses a digit, code.csv a letter pair, and both must rank the same, otherwise
    // alphabetical order picks German.
    expect(languageRank('1')).toBe(languageRank('FR'));
    expect(languageRank('2')).toBe(languageRank('NL'));
    expect(languageRank('3')).toBe(languageRank('DE'));
    expect(languageRank('FR')).toBeLessThan(languageRank('DE'));
    // "0" is undetermined (~831k names): last, but still ranked.
    expect(languageRank('0')).toBeGreaterThan(languageRank('EN'));
    expect(languageRank(null)).toBe(languageRank('0'));
  });

  it('never mistakes a daily delta for the full extract', () => {
    const updatesOnly = `
      <a href="/kbo-open-data/affiliation/xml/files/KboOpenData_0463_2026_08_26_Update.zip">Update</a>`;
    expect(pickFullFile(updatesOnly)).toBeNull();
    expect(pickFullFile('<p>session expired</p>')).toBeNull();
  });
});

describe('Denmark', () => {
  const company = {
    cvrNummer: 25313763,
    sidstIndlaest: '2026-08-01',
    virksomhedMetadata: {
      nyesteNavn: { navn: 'NETCOMPANY A/S' },
      nyesteVirksomhedsform: { langBeskrivelse: 'Aktieselskab' },
      nyesteBeliggenhedsadresse: {
        vejnavn: 'Grønningen',
        husnummerFra: 17,
        postnummer: 1270,
        postdistrikt: 'København K',
        landekode: 'DK',
      },
      sammensatStatus: 'NORMAL',
    },
  };

  it('uses the CVR number as the VAT number', () => {
    expect(mapDanishCompany(company)).toMatchObject({
      vatNumber: 'DK25313763',
      name: 'NETCOMPANY A/S',
      legalForm: 'Aktieselskab',
      status: 'active',
      addressLine1: 'Grønningen 17',
      postalCode: '1270',
      city: 'København K',
    });
  });

  it('reports anything other than a normal status as inactive', () => {
    const stopped = {
      ...company,
      virksomhedMetadata: { ...company.virksomhedMetadata, sammensatStatus: 'OPHØRT' },
    };
    expect(mapDanishCompany(stopped)?.status).toBe('inactive');
    expect(mapDanishCompany({})).toBeNull();
  });
});

describe('Greenland, from the same CVR', () => {
  // KNI EJENDOMME A/S, as the distribution endpoint returns it.
  const company = {
    cvrNummer: 12608950,
    sidstIndlaest: '2026-09-09T08:12:49.844+02:00',
    virksomhedMetadata: {
      nyesteNavn: { navn: 'KNI EJENDOMME A/S' },
      nyesteVirksomhedsform: { langBeskrivelse: 'Aktieselskab' },
      nyesteBeliggenhedsadresse: {
        vejnavn: 'J M Jensenip Aqquserna',
        husnummerFra: 2,
        postnummer: 3911,
        postdistrikt: 'Sisimiut',
        landekode: 'GL',
      },
      sammensatStatus: 'NORMAL',
    },
  };

  it('spells the same CVR number under the Greenlandic prefix', () => {
    expect(mapDanishCompany(company, 'GL')).toMatchObject({
      vatNumber: 'GL12608950',
      nationalId: '12608950',
      name: 'KNI EJENDOMME A/S',
      status: 'active',
      addressLine1: 'J M Jensenip Aqquserna 2',
      postalCode: '3911',
      city: 'Sisimiut',
      addressCountry: 'GL',
    });
  });

  it('still answers DK when no prefix is named, so no existing caller moved', () => {
    expect(mapDanishCompany(company)?.vatNumber).toBe('DK12608950');
  });

  it('takes the seat as what makes a company Greenlandic', () => {
    expect(isGreenlandic(company)).toBe(true);
  });

  it('accepts a Greenlandic postal code with no country code on the address', () => {
    // 14,520 rows have `landekode: GL` and 14,532 are in the 39xx range, so a few only have the postal
    // code. That range is Greenland's only.
    const { landekode, ...address } = company.virksomhedMetadata.nyesteBeliggenhedsadresse;
    expect(landekode).toBe('GL');
    expect(
      isGreenlandic({
        ...company,
        virksomhedMetadata: { ...company.virksomhedMetadata, nyesteBeliggenhedsadresse: address },
      }),
    ).toBe(true);
  });

  it('refuses a Danish company, so a DK number asked under GL is a miss', () => {
    const danish = {
      cvrNummer: 25313763,
      virksomhedMetadata: {
        nyesteNavn: { navn: 'NETCOMPANY A/S' },
        nyesteBeliggenhedsadresse: { postnummer: 1270, postdistrikt: 'København K', landekode: 'DK' },
        sammensatStatus: 'NORMAL',
      },
    };
    expect(isGreenlandic(danish)).toBe(false);
    expect(isGreenlandic({})).toBe(false);
  });
});

describe('Croatia', () => {
  const subject = {
    mbs: 80020784,
    // Both identifiers are numbers in the register, so leading zeros are lost.
    oib: 81793146560,
    status: 1,
    postupak: 1,
    vrijeme_zadnje_izmjene: '2025-09-17T01:10:37',
  };
  const relations = {
    name: 'HRVATSKI TELEKOM d.d.',
    shortName: 'HT d.d.',
    legalForm: 'dioničko društvo',
    addressCountry: 'HR',
    seat: {
      ulica: 'Radnička cesta',
      kucni_broj: 21,
      naziv_naselja: 'Zagreb',
      postanski_broj: 10000,
    },
  };

  it('uses the OIB as the VAT number and joins the tables around the subject', () => {
    expect(mapCroatianSubject(subject, relations)).toMatchObject({
      vatNumber: 'HR81793146560',
      nationalId: '080020784',
      name: 'HRVATSKI TELEKOM d.d.',
      legalForm: 'dioničko društvo',
      status: 'active',
      addressLine1: 'Radnička cesta 21',
      postalCode: '10000',
      city: 'Zagreb',
      addressCountry: 'HR',
    });
  });

  it('restores an OIB the register truncated to a number, and refuses one that is not one', () => {
    // 00123456785 is a valid OIB stored as 123456785. 0 is a column artifact.
    expect(mapCroatianSubject({ ...subject, oib: 123456785 }, relations)?.vatNumber).toBe('HR00123456785');
    expect(mapCroatianSubject({ ...subject, oib: undefined }, relations)).toBeNull();
    expect(mapCroatianSubject({ ...subject, oib: 0 }, relations)).toBeNull();
    expect(mapCroatianSubject({ ...subject, oib: 81793146561 }, relations)).toBeNull();
  });

  it('separates a bare numeric sub-number from the house number', () => {
    const seat = { ...relations.seat, kucni_broj: 10 };
    const line = (sub?: string) =>
      mapCroatianSubject(subject, { ...relations, seat: { ...seat, kucni_podbroj: sub } })?.addressLine1;
    expect(line('1')).toBe('Radnička cesta 10/1');
    expect(line('A')).toBe('Radnička cesta 10A');
    expect(line('/2')).toBe('Radnička cesta 10/2');
    expect(line(undefined)).toBe('Radnička cesta 10');
  });

  it('reports a struck-off subject and a running procedure as inactive', () => {
    expect(mapCroatianSubject({ ...subject, status: 0 }, relations)?.status).toBe('inactive');
    // Absent says nothing.
    expect(mapCroatianSubject({ ...subject, status: undefined }, relations)?.status).toBe('active');
    expect(mapCroatianSubject({ ...subject, postupak: { postupak: {} } }, relations)?.status).toBe('active');
    // Liquidation, as `/subjekti` and `/detalji_subjekta` each represent it.
    expect(mapCroatianSubject({ ...subject, postupak: 3 }, relations)?.status).toBe('inactive');
    expect(
      mapCroatianSubject({ ...subject, postupak: { postupak: { znacenje: 'Likvidacija' } } }, relations)?.status,
    ).toBe('inactive');
    expect(mapCroatianSubject({ ...subject, likvidacijska_masa: 1 }, relations)?.status).toBe('inactive');
  });

  it('falls back to the short name when the registered one overflows the column', () => {
    const long = `Sinko Europe ${'društvo s ograničenom odgovornošću za trgovinu '.repeat(6)}`;
    expect(mapCroatianSubject(subject, { ...relations, name: long })?.name).toBe('HT d.d.');
    expect(mapCroatianSubject(subject, { ...relations, name: long, shortName: null })?.name).toHaveLength(255);
  });

  it('reads a foreign seat with its own country and free-text town', () => {
    const abroad = mapCroatianSubject(subject, {
      ...relations,
      addressCountry: 'FR',
      seat: { ulica: '81, route Cantegrouille', naselje_van_sifrarnika: '40300 Pey' },
    });
    expect(abroad).toMatchObject({
      addressLine1: '81, route Cantegrouille',
      city: '40300 Pey',
      addressCountry: 'FR',
      postalCode: null,
    });
  });
});

describe('Greece', () => {
  const fields = {
    afm: '094013380',
    onomasia: 'ΟΡΓΑΝΙΣΜΟΣ ΤΗΛΕΠΙΚΟΙΝΩΝΙΩΝ ΤΗΣ ΕΛΛΑΔΟΣ Α.Ε.',
    postalAddress: 'ΚΗΦΙΣΙΑΣ',
    postalAddressNo: '99',
    postalZipCode: '15124',
    postalAreaDescription: 'ΜΑΡΟΥΣΙ',
    legalStatusDescr: 'ΑΕ',
    deactivationFlag: '1',
  };

  it('maps the basic record, and reads the deactivation flag the right way round', () => {
    expect(mapGreekFields(fields)).toMatchObject({
      vatNumber: 'EL094013380',
      name: 'ΟΡΓΑΝΙΣΜΟΣ ΤΗΛΕΠΙΚΟΙΝΩΝΙΩΝ ΤΗΣ ΕΛΛΑΔΟΣ Α.Ε.',
      status: 'active',
      addressLine1: 'ΚΗΦΙΣΙΑΣ 99',
      postalCode: '15124',
      city: 'ΜΑΡΟΥΣΙ',
    });

    // "2" is deactivated, not active.
    expect(mapGreekFields({ ...fields, deactivationFlag: '2' })?.status).toBe('inactive');
  });

  it('treats an in-band error and a SOAP fault alike, as no answer', () => {
    expect(parseAadeResponse('<env:Body><errorCode>RG_WS_PUBLIC_WRONG_AFM</errorCode></env:Body>')).toBeNull();
    expect(parseAadeResponse('<env:Fault><faultstring>Unauthorized</faultstring></env:Fault>')).toBeNull();
    expect(parseAadeResponse('<basic_rec><afm>094013380</afm></basic_rec>')?.afm).toBe('094013380');
  });

  describe('the ΓΕΜΗ register', () => {
    // One row of `GET /companies?afm=093371507`, as the register sent it.
    const company = {
      arGemi: '501000',
      afm: '093371507',
      coNameEl: 'GETEL E.E.',
      coNamesEn: ['GKETEL E.E.'],
      street: 'ΠΛΑΤΩΝΟΣ',
      streetNumber: '28',
      zipCode: '15121',
      city: 'ΠΕΥΚΗ',
      municipality: { id: 61191, descr: 'ΛΥΚΟΒΡΥΣΗΣ - ΠΕΥΚΗΣ / ΒΟΡΕΙΟΥ ΤΟΜΕΑ ΑΘΗΝΩΝ' },
      legalType: { id: 4, descr: 'ΕΕ' },
      status: { id: 3, descr: 'Ενεργή' },
      lastStatusChange: '2015-05-21',
      isBranch: false,
    };

    it('maps a search result, keeping the ΓΕΜΗ number as the national id', () => {
      expect(mapGemiCompany(company)).toEqual({
        vatNumber: 'EL093371507',
        nationalId: '501000',
        name: 'GETEL E.E.',
        legalForm: 'ΕΕ',
        status: 'active',
        addressLine1: 'ΠΛΑΤΩΝΟΣ 28',
        addressLine2: null,
        postalCode: '15121',
        city: 'ΠΕΥΚΗ',
        addressCountry: 'EL',
        companyLastUpdatedAt: new Date('2015-05-21T00:00:00.000Z'),
      });
    });

    it('holds only status 3 to be active', () => {
      // Dormant, bankrupt, dissolved, deleted: not trading.
      for (const id of [0, 2, 4, 5, 7, 15, 17, 18, 19, 20, 21]) {
        expect(mapGemiCompany({ ...company, status: { id, descr: 'x' } })?.status).toBe('inactive');
      }
      expect(mapGemiCompany({ ...company, status: null })?.status).toBe('inactive');
    });

    it('falls back to the Latin name, and to no address at all', () => {
      expect(mapGemiCompany({ ...company, coNameEl: '   ' })?.name).toBe('GKETEL E.E.');
      expect(mapGemiCompany({ ...company, coNameEl: null, coNamesEn: null })?.name).toBe('');
      expect(mapGemiCompany({ ...company, street: null, streetNumber: null })?.addressLine1).toBeNull();
      expect(mapGemiCompany({ ...company, streetNumber: null })?.addressLine1).toBe('ΠΛΑΤΩΝΟΣ');
    });

    it('never reads the municipality as a city, since it is a municipality and its regional unit', () => {
      expect(mapGemiCompany({ ...company, city: null })?.city).toBeNull();
    });

    it('answers nothing without a nine-digit AFM', () => {
      expect(mapGemiCompany({ ...company, afm: '9337150' })).toBeNull();
      expect(mapGemiCompany({ ...company, afm: null })).toBeNull();
      // A missing GEMI number does not drop the row: the AFM is used instead.
      expect(mapGemiCompany({ ...company, arGemi: null })?.nationalId).toBe('093371507');
    });
  });
});

describe('the country registry', () => {
  it('has an adapter for every VAT prefix the parser accepts', () => {
    const codes = COUNTRIES.map((country) => country.code).sort();
    expect(codes).toEqual(Object.keys(VAT_RULES).sort());
  });

  it('registers no code twice', () => {
    const codes = COUNTRIES.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('registers Greece under EL, the prefix the parser normalizes to', () => {
    expect(getCountry('EL')?.name).toBe('Greece');
    expect(getCountry('GR')).toBeUndefined();
  });

  it('gives every country at least one source, so every prefix can be resolved', () => {
    // Every prefix the parser accepts must have at least one source, bulk or live. Countries outside
    // the EU have no VIES.
    expect(COUNTRIES.every((country) => country.liveSources.length + country.bulkSources.length > 0)).toBe(true);
  });

  it('derives the strategy from the sources rather than from a field kept in step by hand', () => {
    expect(strategyOf(getCountry('FR')!)).toBe('bulk');
    expect(strategyOf(getCountry('PL')!)).toBe('on-demand');
    expect(strategyOf(getCountry('FI')!)).toBe('both');
    expect(strategyOf(getCountry('AT')!)).toBe('vies');
    // Countries outside Europe served by a dump and no live source.
    expect(strategyOf(getCountry('AU')!)).toBe('bulk');
    expect(strategyOf(getCountry('JP')!)).toBe('bulk');
    expect(strategyOf(getCountry('PE')!)).toBe('bulk');
    expect(strategyOf(getCountry('CA')!)).toBe('bulk');
    expect(strategyOf(getCountry('RU')!)).toBe('bulk');
    expect(strategyOf(getCountry('UA')!)).toBe('bulk');
    // Countries with their own live register and no VIES: `on-demand`, like Poland.
    expect(strategyOf(getCountry('TW')!)).toBe('on-demand');
    expect(strategyOf(getCountry('IL')!)).toBe('on-demand');
    expect(strategyOf(getCountry('CR')!)).toBe('on-demand');
    expect(strategyOf(getCountry('NZ')!)).toBe('on-demand');
    // Live register only, nothing imported.
    expect(strategyOf(getCountry('NO')!)).toBe('on-demand');
    expect(strategyOf(getCountry('CH')!)).toBe('on-demand');
    expect(strategyOf(getCountry('VN')!)).toBe('on-demand');
    expect(strategyOf(getCountry('NG')!)).toBe('on-demand');
    expect(strategyOf(getCountry('EC')!)).toBe('on-demand');
    // Greenland uses Denmark's register and imports nothing.
    expect(strategyOf(getCountry('GL')!)).toBe('on-demand');
  });

  it('declares no VIES fallback for any country outside Europe', () => {
    // VIES only answers for member states, so no other country may list it.
    // Norway and Switzerland are in Europe but not in the EU.
    for (const code of [
      'AU',
      'JP',
      'SG',
      'BR',
      'TW',
      'IL',
      'CR',
      'NZ',
      'PE',
      'CA',
      'RU',
      'UA',
      'NO',
      'CH',
      'VN',
      'NG',
      'EC',
      'GL',
    ]) {
      expect(getCountry(code)!.liveSources.map((source) => source.id)).not.toContain('VIES');
    }
  });

  it('states why every country without a bulk source imports nothing', () => {
    const silent = COUNTRIES.filter((country) => country.bulkSources.length === 0 && !country.importNote);
    expect(silent.map((country) => country.code)).toEqual([]);
  });

  it('resolves an unregistered prefix to the VIES fallback rather than to nothing', () => {
    // Unreachable through the API (the parser rejects unknown prefixes first): a fallback, not a
    // feature.
    expect(resolveCountry('ZZ').liveSources.map((source) => source.id)).toEqual(['VIES']);
    expect(resolveCountry('EL').name).toBe('Greece');
  });

  it('keeps the fallback out of the published country list', () => {
    // COUNTRIES is what GET /v1/countries and `import -- all` use. `--` is not a country.
    expect(COUNTRIES.some((country) => country.code === '--')).toBe(false);
  });
});

describe('Germany, from the Peppol directory', () => {
  const card = (inner: string): string => `<businesscard>${inner}</businesscard>`;

  it('reads the VAT number off a scheme 9930 participant', () => {
    const record = mapPeppolCard(
      card(
        '<participant scheme="iso6523-actorid-upis" value="9930:de811335517"/>' +
          '<entity countrycode="DE"><name name="Bayerischer Landtag" language="de"/>' +
          '<regdate>2026-04-30</regdate></entity>',
      ),
    );

    expect(record?.vatNumber).toBe('DE811335517');
    expect(record?.name).toBe('Bayerischer Landtag');
    // Being on Peppol says nothing about VAT registration.
    expect(record?.status).toBe('unknown');
    expect(record?.companyLastUpdatedAt?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('falls back to a declared VAT id when the participant is a Leitweg-ID', () => {
    const record = mapPeppolCard(
      card(
        '<participant scheme="iso6523-actorid-upis" value="0204:991-12345-67"/>' +
          '<entity countrycode="DE"><name name="Stadt X"/>' +
          '<id scheme="VAT" value="DE122624631"/></entity>',
      ),
    );

    expect(record?.vatNumber).toBe('DE122624631');
  });

  it('keeps the free-text locality whole rather than splitting it on a guess', () => {
    const record = mapPeppolCard(
      card(
        '<participant scheme="iso6523-actorid-upis" value="9930:de122624631"/>' +
          '<entity countrycode="DE"><name name="Forschungszentrum J&#252;lich GmbH"/>' +
          '<geoinfo>J&#252;lich</geoinfo></entity>',
      ),
    );

    expect(record?.name).toBe('Forschungszentrum Jülich GmbH');
    expect(record?.addressLine1).toBe('Jülich');
    expect(record?.postalCode).toBeNull();
    expect(record?.city).toBeNull();
  });

  it('splits a geoinfo that does carry a whole postal address', () => {
    const record = mapPeppolCard(
      card(
        '<participant scheme="iso6523-actorid-upis" value="9930:de811335517"/>' +
          '<entity countrycode="DE"><name name="Bayerischer Landtag"/>' +
          '<geoinfo>Maximilianeum 1, 81627 M&#252;nchen</geoinfo></entity>',
      ),
    );

    expect(record?.addressLine1).toBe('Maximilianeum 1');
    expect(record?.postalCode).toBe('81627');
    expect(record?.city).toBe('München');
  });

  it('splits the same geoinfo when it arrives through the on-demand search', () => {
    expect(
      mapPeppolEntity('811335517', {
        name: [{ name: 'Bayerischer Landtag' }],
        geoInfo: 'Maximilianeum 1, 81627 München',
      }),
    ).toMatchObject({ addressLine1: 'Maximilianeum 1', postalCode: '81627', city: 'München' });
  });

  it('drops every card that is not a German company it can key', () => {
    const french = card(
      '<participant scheme="iso6523-actorid-upis" value="0002:000126010"/>' +
        '<entity countrycode="FR"><name name="ENERTECH"/></entity>',
    );
    const nameless = card('<participant scheme="iso6523-actorid-upis" value="9930:de811335517"/>');
    const malformed = card(
      '<participant scheme="iso6523-actorid-upis" value="9930:de81133"/>' +
        '<entity countrycode="DE"><name name="Too short"/></entity>',
    );

    expect(mapPeppolCard(french)).toBeNull();
    expect(mapPeppolCard(nameless)).toBeNull();
    expect(mapPeppolCard(malformed)).toBeNull();
  });

  it('maps a search API entity the same way as a bulk card', () => {
    const record = mapPeppolEntity('122624631', {
      name: [{ name: 'Forschungszentrum Jülich GmbH' }],
      countryCode: 'DE',
      geoInfo: 'Jülich',
      regDate: '2020-03-20',
    });

    expect(record?.name).toBe('Forschungszentrum Jülich GmbH');
    expect(record?.addressLine1).toBe('Jülich');
  });
});

describe('streamXmlElements', () => {
  const chunks = async function* (parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  };

  it('yields each element and drops the prologue', async () => {
    const source = chunks([
      '<?xml version="1.0"?><root><businesscard>a</businesscard>',
      '<businesscard>b</businesscard></root>',
    ]);

    const cards: string[] = [];
    for await (const card of streamXmlElements(source, 'businesscard')) cards.push(card);

    expect(cards).toEqual(['<businesscard>a</businesscard>', '<businesscard>b</businesscard>']);
  });

  it('reassembles an element split across chunks', async () => {
    const source = chunks(['<root><business', 'card>a</busines', 'scard></root>']);

    const cards: string[] = [];
    for await (const card of streamXmlElements(source, 'businesscard')) cards.push(card);

    expect(cards).toEqual(['<businesscard>a</businesscard>']);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    // "ü" is two bytes, and the split falls between them.
    const encoded = new TextEncoder().encode('<root><businesscard>Jülich</businesscard></root>');
    const source = (async function* () {
      yield encoded.slice(0, 22);
      yield encoded.slice(22);
    })();

    const cards: string[] = [];
    for await (const card of streamXmlElements(source, 'businesscard')) cards.push(card);

    expect(cards).toEqual(['<businesscard>Jülich</businesscard>']);
  });
});

describe('Australia, from the ABR bulk extract', () => {
  const read = async (): Promise<string[]> => {
    const elements: string[] = [];
    for await (const element of streamXmlElements(createReadStream(join(FIXTURES, 'au_abr_sample.xml')), 'ABR')) {
      elements.push(element);
    }
    return elements;
  };

  it('maps a company, keeping the ACN as the national identifier', async () => {
    const [company] = await read();

    expect(mapAbrRecord(company!)).toEqual({
      vatNumber: 'AU11000000948',
      nationalId: '000000948',
      name: 'QBE INSURANCE (INTERNATIONAL) LTD',
      legalForm: 'Australian Public Company',
      status: 'active',
      addressLine1: null,
      addressLine2: null,
      postalCode: '2000',
      city: 'NSW',
      addressCountry: 'AU',
      companyLastUpdatedAt: new Date('2018-02-16T00:00:00.000Z'),
    });
  });

  it('names a sole trader from the individual name, and a cancelled ABN is inactive', async () => {
    const [, soleTrader] = await read();

    expect(mapAbrRecord(soleTrader!)).toMatchObject({
      vatNumber: 'AU11001032430',
      // No ACN: an individual is not a company.
      nationalId: '11001032430',
      name: 'JOHN MCLEOD DUFF',
      legalForm: 'Individual/Sole Trader',
      status: 'inactive',
      city: 'WA',
    });
  });

  it('reports an active ABN with no GST registration as not registered, name and all', async () => {
    const [, , superannuation] = await read();

    expect(mapAbrRecord(superannuation!)).toMatchObject({
      vatNumber: 'AU11001032511',
      name: 'CLIVE MONK SUPERANNUATION FUND',
      // The entity exists but does not charge GST. Not inactive.
      status: 'not_registered',
    });
  });

  it('takes the main name and not the trading names that follow it', async () => {
    const [, , , withTradingNames] = await read();

    expect(mapAbrRecord(withTradingNames!)?.name).toBe('SYDNEY NIGHT PATROL & INQUIRY CO PTY LTD');
  });
});

describe('Singapore, from the ACRA open data', () => {
  const rows = async (): Promise<CsvRow[]> => {
    const read: CsvRow[] = [];
    for await (const row of streamCsv(createReadStream(join(FIXTURES, 'sg_acra_sample.csv')))) read.push(row);
    return read;
  };

  it('maps a live entity and recomposes its address from the block, level and unit', async () => {
    const [live] = await rows();

    expect(mapAcraRow(live!)).toEqual({
      vatNumber: 'SG00182000A',
      nationalId: '00182000A',
      name: 'AIK SENG HENG',
      legalForm: 'Partnership',
      status: 'active',
      addressLine1: '35 FISHERY PORT ROAD',
      addressLine2: '#RM-212 NEW FISH MERCHANT BUILDING',
      postalCode: '619742',
      city: 'Singapore',
      addressCountry: 'SG',
      companyLastUpdatedAt: new Date('1975-02-07T00:00:00.000Z'),
    });
  });

  it('reads the "na" of an empty cell as empty, rather than as an address', async () => {
    const [, struckOff] = await rows();

    expect(mapAcraRow(struckOff!)).toMatchObject({
      vatNumber: 'SG190900023E',
      name: 'AYER MOLEK RUBBER CO,LTD.,THE',
      legalForm: 'Exempt Private Company Limited by Shares',
      status: 'inactive',
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      addressCountry: null,
    });
  });
});

describe('Japan, from the invoice issuer registry', () => {
  const asOf = new Date('2026-08-31T00:00:00.000Z');
  const rows = async (): Promise<string[][]> => {
    const read: string[][] = [];
    for await (const row of streamCsvRows(createReadStream(join(FIXTURES, 'jp_invoice_sample.csv')))) read.push(row);
    return read;
  };

  it('maps a registered corporation', async () => {
    const [company] = await rows();

    expect(mapInvoiceRow(company!, asOf)).toEqual({
      vatNumber: 'JPT1010001001359',
      nationalId: '1010001001359',
      name: '株式会社エル・アイ・シー',
      legalForm: null,
      status: 'active',
      addressLine1: '埼玉県さいたま市緑区大字三室１４４３番地',
      addressLine2: null,
      postalCode: null,
      city: null,
      addressCountry: 'JP',
      companyLastUpdatedAt: new Date('2023-05-12T00:00:00.000Z'),
    });
  });

  it('reports a registration that has already lapsed as inactive', async () => {
    const [, , expired] = await rows();

    expect(mapInvoiceRow(expired!, asOf)).toMatchObject({
      vatNumber: 'JPT1010001004238',
      name: '船舶照電株式会社',
      status: 'inactive',
    });
  });

  it('skips the superseded history rows a registration number carries', async () => {
    const [, , , superseded, current] = await rows();

    // Same number, two rows: 最新履歴 = 0 for a past event, 1 for the current state.
    expect(superseded![1]).toBe(current![1]);
    expect(mapInvoiceRow(superseded!, asOf)).toBeNull();
    expect(mapInvoiceRow(current!, asOf)).toMatchObject({ name: '半田財産区' });
  });

  it('does not end a registration on a lapse date still in the future', async () => {
    const [, , , , future] = await rows();

    // 失効年月日 is often set in advance and has not happened yet on the file's date.
    expect(future![10]).toBe('2027-04-01');
    expect(mapInvoiceRow(future!, asOf)?.status).toBe('active');
  });

  it('reads the management numbers off the download page, by 人格区分', () => {
    const html = [
      `<a href="#" onclick="return doDownload('5075','2','01');">分割1</a>`,
      `<a href="#" onclick="return doDownload('5071','2','01');">分割2</a>`,
      `<a href="#" onclick="return doDownload('5074','3','01');">全件</a>`,
      // The XML and JSON entries repeat every file. Only the CSV is wanted.
      `<a href="#" onclick="return doDownload('5082','2','11');">分割1</a>`,
    ].join('\n');

    expect(parseDownloadIds(html)).toEqual(
      new Map([
        ['2', ['5075', '5071']],
        ['3', ['5074']],
      ]),
    );
  });

  it('dates the edition by the name of the file inside the archive', () => {
    expect(editionDateOf('h_all_20260831_001.csv')).toEqual(new Date('2026-08-31T00:00:00.000Z'));
    expect(editionDateOf('h_all.csv')).toBeNull();
  });
});

describe('Brazil, from the CNPJ open data', () => {
  // Real rows from the August 2026 edition: the establishment has thirty positional fields, the
  // company seven, no headers.
  const natures = new Map([['3999', 'Associação Privada']]);
  const cities = new Map([['7107', 'SAO PAULO']]);
  const company = { razaoSocial: 'ASSOCIACAO DE AMIGOS DE BAIRRO DO CONJ PAULISTANO', naturezaJuridica: '3999' };
  const row = [
    '00000001',
    '0001',
    '36',
    '1',
    '',
    '02',
    '20220818',
    '00',
    '',
    '',
    '19940603',
    '9430800',
    '9493600,9499500',
    'RUA',
    'REGINA GARBA',
    '02',
    '',
    'JD PAULISTANO',
    '02813030',
    'SP',
    '7107',
  ];

  it('joins an establishment to the company that carries its name', () => {
    expect(mapEstablishmentRow(row, company, natures, cities)).toEqual({
      // Eight digits of root, four of establishment, two of checksum, leading zeros included.
      vatNumber: 'BR00000001000136',
      nationalId: '00000001000136',
      name: 'ASSOCIACAO DE AMIGOS DE BAIRRO DO CONJ PAULISTANO',
      legalForm: 'Associação Privada',
      status: 'active',
      addressLine1: 'RUA REGINA GARBA, 02',
      addressLine2: 'JD PAULISTANO',
      postalCode: '02813030',
      city: 'SAO PAULO - SP',
      addressCountry: 'BR',
      companyLastUpdatedAt: new Date('2022-08-18T00:00:00.000Z'),
    });
  });

  it('writes nothing at all for a root the company pass did not stage', () => {
    // A row naming a CNPJ without saying whose it is must never be written.
    expect(mapEstablishmentRow(row, undefined, natures, cities)).toBeNull();
  });

  it('reports every situação cadastral other than ATIVA as inactive', () => {
    const baixada = [...row];
    baixada[5] = '08';

    expect(mapEstablishmentRow(baixada, company, natures, cities)?.status).toBe('inactive');
  });

  it('reads a reference table, and lists the editions the share still offers', async () => {
    const labels = await readLabels(
      (async function* () {
        yield ['2062', 'Sociedade Empresária Limitada'];
        yield ['', 'ignored'];
      })(),
    );
    expect(labels).toEqual(new Map([['2062', 'Sociedade Empresária Limitada']]));

    const listing = [
      '<d:response><d:href>/public.php/webdav/</d:href></d:response>',
      '<d:response><d:href>/public.php/webdav/2026-08/</d:href></d:response>',
      '<d:response><d:href>/public.php/webdav/2023-05/</d:href></d:response>',
    ].join('');

    // Oldest first.
    expect(parseEditionFolders(listing).map((edition) => edition.name)).toEqual(['2023-05', '2026-08']);
  });
});

describe('Taiwan, from the GCIS company register', () => {
  const payload = async (): Promise<Record<string, unknown>[]> =>
    JSON.parse(await readFile(join(FIXTURES, 'tw_gcis_sample.json'), 'utf8')) as Record<string, unknown>[];

  it('maps a live company, address and all', async () => {
    const [company] = await payload();

    expect(mapTaiwanCompany(company!)).toEqual({
      vatNumber: 'TW22099131',
      nationalId: '22099131',
      name: '台灣積體電路製造股份有限公司',
      legalForm: null,
      status: 'active',
      addressLine1: '新竹科學園區新竹市力行六路8號',
      addressLine2: null,
      postalCode: null,
      city: null,
      addressCountry: 'TW',
      companyLastUpdatedAt: new Date('2026-08-21T00:00:00.000Z'),
    });
  });

  it('reads the Minguo calendar, whose year is 1911 behind the Gregorian one', () => {
    expect(parseMinguoDate('0760221')).toEqual(new Date('1987-02-21T00:00:00.000Z'));
    expect(parseMinguoDate('1150821')).toEqual(new Date('2026-08-21T00:00:00.000Z'));
    expect(parseMinguoDate('')).toBeNull();
    expect(parseMinguoDate('1151321')).toBeNull();
  });

  it('calls a dissolved company inactive and a suspended one active', () => {
    const at = (status: string): string | undefined =>
      mapTaiwanCompany({ Business_Accounting_NO: '22099131', Company_Status_Desc: status })?.status;

    expect(at('核准設立')).toBe('active');
    expect(at('停業')).toBe('active');
    expect(at('解散')).toBe('inactive');
    expect(at('撤銷')).toBe('inactive');
  });
});

describe('Israel, from the Registrar of Companies', () => {
  const record = async (): Promise<Record<string, unknown>> => {
    const body = JSON.parse(await readFile(join(FIXTURES, 'il_rasham_sample.json'), 'utf8')) as {
      result: { records: Record<string, unknown>[] };
    };
    return body.result.records[0]!;
  };

  it('maps a live company out of the Hebrew-keyed payload', async () => {
    expect(mapIsraeliCompany(await record())).toEqual({
      vatNumber: 'IL520000472',
      nationalId: '520000472',
      name: 'חברת החשמל לישראל בעמ',
      legalForm: 'ישראלית חברה ציבורית',
      status: 'active',
      addressLine1: 'נתיב האור 1',
      addressLine2: null,
      postalCode: '3508510',
      city: 'חיפה',
      addressCountry: 'IL',
      companyLastUpdatedAt: null,
    });
  });

  it('puts back the double quote the portal writes as a tilde', () => {
    expect(restoreQuotes('אולימפיה אוטו בע~מ')).toBe('אולימפיה אוטו בע"מ');
  });

  it('keeps a company in liquidation active and a struck-off one inactive', () => {
    const at = (code: number): string | undefined =>
      mapIsraeliCompany({ 'מספר חברה': 520000472, 'קוד סטטוס חברה': code })?.status;

    expect(at(0)).toBe('active');
    expect(at(15)).toBe('active');
    expect(at(19)).toBe('inactive');
    expect(at(35)).toBe('inactive');
  });
});

describe('Costa Rica, from the Hacienda invoicing API', () => {
  const taxpayer = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(FIXTURES, 'cr_hacienda_sample.json'), 'utf8')) as Record<string, unknown>;

  it('maps a registered taxpayer, and carries no address because the payload has none', async () => {
    expect(mapCostaRicanTaxpayer('3101000109', await taxpayer())).toEqual({
      vatNumber: 'CR3101000109',
      nationalId: '3101000109',
      name: 'COMP BELLA VISTA',
      legalForm: 'Sociedad Anónima',
      status: 'active',
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      addressCountry: 'CR',
      companyLastUpdatedAt: null,
    });
  });

  it('reads the legal form out of the number, which is the only place it is written', () => {
    expect(costaRicanLegalForm('3101000109')).toBe('Sociedad Anónima');
    expect(costaRicanLegalForm('3102123456')).toBe('Sociedad de Responsabilidad Limitada');
    // A public body is not a commercial form, so it stays null.
    expect(costaRicanLegalForm('4000042138')).toBeNull();
  });

  it('treats a deregistered number as inactive', () => {
    const record = mapCostaRicanTaxpayer('3101000109', {
      nombre: 'COMP BELLA VISTA',
      situacion: { estado: 'Desinscrito' },
    });

    expect(record?.status).toBe('inactive');
  });
});

describe('New Zealand, from the NZBN register', () => {
  /** Captured from the v5 entity endpoint on 2026-09-17, trimmed to the fields read. */
  const xero = {
    nzbn: '9429034042984',
    entityName: 'XERO LIMITED',
    entityStatusCode: '50',
    entityStatusDescription: 'Registered',
    entityTypeDescription: 'NZ Limited Company',
    lastUpdatedDate: '2026-09-01T13:37:59.000+1200',
    addresses: {
      addressList: [
        {
          addressType: 'POSTAL',
          address1: '19-23 Taranaki St, Te Aro',
          address2: null,
          address3: 'Wellington',
          address4: null,
          postCode: '6011',
          countryCode: 'NZ',
          endDate: null,
        },
        {
          addressType: 'REGISTERED',
          address1: '19-23 Taranaki St, Te Aro',
          address2: null,
          address3: 'Wellington',
          address4: null,
          postCode: '6011',
          countryCode: 'NZ',
          endDate: null,
        },
      ],
    },
  };

  it('maps a registered company and prefers its registered office', () => {
    expect(mapNewZealandEntity(xero)).toEqual({
      vatNumber: 'NZ9429034042984',
      nationalId: '9429034042984',
      name: 'XERO LIMITED',
      legalForm: 'NZ Limited Company',
      status: 'active',
      addressLine1: '19-23 Taranaki St, Te Aro',
      addressLine2: null,
      postalCode: '6011',
      city: 'Wellington',
      addressCountry: 'NZ',
      companyLastUpdatedAt: new Date('2026-09-01T01:37:59.000Z'),
    });
  });

  /**
   * The town is `address3` in the companies register and `address4` in the charities one, with the
   * suburb in the field before. The last filled line is the city.
   */
  it('reads the town from the last line the register filled in', () => {
    const charity = {
      nzbn: '9429042740995',
      entityName: 'SOCIETY OF ST VINCENT DE PAUL IN NEW ZEALAND',
      entityStatusCode: '50',
      entityStatusDescription: 'Registered',
      entityTypeDescription: 'Charitable Trust',
      lastUpdatedDate: null,
      addresses: {
        addressList: [
          {
            addressType: 'REGISTERED',
            address1: 'Level 1 Lg Building, 35 Victoria Street',
            address2: 'Wellington Central',
            address3: null,
            address4: 'Wellington',
            postCode: null,
            countryCode: null,
            endDate: null,
          },
        ],
      },
    };

    expect(mapNewZealandEntity(charity)).toMatchObject({
      addressLine1: 'Level 1 Lg Building, 35 Victoria Street',
      addressLine2: 'Wellington Central',
      city: 'Wellington',
      postalCode: null,
      // The charities register has no country on the address. The entity is a New Zealand one.
      addressCountry: 'NZ',
      companyLastUpdatedAt: null,
    });
  });

  it('leaves a superseded address where it is', () => {
    const moved = {
      nzbn: '9429043022182',
      entityStatusCode: '50',
      entityName: 'COUNCIL OF AUCKLAND PHILIPPINE ORGANISATIONS INCORPORATED',
      addresses: {
        addressList: [
          {
            addressType: 'REGISTERED',
            address1: '7b Covil Avenue',
            address2: 'Te Atatu South',
            address3: 'Auckland',
            postCode: '0610',
            countryCode: 'NZ',
            endDate: null,
          },
          {
            addressType: 'REGISTERED',
            address1: '647 Te Atatu Road',
            address2: 'Te Atatu Peninsula',
            address3: 'Auckland',
            postCode: '0610',
            countryCode: 'NZ',
            endDate: '2020-09-01T00:00:00.000+1200',
          },
        ],
      },
    };

    expect(currentAddress(moved)?.address1).toBe('7b Covil Avenue');
    expect(mapNewZealandEntity(moved)).toMatchObject({
      addressLine2: 'Te Atatu South',
      city: 'Auckland',
    });
  });

  /**
   * 80 is removed, 70 to 72 are receivership, liquidation and statutory management. The status code
   * decides.
   */
  it('calls a removed entity, and one being wound up, inactive', () => {
    for (const code of ['80', '70', '71', '72']) {
      expect(mapNewZealandEntity({ ...xero, entityStatusCode: code })?.status).toBe('inactive');
    }
  });

  it('falls back to the description when the entity carries no status code', () => {
    const { entityStatusCode: _code, ...described } = xero;

    expect(mapNewZealandEntity(described)?.status).toBe('active');
    expect(mapNewZealandEntity({ ...described, entityStatusDescription: 'Removed' })?.status).toBe('inactive');
    expect(mapNewZealandEntity({ ...described, entityStatusDescription: undefined })?.status).toBe('unknown');
  });

  /** Sole traders may keep their name private, and then have none. */
  it('maps a nameless sole trader without inventing a name or an address', () => {
    expect(
      mapNewZealandEntity({
        nzbn: '9429046120472',
        entityName: null,
        entityStatusCode: '50',
        entityTypeDescription: 'Sole Trader',
        addresses: { addressList: [] },
      }),
    ).toMatchObject({ name: null, addressLine1: null, city: null, addressCountry: 'NZ' });
  });
});

describe('Peru, from the SUNAT padrón reducido', () => {
  const rows = async (): Promise<string[][]> => {
    const read: string[][] = [];
    const stream = createReadStream(join(FIXTURES, 'pe_padron_sample.txt'));
    for await (const row of streamCsvRows(stream, { delimiter: '|', encoding: 'latin1', quote: '\0' })) {
      read.push(row);
    }
    return read;
  };

  it('maps a live company, latin-1 accents and all', async () => {
    const [, backus] = await rows();

    expect(mapPaddedRucRow(backus!)).toEqual({
      vatNumber: 'PE20100113610',
      nationalId: '20100113610',
      name: 'UNIÓN DE CERVECERÍAS PERUANAS BACKUS Y JOHNSTON SOCIEDAD ANÓNIMA ABIERTA',
      legalForm: null,
      status: 'active',
      addressLine1: 'AV. NICOLAS AYLLON 3986',
      addressLine2: null,
      postalCode: null,
      city: 'Lima',
      addressCountry: 'PE',
      companyLastUpdatedAt: null,
    });
  });

  it('recomposes the interior and the apartment, which are separate columns', async () => {
    const [, , deregistered, withApartment] = await rows();

    expect(mapPaddedRucRow(deregistered!)).toMatchObject({
      vatNumber: 'PE20272209325',
      status: 'inactive',
      addressLine1: 'AV. JOSE PARDO 601 INT. 1603',
      addressLine2: null,
    });
    expect(mapPaddedRucRow(withApartment!)).toMatchObject({
      vatNumber: 'PE20100193117',
      addressLine1: 'JR. MONTERROSA 271',
      addressLine2: 'DPTO. 902',
    });
  });

  it('reads a row whose every address column is a hyphen as having no address', async () => {
    const [, , , , individual] = await rows();

    expect(mapPaddedRucRow(individual!)).toMatchObject({
      vatNumber: 'PE10452159428',
      name: 'GARCIA CHANCO CARLOS AUGUSTO',
      addressLine1: null,
      addressLine2: null,
      city: null,
    });
  });

  it('skips the header line rather than storing it as a company', async () => {
    const [header] = await rows();

    expect(mapPaddedRucRow(header!)).toBeNull();
  });

  it('resolves the department out of the first two digits of the UBIGEO', () => {
    expect(departmentOf('150103')).toBe('Lima');
    expect(departmentOf('070101')).toBe('Callao');
    expect(departmentOf(null)).toBeNull();
    expect(departmentOf('990101')).toBeNull();
  });

  it('keeps a temporarily suspended taxpayer registered', () => {
    expect(peruvianStatus('ACTIVO')).toBe('active');
    expect(peruvianStatus('SUSPENSION TEMPORAL')).toBe('active');
    expect(peruvianStatus('BAJA DE OFICIO')).toBe('inactive');
    expect(peruvianStatus('INHABILITADO-VENT.UN')).toBe('inactive');
    expect(peruvianStatus('NUM. INTERNO IDENTIF')).toBe('unknown');
  });
});

describe('Canada, from the federal corporations open data', () => {
  const read = async (file: string): Promise<string> => readFile(join(FIXTURES, file), 'utf8');
  const corporations = async (): Promise<string[]> => {
    const xml = await read('ca_corpcan_sample.xml');
    const found: string[] = [];
    for await (const corporation of streamXmlElements(Readable.from([Buffer.from(xml)]), 'corporation')) {
      found.push(corporation);
    }
    return found;
  };
  const acts = async (): Promise<Map<string, string>> => parseActCodes(await read('ca_corpcan_codes.xml'));

  it('maps a corporation onto its business number, which is the root of its GST/HST number', async () => {
    const [company] = await corporations();

    expect(mapCorporation(company!, await acts())).toEqual({
      vatNumber: 'CA106679285',
      nationalId: '1007',
      name: 'Abbotsford Chamber of Commerce',
      legalForm: 'Boards of Trade Act - Part II',
      status: 'active',
      addressLine1: '207 - 32900 SOUTH FRASER WAY',
      addressLine2: null,
      postalCode: 'V2S 5A1',
      city: 'ABBOTSFORD, BC',
      addressCountry: 'CA',
      companyLastUpdatedAt: new Date('2007-03-20T12:11:00.000Z'),
    });
  });

  it('reads the name and the address in force, not the ones the record has moved past', async () => {
    const [company] = await corporations();

    // The record has three names and two addresses, one of each flagged current.
    expect(company).toContain('ABBOTSFORD AND DISTRICT CHAMBER OF COMMERCE');
    expect(mapCorporation(company!, await acts())?.name).toBe('Abbotsford Chamber of Commerce');
  });

  it('reports a dissolved corporation as inactive', async () => {
    const [, dissolved] = await corporations();

    expect(mapCorporation(dissolved!, await acts())).toMatchObject({
      vatNumber: 'CA106775950',
      status: 'inactive',
    });
  });

  it('skips a corporation with no business number, which nothing could look up', async () => {
    const [, , without] = await corporations();

    expect(without).not.toContain('<businessNumber>');
    expect(mapCorporation(without!, await acts())).toBeNull();
  });

  it('publishes the corporate name and not its version in the other official language', async () => {
    const [, , , bilingual] = await corporations();

    // Both flagged current: `code="1"` is the name, `code="2"` its French version.
    expect(bilingual).toContain('La Chambre de Commerce du Grand Bathurst');
    expect(mapCorporation(bilingual!, await acts())).toMatchObject({
      vatNumber: 'CA106775653',
      name: 'Greater Bathurst Chamber of Commerce',
      // Two `<addressLine>` elements, a street and a suite, both kept.
      addressLine1: '270 AV. DOUGLAS',
      addressLine2: 'SUITE 500',
    });
  });

  it('dates the edition by the root element of a member, the only place the file says so', async () => {
    expect(parseEditionDate(await read('ca_corpcan_sample.xml'))).toEqual(new Date('2026-09-09T08:00:00.150Z'));
    expect(parseEditionDate('<cc:corpcan reportId="OPEN_DATA">')).toBeNull();
  });
});

describe('Russia, from the register of small and medium-sized businesses', () => {
  const documents = async (): Promise<string[]> => {
    const xml = await readFile(join(FIXTURES, 'ru_rsmp_sample.xml'), 'utf8');
    const found: string[] = [];
    for await (const document of streamXmlElements(Readable.from([Buffer.from(xml)]), 'Документ')) {
      found.push(document);
    }
    return found;
  };

  it('maps a company onto its ИНН, which is the number a Russian invoice carries', async () => {
    const [company] = await documents();

    expect(mapRsmpDocument(company!)).toEqual({
      vatNumber: 'RU7451269247',
      nationalId: '1087451009073',
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ ЛОГИСТИЧЕСКАЯ КОМПАНИЯ "ШИНИНВЕСТ"',
      legalForm: null,
      status: 'active',
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: 'г. Челябинск, Челябинская обл.',
      addressCountry: 'RU',
      companyLastUpdatedAt: new Date('2016-08-01T00:00:00.000Z'),
    });
  });

  it('writes the district of a village, which is what tells two of the same name apart', async () => {
    const [, village] = await documents();

    expect(mapRsmpDocument(village!)?.city).toBe('п. Саргазы, Сосновский р-н, Челябинская обл.');
  });

  it('drops an individual entrepreneur rather than storing a natural person', async () => {
    const [, , entrepreneur] = await documents();

    expect(entrepreneur).toContain('ИПВклМСП');
    expect(mapRsmpDocument(entrepreneur!)).toBeNull();
  });

  it('does not say the same thing twice when the register writes the type into the name', async () => {
    // The same region appears as `Тип="обл." Наим="Челябинская"` and as
    // `Тип="обл." Наим="Кемеровская область - Кузбасс"`, in the same file.
    const kuzbass =
      '<Документ ДатаВклМСП="01.08.2016"><ОргВклМСП НаимОрг="ООО ТЕСТ" ИННЮЛ="7451269247" ОГРН="1"/>' +
      '<СведМН КодРегион="42"><Регион Тип="обл." Наим="Кемеровская область - Кузбасс"/>' +
      '<Город Тип="г." Наим="Кемерово"/></СведМН></Документ>';

    expect(mapRsmpDocument(kuzbass)?.city).toBe('г. Кемерово, Кемеровская область - Кузбасс');
  });

  it('reads the editions the dataset page still offers, dated by their file names', () => {
    const html = [
      '<a href="https://file.nalog.ru/opendata/7707329152-rsmp/data-10092026-structure-12052026.zip">10.09.2026</a>',
      '<a href="https://file.nalog.ru/opendata/7707329152-rsmp/data-10082026-structure-12052026.zip">10.08.2026</a>',
      // The format documentation is on the same page and is not an edition.
      '<a href="https://file.nalog.ru/opendata/7707329152-rsmp/VO_RRMSPSV_2_213_04_04_06.zip">формат</a>',
    ].join('\n');

    expect(parseEditions(html)).toEqual([
      {
        url: 'https://file.nalog.ru/opendata/7707329152-rsmp/data-10092026-structure-12052026.zip',
        fileName: 'data-10092026-structure-12052026.zip',
        date: new Date('2026-09-10T00:00:00.000Z'),
      },
      {
        url: 'https://file.nalog.ru/opendata/7707329152-rsmp/data-10082026-structure-12052026.zip',
        fileName: 'data-10082026-structure-12052026.zip',
        date: new Date('2026-08-10T00:00:00.000Z'),
      },
    ]);
  });
});

describe('Ukraine, from the ЄДР', () => {
  /**
   * Read as bytes and decoded as windows-1251, like the register publishes it. Real fixture, with the
   * founder, beneficiary and signer subtrees emptied (private individuals, not read by the mapper).
   */
  const subjects = async (): Promise<string[]> => {
    const bytes = await readFile(join(FIXTURES, 'ua_edr_sample.xml'));
    const found: string[] = [];
    for await (const subject of streamXmlElements(Readable.from([bytes]), 'SUBJECT', 'windows-1251')) {
      found.push(subject);
    }
    return found;
  };

  it('maps a company onto its ЄДРПОУ, which the ІПН on an invoice reduces to', async () => {
    const [, company] = await subjects();

    expect(mapEdrSubject(company!)).toEqual({
      vatNumber: 'UA33444728',
      nationalId: '50744',
      name: 'ПРИВАТНЕ ПІДПРИЄМСТВО "ФОРЕСТПРОМТРЕЙД"',
      legalForm: 'ПРИВАТНЕ ПІДПРИЄМСТВО',
      status: 'active',
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      addressCountry: 'UA',
      companyLastUpdatedAt: new Date('2005-05-24T00:00:00.000Z'),
    });
  });

  it('publishes no address at all, because the register holds none', async () => {
    for (const subject of await subjects()) {
      const record = mapEdrSubject(subject);
      if (!record) continue;
      expect([record.addressLine1, record.addressLine2, record.postalCode, record.city]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it('reads the date of the registry action, not the date of incorporation', async () => {
    // `16.09.1996; 24.02.2005; 10671200000002144`: founded in 1996, last action in 2005.
    const [first] = await subjects();

    expect(mapEdrSubject(first!)?.companyLastUpdatedAt).toEqual(new Date('2005-02-24T00:00:00.000Z'));
  });

  it('keeps a company that is winding up or in bankruptcy, which can still invoice you', () => {
    expect(ukrainianStatus('зареєстровано')).toBe('active');
    expect(ukrainianStatus('зареєстровано, свідоцтво про державну реєстрацію недійсне')).toBe('active');
    expect(ukrainianStatus('в стані припинення')).toBe('active');
    expect(ukrainianStatus('порушено справу про банкрутство')).toBe('active');
    expect(ukrainianStatus('припинено')).toBe('inactive');
    expect(ukrainianStatus('скасовано')).toBe('inactive');
    expect(ukrainianStatus(null)).toBe('unknown');
  });

  it('drops a record whose ЄДРПОУ is not the eight digits a code has', async () => {
    const subjects_ = await subjects();
    const short = subjects_[subjects_.length - 1];

    // A few codes have seven digits. Padding one would invent a company.
    expect(short).toContain('<EDRPOU>2638920</EDRPOU>');
    expect(mapEdrSubject(short!)).toBeNull();
  });
});

describe('Norway, from Enhetsregisteret', () => {
  const unit = async (): Promise<BrregUnit> =>
    JSON.parse(await readFile(join(FIXTURES, 'no_brreg_sample.json'), 'utf-8')) as BrregUnit;

  it('maps a unit to a record, seat address and all', async () => {
    const record = mapNorwegianUnit('923609016', await unit())!;

    expect(record.vatNumber).toBe('NO923609016');
    expect(record.nationalId).toBe('923609016');
    expect(record.name).toBe('EQUINOR ASA');
    expect(record.legalForm).toBe('Allmennaksjeselskap');
    expect(record.status).toBe('active');
    expect(record.city).toBe('STAVANGER');
    expect(record.addressCountry).toBe('NO');
  });

  it('prefers the seat over the postal address, which is often a box number', async () => {
    const seated = await unit();
    expect(seated.forretningsadresse?.adresse?.[0]).toBe('Forusbeen 50');
    expect(mapNorwegianUnit('923609016', seated)!.addressLine1).toBe('Forusbeen 50');

    // Without the seat, the PO box is used.
    const { forretningsadresse: _seat, ...boxed } = seated;
    expect(mapNorwegianUnit('923609016', boxed)!.addressLine1).toBe('Postboks 8500');
  });

  it('reads any of the four ways of ceasing to exist as inactive', async () => {
    const live = await unit();
    expect(mapNorwegianUnit('923609016', { ...live, konkurs: true }).status).toBe('inactive');
    expect(mapNorwegianUnit('923609016', { ...live, underAvvikling: true }).status).toBe('inactive');
    expect(mapNorwegianUnit('923609016', { ...live, slettedato: '2025-01-01' }).status).toBe('inactive');
  });

  it('drops a unit with no name rather than storing an empty company', () => {
    expect(mapNorwegianUnit('923609016', { organisasjonsnummer: '923609016' })).toBeNull();
  });
});

describe('Switzerland, from the UID register', () => {
  const body = async (): Promise<string> => readFile(join(FIXTURES, 'ch_uid_sample.xml'), 'utf-8');

  it('maps one organisation out of the array GetByUID answers with', async () => {
    const organisation = firstOrganisation(await body())!;
    const record = mapSwissOrganisation('105805313', organisation)!;

    expect(record.vatNumber).toBe('CH105805313');
    expect(record.name).toBe('Schneider Korbwaren AG');
    expect(record.legalForm).toBe('Aktiengesellschaft');
    expect(record.status).toBe('active');
    expect(record.addressLine1).toBe('Bahnhofstrasse 5');
    expect(record.postalCode).toBe('9464');
    expect(record.city).toBe('Rüthi (Rheintal)');
    expect(record.addressCountry).toBe('CH');
  });

  it('takes the seat and not the letterbox, which the same answer also carries', async () => {
    const organisation = firstOrganisation(await body())!;
    // Two `<address>` blocks, LEGAL then POBOX. The second has no street.
    expect(organisation.match(/<addressCategory>/g)).toHaveLength(2);
    expect(legalAddress(organisation)).toContain('<addressCategory>LEGAL</addressCategory>');
  });

  it('reads the two VAT codes together, because either one can end a registration', async () => {
    const organisation = firstOrganisation(await body())!;
    expect(isVatRegistered(organisation)).toBe(true);
    // `3` is "not in the MWST register", `2` on the entry is "struck off since".
    expect(isVatRegistered(organisation.replace('<vatStatus>2', '<vatStatus>3'))).toBe(false);
    expect(isVatRegistered(organisation.replace('<vatEntryStatus>1', '<vatEntryStatus>2'))).toBe(false);
  });

  it('leaves an unlisted legal form null rather than guessing at the code', () => {
    expect(swissLegalForm('0106')).toBe('Aktiengesellschaft');
    expect(swissLegalForm('0107')).toBe('Gesellschaft mit beschränkter Haftung');
    expect(swissLegalForm('0302')).toBe('Mehrwertsteuergruppe');
    expect(swissLegalForm('0999')).toBeNull();
    expect(swissLegalForm(null)).toBeNull();
  });

  it('finds no organisation in the empty result a number nobody holds answers with', () => {
    const empty =
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<GetByUIDResponse xmlns="http://www.uid.admin.ch/xmlns/uid-wse"><GetByUIDResult/>' +
      '</GetByUIDResponse></s:Body></s:Envelope>';
    expect(firstOrganisation(empty)).toBeNull();
  });
});

describe('Vietnam, from VietQR', () => {
  const payload = async (): Promise<VietQrResponse> =>
    JSON.parse(await readFile(join(FIXTURES, 'vn_vietqr_sample.json'), 'utf-8')) as VietQrResponse;

  it('maps a taxpayer, address unsplit because the payload does not split it', async () => {
    const record = mapVietnameseBusiness('0100109106', await payload())!;

    expect(record.vatNumber).toBe('VN0100109106');
    expect(record.name).toBe('TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI');
    expect(record.status).toBe('active');
    expect(record.addressLine1).toContain('Nguyễn Hữu An');
    expect(record.city).toBeNull();
    expect(record.addressCountry).toBe('VN');
  });

  it('reads the Vietnamese status wording, and admits when it does not', async () => {
    const found = await payload();
    const withStatus = (status: string | null): VietQrResponse => ({
      ...found,
      data: { ...found.data, status },
    });
    expect(mapVietnameseBusiness('0100109106', withStatus('NNT đang hoạt động'))!.status).toBe('active');
    expect(mapVietnameseBusiness('0100109106', withStatus('NNT ngừng hoạt động'))!.status).toBe('inactive');
    expect(mapVietnameseBusiness('0100109106', withStatus('something new'))!.status).toBe('unknown');
    expect(mapVietnameseBusiness('0100109106', withStatus(null))!.status).toBe('unknown');
  });

  it('maps nothing at all from the 200 that carries the miss', () => {
    // `51` with a null body and HTTP 200: read the code, not the status.
    expect(mapVietnameseBusiness('9999999999', { code: '51', desc: 'Tax not found', data: null })).toBeNull();
  });
});

describe('Nigeria, from the NRS TIN verification', () => {
  const page = async (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf-8');

  it('reads the four fields off the form the page answers with', async () => {
    const record = mapNigerianTaxpayer('009690090001', await page('ng_firs_sample.html'))!;

    expect(record.vatNumber).toBe('NG009690090001');
    expect(record.name).toBe('MTN NIGERIA COMMUNICATIONS PLC');
    expect(record.nationalId).toBe('395010');
    // The service publishes neither, so they stay empty.
    expect(record.status).toBe('unknown');
    expect(record.addressLine1).toBeNull();
  });

  it('anchors on the field name, because the id is rendered after the value', async () => {
    const html = await page('ng_firs_sample.html');
    expect(formField(html, 'txtTIN')).toBe('00969009-0001');
    expect(formField(html, 'txtJTB')).toBe('1002183661');
    expect(formField(html, 'txtTaxOffice')).toBe('LTO TELECOMS & BROADCAST');
    expect(formField(html, 'txtNothing')).toBeNull();
  });

  it('maps nothing from the page that carries the alert instead of a taxpayer', async () => {
    const miss = await page('ng_firs_miss_sample.html');
    expect(mapNigerianTaxpayer('009690090001', miss)).toBeNull();
    expect(miss).toContain('id="Alert1"');
  });

  it('puts the hyphen back for the register, having taken it out for the history', () => {
    // `009690090001` finds nothing, `00969009-0001` finds MTN. The ten-digit JTB number is typed as is.
    expect(spellTin('009690090001')).toBe('00969009-0001');
    expect(spellTin('1002183661')).toBe('1002183661');
  });
});

describe('Ecuador, from the SRI catastro', () => {
  const load = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(FIXTURES, name), 'utf-8')) as T;
  const taxpayer = async (): Promise<SriTaxpayer> => (await load<SriTaxpayer[]>('ec_sri_sample.json'))[0]!;
  const places = async (): Promise<SriEstablishment[]> => load<SriEstablishment[]>('ec_sri_establishments_sample.json');

  it('joins the two endpoints into one record', async () => {
    const record = mapEcuadorianTaxpayer('1790016919001', await taxpayer(), await places())!;

    expect(record.vatNumber).toBe('EC1790016919001');
    expect(record.nationalId).toBe('1790016919001');
    expect(record.name).toBe('CORPORACION FAVORITA C.A.');
    expect(record.legalForm).toBe('SOCIEDAD');
    expect(record.status).toBe('active');
    expect(record.addressLine1).toBe('AV. GENERAL ENRIQUEZ S/N');
    expect(record.city).toBe('RUMIÑAHUI');
    expect(record.addressCountry).toBe('EC');
    expect(record.companyLastUpdatedAt).toBeInstanceOf(Date);
  });

  it('finds the head office rather than taking the first establishment', async () => {
    const all = await places();
    expect(all[0]!.matriz).toBe('NO');
    expect(headOffice(all)?.matriz).toBe('SI');
    expect(headOffice([])).toBeNull();
    expect(headOffice(null)).toBeNull();
  });

  it('answers without an address when the premises endpoint gave nothing', async () => {
    const record = mapEcuadorianTaxpayer('1790016919001', await taxpayer(), null)!;
    expect(record.name).toBe('CORPORACION FAVORITA C.A.');
    expect(record.addressLine1).toBeNull();
    expect(record.city).toBeNull();
  });

  it('splits the address on the spaces around the slash, not on the slash', () => {
    // `S/N` (sin número) ends many Ecuadorian addresses. Splitting on the bare slash would cut the `N`.
    expect(splitEcuadorianAddress('PICHINCHA / RUMIÑAHUI / COTOGCHOA / AV. GENERAL ENRIQUEZ S/N')).toEqual({
      line1: 'AV. GENERAL ENRIQUEZ S/N',
      line2: 'COTOGCHOA',
      city: 'RUMIÑAHUI',
    });
  });

  it('leaves an address it cannot read as a path whole rather than assigning it on a guess', () => {
    expect(splitEcuadorianAddress('GUAYAS / GUAYAQUIL')).toEqual({
      line1: 'GUAYAS, GUAYAQUIL',
      line2: null,
      city: null,
    });
    expect(splitEcuadorianAddress(null)).toEqual({ line1: null, line2: null, city: null });
  });

  it('reads the two ways of no longer being registered', async () => {
    const live = await taxpayer();
    const withState = (estadoContribuyenteRuc: string): SriTaxpayer => ({ ...live, estadoContribuyenteRuc });
    expect(mapEcuadorianTaxpayer('1790016919001', withState('SUSPENDIDO'), null)!.status).toBe('inactive');
    expect(mapEcuadorianTaxpayer('1790016919001', withState('PASIVO'), null)!.status).toBe('inactive');
    expect(mapEcuadorianTaxpayer('1790016919001', withState('ACTIVO'), null)!.status).toBe('active');
  });
});
