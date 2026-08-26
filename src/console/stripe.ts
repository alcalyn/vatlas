import Stripe from 'stripe';
import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { openPeriod } from '../services/usage.js';
import type { Locale } from './i18n.js';

/**
 * Subscriptions, delegated to Stripe as much as possible.
 *
 * Checkout hosts the payment page, the Customer Portal handles cards, invoices and cancellation,
 * and Stripe Tax computes VAT, including the reverse charge (the customer's VAT number is passed as
 * a tax id).
 *
 * Only the webhook changes a plan. Everything else is a redirect.
 */

const stripeLogger = logger.child({ component: 'stripe' });

let client: Stripe | undefined;

/** Without it, the console hides the upgrade button. */
export function getStripe(): Stripe | undefined {
  if (!config.stripe.secretKey) return undefined;
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

/**
 * Which of the three settings are missing, empty when Stripe is fully configured.
 *
 * All three are required: Checkout works without the webhook secret, but only the webhook grants
 * the plan, so the customer would pay and stay on the free plan.
 *
 * Returns names rather than a boolean so the log says which variable is missing (see
 * {@link logStripeConfiguration}).
 */
export function missingStripeSettings(): string[] {
  const missing: string[] = [];
  if (!config.stripe.secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.stripe.pricePro) missing.push('STRIPE_PRICE_PRO');
  if (!config.stripe.webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  return missing;
}

export function isStripeConfigured(): boolean {
  return missingStripeSettings().length === 0;
}

/**
 * Logged once at startup, so a console running without payments says so.
 *
 * A blank value counts as absent: `optionalFromEnv` turns `STRIPE_PRICE_PRO=` into undefined.
 */
export function logStripeConfiguration(): void {
  const missing = missingStripeSettings();
  if (missing.length === 0) {
    stripeLogger.info({ mode: config.stripe.secretKey?.includes('_live_') ? 'live' : 'test' }, 'stripe configured');
    return;
  }
  stripeLogger.warn(
    { missing },
    'stripe is not configured: subscribing and the customer portal are disabled until these are set',
  );
}

/**
 * The Stripe customer is created from our billing profile, so the invoice address is the one
 * entered here.
 */
async function ensureCustomer(stripe: Stripe, userId: bigint): Promise<string> {
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, stripeCustomerId: true, billingProfile: true },
  });
  if (account.stripeCustomerId) return account.stripeCustomerId;

  const profile = account.billingProfile;
  const customer = await stripe.customers.create({
    email: account.email,
    name: profile?.companyName,
    address: profile
      ? {
          line1: profile.line1,
          line2: profile.line2 ?? undefined,
          postal_code: profile.postalCode,
          city: profile.city,
          country: profile.country,
        }
      : undefined,
    metadata: { userId: userId.toString() },
  });

  // The customer's VAT number, so Stripe Tax applies the reverse charge.
  if (profile?.vatNumber) {
    await stripe.customers
      .createTaxId(customer.id, { type: 'eu_vat', value: profile.vatNumber })
      .catch((error: unknown) => {
        // A number Stripe rejects must not block the subscription: at worst VAT is charged and the customer
        // reclaims it.
        stripeLogger.warn({ err: error, userId: userId.toString() }, 'tax id refused');
      });
  }

  await getPrisma().account.update({ where: { id: userId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Why no redirect could be produced: Stripe not configured, or no Stripe customer yet. */
export type CheckoutOutcome = { url: string } | { error: 'not-configured' };
export type PortalOutcome = { url: string } | { error: 'not-configured' | 'no-customer' };

export async function createCheckoutUrl(userId: bigint, locale: Locale): Promise<CheckoutOutcome> {
  const stripe = getStripe();
  // Same check as the button, so a forged POST cannot start a payment no webhook could complete.
  if (!stripe || !isStripeConfigured()) {
    stripeLogger.warn({ missing: missingStripeSettings() }, 'checkout refused: stripe is not configured');
    return { error: 'not-configured' };
  }

  const customer = await ensureCustomer(stripe, userId);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: config.stripe.pricePro, quantity: 1 }],
    locale,
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto', name: 'auto' },
    success_url: `${config.console.baseUrl}/billing?saved`,
    cancel_url: `${config.console.baseUrl}/billing`,
    // Sent back on every event of this checkout, so the webhook knows the account.
    metadata: { userId: userId.toString() },
    subscription_data: { metadata: { userId: userId.toString() } },
  });

  // A session without URL is treated as a provider failure, not a configuration problem.
  return session.url ? { url: session.url } : { error: 'not-configured' };
}

