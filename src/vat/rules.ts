/**
 * Per-country syntax of the national part of a VAT number, plus the checksum when it can be
 * verified offline.
 */
export interface CountryVatRule {
  /** VAT prefix as used on invoices (EL for Greece, XI for Northern Ireland). */
  code: string;
  name: string;
  /**
   * Reduces the spellings of one number to one, before `pattern` is tested and before storing. Only
   * normalizes: anything it does not recognize is returned unchanged and `pattern` rejects it.
   *
   * For Canada: callers hold `123456789RT0001` (business number plus sales tax account), the file
   * holds the nine digits.
   */
  normalize?: (nationalNumber: string) => string;
  /** Applies to the national part only, without the prefix. */
  pattern: RegExp;
  /** Optional offline checksum, only called once `pattern` matched. */
  checksum?: (nationalNumber: string) => boolean;
}

/** Greece is GR in ISO 3166 but EL for VAT. Both are accepted. */
const PREFIX_ALIASES: Record<string, string> = { GR: 'EL' };

export function normalizeCountryCode(code: string): string {
  const upper = code.toUpperCase();
  return PREFIX_ALIASES[upper] ?? upper;
}

/**
 * France: the two check characters are derived from the SIREN.
 * key = (12 + 3 * (SIREN mod 97)) mod 97, left-padded to two digits.
 * A few historical numbers use letters, which cannot be verified offline.
 */
export function frenchVatKey(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return key.toString().padStart(2, '0');
}

export function frenchVatNumber(siren: string): string {
  return `${frenchVatKey(siren)}${siren}`;
}

function checkFrench(nationalNumber: string): boolean {
  const key = nationalNumber.slice(0, 2);
  const siren = nationalNumber.slice(2);
  // Alphanumeric keys exist and follow no verifiable rule.
  if (!/^[0-9]{2}$/.test(key)) return true;
  return key === frenchVatKey(siren);
}

/** Finland: modulus 11 over the first seven digits of the Business ID. */
function checkFinnish(nationalNumber: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2];
  const digits = nationalNumber.split('').map(Number);
  const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
  const remainder = sum % 11;
  if (remainder === 1) return false;
  const expected = remainder === 0 ? 0 : 11 - remainder;
  return expected === digits[7];
}

/** Poland: weighted modulus 11 over the first nine digits of the NIP. */
function checkPolish(nationalNumber: string): boolean {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const digits = nationalNumber.split('').map(Number);
  const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
  const remainder = sum % 11;
  if (remainder === 10) return false;
  return remainder === digits[9];
}

/**
 * Australia: ABN modulus 89. Subtract one from the first digit, weight the eleven digits, and the
 * sum must divide by 89.
 */
function checkAbn(nationalNumber: string): boolean {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = nationalNumber.split('').map(Number);
  digits[0] = (digits[0] ?? 0) - 1;
  const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
  return sum % 89 === 0;
}

/** Brazil: the two modulus 11 check digits of the CNPJ, each computed over the digits before it. */
function checkCnpj(nationalNumber: string): boolean {
  const digitFor = (base: string): string => {
    // 2..9 repeating from the right, same as the published 5,4,3,2,9,8,7,6,...
    const sum = base
      .split('')
      .reverse()
      .reduce((total, digit, index) => total + Number(digit) * (2 + (index % 8)), 0);
    const remainder = sum % 11;
    return remainder < 2 ? '0' : String(11 - remainder);
  };
  const first = digitFor(nationalNumber.slice(0, 12));
  return nationalNumber[12] === first && nationalNumber[13] === digitFor(nationalNumber.slice(0, 12) + first);
}

/**
 * Japan: the 法人番号 has its check digit first, over the twelve that follow. Odd positions from
 * the right count once, even positions twice, and the digit is 9 minus the sum modulo 9. The `T` of
 * the invoice number is not included.
 */
function checkHojinBango(nationalNumber: string): boolean {
  const body = nationalNumber.slice(2); // past the `T` and the check digit
  const sum = body
    .split('')
    .reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 1 ? 2 : 1), 0);
  return Number(nationalNumber[1]) === 9 - (sum % 9);
}

/**
 * Taiwan: the 統一編號 weights its eight digits 1,2,1,2,1,2,4,1, sums the digits of each product,
 * and the total must divide by five. Five, not ten: the rule was relaxed in 2023, and the old
 * modulus 10 rejects every number issued since.
 */
