import { getVatRule, normalizeCountryCode } from './rules.js';

export interface ParsedVat {
  /** VAT prefix, normalized (GR becomes EL). */
  countryCode: string;
  /** National part, without the prefix. */
  nationalNumber: string;
  /** Canonical form, prefix included, e.g. FR95884831538. */
  formatted: string;
}

export class InvalidVatError extends Error {
  constructor(
    message: string,
    readonly reason: 'EMPTY' | 'UNKNOWN_COUNTRY' | 'BAD_FORMAT' | 'BAD_CHECKSUM',
  ) {
    super(message);
    this.name = 'InvalidVatError';
  }
}

/** Uppercases and removes everything that is not a letter or digit. */
export function normalizeVatInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Parses and validates a VAT number. Validation is syntactic only: the number is well formed, not
 * necessarily registered.
 */
export function parseVatNumber(input: string): ParsedVat {
  const normalized = normalizeVatInput(input ?? '');
  if (normalized.length < 3) {
    throw new InvalidVatError('VAT number is empty or too short', 'EMPTY');
  }

  const countryCode = normalizeCountryCode(normalized.slice(0, 2));
  const rule = getVatRule(countryCode);

  if (!rule) {
    throw new InvalidVatError(`Unknown VAT country prefix "${countryCode}"`, 'UNKNOWN_COUNTRY');
  }

  // Before the pattern and `formatted`, so both spellings of a Canadian number are one number
  // everywhere.
  const written = normalized.slice(2);
  const nationalNumber = rule.normalize?.(written) ?? written;

  if (!rule.pattern.test(nationalNumber)) {
    throw new InvalidVatError(`"${normalized}" does not match the ${rule.name} VAT format`, 'BAD_FORMAT');
  }
  if (rule.checksum && !rule.checksum(nationalNumber)) {
    throw new InvalidVatError(`"${normalized}" has an invalid ${rule.name} checksum`, 'BAD_CHECKSUM');
  }

  return { countryCode, nationalNumber, formatted: `${countryCode}${nationalNumber}` };
}
