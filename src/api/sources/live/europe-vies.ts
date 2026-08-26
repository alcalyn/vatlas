import { config } from '../../../config.js';
import { flushSourceCalls, trackSourceCallLog, type SourceCallLogEntry } from '../../../db/companyRepository.js';
import { parseAddress } from '../../../lib/address.js';
import { delay } from '../../../lib/http.js';
import { logger } from '../../../lib/logger.js';
import { extractTag as extract } from '../../../lib/xml.js';
import type { CompanyRecord } from '../../types.js';
import type { ParsedVat } from '../../../vat/parse.js';
import { LiveSource, type FetchContext, type LiveAnswer, type SourceFailure } from '../types.js';

/**
 * VIES, the European Commission's front end to the member state registers. The fallback for EU
 * countries without another source.
 *
 * It is the only source that issues a consultation number, which a tax authority accepts as proof
 * that a check was made. That is what `issuesProof` marks and what `?prefer=proof` selects.
 *
 * Answers are stored in `company` under `source = 'VIES'` like any other live source. Freshness and
 * fallback to old answers are handled by the country adapter.
 */

/** The SOAP endpoint. Exported so a report can name what it measured. */
export const ENDPOINT = 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService';
/** The register name of every VIES statement. */
export const SOURCE = 'VIES';
/** MS_MAX_CONCURRENT_REQ is common, so retrying is worth it. */
const MAX_RETRIES = 3;

/**
 * How hard to retry VIES, for member states where the default is wrong.
 *
 * The default (four attempts of `VIES_TIMEOUT_MS`) suits a country that usually answers and
 * sometimes returns MS_MAX_CONCURRENT_REQ. For a country that is down, it only makes the failure
 * slower. Overrides should be based on a paired benchmark, and are documented where they are set.
 *
 * A country with its own policy creates its own `ViesSource`. The shared `vies` instance below
 * uses the defaults.
 */
export interface ViesPolicy {
  /** Retries after the first attempt. Zero means one call. Defaults to `MAX_RETRIES`. */
  maxRetries?: number;
  /** Timeout of one attempt, instead of `VIES_TIMEOUT_MS`. The lookup deadline still applies. */
  timeoutMs?: number;
}

export class ViesSource extends LiveSource {
  readonly id = SOURCE;
  readonly name = 'VIES (European Commission)';
  /** Null: VIES serves every member state. */
  readonly countryCode = null;
  override readonly issuesProof = true;
  /** One `log_source_call` row per attempt. */
  protected override readonly logsOwnCalls = true;

  constructor(private readonly policy: ViesPolicy = {}) {
    super();
  }

  /** VIES can be disabled per deployment. */
  override get available(): boolean {
    return config.vies.enabled;
  }

  protected async query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    const { countryCode, nationalNumber } = vat;
    const maxRetries = this.policy.maxRetries ?? MAX_RETRIES;

    // A member state that just reported itself unavailable is skipped until the cooldown ends. The
    // country then falls back to its last stored statement, as it would after the retries.
    const cooling = memberStateCooldown(countryCode);
    if (cooling) return { status: 'unavailable', failure: { fault: cooling.fault, attempts: 0 } };

    const result = await checkVatRaw(countryCode, nationalNumber, {
      requester: config.vies.requester,
      deadline: context.deadline,
      maxRetries,
      timeoutMs: this.policy.timeoutMs,
    });

    if (result?.parsed.kind !== 'answer') {
      return { status: 'unavailable', failure: rememberFailure(countryCode, toFailure(result, maxRetries)) };
    }
    clearMemberStateCooldown(countryCode);

    const { valid, name, address, viesConsultationNumber } = result.parsed;
    const checkedAt = new Date();
    // The consultation number is kept when VIES issued one, and its absence is not a failure: VIES
    // issues none for an unregistered number. A proof lookup without one is handled by the country.
    const proof = viesConsultationNumber ?? undefined;

    if (!valid) return { status: 'not-registered', checkedAt, proof };
    return { status: 'found', record: toCompanyRecord(vat, name, address), checkedAt, proof };
  }
}

/** The instance every country uses unless it needs different retries. */
export const vies = new ViesSource();

/** Converts a VIES answer. VIES only publishes a free-form address and no national identifier. */
export function toCompanyRecord(vat: ParsedVat, name: string | null, address: string | null): CompanyRecord {
  const parsed = parseAddress(address, vat.countryCode);

  return {
    vatNumber: vat.formatted,
    nationalId: null,
    name,
    legalForm: null,
    status: 'active',
    addressLine1: parsed.line1,
    addressLine2: parsed.line2,
    postalCode: parsed.postalCode,
    city: parsed.city,
    addressCountry: vat.countryCode,
    // VIES publishes no update date for the record, so null. The call date is the plateau's, and the
    // consultation number proves the call.
    companyLastUpdatedAt: null,
  };
}