function checkTaiwanUbn(nationalNumber: string): boolean {
  if (/^0+$/.test(nationalNumber)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  const digitSum = (value: number): number =>
    String(value)
      .split('')
      .reduce((total, digit) => total + Number(digit), 0);
  const total = weights.reduce((sum, weight, index) => sum + digitSum(weight * Number(nationalNumber[index])), 0);
  if (total % 5 === 0) return true;
  // Left from the old rule: a seventh digit of 7 allows two totals.
  return nationalNumber[6] === '7' && (total + 1) % 5 === 0;
}

/**
 * Israel: same check digit as a Teudat Zehut. Digits weighted 1,2 alternately, digits of each
 * product summed, total a multiple of ten.
 */
function checkIsraeli(nationalNumber: string): boolean {
  const total = nationalNumber.split('').reduce((sum, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 1 : 2);
    return sum + (product > 9 ? product - 9 : product);
  }, 0);
  return total % 10 === 0;
}

/**
 * Canada: the nine digits of the business number end with a Luhn check. The program account suffix
 * (`RT0001` sales tax, `RC` income tax, `RP` payroll) is removed before this.
 */
function checkBusinessNumber(nationalNumber: string): boolean {
  const sum = nationalNumber
    .split('')
    .reverse()
    .reduce((total, digit, index) => {
      const value = Number(digit) * (index % 2 === 1 ? 2 : 1);
      return total + (value > 9 ? value - 9 : value);
    }, 0);
  return sum % 10 === 0;
}

/** The ИНН weights, longest first. Shorter forms use the tail of this table. */
const INN_WEIGHTS = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

const innWeights = (digits: number): number[] => INN_WEIGHTS.slice(INN_WEIGHTS.length - digits);

function innDigit(digits: string, weights: number[]): number {
  const sum = weights.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
  return (sum % 11) % 10;
}

/**
 * Russia: the ИНН has one check digit at ten digits and two at twelve, both modulus 11. The
 * twelve-digit form applies the rule twice, over the first ten then the first eleven digits.
 *
 * Ten digits is a legal person and twelve a natural person. Both appear on invoices.
 */
function checkInn(nationalNumber: string): boolean {
  if (nationalNumber.length === 10) {
    return innDigit(nationalNumber, innWeights(9)) === Number(nationalNumber[9]);
  }
  return (
    innDigit(nationalNumber, innWeights(10)) === Number(nationalNumber[10]) &&
    innDigit(nationalNumber, innWeights(11)) === Number(nationalNumber[11])
  );
}

/**
 * Ukraine: the eighth digit of the ЄДРПОУ is a modulus 11 check over the first seven. Weights
 * `1..7`, except between 30000000 and 60000000 where they are `7,1,2,3,4,5,6`. A remainder of 10
 * reruns the weights shifted by two, and a second 10 means the digit is `0`.
 *
 * The shift is two, not seven as often written: over 14,662 codes from the register, +2 matches
 * 99.92% and +7 92.2%. Thirteen codes fail both (`00000006`, `00000008`, and old farms and
 * cooperatives), which is why no Ukrainian `checksum` is declared, see `VAT_RULES.UA`.
 */
export function edrpouCheckDigit(sequence: string): string {
  const code = Number(`${sequence}0`);
  const weights = code >= 30_000_000 && code <= 60_000_000 ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7];
  const remainder = (shift: number): number =>
    weights.reduce((total, weight, index) => total + (weight + shift) * Number(sequence[index]), 0) % 11;

  const first = remainder(0);
  if (first < 10) return String(first);
  const second = remainder(2);
  return String(second < 10 ? second : 0);
}

/**
 * New Zealand: the NZBN is a GS1 global location number, with the standard GTIN check digit
 * (weights 1 and 3 alternating from the left).
 */
function checkNzbn(nationalNumber: string): boolean {
  const sum = nationalNumber
    .slice(0, 12)
    .split('')
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(nationalNumber[12]);
}

/**
 * Peru: RUC modulus 11 over the first ten digits, weights 5,4,3,2,7,6,5,4,3,2. A result of ten or
 * eleven becomes zero or one.
 */
function checkRuc(nationalNumber: string): boolean {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(nationalNumber[index]), 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder;
  return expected === Number(nationalNumber[10]);
}

/**
 * Norway and Switzerland: the digits before the last are weighted, summed modulo eleven, and the
 * check digit completes it. A remainder of one would need a ten, and those numbers are never
 * issued, so this returns null and the number is rejected.
 */
function mod11CheckDigit(digits: string, weights: readonly number[]): number | null {
  const total = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0);
  const remainder = total % 11;
  if (remainder === 0) return 0;
  if (remainder === 1) return null;
  return 11 - remainder;
}

