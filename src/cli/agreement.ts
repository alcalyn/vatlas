/**
 * Compares two answers about the same VAT number, for the paired benchmark.
 *
 * Separate from `benchmark.ts`, which runs `main()` on import and so cannot be tested.
 */

/**
 * Fields compared between two answers. Not `legalForm` (VIES never returns one) nor `source` (it
 * names the register, not the company).
 */
export const COMPARED = ['name', 'address', 'postalCode', 'city'] as const;
export type Compared = (typeof COMPARED)[number];

/** How two answers relate, for one field. */
export const VERDICTS = ['equal', 'different', 'onlyVatlas', 'onlyVies', 'neither'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Case, accents and punctuation are ignored: "9, RUE DES COLONNES" and "9 rue des Colonnes" agree. */
export function normalizeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const flattened = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return flattened.length > 0 ? glueInitials(flattened) : null;
}

/**
 * Joins runs of single letters left by removing dots from abbreviations, so "S.A.R.L." becomes one
 * token like "SARL". Done before comparing word sets, since "DUPONT S.A.R.L." against
 * "SARL DUPONT" is both reordered and split differently.
 *
 * It also joins a real "A B C Consulting", but on both sides, which is all that matters.
 */
function glueInitials(value: string): string {
  return value.replace(/\b(?:\p{L} ){1,}\p{L}\b/gu, (run) => run.replace(/ /g, ''));
}

/**
 * Two ways of being the same answer:
 *
 * - the same words in another order ("SARL DUPONT" against "DUPONT SARL");
 * - the same characters split differently ("S.A.R.L." against "SARL", "SP. Z O.O." against
 *   "SP Z OO").
 *
 * Both are narrow on purpose: "PARIS" and "PARIS SUD" still differ.
 */
export function sameValue(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;

  const words = (value: string): string => [...new Set(value.split(' '))].sort().join(' ');
  if (words(left) === words(right)) return true;

  return left.replace(/ /g, '') === right.replace(/ /g, '');
}

/**
 * Which of the five relations holds for one field. "Only one side has it" is separate from "they
 * disagree": the first is a coverage gap, the second a contradiction.
 */
export function verdictFor(vatlas: string | null | undefined, vies: string | null | undefined): Verdict {
  const left = normalizeValue(vatlas);
  const right = normalizeValue(vies);
  if (left === null && right === null) return 'neither';
  if (right === null) return 'onlyVatlas';
  if (left === null) return 'onlyVies';
  return sameValue(left, right) ? 'equal' : 'different';
}
