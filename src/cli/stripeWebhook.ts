import type Stripe from 'stripe';
import { getStripe } from '../console/stripe.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { disconnectPrisma, getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { select } from './select.js';

/**
 * Replays a subscription webhook against the local console, without paying and without a tunnel.
 *
 * Stripe only delivers webhooks to a public URL, so without `stripe listen` nothing reaches the app
 * in development: a paying customer stays on the free plan, a cancelled one stays on the paid plan.
 *
 * `--sync` fetches the real subscription from Stripe and replays it. Use it when Stripe and the
 * database disagree.
 *
 * Every event is signed with `STRIPE_WEBHOOK_SECRET` and posted to the real endpoint, so the
 * signature check, `stripe_event` deduplication, plan update and quota reset are all exercised.
 * Nothing is written to the database directly.
 */

type Mode =
  /** Grants the paid plan, like a completed Checkout. */
  | { kind: 'grant' }
  /** Cancels at period end, like the Customer Portal's cancel button. */
  | { kind: 'cancel' }
  /** Cancels now: the plan drops immediately. */
  | { kind: 'cancelNow' }
  /** Replays the real subscription as Stripe holds it. */
  | { kind: 'sync' }
  /** Any status Stripe can send. */
  | { kind: 'status'; status: string };

function usage(): string {
  return [
    'Usage: npm run stripe:webhook [options]',
    '',
    'Lists the accounts with something to replay, lets you pick one with the arrow keys, and',
    'posts the corresponding subscription webhook to the console - signed with',
    'STRIPE_WEBHOOK_SECRET, exactly as Stripe would.',
    '',
    'Modes (one at a time, default --grant):',
    '  --grant        Grant the paid plan, as a completed Checkout would.',
    '                 Lists the payments waiting: an open Checkout session, or an account',
    '                 that has a Stripe customer and is still on the free plan.',
    '  --cancel       Cancel at period end, which is what the Customer Portal button does.',
    '                 The subscription stays active and the plan stays paid until the date',
    '                 already paid for - that is correct, not a bug.',
    '  --cancel-now   End the subscription immediately; the plan drops to free at once.',
    '  --sync         Replay the real subscription as Stripe currently holds it. Use this',
    '                 when something was done in the Stripe dashboard or the Customer',
    '                 Portal and the console never heard about it.',
    '  --status <s>   Send an arbitrary status: active, trialing, past_due, canceled,',
    '                 unpaid, incomplete.',
    '',
    'Options:',
    '  --url <url>    Where to post, default CONSOLE_BASE_URL + /stripe/webhook',
    '  --all          List every account that has a Stripe customer, whatever its state,',
    '                 instead of only those the mode has something to do with.',
    '',
    'Examples:',
    '  npm run stripe:webhook                  # pay for a pending checkout',
    '  npm run stripe:webhook -- --cancel      # cancel at period end, as the portal does',
    '  npm run stripe:webhook -- --cancel-now  # drop to free immediately',
    '  npm run stripe:webhook -- --sync        # make the console catch up with Stripe',
  ].join('\n');
}

