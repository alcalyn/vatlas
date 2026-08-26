import type { CompanyStatement } from '../types.js';

/**
 * Choosing between sources that disagree.
 *
 * Sources disagree often without being wrong: SIRENE's August file and a VIES call made today
 * describe different moments. The single-answer endpoint has to pick one, `/v1/lookup-all` does
 * not.
 *
 * A country can override `pick`. None does yet.
 */

/** One source's answer, as collected by the resolution. */
export interface Candidate {
  statement: CompanyStatement;
  /** True when it comes from storage rather than from a call made now. */
  stored: boolean;
  /** True for a bulk source, whose statements never expire. */
  bulk: boolean;
  /** When the source answered, only for a call made by this request. */
  checkedAt?: Date;
}

/**
 * How much a statement says, weighted by what callers need.
 *
 * The name weighs 10 against 9 for a complete address, so a statement with a name always wins over
 * one with only an address. Identifiers come last.
 */
export function completeness(statement: CompanyStatement): number {
  const weights: [unknown, number][] = [
    [statement.name, 10],
    [statement.addressLine1, 3],
    [statement.city, 3],
    [statement.postalCode, 2],
    [statement.legalForm, 1],
    [statement.nationalId, 1],
  ];
  return weights.reduce((total, [value, weight]) => total + (value ? weight : 0), 0);
}

/** With `prefer: 'proof'`, whether this candidate carries a proof. */
function proven(candidate: Candidate, prefer: Preference): number {
  return prefer === 'proof' && candidate.statement.proof ? 1 : 0;
}

/** A statement without identity: a `not_registered` answer. */
function isNegative(statement: CompanyStatement): boolean {
  return statement.status === 'not_registered';
}

/**
 * Whether a statement names the company, which is what stops the walk.
 *
 * VIES answers `valid` with every field null for Germany and Spain. That answer is stored and
 * served when nothing else answers, but it must not stop the next sources from being asked.
 */
export function names(statement: CompanyStatement): boolean {
  return Boolean(statement.name);
}

/** What the caller wants favoured when sources disagree (`?prefer`). */
export type Preference = 'completeness' | 'proof';

/** Newest first, by `dateEnd` (last confirmation), not `dateStart`. */
function newest(a: Candidate, b: Candidate): number {
  return b.statement.dateEnd.getTime() - a.statement.dateEnd.getTime();
}

/**
 * The candidate to answer with, or null when no source said anything.
 *
 * 1. A statement that names a company beats one that does not.
 * 2. Except when a live source says, more recently than any of those, that the number is not
 *    registered. A deregistration is news a months-old bulk file cannot carry.
 *
 * Within a group, the most complete statement wins and the most recent breaks ties. Completeness
 * comes first, otherwise every French lookup would answer from VIES, which is always more recent
 * but much less complete.
 *
 * `prefer: 'proof'` adds a first rule: a statement with a proof beats one without.
 */
export function pick(candidates: Candidate[], prefer: Preference = 'completeness'): Candidate | null {
  if (candidates.length === 0) return null;

  const named = candidates.filter((candidate) => !isNegative(candidate.statement));
  const negative = candidates.filter((candidate) => isNegative(candidate.statement));

  const freshestNegative = negative.filter((candidate) => !candidate.bulk).sort(newest)[0];
  if (freshestNegative) {
    const contradicted = named.every(
      (candidate) => candidate.statement.dateEnd.getTime() < freshestNegative.statement.dateEnd.getTime(),
    );
    if (contradicted) return freshestNegative;
  }

  const ranked = (named.length > 0 ? named : negative).sort(
    (a, b) =>
      proven(b, prefer) - proven(a, prefer) || completeness(b.statement) - completeness(a.statement) || newest(a, b),
  );
  return ranked[0] ?? null;
}
