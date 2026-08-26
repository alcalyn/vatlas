import { ApiError } from './errors.js';
import type { Preference } from './countries/pick.js';
import type { LookupOutcome } from './resolve.js';
import type { AllLookupReport } from './resolveAll.js';
import type { SourceHistory } from './countries/types.js';
import type { LiveAnswer } from './sources/types.js';
import type { CompanyStatement, StoredStatement } from './types.js';
import type { ParsedVat } from '../vat/parse.js';

/**
 * The wire format: what a lookup, a lookup-all and a miss look like.
 *
 * Separate from `routes.ts` so the monitor and async lookup crons can build the same envelopes
 * without pulling Express.
 */

/**
 * Faults that mean the check could not be proved: VIES answered without a consultation number,
 * or VIES is disabled. Separate in `log_lookup.fault`, the same 503 for the caller.
 */
const PROOF_FAULTS = new Set(['NO_CONSULTATION_NUMBER', 'SOURCE_NOT_CONFIGURED']);

/**
 * The error code says how far the lookup got: a source answered (`VAT_NOT_REGISTERED`), a source
 * did not answer (`SOURCE_UNAVAILABLE`), or nothing was left to ask (`COMPANY_NOT_FOUND`). The
 * consulted sources are in `log_lookup` and the audit row.
 */
export function toApiError(
  outcome: Exclude<LookupOutcome, { status: 'found' }>,
  prefer: Preference = 'completeness',
): ApiError {
  const { formatted } = outcome.vat;

  switch (outcome.status) {
    case 'not-registered':
      // Name the register that said so: it is not always VIES.
      return new ApiError(
        404,
        'VAT_NOT_REGISTERED',
        `${outcome.statement.source} reports that "${formatted}" is not registered: for ` +
          'intra-community trade where VIES answers, for the national consumption tax elsewhere. ' +
          'The company may well exist in its national register all the same.',
        {
          // The time of the call when this request made it, or the last day the source said it when the
          // answer came from storage.
          checkedAt: outcome.checkedAt ?? asDate(outcome.statement.dateEnd),
          ...proofOf(outcome.statement.proof ?? undefined),
        },
      );

    case 'unavailable':
      // A proof was asked and none could be produced. Separate from an unanswered call: the source may
      // well have answered, without a proof.
      if (prefer === 'proof' && PROOF_FAULTS.has(outcome.failure.fault)) {
        // One code, two messages: retrying only helps in the first case. VIES disabled is a deployment
        // setting.
        const why =
          outcome.failure.fault === 'SOURCE_NOT_CONFIGURED'
            ? 'this deployment has no VIES to consult, and nothing else issues a proof.'
            : 'VIES issued no consultation number for it. Retry later, or ask for ' +
              '"prefer=completeness" to take the answer without a proof.';
        return new ApiError(503, 'PROOF_UNAVAILABLE', `The check on "${formatted}" could not be proved: ${why}`);
      }

      // Two messages: a plain lookup read storage then failed to reach a live source, a proof lookup
      // never read storage.
      return new ApiError(
        503,
        'SOURCE_UNAVAILABLE',
        prefer === 'proof'
          ? `No source that can prove a check answered for "${formatted}". ` +
              'Member state services are regularly unavailable for short periods; retry later.'
          : `Nothing stored answers for "${formatted}", and no live source could be reached. ` +
              'Member state services are regularly unavailable for short periods; retry later.',
      );

    default:
      return new ApiError(404, 'COMPANY_NOT_FOUND', `No company found for VAT number "${formatted}"`);
  }
}

/** The proof that the check was made. Callers read `type`. Absent (not null) when there is none. */
export function proofOf(proof: string | undefined): Record<string, unknown> {
  if (!proof) return {};
  return { proof: { type: 'vies_consultation_number', value: proof } };
}

/**
 * Same envelope whatever the source. `meta.source` names the register and `meta.sourceDate` says
 * how fresh the statement is.
 */
export function serialize(outcome: Extract<LookupOutcome, { status: 'found' }>): Record<string, unknown> {
  const { statement, vat } = outcome;

  return {
    data: companyOf(vat, statement),
    meta: metaOf(statement),
    // Only with `?history`, and only for the answering source. Use `GET /v1/lookup-all/:vatNumber` for
    // all of them.
    ...historyOf(outcome.history),
  };
}

/**
 * The company as one source describes it.
 *
 * Shared by the lookup and every item of `/v1/lookup-all`, so both always have the same shape.
 */
function companyOf(vat: ParsedVat, statement: CompanyStatement): Record<string, unknown> {
  return {
    vatNumber: vat.formatted,
    countryCode: vat.countryCode,
    nationalNumber: vat.nationalNumber,
    nationalId: statement.nationalId,
    name: statement.name,
    legalForm: statement.legalForm,
    status: statement.status,
    address: {
      line1: statement.addressLine1,
      line2: statement.addressLine2,
      postalCode: statement.postalCode,
      city: statement.city,
      country: statement.addressCountry,
    },
  };
}