/**
 * The Customer Portal: cards, invoices and cancellation.
 *
 * It needs a Stripe customer, which only exists after a checkout. Otherwise `no-customer`.
 */
export async function createPortalUrl(userId: bigint, locale: Locale): Promise<PortalOutcome> {
  const stripe = getStripe();
  if (!stripe) {
    stripeLogger.warn({ missing: missingStripeSettings() }, 'portal refused: stripe is not configured');
    return { error: 'not-configured' };
  }

  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!account.stripeCustomerId) return { error: 'no-customer' };

  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    locale,
    return_url: `${config.console.baseUrl}/billing`,
  });
  return { url: session.url };
}

/**
 * The webhook, the only place that grants a paid plan:
 *
 * - The signature is verified against `STRIPE_WEBHOOK_SECRET`, otherwise anyone could post a
 *   subscription.
 * - Events are processed once: `stripe_event` has the event id as primary key, so a replay fails on
 *   insert and is dropped.
 */
export async function handleWebhook(payload: Buffer, signature: string | undefined): Promise<void> {
  const stripe = getStripe();
  if (!stripe || !config.stripe.webhookSecret) throw new Error('Stripe webhooks are not configured');
  if (!signature) throw new Error('Missing Stripe signature');

  const event = stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);

  try {
    await getPrisma().stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    stripeLogger.info({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
    return;
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object);
      break;
    default:
      stripeLogger.debug({ type: event.type }, 'webhook ignored');
  }
}

/**
 * Statuses that give the paid quota. `past_due` is included: Stripe is still retrying the card.
 * The plan drops when the subscription becomes `canceled` or `unpaid`.
 */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * When the subscription is scheduled to stop, or null when it renews.
 *
 * Cancelling from the Customer Portal keeps the status `active` until the end of the paid period.
 * Only this field says it is ending.
 *
 * Depending on the API version, Stripe sends `cancel_at` with a date or the older
 * `cancel_at_period_end` flag. Both are read. A resumed subscription returns null.
 */
function cancellationDate(subscription: Stripe.Subscription, periodEnd: number | undefined): Date | null {
  if (subscription.cancel_at) return new Date(subscription.cancel_at * 1000);
  if (subscription.cancel_at_period_end && periodEnd) return new Date(periodEnd * 1000);
  // An ended subscription has its status for that.
  return null;
}

async function applySubscription(subscription: Stripe.Subscription): Promise<void> {
  const userId = subscription.metadata?.userId;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const account = userId
    ? await getPrisma().account.findUnique({ where: { id: BigInt(userId) }, select: { id: true } })
    : await getPrisma().account.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });

  if (!account) {
    stripeLogger.warn({ customerId, userId }, 'subscription for an unknown account');
    return;
  }

  const paid = PAID_STATUSES.has(subscription.status);
  const periodEnd = subscription.items.data[0]?.current_period_end;

  await getPrisma().account.update({
    where: { id: account.id },
    data: {
      plan: paid ? 'pro' : 'free',
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAt: cancellationDate(subscription, periodEnd),
    },
  });

  // Apply the new quota to the current month. API processes pick it up within the key cache's minute,
  // since their counter reloads when the plan changes.
  await openPeriod(account.id, paid ? 'pro' : 'free');

  stripeLogger.info(
    { userId: account.id.toString(), status: subscription.status, plan: paid ? 'pro' : 'free' },
    'plan updated from Stripe',
  );
}