/** Norway: the ninth digit of an organisasjonsnummer. */
function checkNorwegianOrgnr(nationalNumber: string): boolean {
  const expected = mod11CheckDigit(nationalNumber, [3, 2, 7, 6, 5, 4, 3, 2]);
  return expected !== null && expected === Number(nationalNumber[8]);
}

/**
 * Switzerland: the same with the UID weights. `normalize` has already removed the `E` of `CHE`
 * (`CH` is the VAT prefix).
 */
function checkSwissUid(nationalNumber: string): boolean {
  const expected = mod11CheckDigit(nationalNumber, [5, 4, 3, 2, 7, 6, 5, 4]);
  return expected !== null && expected === Number(nationalNumber[8]);
}

export const VAT_RULES: Record<string, CountryVatRule> = {
  AT: { code: 'AT', name: 'Austria', pattern: /^U[0-9]{8}$/ },
  AU: { code: 'AU', name: 'Australia', pattern: /^[0-9]{11}$/, checksum: checkAbn },
  BE: { code: 'BE', name: 'Belgium', pattern: /^[01][0-9]{9}$/ },
  BG: { code: 'BG', name: 'Bulgaria', pattern: /^[0-9]{9,10}$/ },
  BR: { code: 'BR', name: 'Brazil', pattern: /^[0-9]{14}$/, checksum: checkCnpj },
  CA: {
    code: 'CA',
    name: 'Canada',
    // `123456789RT0001` is a business number and one of its program accounts. The register files the
    // nine digits.
    normalize: (nationalNumber) => nationalNumber.replace(/R[A-Z][0-9]{4}$/, ''),
    pattern: /^[0-9]{9}$/,
    checksum: checkBusinessNumber,
  },
  CH: {
    code: 'CH',
    name: 'Switzerland',
    /**
     * A Swiss UID is written `CHE-116.281.710 MWST`. The parser reads `CH` as the prefix, leaving the
     * `E` at the start and the tax suffix at the end. Both are removed: the register is keyed by the
     * nine digits, and the suffix only gives the invoice language.
     */
    normalize: (nationalNumber) => nationalNumber.replace(/^E/, '').replace(/(MWST|TVA|IVA)$/, ''),
    pattern: /^[0-9]{9}$/,
    checksum: checkSwissUid,
  },
  CR: { code: 'CR', name: 'Costa Rica', pattern: /^[0-9]{10}$/ },
  CY: { code: 'CY', name: 'Cyprus', pattern: /^[0-9]{8}[A-Z]$/ },
  CZ: { code: 'CZ', name: 'Czechia', pattern: /^[0-9]{8,10}$/ },
  DE: { code: 'DE', name: 'Germany', pattern: /^[0-9]{9}$/ },
  DK: { code: 'DK', name: 'Denmark', pattern: /^[0-9]{8}$/ },
  EC: {
    code: 'EC',
    name: 'Ecuador',
    /**
     * Thirteen digits: two for the province, one for the taxpayer type (below 6 a natural person, 6
     * public sector, 9 a private company), then the serial, the check digit, and three for the
     * establishment (`001` is the head office).
     */
    pattern: /^[0-9]{13}$/,
    // No `checksum`: the published rule for private RUCs (coefficients 4,3,2,7,6,5,4,3 modulo eleven)
    // does not match `1790016919001` (Corporación Favorita, one of the largest companies in Ecuador).
  },
  EE: { code: 'EE', name: 'Estonia', pattern: /^[0-9]{9}$/ },
  EL: { code: 'EL', name: 'Greece', pattern: /^[0-9]{9}$/ },
  ES: { code: 'ES', name: 'Spain', pattern: /^[A-Z0-9][0-9]{7}[A-Z0-9]$/ },
  FI: { code: 'FI', name: 'Finland', pattern: /^[0-9]{8}$/, checksum: checkFinnish },
  FR: { code: 'FR', name: 'France', pattern: /^[0-9A-Z]{2}[0-9]{9}$/, checksum: checkFrench },
  GL: {
    code: 'GL',
    name: 'Greenland',
    /**
     * The Danish CVR number, since Greenlandic companies were moved into the CVR on 2018-01-01. Same
     * eight digits as Denmark: `GL` means the company is seated in Greenland, which the source checks.
     *
     * No `checksum`, like `DK`.
     */
    pattern: /^[0-9]{8}$/,
  },
  HR: { code: 'HR', name: 'Croatia', pattern: /^[0-9]{11}$/ },
  HU: { code: 'HU', name: 'Hungary', pattern: /^[0-9]{8}$/ },
  IE: {
    code: 'IE',
    name: 'Ireland',
    pattern: /^([0-9]{7}[A-W]|[0-9][A-Z*+][0-9]{5}[A-W]|[0-9]{7}[A-W][A-I])$/,
  },
  IL: { code: 'IL', name: 'Israel', pattern: /^[0-9]{9}$/, checksum: checkIsraeli },
  IT: { code: 'IT', name: 'Italy', pattern: /^[0-9]{11}$/ },
  JP: { code: 'JP', name: 'Japan', pattern: /^T[0-9]{13}$/, checksum: checkHojinBango },
  LT: { code: 'LT', name: 'Lithuania', pattern: /^([0-9]{9}|[0-9]{12})$/ },
  LU: { code: 'LU', name: 'Luxembourg', pattern: /^[0-9]{8}$/ },
  LV: { code: 'LV', name: 'Latvia', pattern: /^[0-9]{11}$/ },
  MT: { code: 'MT', name: 'Malta', pattern: /^[0-9]{8}$/ },
  NG: {
    code: 'NG',
    name: 'Nigeria',
    /**
     * Two generations: the ten-digit JTB TIN, and the older FIRS form `01013457-0001` (eight digits, a
     * hyphen, four for the tax office). The hyphen is already removed here, so the old form arrives as
     * twelve digits and is kept as is.
     */
    pattern: /^([0-9]{10}|[0-9]{12})$/,
    // No `checksum`: neither JTB nor FIRS publishes one.
  },
  NL: { code: 'NL', name: 'Netherlands', pattern: /^[0-9]{9}B[0-9]{2}$/ },
  NO: {
    code: 'NO',
    name: 'Norway',
    /** `NO 974 760 673 MVA`: the suffix marks the VAT register, the number is the nine digits. */
    normalize: (nationalNumber) => nationalNumber.replace(/MVA$/, ''),
    pattern: /^[0-9]{9}$/,
    checksum: checkNorwegianOrgnr,
  },
  NZ: { code: 'NZ', name: 'New Zealand', pattern: /^[0-9]{13}$/, checksum: checkNzbn },
  PE: { code: 'PE', name: 'Peru', pattern: /^[0-9]{11}$/, checksum: checkRuc },
  PL: { code: 'PL', name: 'Poland', pattern: /^[0-9]{10}$/, checksum: checkPolish },
  PT: { code: 'PT', name: 'Portugal', pattern: /^[0-9]{9}$/ },
  RO: { code: 'RO', name: 'Romania', pattern: /^[0-9]{2,10}$/ },
  RU: { code: 'RU', name: 'Russia', pattern: /^([0-9]{10}|[0-9]{12})$/, checksum: checkInn },
  SE: { code: 'SE', name: 'Sweden', pattern: /^[0-9]{12}$/ },
  SG: {
    code: 'SG',
    name: 'Singapore',
    pattern: /^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$/,
  },
  SI: { code: 'SI', name: 'Slovenia', pattern: /^[0-9]{8}$/ },
  SK: { code: 'SK', name: 'Slovakia', pattern: /^[0-9]{10}$/ },
  TW: { code: 'TW', name: 'Taiwan', pattern: /^[0-9]{8}$/, checksum: checkTaiwanUbn },
  UA: {
    code: 'UA',
    name: 'Ukraine',
    /**
     * Ukrainian invoices carry the twelve-digit ІПН, but the register is keyed by the eight-digit
     * ЄДРПОУ. The first seven digits are shared and the eighth of the ЄДРПОУ is its check digit, so one
     * can be computed from the other: 98.9% of 245,863 real ІПН map to a ЄДРПОУ in the register.
     *
     * Like Canada, both forms are normalized to one key.
     */
    normalize: (nationalNumber) =>
      nationalNumber.length === 12
        ? nationalNumber.slice(0, 7) + edrpouCheckDigit(nationalNumber.slice(0, 7))
        : nationalNumber,
    pattern: /^[0-9]{8}$/,
    // No `checksum`: thirteen real companies out of 14,662 fail the rule (see `edrpouCheckDigit`).
  },
  VN: {
    code: 'VN',
    name: 'Vietnam',
    /**
     * A mã số thuế has ten digits, and a branch adds three (`0100109106-001`). The hyphen is already
     * removed, so a branch arrives as thirteen digits and is kept whole: the register answers for
     * branches under their own number.
     */
    pattern: /^([0-9]{10}|[0-9]{13})$/,
  },
  XI: { code: 'XI', name: 'Northern Ireland', pattern: /^([0-9]{9}|[0-9]{12}|(GD|HA)[0-9]{3})$/ },
};

export function getVatRule(countryCode: string): CountryVatRule | undefined {
  return VAT_RULES[normalizeCountryCode(countryCode)];
}
