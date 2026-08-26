import { numberOption, optionValue } from './vatList.js';
import { AUDIT_PRO_DAYS, AUDIT_FREE_KEEP } from '../services/retention.js';
import type { Plan } from '../services/usage.js';

/**
 * Arguments of `npm run audit:prune`, separate from the command so they can be tested (importing
 * the command runs `main()`).
 */

const PLANS: Plan[] = ['free', 'pro'];

export function usage(): string {
  return [
    'Usage: npm run audit:prune -- [--plan free|pro|all] [--older-than <days>] [--keep <n>] [--dry-run]',
    '',
    'Deletes rows from audit_lookups, the history of what the API answered.',
    '',
    'Options:',
    '  --plan <p>        free, pro or all (default: all)',
    '  --older-than <n>  Delete rows older than n days',
    '  --keep <n>        Keep only the n most recent rows of each account',
    '  --policy          Apply the published rules instead: ' +
      `free keeps its last ${AUDIT_FREE_KEEP}, pro keeps ${AUDIT_PRO_DAYS} days`,
    '  --dry-run         Count what would go, delete nothing',
    '  --help            This text',
    '',
    '--older-than and --keep can be combined: a row goes if it falls under either.',
    'One of --older-than, --keep or --policy is required - a purge with no criterion would',
    'empty the table, and that is never what anyone meant to type.',
    '',
    'Examples:',
    '  npm run audit:prune -- --plan free --older-than 90',
    '  npm run audit:prune -- --plan free --keep 1000',
    '  npm run audit:prune -- --older-than 30 --dry-run',
  ].join('\n');
}

/** Separate from `main` so the rules are testable without a database. */
export function parseAuditPruneArgs(
  args: string[],
): { error: string } | { plans: Plan[]; olderThanDays?: number; keepPerAccount?: number; dryRun: boolean } {
  const known = ['--plan', '--older-than', '--keep'];
  const flags = ['--policy', '--dry-run', '--help', '-h'];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (known.includes(arg)) {
      if (args[index + 1] === undefined) return { error: `${arg} expects a value` };
      index += 1;
      continue;
    }
    if (!flags.includes(arg)) return { error: `Unknown argument "${arg}"` };
  }

  const rawPlan = optionValue(args, '--plan') ?? 'all';
  if (rawPlan !== 'all' && !PLANS.includes(rawPlan as Plan)) {
    return { error: `--plan expects free, pro or all, got "${rawPlan}"` };
  }
  const plans = rawPlan === 'all' ? PLANS : [rawPlan as Plan];

  let olderThanDays: number | undefined;
  let keepPerAccount: number | undefined;
  try {
    // `numberOption` refuses anything but a positive number, so a typo cannot widen a deletion.
    if (optionValue(args, '--older-than') !== undefined) olderThanDays = numberOption(args, '--older-than', 0);
    if (optionValue(args, '--keep') !== undefined) keepPerAccount = numberOption(args, '--keep', 0);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const policy = args.includes('--policy');
  if (policy && (olderThanDays !== undefined || keepPerAccount !== undefined)) {
    return { error: '--policy applies the published windows; it cannot be combined with --older-than or --keep' };
  }
  if (!policy && olderThanDays === undefined && keepPerAccount === undefined) {
    return { error: 'Nothing to do: pass --older-than, --keep or --policy' };
  }

  return { plans, olderThanDays, keepPerAccount, dryRun: args.includes('--dry-run') };
}
