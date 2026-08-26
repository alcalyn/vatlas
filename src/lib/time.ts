/**
 * Everything in MySQL is UTC: the pool serializes dates as UTC and every connection uses
 * `time_zone = '+00:00'`. These helpers convert the formats registers publish.
 */

/** ISO 8601 with a zone, or a date only (UTC midnight). */
export function parseUtcDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** dd.mm.yyyy (Estonian register). */
export function parseUtcDayMonthYear(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
}

/** `YYYYMMDD` (Australian extract, Receita Federal). */
export function parseUtcCompactDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A timestamp without zone, in `timeZone` local time. SIRENE publishes `2025-12-06T10:06:34` in
 * Paris time, and `new Date()` would use the server's zone.
 */
export function parseZonedDateTime(value: string | null | undefined, timeZone: string): Date | null {
  if (!value) return null;

  const asUtc = new Date(`${value.trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(asUtc.getTime())) return null;

  // Subtracting the offset can cross a DST change, so resolve twice.
  let result = new Date(asUtc.getTime() - offsetMs(asUtc, timeZone));
  result = new Date(asUtc.getTime() - offsetMs(result, timeZone));
  return result;
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));

  return asIfUtc - instant.getTime();
}