interface Candidate {
  userId: bigint;
  email: string;
  /** What the database says. */
  plan: string;
  dbStatus?: string;
  customerId: string;
  /** The stored id, possibly a `sub_sim_...` from an earlier simulation. */
  storedSubscriptionId?: string;
  /** The real subscription, if Stripe has one for this customer. */
  subscription?: Stripe.Subscription;
  /** An open Checkout session: a payment started and not finished. */
  openSession?: { id: string; created: Date };
  /** Most recent activity first. */
  sortedOn: Date;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseMode(args: string[]): Mode {
  const status = flagValue(args, '--status');
  if (status) return { kind: 'status', status };
  if (args.includes('--cancel-now')) return { kind: 'cancelNow' };
  if (args.includes('--cancel')) return { kind: 'cancel' };
  if (args.includes('--sync')) return { kind: 'sync' };
  return { kind: 'grant' };
}

/** Statuses that give the paid quota, as the webhook sees them. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Two Stripe calls for the whole listing: subscriptions and open Checkout sessions, keyed by
 * customer.
 */
async function fromStripe(stripe: Stripe): Promise<{
  subscriptions: Map<string, Stripe.Subscription>;
  sessions: Map<string, { id: string; created: Date }>;
}> {
  const subscriptions = new Map<string, Stripe.Subscription>();
  const sessions = new Map<string, { id: string; created: Date }>();

  const subs = await stripe.subscriptions.list({ limit: 100, status: 'all' });
  for (const subscription of subs.data) {
    const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const held = subscriptions.get(customer);
    // A customer can have several. The live one wins, otherwise the newest.
    const better =
      !held ||
      (LIVE_STATUSES.has(subscription.status) && !LIVE_STATUSES.has(held.status)) ||
      (LIVE_STATUSES.has(subscription.status) === LIVE_STATUSES.has(held.status) &&
        subscription.created > held.created);
    if (better) subscriptions.set(customer, subscription);
  }

  const open = await stripe.checkout.sessions.list({ limit: 50, status: 'open' });
  for (const session of open.data) {
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customer) continue;
    // Newest first: keep the first one.
    if (!sessions.has(customer)) sessions.set(customer, { id: session.id, created: new Date(session.created * 1000) });
  }

  return { subscriptions, sessions };
}

/** A real subscription's end date wins. */
function periodEndOf(subscription: Stripe.Subscription | undefined): number | undefined {
  return subscription?.items.data[0]?.current_period_end;
}

/** Whether the chosen mode has anything to do for this candidate. */
function relevant(candidate: Candidate, mode: Mode): boolean {
  const live = candidate.subscription !== undefined && LIVE_STATUSES.has(candidate.subscription.status);
  switch (mode.kind) {
    case 'grant':
      return candidate.openSession !== undefined || candidate.plan === 'free';
    case 'cancel':
    case 'cancelNow':
      // Either side is enough: a live subscription at Stripe, or a paid plan here.
      return live || candidate.plan !== 'free';
    case 'sync':
      return candidate.subscription !== undefined;
    case 'status':
      return true;
  }
}