/** The `meta` of a lookup: source and dates. */
function metaOf(statement: CompanyStatement): Record<string, unknown> {
  return {
    source: statement.source,
    /** Last day the source was seen saying this (file date or call date). */
    sourceDate: asDate(statement.dateEnd),
    /** First day the source said this. */
    sourceSince: asDate(statement.dateStart),
    /** When the source itself last updated the record, if it publishes that. */
    sourceUpdatedAt: statement.companyLastUpdatedAt,
    ...proofOf(statement.proof ?? undefined),
  };
}

/** The `history` node, absent (not empty) when not asked. */
function historyOf(history: StoredStatement[] | undefined): Record<string, unknown> {
  return history ? { history: serializeHistory(history) } : {};
}

/** Every plateau of a source, oldest first. */
export function serializeHistory(history: StoredStatement[]): Record<string, unknown>[] {
  return history.map(serializeStatement);
}

/** A DATE column on the wire: a day, without time or zone. */
function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Every source's answer on the wire: `GET /v1/lookup-all/:vatNumber`.
 *
 * There is no single answer, so no top-level `data` or `meta` and no summary. Each item has the
 * lookup shape: `data` and `meta`, or `error` and `meta`.
 */
export function serializeAll(report: AllLookupReport): Record<string, unknown> {
  const { vat, sources } = report;

  return {
    data: {
      vatNumber: vat.formatted,
      countryCode: vat.countryCode,
      nationalNumber: vat.nationalNumber,
      sources: sources.map((source) => serializeSource(vat, source, report.history)),
    },
  };
}

/**
 * One source, in the lookup shape.
 *
 * `data` is the current statement. `error` replaces it with the lookup's codes when there is no
 * company: not registered, the call failed, or the source never said anything. Unreachable sources
 * are kept in the report.
 *
 * `meta` has the lookup fields plus `name`, `kind` (file or live), and `call` when this request
 * made a live call.
 *
 * `history` is every statement, oldest first, with its dates and file. Not read with
 * `?history=false`.
 */
function serializeSource(vat: ParsedVat, source: SourceHistory, history: boolean): Record<string, unknown> {
  const current = source.history.at(-1);

  return {
    ...(current && current.status !== 'not_registered'
      ? { data: companyOf(vat, current) }
      : { error: errorOf(vat, source, current) }),
    meta: {
      // `metaOf` also names the register. It goes first here because an item without a statement still
      // has a source.
      source: source.source,
      name: source.name,
      kind: source.kind,
      ...(current ? metaOf(current) : {}),
      ...(source.call ? { call: serializeCall(source.call) } : {}),
    },
    ...(history ? { history: serializeHistory(source.history) } : {}),
  };
}

/** Why this source has no company, using the lookup's error codes. */
function errorOf(vat: ParsedVat, source: SourceHistory, current: StoredStatement | undefined): Record<string, unknown> {
  if (current) {
    return {
      code: 'VAT_NOT_REGISTERED',
      message: `${source.source} reports that "${vat.formatted}" is not registered.`,
    };
  }
  if (source.call?.status === 'unavailable') {
    return {
      code: 'SOURCE_UNAVAILABLE',
      message: 'The source did not answer. Registers are regularly unavailable for short periods.',
      fault: source.call.failure.fault,
      attempts: source.call.failure.attempts,
    };
  }
  return { code: 'COMPANY_NOT_FOUND', message: `${source.source} holds nothing for "${vat.formatted}"` };
}

/** The result of the live call made now, using the lookup's error codes. */
function serializeCall(call: LiveAnswer): Record<string, unknown> {
  switch (call.status) {
    case 'found':
      return { status: 'found', checkedAt: call.checkedAt, ...proofOf(call.proof) };
    case 'not-registered':
      return { status: 'not-registered', checkedAt: call.checkedAt, ...proofOf(call.proof) };
    case 'not-found':
      return { status: 'not-found' };
    case 'unavailable':
      return {
        status: 'unavailable',
        error: {
          code: 'SOURCE_UNAVAILABLE',
          message: 'The source did not answer. Registers are regularly unavailable for short periods.',
          fault: call.failure.fault,
          attempts: call.failure.attempts,
        },
      };
  }
}

/**
 * One plateau: what the source said, from when to when, and from which file.
 *
 * A gap between one entry's `to` and the next one's `from` means no file was read in between.
 */
function serializeStatement(statement: StoredStatement): Record<string, unknown> {
  return {
    from: asDate(statement.dateStart),
    to: asDate(statement.dateEnd),
    status: statement.status,
    nationalId: statement.nationalId,
    name: statement.name,
    legalForm: statement.legalForm,
    address: {
      line1: statement.addressLine1,
      line2: statement.addressLine2,
      postalCode: statement.postalCode,
      city: statement.city,
      country: statement.addressCountry,
    },
    sourceUpdatedAt: statement.companyLastUpdatedAt,
    ...(statement.bulk ? { file: { name: statement.bulk.fileName, url: statement.bulk.url } } : {}),
    ...proofOf(statement.proof ?? undefined),
  };
}