/**
 * Member states VIES recently reported as unavailable, and until when. In memory: a restart costs
 * at most one retry ladder. Shared by every `ViesSource`, since an outage concerns the member state.
 */
const memberStateOutages = new Map<string, { until: number; fault: string }>();

/**
 * Only faults about the member state open the circuit. `INVALID_INPUT` and malformed responses
 * are about the number.
 *
 * `NO_RESPONSE` is included: a member state that times out never sends a fault, and without it
 * every lookup paid the full retry ladder. A local network outage would mark every country as
 * down, for at most VIES_MS_COOLDOWN_MS.
 */
const MEMBER_STATE_FAULTS = new Set(['MS_UNAVAILABLE', 'MS_MAX_CONCURRENT_REQ', 'NO_RESPONSE']);

function memberStateCooldown(countryCode: string): { fault: string } | null {
  const entry = memberStateOutages.get(countryCode);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    memberStateOutages.delete(countryCode);
    return null;
  }
  return { fault: entry.fault };
}

/** Opens the circuit when the fault says the member state is down. */
function rememberFailure(countryCode: string, failure: SourceFailure): SourceFailure {
  if (MEMBER_STATE_FAULTS.has(failure.fault)) {
    memberStateOutages.set(countryCode, {
      until: Date.now() + config.vies.memberStateCooldownMs,
      fault: failure.fault,
    });
    logger.warn(
      { countryCode, fault: failure.fault, cooldownMs: config.vies.memberStateCooldownMs },
      'VIES member state marked unavailable, skipping it for a while',
    );
  }
  return failure;
}

function clearMemberStateCooldown(countryCode: string): void {
  memberStateOutages.delete(countryCode);
}

/** For tests: the cooldown map outlives a single call. */
export function resetMemberStateCooldowns(): void {
  memberStateOutages.clear();
}

/**
 * VIES answers SOAP faults with HTTP 200, so the body must be inspected. A missing `valid` element
 * is never a negative answer.
 */
export type CheckVatResponse =
  | {
      kind: 'answer';
      valid: boolean;
      name: string | null;
      address: string | null;
      /** Only set on a `checkVatApprox` answer, i.e. when a requester was given. */
      viesConsultationNumber: string | null;
    }
  | { kind: 'fault'; fault: string };

/** Faults that mean "ask again later" rather than "unknown number". */
const TRANSIENT_FAULTS = new Set([
  'MS_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'MS_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'SERVER_BUSY',
  'TIMEOUT',
]);

export function parseCheckVatResponse(xml: string): CheckVatResponse {
  const fault = extract(xml, 'faultstring');
  if (fault) return { kind: 'fault', fault };

  const valid = extract(xml, 'valid');
  if (valid === null) {
    // Neither an answer nor a known fault.
    return { kind: 'fault', fault: 'MALFORMED_RESPONSE' };
  }

  return {
    kind: 'answer',
    valid: valid === 'true',
    // `checkVatApprox` returns the same fields under different names. Both are read here.
    name: cleanup(extract(xml, 'name') ?? extract(xml, 'traderName')),
    // Line breaks kept: parseAddress splits on them.
    address: cleanupAddress(extract(xml, 'address') ?? extract(xml, 'traderAddress')),
    viesConsultationNumber: cleanup(extract(xml, 'requestIdentifier')),
  };
}

export interface ViesRawResult {
  /** The SOAP body exactly as VIES sent it, faults included. */
  body: string;
  parsed: CheckVatResponse;
  attempts: number;
}

/**
 * One checkVat exchange, retried on transient faults. Returns the raw body with the parsed result
 * (printed by `npm run source -- --raw`).
 */
export interface CheckVatOptions {
  /** Requester VAT number, to get a consultation number. */
  requester?: { countryCode: string; vatNumber: string };
  /** Epoch milliseconds after which no attempt is made. */
  deadline?: number;
  /**
   * Retries after a transient fault. Zero means one call, used by the benchmark baseline so it
   * measures a plain VIES call.
   */
  maxRetries?: number;
  /** Timeout of one attempt, instead of `VIES_TIMEOUT_MS`. Never past `deadline`. */
  timeoutMs?: number;
}