async function collect(mode: Mode, includeAll: boolean): Promise<Candidate[]> {
  const accounts = await getPrisma().account.findMany({
    where: { stripeCustomerId: { not: null } },
    select: {
      id: true,
      email: true,
      plan: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  const stripe = getStripe();
  // Without Stripe configured, local accounts are still enough for fabricated events. `--sync` needs
  // Stripe and says so.
  const state = stripe
    ? await fromStripe(stripe).catch((error: unknown) => {
        process.stderr.write(`Could not read Stripe (${String(error)}); listing from the database only.\n\n`);
        return {
          subscriptions: new Map<string, Stripe.Subscription>(),
          sessions: new Map<string, { id: string; created: Date }>(),
        };
      })
    : {
        subscriptions: new Map<string, Stripe.Subscription>(),
        sessions: new Map<string, { id: string; created: Date }>(),
      };

  const candidates: Candidate[] = [];
  for (const account of accounts) {
    const customerId = account.stripeCustomerId;
    if (!customerId) continue;

    const subscription = state.subscriptions.get(customerId);
    const openSession = state.sessions.get(customerId);
    const candidate: Candidate = {
      userId: account.id,
      email: account.email,
      plan: account.plan,
      dbStatus: account.subscriptionStatus ?? undefined,
      customerId,
      storedSubscriptionId: account.stripeSubscriptionId ?? undefined,
      subscription,
      openSession,
      sortedOn: openSession?.created ?? account.updatedAt,
    };

    if (includeAll || relevant(candidate, mode)) candidates.push(candidate);
  }

  return candidates.sort((a, b) => b.sortedOn.getTime() - a.sortedOn.getTime());
}

function day(seconds: number | null | undefined): string | undefined {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : undefined;
}

/**
 * One line per account: what the console believes on the left, what Stripe holds on the right. A
 * missed cancellation shows as `pro` next to `ends 2026-09-27`.
 */
function describe(candidate: Candidate): string {
  const left = `${candidate.email.padEnd(26).slice(0, 26)}  ${candidate.plan.padEnd(5)}`;

  const right: string[] = [];
  const subscription = candidate.subscription;
  if (subscription) {
    const ends = day(subscription.cancel_at) ?? day(subscription.ended_at);
    right.push(`stripe ${subscription.status}${ends ? `, ends ${ends}` : ''}`);
  } else {
    right.push('no stripe subscription');
  }
  if (candidate.openSession) right.push('checkout open');
  if (candidate.storedSubscriptionId?.startsWith('sub_sim_')) right.push('simulated id stored');

  return `${left}  ${right.join(' - ')}`;
}

/**
 * The subscription as Stripe would send it, with only the fields the webhook reads (account,
 * status, period end) plus the cancellation fields.
 *
 * The real subscription id is used when there is one: a `sub_sim_...` id would later be refused by
 * the Customer Portal. One is only invented for accounts that never subscribed.
 */
function buildSubscription(candidate: Candidate, mode: Mode): { object: Record<string, unknown>; type: string } {
  const now = Math.floor(Date.now() / 1000);
  const periodEnd = periodEndOf(candidate.subscription) ?? now + 30 * 24 * 3600;
  const id =
    candidate.subscription?.id ??
    (candidate.storedSubscriptionId?.startsWith('sub_') && !candidate.storedSubscriptionId.startsWith('sub_sim_')
      ? candidate.storedSubscriptionId
      : `sub_sim_${now}${Math.random().toString(36).slice(2, 8)}`);

  let status: string;
  let cancelAt: number | null = null;
  let canceledAt: number | null = null;
  let endedAt: number | null = null;

  switch (mode.kind) {
    case 'grant':
      status = 'active';
      break;
    case 'cancel':
      // Still active and paid: Stripe expresses "cancel at period end" with cancel_at and an unchanged
      // status.
      status = 'active';
      cancelAt = periodEnd;
      canceledAt = now;
      break;
    case 'cancelNow':
      status = 'canceled';
      canceledAt = now;
      endedAt = now;
      break;
    case 'status':
      status = mode.status;
      break;
    case 'sync':
      throw new Error('sync replays the real object, it does not build one');
  }

  const type =
    status === 'canceled' || status === 'unpaid'
      ? 'customer.subscription.deleted'
      : candidate.subscription || candidate.storedSubscriptionId
        ? 'customer.subscription.updated'
        : 'customer.subscription.created';

  return {
    type,
    object: {
      id,
      object: 'subscription',
      customer: candidate.customerId,
      status,
      created: candidate.subscription?.created ?? now,
      currency: 'eur',
      cancel_at: cancelAt,
      cancel_at_period_end: cancelAt !== null,
      canceled_at: canceledAt,
      ended_at: endedAt,
      cancellation_details:
        canceledAt !== null ? { comment: null, feedback: null, reason: 'cancellation_requested' } : null,
      metadata: { userId: candidate.userId.toString(), simulated: 'true' },
      items: {
        object: 'list',
        data: [
          {
            id: `si_sim_${now}`,
            object: 'subscription_item',
            current_period_start: now,
            current_period_end: periodEnd,
            price: { id: config.stripe.pricePro ?? 'price_simulated', object: 'price' },
            quantity: 1,
          },
        ],
      },
    },
  };
}

/**
 * `--sync` sends the real object as is. Only the event id and type are ours, and the type is
 * derived like Stripe does.
 */
function buildFromReal(subscription: Stripe.Subscription): { object: Record<string, unknown>; type: string } {
  const finished = subscription.status === 'canceled' || subscription.status === 'incomplete_expired';
  return {
    type: finished ? 'customer.subscription.deleted' : 'customer.subscription.updated',
    object: subscription as unknown as Record<string, unknown>,
  };
}

function wrap(type: string, object: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    // A new event id every run, since `stripe_event` deduplicates on it.
    id: `evt_sim_${now}${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    api_version: null,
    created: now,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: { object },
  };
}

async function post(url: string, event: Record<string, unknown>): Promise<void> {
  const stripe = getStripe();
  if (!stripe || !config.stripe.webhookSecret) {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are needed to sign the event');
  }

  const payload = JSON.stringify(event);
  // The SDK's own test signer, so the header is built by the code that verifies it.
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripe.webhookSecret });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${body}`);
  process.stdout.write(`  ${response.status} ${body}\n`);
}

function header(mode: Mode): string {
  switch (mode.kind) {
    case 'grant':
      return 'Payments waiting - the selected account will be granted the paid plan';
    case 'cancel':
      return 'Cancel at period end - the plan stays paid until the date already paid for';
    case 'cancelNow':
      return 'Cancel immediately - the plan drops to free as soon as this is sent';
    case 'sync':
      return 'Replay the real Stripe subscription, so the console catches up with it';
    case 'status':
      return `Send customer.subscription.* with status "${mode.status}"`;
  }
}

function emptyAdvice(mode: Mode, includeAll: boolean): string {
  const lines = ['Nothing to replay.', ''];
  switch (mode.kind) {
    case 'grant':
      lines.push('Start a payment from the console: log in, open /billing and click upgrade.');
      lines.push('The Checkout session it opens is what this lists - you do not have to pay it.');
      break;
    case 'cancel':
    case 'cancelNow':
      lines.push('No account holds a paid plan or a live Stripe subscription.');
      break;
    case 'sync':
      lines.push('Stripe holds no subscription for any account here.');
      break;
    case 'status':
      lines.push('No account has a Stripe customer yet.');
      break;
  }
  if (!includeAll) lines.push('', '--all lists every account with a Stripe customer, whatever its state.');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return true;
  }

  const mode = parseMode(args);
  const url = flagValue(args, '--url') ?? `${config.console.baseUrl}/stripe/webhook`;

  if (mode.kind === 'sync' && !getStripe()) {
    process.stderr.write('--sync reads the real subscription from Stripe, so STRIPE_SECRET_KEY is required.\n');
    return false;
  }

  const candidates = await collect(mode, args.includes('--all'));
  if (candidates.length === 0) {
    process.stdout.write(emptyAdvice(mode, args.includes('--all')));
    return true;
  }

  const chosen = await select({ items: candidates, header: header(mode), render: describe });
  if (!chosen) {
    process.stdout.write('Cancelled, nothing sent.\n');
    return true;
  }

  if (mode.kind === 'sync' && !chosen.subscription) {
    process.stderr.write(`Stripe holds no subscription for ${chosen.email}; there is nothing to sync.\n`);
    return false;
  }

  const built =
    mode.kind === 'sync' && chosen.subscription ? buildFromReal(chosen.subscription) : buildSubscription(chosen, mode);
  const event = wrap(built.type, built.object);
  const status = String((built.object as { status?: unknown }).status ?? '?');

  process.stdout.write(`\nPosting ${built.type} (${status}) for ${chosen.email} to ${url}\n`);
  await post(url, event);

  const account = await getPrisma().account.findUnique({
    where: { id: chosen.userId },
    select: { plan: true, subscriptionStatus: true, currentPeriodEnd: true },
  });
  process.stdout.write(
    `  account is now plan=${account?.plan ?? '?'}` +
      ` status=${account?.subscriptionStatus ?? '-'}` +
      ` until=${account?.currentPeriodEnd?.toISOString() ?? '-'}\n`,
  );

  // A cancellation at period end keeps the plan paid until then. Say so.
  const cancelAt = (built.object as { cancel_at?: number | null }).cancel_at;
  if (cancelAt && account?.plan !== 'free') {
    process.stdout.write(
      `  the subscription is set to end on ${new Date(cancelAt * 1000).toISOString().slice(0, 10)};` +
        ' until then the plan stays paid, which is what Stripe intends.\n' +
        '  Use --cancel-now to drop it immediately instead.\n',
    );
  }
  process.stdout.write('\n');

  return true;
}

async function shutdown(): Promise<void> {
  await Promise.all([closePool(), disconnectPrisma()]);
}

main()
  .then(async (ok) => {
    await shutdown();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'stripe:webhook command failed');
    await shutdown();
    process.exit(1);
  });
