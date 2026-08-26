/**
 * Splits a free-text European address into street, postal code and town.
 *
 * Written for VIES, where most member states put the locality on its own line and the others
 * separate parts with runs of spaces. Poland's White List, the Latvian register and Peppol's
 * `geoinfo` use the same shape, so every caller passes the country whose format applies.
 */
export interface ParsedAddress {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
}

interface PostalRule {
  /** Regex fragment for the country's postal code. */
  postal: string;
  /** Where the postal code sits on the locality line. Leading is the norm. */
  position?: 'leading' | 'trailing';
  /** Tried when the position above finds nothing. */
  fallback?: (segments: string[]) => Locality | null;
}

const POSTAL_RULES: Record<string, PostalRule> = {
  AT: { postal: '\\d{4}' },
  BE: { postal: '\\d{4}' },
  BG: { postal: '\\d{4}', fallback: findBulgarianLocality },
  CY: { postal: '\\d{4}' },
  CZ: { postal: '\\d{3} ?\\d{2}' },
  DE: { postal: '\\d{5}' },
  DK: { postal: '\\d{4}' },
  EE: { postal: '\\d{5}' },
  EL: { postal: '\\d{3} ?\\d{2}' },
  ES: { postal: '\\d{5}' },
  FI: { postal: '\\d{5}' },
  FR: { postal: '\\d{5}' },
  HR: { postal: '(?:HR-)?\\d{5}' },
  HU: { postal: '\\d{4}' },
  IE: { postal: '[A-Z]\\d{2} ?[A-Z0-9]{4}', position: 'trailing' },
  IT: { postal: '\\d{5}' },
  LT: { postal: '(?:LT-)?\\d{5}' },
  LU: { postal: '\\d{4}' },
  LV: { postal: '(?:LV-)?\\d{4}' },
  MT: { postal: '[A-Z]{3} ?\\d{4}', position: 'trailing' },
  NL: { postal: '\\d{4} ?[A-Z]{2}' },
  PL: { postal: '\\d{2}-\\d{3}' },
  PT: { postal: '\\d{4}-\\d{3}' },
  RO: { postal: '\\d{6}' },
  SE: { postal: '\\d{3} ?\\d{2}' },
  SI: { postal: '(?:SI-)?\\d{4}' },
  SK: { postal: '\\d{3} ?\\d{2}' },
  XI: { postal: '[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}', position: 'trailing' },
};

const EMPTY: ParsedAddress = { line1: null, line2: null, postalCode: null, city: null };

/** Anything unrecognised stays in `line1`, so nothing is lost. */
export function parseAddress(raw: string | null | undefined, countryCode: string): ParsedAddress {
  const segments = splitSegments(raw);
  if (segments.length === 0) return EMPTY;

  const rule = POSTAL_RULES[countryCode.toUpperCase()];
  const locality = rule ? (findLocality(segments, rule) ?? rule.fallback?.(segments) ?? null) : null;

  const street =
    locality === null
      ? segments
      : segments.flatMap((segment, index) =>
          index === locality.index ? (locality.streetPrefix ? [locality.streetPrefix] : []) : [segment],
        );

  return {
    line1: street[0] ?? null,
    line2: street.length > 1 ? street.slice(1).join(', ') : null,
    postalCode: locality?.postalCode ?? null,
    city: locality ? finishCity(locality.city, countryCode) : null,
  };
}

/** Split on line breaks, or on runs of spaces for single-line answers (Greece). */
function splitSegments(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const segments = lines.length > 1 ? lines : (lines[0] ?? '').split(/\s{2,}/);

  return segments.map((segment) => segment.replace(/\s+/g, ' ').trim()).filter((segment) => segment.length > 0);
}

interface Locality {
  index: number;
  postalCode: string;
  city: string;
  /** What came before the postal code on the same segment. */
  streetPrefix?: string;
}

/**
 * Scans from the end, since the locality comes last in every EU format. The postal code may be in
 * the middle of a segment, since some member states answer on one line.
 */
function findLocality(segments: string[], rule: PostalRule): Locality | null {
  const trailing = new RegExp(`^(.+?)[\\s,]+(${rule.postal})$`);

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';

    if (rule.position === 'trailing') {
      const match = trailing.exec(segment);
      if (match) return { index, postalCode: (match[2] ?? '').trim(), city: (match[1] ?? '').trim() };
      continue;
    }

    const found = findLeadingPostal(segment, rule.postal);
    if (found) return { index, ...found };
  }

  return null;
}

/** Finds the last postal code in a segment that has a town after it, and splits around it. */
function findLeadingPostal(
  segment: string,
  postal: string,
): { postalCode: string; city: string; streetPrefix?: string } | null {
  const scanner = new RegExp(`(?:^|[\\s,])(${postal})(?=[\\s,-]|$)`, 'g');
  let last: RegExpExecArray | null = null;

  for (let match = scanner.exec(segment); match !== null; match = scanner.exec(segment)) {
    const city = segment
      .slice(match.index + match[0].length)
      .replace(/^[\s,-]+/, '')
      .trim();
    if (city.length > 0) last = match;
  }

  if (!last) return null;

  const postalCode = (last[1] ?? '').trim();
  const city = segment
    .slice(last.index + last[0].length)
    .replace(/^[\s,-]+/, '')
    .trim();
  const streetPrefix = segment
    .slice(0, last.index)
    .replace(/[\s,-]+$/, '')
    .trim();

  return streetPrefix.length > 0 ? { postalCode, city, streetPrefix } : { postalCode, city };
}

/**
 * Bulgaria writes the locality last with labels: "... обл.СОФИЯ, гр.СОФИЯ 1000" ("province of
 * Sofia, town of Sofia 1000"). Nothing follows the postal code, so take the four digits ending the
 * segment and the town after гр. (town) or с. (village). The province is dropped.
 */
function findBulgarianLocality(segments: string[]): Locality | null {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';

    const closing = /^(.*?)[\s,]*(\d{4})$/.exec(segment);
    if (!closing) continue;

    const postalCode = closing[2] ?? '';
    const head = closing[1] ?? '';

    const town = lastMatch(head, /(?:^|[\s,])[\s,]*(?:гр|с)\.\s*([^,\d]+)$/gi);
    if (!town) return { index, postalCode, city: '', ...prefix(head) };

    const street = head.slice(0, town.index).replace(/[\s,]*обл\.[^,]*$/i, '');

    return { index, postalCode, city: (town[1] ?? '').trim(), ...prefix(street) };
  }

  return null;
}

function lastMatch(text: string, scanner: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) last = match;
  return last;
}

function prefix(street: string): { streetPrefix?: string } {
  const trimmed = street.replace(/^[\s,]+|[\s,]+$/g, '');
  return trimmed.length > 0 ? { streetPrefix: trimmed } : {};
}

/** Italy appends the two-letter province: "20122 MILANO MI". */
function finishCity(city: string, countryCode: string): string | null {
  const trimmed = countryCode.toUpperCase() === 'IT' ? city.replace(/\s+[A-Z]{2}$/, '') : city;
  return trimmed.length > 0 ? trimmed : null;
}
