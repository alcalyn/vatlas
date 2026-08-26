import { closePool } from '../db/pool.js';
import { disconnectPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import {
  ASYNC_LOOKUP_DAYS,
  AUDIT_PRO_DAYS,
  AUTH_ATTEMPT_DAYS,
  AUDIT_FREE_KEEP,
  CONSOLE_VAT_LOOKUP_DAYS,
  DELIVERY_DAYS,
  DORMANT_ACCOUNT_DAYS,
  EXPIRED_SESSION_DAYS,
  LOOKUP_LOG_DAYS,
  SPENT_LOGIN_TOKEN_DAYS,
  enforceDormantAccounts,
  enforceRetention,
} from '../services/retention.js';

function usage(): string {
  return [
    'Usage: npm run retention [-- --dry-run]',
    '',
    'Deletes everything past the retention windows published in the privacy policy.',
    'Meant to run daily from cron; it is safe against a live service, and safe to run twice.',
    '',
    `  lookup_logs           ${LOOKUP_LOG_DAYS} days   detailed call logs, incl. the VAT number looked up`,
    `  audit_lookups         ${AUDIT_PRO_DAYS} days  the audit trail on the paid plan; the free plan keeps its last ${AUDIT_FREE_KEEP}`,
    `  sessions              ${EXPIRED_SESSION_DAYS} days  expired sessions (they carry an IP and a user agent)`,
    `  login_tokens          ${SPENT_LOGIN_TOKEN_DAYS} days  spent verification and reset links (they carry the requesting IP)`,
    `  console_vat_lookups   ${CONSOLE_VAT_LOOKUP_DAYS} days   the console autofill throttle`,
    `  rate_limit_auth       ${AUTH_ATTEMPT_DAYS} days   the sign-up and failed sign-in throttle`,
    `  user_delivery         ${DELIVERY_DAYS} days   callback deliveries, payload included`,
    `  user_async_lookup     ${ASYNC_LOOKUP_DAYS} days   finished asynchronous lookups and their attempts`,
    `  dormant accounts      ${Math.round(DORMANT_ACCOUNT_DAYS / 365)} years  unused accounts, warned by email a month first`,
    '',
    'Options:',
    '  --dry-run   Count what would go, delete nothing',
    '  --help      This text',
    '',
    'Any other audit window - a different age, or "keep only the N most recent" - is applied',
    "on demand by `npm run audit:prune`, which shares this pass's implementation.",
    '',
    'The aggregate counters in usage_periods are deliberately never purged: they are the',
    "console's usage history, and they carry no VAT number and nothing about a third party.",
    'Monitors are not purged either: a subscription somebody is still using is not a log.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const report = await enforceRetention({ dryRun });
  // After the trimming above: account erasure reads the rows the first pass deletes, and should not
  // date an account from logs that were about to go.
  const dormant = await enforceDormantAccounts({ dryRun });

  const verb = dryRun ? 'would delete' : 'deleted';
  process.stdout.write(
    [
      `lookup_logs          ${verb} ${report.lookupLogs}`,
      `log_source_call      ${verb} ${report.sourceCallLogs}`,
      `audit_lookups        ${verb} ${report.auditLookups}`,
      `sessions             ${verb} ${report.sessions}`,
      `login_tokens         ${verb} ${report.loginTokens}`,
      `console_vat_lookups  ${verb} ${report.consoleVatLookups}`,
      `site_vat_lookups     ${verb} ${report.siteVatLookups}`,
      `rate_limit_auth      ${verb} ${report.authAttempts}`,
      `user_delivery        ${verb} ${report.deliveries}`,
      `user_async_lookup    ${verb} ${report.asyncLookups}`,
      `dormant accounts     ${dryRun ? 'would warn' : 'warned'} ${dormant.warned}, ${verb} ${dormant.deleted}` +
        (dormant.skipped > 0 ? ` (${dormant.skipped} skipped, still subscribed)` : ''),
      '',
    ].join('\n'),
  );
}

async function shutdown(): Promise<void> {
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(async () => {
    await shutdown();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'retention command failed');
    await shutdown();
    process.exit(1);
  });