export async function checkVatRaw(
  countryCode: string,
  vatNumber: string,
  options: CheckVatOptions = {},
): Promise<ViesRawResult | null> {
  const { requester, deadline, maxRetries = MAX_RETRIES, timeoutMs: attemptMs } = options;
  // `checkVatApprox` is the same call with a named requester, and the only one returning a
  // consultation number. Every lookup names one (VIES_REQUESTER_VAT). The anonymous branch is for
  // callers passing none (`--raw` on the CLI, tests). Values are interpolated raw, which is safe
  // because they come out of `parseVatNumber`.
  const operation = requester ? 'checkVatApprox' : 'checkVat';
  const requesterFields = requester
    ? `
      <urn:requesterCountryCode>${requester.countryCode}</urn:requesterCountryCode>
      <urn:requesterVatNumber>${requester.vatNumber}</urn:requesterVatNumber>`
    : '';

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:${operation}>
      <urn:countryCode>${countryCode}</urn:countryCode>
      <urn:vatNumber>${vatNumber}</urn:vatNumber>${requesterFields}
    </urn:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;

  let last: ViesRawResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const backoff = attempt > 0 ? 2 ** attempt * 400 : 0;
    // Stop before waiting: an attempt that would start past the deadline is useless.
    if (deadline !== undefined && Date.now() + backoff >= deadline) {
      logger.warn({ countryCode, attempt }, 'VIES retry budget exhausted, giving up early');
      break;
    }
    if (backoff > 0) await delay(backoff);

    // The last attempt gets whatever time is left.
    const ceiling = attemptMs ?? config.vies.timeoutMs;
    const timeoutMs = deadline === undefined ? ceiling : Math.min(ceiling, Math.max(1, deadline - Date.now()));

    // Every exchange is logged to `log_source_call`, failures included.
    const call = {
      source: SOURCE,
      vatNumber: `${countryCode}${vatNumber}`,
      operation,
      attempt: attempt + 1,
      calledAt: new Date(),
    };
    const startedAt = performance.now();
    const spent = (): number => Math.round(performance.now() - startedAt);

    let body: string;
    let httpStatus: number;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
        body: envelope,
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = response.status;
      body = await response.text();
    } catch (error) {
      // A timeout ("slow") and a refused connection ("gone") are told apart. Only
      // `AbortSignal.timeout` raises TimeoutError here.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      trackCallLog({
        ...call,
        durationMs: spent(),
        outcome: timedOut ? 'timeout' : 'network-error',
        error: true,
      });
      logger.warn({ err: error, countryCode, attempt }, 'VIES call errored');
      continue;
    }

    const parsed = parseCheckVatResponse(body);
    last = { body, parsed, attempts: attempt + 1 };
    trackCallLog({ ...call, durationMs: spent(), httpStatus, ...describeCall(parsed) });

    if (parsed.kind === 'answer') return last;

    logger.warn({ countryCode, fault: parsed.fault, attempt }, 'VIES answered with a fault');
    if (!TRANSIENT_FAULTS.has(parsed.fault)) return last;
  }

  return last;
}

/**
 * The outcome columns of `log_source_call`, from a parsed response.
 *
 * `not-registered` is not an error: VIES answered correctly.
 */
function describeCall(parsed: CheckVatResponse): {
  outcome: string;
  error: boolean;
  fault?: string | null;
  hasName?: boolean | null;
  hasAddress?: boolean | null;
  hasProof?: boolean | null;
} {
  if (parsed.kind === 'fault') {
    const malformed = parsed.fault === 'MALFORMED_RESPONSE';
    return { outcome: malformed ? 'malformed' : 'fault', error: true, fault: shorten(parsed.fault) };
  }

  return {
    outcome: parsed.valid ? 'valid' : 'not-registered',
    error: false,
    hasName: parsed.name !== null,
    hasAddress: parsed.address !== null,
    hasProof: parsed.viesConsultationNumber !== null,
  };
}

/**
 * Every attempt failed before VIES answered, so the count is the allowed number of attempts (an
 * upper bound: a deadline may have stopped earlier). Uses `maxRetries` so per-country settings are
 * respected.
 */
function toFailure(result: ViesRawResult | null, maxRetries: number): SourceFailure {
  if (!result) return { fault: 'NO_RESPONSE', attempts: maxRetries + 1 };

  return {
    fault: result.parsed.kind === 'fault' ? shorten(result.parsed.fault) : 'MALFORMED_RESPONSE',
    attempts: result.attempts,
  };
}

/** A malformed request comes back as a multi-line Java stack trace. Only its head is kept. */
function shorten(fault: string): string {
  const oneLine = fault.replace(/\s+/g, ' ').trim();
  return oneLine.length > 255 ? `${oneLine.slice(0, 254)}…` : oneLine;
}

/** Several member states answer "---" instead of an empty field. */
function cleanup(value: string | null): string | null {
  if (!value || value.trim() === '---') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

/** Same, keeping line breaks so the address can be split. */
function cleanupAddress(value: string | null): string | null {
  if (!value || value.trim() === '---') return null;
  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return normalized.length > 0 ? normalized : null;
}

function trackCallLog(entry: SourceCallLogEntry): void {
  trackSourceCallLog(entry, (error) => {
    logger.warn({ err: error, vatNumber: entry.vatNumber }, 'failed to write the VIES call log');
  });
}

/**
 * Re-exported from the repository, where pending writes are held for every live source. Kept here
 * since callers already import it from this module.
 */
export { flushSourceCalls };
