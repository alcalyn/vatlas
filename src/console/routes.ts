import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { presentAll, presentLookup } from '../lib/lookupView.js';
import {
  accountByEmail,
  authenticate,
  createAccount,
  createSecretKey,
  deleteAccount,
  dismissOnboarding,
  listSecretKeys,
  markEmailVerified,
  normalizeEmail,
  revokeSecretKey,
  setPassword,
  usageByKey,
  usageHistory,
} from '../services/accounts.js';
import { clearLoginFailures, recordAttempt, withinBudget } from '../services/authThrottle.js';
import { PASSWORD_MAX, PASSWORD_MIN, isAcceptablePassword, verifyPassword } from '../services/passwords.js';
import { TERMS_VERSION } from './legal.js';
import { lookupVat } from '../api/resolve.js';
import { InvalidVatError, normalizeVatInput, parseVatNumber } from '../vat/parse.js';
import { openPeriod, quotaForPlan } from '../services/usage.js';
import { DEFAULT_LOCALE, isLocale, localeFromHeader, t, type Locale } from './i18n.js';
import { sendPasswordChangedEmail, sendPasswordResetEmail, sendVerifyEmail } from './emails.js';
import {
  COOKIE_NAME,
  consumeEmailToken,
  createEmailToken,
  createSession,
  destroyOtherSessions,
  destroySession,
  peekEmailToken,
  readCookie,
  readSession,
  readSessionAccount,
} from './session.js';
import { hashSecret } from '../services/secretKeys.js';
import { collectPersonalData, eraseSection, isErasable, toJsonExport, toTextExport } from '../services/personalData.js';
import {
  accountDeletedPage,
  accountPage,
  asyncLookupDetailPage,
  asyncLookupsPage,
  auditEntryPage,
  auditPage,
  billingPage,
  contactPage,
  dashboardPage,
  forgotPasswordPage,
  keysPage,
  loginPage,
  resetPasswordPage,
  signupPage,
  lookupPage,
  monitorDetailPage,
  monitorsPage,
  personalDataPage,
  type HistoryRow,
  LOOKUP_MODES,
  LOOKUP_PREFERENCES,
  lookupPath,
  type LookupMode,
  type LookupPreference,
  type LookupResult,
  type LookupSourceRow,
} from './views.js';
import {
  MonitorError,
  countMonitors,
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  monitorLimitFor,
  sendTestDelivery,
} from '../services/monitors.js';
import {
  createAsyncLookup,
  deleteAsyncLookup,
  getAsyncLookup,
  listAsyncLookups,
  type AsyncKind,
} from '../services/asyncLookups.js';
import {
  CallbackUrlError,
  assertPublicUrl,
  callbackSecret,
  resendLastDelivery,
  rotateCallbackSecret,
  resolveCallbackUrl,
} from '../services/callbacks.js';
import { consume, peek } from '../services/usage.js';
import { getAuditRow, pageAudit, resolveCursor, searchAudit } from '../services/audit.js';
import { AUDIT_PRO_DAYS, AUDIT_FREE_KEEP } from '../services/retention.js';
import { createCheckoutUrl, createPortalUrl, handleWebhook, isStripeConfigured } from './stripe.js';

export const consoleRouter: Router = Router();
const consoleLogger = logger.child({ component: 'console' });

declare module 'express-serve-static-core' {
  interface Request {
    userId?: bigint;
    emailVerified?: boolean;
    locale?: Locale;
  }
}

/** Everything after this point requires a session. */
async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await readSessionAccount(req);
    if (!session) {
      res.redirect('/login');
      return;
    }
    req.userId = session.userId;
    req.emailVerified = session.emailVerified;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Defense in depth behind `SameSite=Lax`, which already blocks the session cookie on cross-site
 * POSTs.
 */
function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && origin !== config.console.baseUrl) {
    res.status(403).send('Cross-origin request refused.');
    return;
  }
  next();
}

/**
 * Language source, in order: `?lang=`, then the cookie this middleware writes, then
 * `Accept-Language`. A signed-in page uses the account's setting, which `?lang=` has already
 * updated.
 */
function localeOf(req: Request): Locale {
  return req.locale ?? localeFromHeader(req.get('accept-language'));
}

const LOCALE_COOKIE = 'vatlas-locale';

/**
 * The site and console are different origins, so links from the site carry `?lang=`.
 *
 * The choice is saved (on the account, or in a cookie for anonymous visitors) so the next click
 * keeps it.
 *
 * This is a GET that writes, which this file otherwise avoids. Acceptable here: the value is one of
 * a few constants, idempotent, and the visitor's own choice.
 */
async function resolveLocale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const wanted = String(req.query.lang ?? '');
    if (isLocale(wanted)) {
      req.locale = wanted;
      rememberLocale(res, wanted);
      const userId = await readSession(req);
      if (userId) await getPrisma().account.update({ where: { id: userId }, data: { locale: wanted } });
    } else {
      const stored = readCookie(req, LOCALE_COOKIE);
      if (isLocale(stored)) req.locale = stored;
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** One year, host only, readable by the page: nothing secret. */
function rememberLocale(res: Response, locale: Locale): void {
  res.cookie(LOCALE_COOKIE, locale, {
    httpOnly: false,
    sameSite: 'lax',
    secure: config.console.baseUrl.startsWith('https://'),
    maxAge: 365 * 86_400_000,
    path: '/',
  });
}

consoleRouter.use(resolveLocale);

// -- sign in --

consoleRouter.get('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Already signed in: go to the dashboard.
    if (await readSession(req)) {
      res.redirect('/');
      return;
    }
    const locale = localeOf(req);
    const tr = t(locale);
    // Where a verification link lands when opened in a browser that is not signed in.
    res.type('html').send(
      loginPage(locale, {
        notice: req.query.verified !== undefined ? tr('verify.done') : undefined,
        error: req.query['verify-expired'] !== undefined ? tr('verify.expired') : undefined,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * One failure message for every case (unknown address, no password yet, wrong password), so the
 * form never reveals which addresses have an account. The page itself tells old magic-link
 * accounts to use "forgotten password" once.
 */
consoleRouter.post('/login', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  const locale = localeOf(req);
  const tr = t(locale);
  const email = normalizeEmail(String(req.body?.email ?? ''));
  const password = String(req.body?.password ?? '');

  try {
    const target = await accountByEmail(email);
    if (!(await withinBudget('login', req.ip, target?.id))) {
      res
        .status(429)
        .type('html')
        .send(loginPage(locale, { error: tr('login.throttled'), email }));
      return;
    }

    const result = await authenticate(email, password);
    if (!result.ok) {
      await recordAttempt('login', req.ip, result.userId);
      res.type('html').send(loginPage(locale, { error: tr('login.invalid'), email }));
      return;
    }

    await clearLoginFailures(result.userId);
    await createSession(result.userId, req, res);
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

// -- sign up --

consoleRouter.get('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (await readSession(req)) {
      res.redirect('/');
      return;
    }
    res.type('html').send(signupPage(localeOf(req), {}));
  } catch (error) {
    next(error);
  }
});

/**
 * The account is usable right away: signed in, with a working key. The only email sent is the
 * verification link, so typing someone else's address only sends them that.
 */
consoleRouter.post('/signup', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  const locale = localeOf(req);
  const tr = t(locale);
  const email = normalizeEmail(String(req.body?.email ?? ''));
  const password = String(req.body?.password ?? '');
  // An unchecked box submits nothing, so presence is the test. The value is the version the visitor
  // was shown, which is what gets stored.
  const acceptedVersion = String(req.body?.terms ?? '');
  const again = (error: string) => signupPage(locale, { error, email, termsChecked: acceptedVersion !== '' });

  if (!isPlausibleEmail(email)) {
    res.type('html').send(again(tr('login.invalidEmail')));
    return;
  }
  if (!isAcceptablePassword(password)) {
    res.type('html').send(again(tr('password.tooShort', { min: PASSWORD_MIN, max: PASSWORD_MAX })));
    return;
  }
  // Checked on the server, not only with `required`.
  if (acceptedVersion !== TERMS_VERSION) {
    res.type('html').send(signupPage(locale, { error: tr('signup.termsRequired'), email }));
    return;
  }

  try {
    if (!(await withinBudget('signup', req.ip))) {
      res
        .status(429)
        .type('html')
        .send(again(tr('signup.throttled')));
      return;
    }

    const result = await createAccount(email, password, locale, { version: acceptedVersion, ip: req.ip });
    if (!result.created) {
      res.type('html').send(signupPage(locale, { error: tr('signup.exists'), email, exists: true }));
      return;
    }
    await recordAttempt('signup', req.ip);

    await createSession(result.userId, req, res);
    await sendVerification(result.userId, email, locale, req.ip);
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

/** Sends a verification link unless the account asked too often. False when throttled. */
async function sendVerification(
  userId: bigint,
  email: string,
  locale: Locale,
  ip: string | undefined,
): Promise<boolean> {
  const link = await createEmailToken(userId, 'verify_email', ip);
  if (!link.allowed) {
    consoleLogger.warn({ userId: userId.toString() }, 'verification link throttled');
    return false;
  }
  try {
    await sendVerifyEmail(email, link.url, locale);
  } catch (error) {
    // The account exists and the session is set: a mail failure must not turn the sign-up into an
    // error. The banner offers to resend.
    consoleLogger.error({ err: error, userId: userId.toString() }, 'verification mail failed');
  }
  return true;
}

// -- email verification --

/**
 * Consumed on GET, unlike the reset link: a mail scanner prefetching it only proves the mailbox
 * exists, which is all the link claims. Works signed in or not.
 */
consoleRouter.get('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.query.token ?? '');
    const userId = token ? await consumeEmailToken(token, 'verify_email') : null;
    const signedIn = await readSession(req);
    if (userId) await markEmailVerified(userId);

    const outcome = userId ? 'verified' : 'verify-expired';
    res.redirect(signedIn ? `/account?${outcome}` : `/login?${outcome}`);
  } catch (error) {
    next(error);
  }
});

consoleRouter.post(
  '/verify-email/resend',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await getPrisma().account.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { email: true, locale: true, emailVerifiedAt: true },
      });
      if (account.emailVerifiedAt) {
        res.redirect('/account');
        return;
      }
      const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
      const sent = await sendVerification(req.userId!, account.email, locale, req.ip);
      res.redirect(sent ? '/account?verify-sent' : '/account?verify-throttled');
    } catch (error) {
      next(error);
    }
  },
);

// -- forgotten password --

consoleRouter.get('/password/forgot', (req: Request, res: Response) => {
  res.type('html').send(forgotPasswordPage(localeOf(req), {}));
});

/**
 * Same answer whether or not the address has an account or is throttled, so the form reveals
 * nothing.
 *
 * It is also how old magic-link accounts set a password.
 */
consoleRouter.post('/password/forgot', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  const locale = localeOf(req);
  const email = normalizeEmail(String(req.body?.email ?? ''));

  if (!isPlausibleEmail(email)) {
    res.type('html').send(forgotPasswordPage(locale, { error: t(locale)('login.invalidEmail'), email }));
    return;
  }

  try {
    if (await withinBudget('forgot', req.ip)) {
      await recordAttempt('forgot', req.ip);
      const account = await accountByEmail(email);
      if (account && account.status === 'active') {
        const link = await createEmailToken(account.id, 'reset_password', req.ip);
        const mailLocale = isLocale(account.locale) ? account.locale : locale;
        if (link.allowed) await sendPasswordResetEmail(account.email, link.url, mailLocale);
        else consoleLogger.warn({ userId: account.id.toString() }, 'reset link throttled');
      }
    } else {
      consoleLogger.warn({ ip: req.ip }, 'password reset requests throttled');
    }
    res.type('html').send(forgotPasswordPage(locale, { sent: true }));
  } catch (error) {
    next(error);
  }
});

/**
 * Shows the form only. The token is consumed by the POST: mail scanners open every link, and a GET
 * that consumed it would expire the link before the user clicked.
 */
consoleRouter.get('/password/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locale = localeOf(req);
    const token = String(req.query.token ?? '');
    const valid = token !== '' && (await peekEmailToken(token, 'reset_password'));
    res.type('html').send(resetPasswordPage(locale, valid ? { token } : { expired: true }));
  } catch (error) {
    next(error);
  }
});

/**
 * A used reset link proves the mailbox, so it also verifies the address. Every session is signed
 * out and a new one is opened here.
 */
consoleRouter.post('/password/reset', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  const locale = localeOf(req);
  const tr = t(locale);
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');

  if (!isAcceptablePassword(password)) {
    res
      .type('html')
      .send(
        resetPasswordPage(locale, { token, error: tr('password.tooShort', { min: PASSWORD_MIN, max: PASSWORD_MAX }) }),
      );
    return;
  }

  try {
    const userId = token ? await consumeEmailToken(token, 'reset_password') : null;
    if (!userId) {
      res.type('html').send(resetPasswordPage(locale, { expired: true }));
      return;
    }

    await setPassword(userId, password);
    await markEmailVerified(userId);
    await clearLoginFailures(userId);
    await destroyOtherSessions(userId);
    await createSession(userId, req, res);
    await notifyPasswordChanged(userId);
    res.redirect('/account?password-changed');
  } catch (error) {
    next(error);
  }
});

/** Best effort: the password is already changed. */
async function notifyPasswordChanged(userId: bigint): Promise<void> {
  try {
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, locale: true },
    });
    await sendPasswordChangedEmail(account.email, isLocale(account.locale) ? account.locale : DEFAULT_LOCALE);
  } catch (error) {
    consoleLogger.error({ err: error, userId: userId.toString() }, 'password-changed notice failed');
  }
}

/** Old magic links land on the sign-in page, which explains the change. */
consoleRouter.get('/auth/callback', (_req: Request, res: Response) => {
  res.redirect('/login');
});

consoleRouter.post('/logout', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await destroySession(req, res);
    res.redirect('/login');
  } catch (error) {
    next(error);
  }
});

/** Loose on purpose: the verification link is the real test of an address. */
function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value) && value.length <= 255;
}

// -- dashboard --

consoleRouter.get('/', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, plan: true, locale: true, stripeCustomerId: true, onboardingDismissedAt: true },
    });
    const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;

    // Awaited before the read: `openPeriod` is an upsert, and running it in the same `Promise.all` as
    // `usageHistory` would race at the start of a month and lose the last bar of the chart.
    const period = await openPeriod(userId, account.plan);
    const [keys, history, monitorsUsed] = await Promise.all([
      listSecretKeys(userId),
      usageHistory(userId),
      countMonitors(userId),
    ]);

    res.type('html').send(
      dashboardPage({
        emailVerified: req.emailVerified,
        locale,
        email: account.email,
        sampleKey: sampleKey(keys),
        monitorsUsed,
        monitorsLimit: monitorLimitFor(account.plan),
        used: period.used,
        quota: period.quota,
        periodStart: period.periodStart,
        resetAt: period.periodEnd,
        plan: account.plan,
        stripeReady: isStripeConfigured(),
        hasBillingAccount: account.stripeCustomerId !== null,
        history: withCurrentMonth(history, period),
        onboarding: account.onboardingDismissedAt === null,
      }),
    );
  } catch (error) {
    next(error);
  }
});

consoleRouter.post(
  '/onboarding/dismiss',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await dismissOnboarding(req.userId!);
      res.redirect('/');
    } catch (error) {
      next(error);
    }
  },
);

/**
 * The current month, added to the twelve from the database if missing.
 *
 * The counter is flushed to the database every few seconds, so the row's `used` can lag. The
 * in-memory figure wins for that bar, so the chart matches the number above it.
 */
function withCurrentMonth(
  history: HistoryRow[],
  period: { periodStart: Date; quota: number; used: number },
): HistoryRow[] {
  const current = { periodStart: period.periodStart, quota: period.quota, used: period.used };
  const index = history.findIndex((row) => row.periodStart.getTime() === period.periodStart.getTime());
  if (index === -1) return [...history, current];
  return history.map((row, at) => (at === index ? current : row));
}

// -- lookup --

/** How long the console waits for the API. Long, since a first VIES lookup can be slow. */
const LOOKUP_TIMEOUT_MS = 20_000;

consoleRouter.get('/lookup', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.type('html').send(await renderLookup(req, {}));
  } catch (error) {
    next(error);
  }
});

/**
 * A lookup from the console, made over HTTP to the public API with the account's own key, so it is
 * authenticated, metered, rate limited and audited like any customer call.
 *
 * A POST, since it spends quota.
 */
consoleRouter.post('/lookup', requireSession, sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = normalizeVatInput(String(req.body?.vatNumber ?? '')).slice(0, 20);
    // The selected mode, matched against the list. Anything else is the plain lookup, so a forged POST
    // cannot pick another call.
    const mode = readMode(req.body?.mode);
    const prefer = readPreference(req.body?.prefer);
    // An unchecked checkbox posts nothing.
    const history = req.body?.history !== undefined;
    res.type('html').send(await renderLookup(req, { query, mode, prefer, history, run: query !== '' }));
  } catch (error) {
    next(error);
  }
});

/**
 * The selected mode, matched against the list. Anything else is the plain lookup, so a forged POST
 * cannot pick the expensive call or force `prefer`.
 */
function readMode(value: unknown): LookupMode {
  const submitted = String(value ?? '');
  return (LOOKUP_MODES as readonly string[]).includes(submitted) ? (submitted as LookupMode) : 'single';
}

function readPreference(value: unknown): LookupPreference {
  const submitted = String(value ?? '');
  return (LOOKUP_PREFERENCES as readonly string[]).includes(submitted)
    ? (submitted as LookupPreference)
    : 'completeness';
}

async function renderLookup(
  req: Request,
  options: { query?: string; mode?: LookupMode; prefer?: LookupPreference; history?: boolean; run?: boolean },
) {
  const userId = req.userId!;
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, locale: true, stripeCustomerId: true },
  });
  const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
  const keys = await listSecretKeys(userId);
  const key = sampleKey(keys);
  const query = options.query ?? '';
  const mode = options.mode ?? 'single';
  const prefer = options.prefer ?? 'completeness';
  // On by default in the console (off on the API): the console shows what an answer looks like.
  const history = options.history ?? true;

  let called: CalledApi | undefined;
  let error: string | undefined;

  if (options.run) {
    if (!key) {
      // Same rule as the sample command: the default key, else any live key that can be shown in full.
      // Without one there is nothing to authenticate with.
      error = t(locale)('lookup.noKey');
    } else {
      called = await callApi(query, key, { mode, prefer, history });
      if (!called) error = t(locale)('lookup.failed');
    }
  }

  return lookupPage({
    emailVerified: req.emailVerified,
    locale,
    email: account.email,
    stripeReady: isStripeConfigured(),
    hasBillingAccount: account.stripeCustomerId !== null,
    sampleKey: key,
    query,
    mode,
    prefer,
    history,
    result: called?.result,
    sources: mode === 'all' ? readSources(called) : undefined,
    // The formatted tab is built by `src/lib/lookupView.ts`, shared with the site.
    view: called
      ? mode === 'all'
        ? presentAll(called.payload)
        : presentLookup(called.result.status, called.payload)
      : undefined,
    error,
  });
}

/**
 * The sources of a lookup-all, read from the API's response body.
 *
 * From the response, so the page shows exactly what the integration receives. Anything unexpected
 * shows no table, and the raw body is still there.
 */
function readSources(called: CalledApi | undefined): LookupSourceRow[] | undefined {
  if (!called || called.result.status !== 200) return undefined;
  const body = called.payload as { data?: { sources?: unknown } } | undefined;
  const sources = body?.data?.sources;
  if (!Array.isArray(sources)) return undefined;

  return sources.map((source: Record<string, unknown>) => {
    const history = Array.isArray(source.history) ? (source.history as Record<string, unknown>[]) : [];
    const latest = history.at(-1);
    const meta = (source.meta ?? {}) as Record<string, unknown>;
    const call = meta.call as Record<string, unknown> | undefined;

    return {
      source: String(meta.source ?? ''),
      kind: String(meta.kind ?? ''),
      // The result of the call this report made. Without a call, the entry came from storage.
      status: call ? String(call.status ?? '') : history.length > 0 ? 'stored' : 'not-found',
      // The plateau's `to`: the last day the source said it.
      asOf: typeof latest?.to === 'string' ? latest.to : null,
      statements: history.length,
    };
  });
}

/**
 * The call itself. Undefined when the API never answered.
 *
 * The body is returned pretty-printed for the raw tab and parsed for the rest, parsed once here.
 */
async function callApi(
  vatNumber: string,
  key: string,
  options: { mode: LookupMode; prefer: LookupPreference; history: boolean },
): Promise<CalledApi | undefined> {
  const started = Date.now();
  // The URL is built by the same function that prints it above the answer, so what is shown is what
  // was sent.
  const path = lookupPath(vatNumber, options);
  try {
    const response = await fetch(`${config.apiBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const text = (await response.text()).slice(0, 20_000);
    return {
      result: { status: response.status, body: prettyJson(text), durationMs: Date.now() - started },
      payload: parseJson(text),
    };
  } catch (error) {
    consoleLogger.warn({ err: error }, 'console lookup could not reach the API');
    return undefined;
  }
}

/** The result of one API call: what to show and what to read. */
interface CalledApi {
  result: LookupResult;
  /** The parsed body, or undefined when it is not JSON (a proxy's HTML page). */
  payload: unknown;
}

/** Indented if it parses, otherwise shown as received. */
function prettyJson(text: string): string {
  const parsed = parseJson(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

/** The body as a value, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// -- keys --

consoleRouter.get('/keys', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, locale: true, stripeCustomerId: true },
    });
    const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
    const [keys, requestsByKey] = await Promise.all([listSecretKeys(userId), usageByKey(userId)]);

    res.type('html').send(
      keysPage({
        emailVerified: req.emailVerified,
        locale,
        email: account.email,
        stripeReady: isStripeConfigured(),
        hasBillingAccount: account.stripeCustomerId !== null,
        keys,
        requestsByKey,
      }),
    );
  } catch (error) {
    next(error);
  }
});

// -- audit --

/** Page size of the recent calls listing. */
const AUDIT_PAGE_SIZE = 25;

/**
 * The audit trail: what the API answered, per number and over time.
 *
 * Two queries: the searched number's history, and the account's latest calls. Both are scoped to
 * the signed-in account.
 *
 * A GET without side effects, so it is linkable. The `before` cursor is a keyset on the primary key.
 */
/** Old URL, redirected with its query string and row id. */
consoleRouter.get(['/audit', '/audit/:publicId'], (req: Request, res: Response) => {
  res.redirect(`/audits${req.originalUrl.slice('/audit'.length)}`);
});

consoleRouter.get('/audits', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, plan: true, locale: true, stripeCustomerId: true, onboardingDismissedAt: true },
    });
    const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;

    // Normalized like the API, so "fr 958 848 315 38" finds `FR95884831538`. Invalid input is
    // reported rather than searched.
    const raw = String(req.query.q ?? '').trim();
    let query = '';
    let queryError = false;
    if (raw) {
      try {
        query = parseVatNumber(normalizeVatInput(raw)).formatted;
      } catch {
        queryError = true;
      }
    }

    // Lenient, unlike the API: an invalid or foreign cursor shows the first page.
    const cursor = parseCursor(req.query.before);
    const before = cursor === undefined ? undefined : ((await resolveCursor(userId, cursor)) ?? undefined);

    const [matches, recent, keys] = await Promise.all([
      query ? searchAudit(userId, { vatNumber: query, limit: AUDIT_PAGE_SIZE }) : Promise.resolve([]),
      pageAudit(userId, { before, limit: AUDIT_PAGE_SIZE }),
      listSecretKeys(userId),
    ]);

    res.type('html').send(
      auditPage({
        emailVerified: req.emailVerified,
        locale,
        email: account.email,
        query: queryError ? raw : query,
        queryError,
        matches,
        recent: recent.rows,
        olderThan: recent.nextBefore,
        plan: account.plan,
        retentionKeep: AUDIT_FREE_KEEP,
        retentionDays: AUDIT_PRO_DAYS,
        stripeReady: isStripeConfigured(),
        hasBillingAccount: account.stripeCustomerId !== null,
        apiBaseUrl: config.apiBaseUrl,
        sampleKey: sampleKey(keys),
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * One recorded answer, with the rest of its number's history below (same keyset paging).
 *
 * A `publicId` from another account behaves like a missing one, and both redirect to the trail.
 */
consoleRouter.get('/audits/:publicId', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const row = await getAuditRow(userId, String(req.params.publicId ?? ''));
    if (!row) {
      res.redirect('/audits');
      return;
    }

    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, locale: true, stripeCustomerId: true },
    });

    const cursor = parseCursor(req.query.before);
    const before = cursor === undefined ? undefined : ((await resolveCursor(userId, cursor)) ?? undefined);
    const history = await pageAudit(userId, { vatNumber: row.vatNumber, before, limit: AUDIT_PAGE_SIZE });

    res.type('html').send(
      auditEntryPage({
        emailVerified: req.emailVerified,
        locale: isLocale(account.locale) ? account.locale : DEFAULT_LOCALE,
        email: account.email,
        row,
        history: history.rows,
        ...(history.nextBefore !== undefined ? { olderThan: history.nextBefore } : {}),
        stripeReady: isStripeConfigured(),
        hasBillingAccount: account.stripeCustomerId !== null,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/** The `before` cursor: a `publicId`, anything else is ignored. */
function parseCursor(value: unknown): string | undefined {
  const raw = String(value ?? '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : undefined;
}

/**
 * The key to put in a sample command.
 *
 * `default` first (the one shown after sign-up), else any live key that can be shown in full.
 * Undefined otherwise, and the panels fall back to `$VATLAS_KEY` like the published docs.
 */
function sampleKey(keys: Awaited<ReturnType<typeof listSecretKeys>>): string | undefined {
  const usable = keys.filter((key) => key.revokedAt === null && key.copyable);
  return (usable.find((key) => key.name === 'default') ?? usable[0])?.key;
}

/**
 * The language of the console and of every email. Stored on the account when there is one, and in a
 * cookie too (all an anonymous visitor has).
 *
 * A POST, since it changes state, covered by `sameOrigin`. Redirects back to the page it came from,
 * and only to one of our own paths: the Referer is attacker-controlled and could make this an open
 * redirect.
 */
// -- monitors --

/**
 * What the two callback pages need about the account, in one query. `plan` sets the monitor limit,
 * `callbackUrl` is the fallback address.
 */
async function callbackContext(userId: bigint) {
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      plan: true,
      locale: true,
      monitorUrl: true,
      lookupAsyncUrl: true,
      stripeCustomerId: true,
    },
  });
  return {
    ...account,
    locale: isLocale(account.locale) ? account.locale : DEFAULT_LOCALE,
    stripeReady: isStripeConfigured(),
    hasBillingAccount: account.stripeCustomerId !== null,
  };
}

/** A service refusal, as a sentence for the page. Other errors go to the error handler. */
function refusalMessage(error: unknown): string | undefined {
  if (error instanceof CallbackUrlError || error instanceof MonitorError) return error.message;
  if (error instanceof InvalidVatError) return error.message;
  return undefined;
}

async function renderMonitors(req: Request, options: { saved?: boolean; error?: string } = {}) {
  const userId = req.userId!;
  const account = await callbackContext(userId);
  const [monitors, keys] = await Promise.all([listMonitors(userId), listSecretKeys(userId)]);

  return monitorsPage({
    emailVerified: req.emailVerified,
    locale: account.locale,
    email: account.email,
    stripeReady: account.stripeReady,
    hasBillingAccount: account.hasBillingAccount,
    monitors,
    limit: monitorLimitFor(account.plan),
    monitorUrl: account.monitorUrl ?? '',
    // A GET that writes, like `resolveLocale`: it creates the signing secret on first visit.
    // Idempotent afterwards. Accounts that never open this page never get a secret.
    callbackSecret: await callbackSecret(userId),
    apiBaseUrl: config.apiBaseUrl,
    sampleKey: sampleKey(keys),
    ...options,
  });
}

consoleRouter.get('/monitor', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.type('html').send(await renderMonitors(req, { saved: req.query.saved !== undefined }));
  } catch (error) {
    next(error);
  }
});

consoleRouter.post('/monitor', requireSession, sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await callbackContext(req.userId!);
    await createMonitor(req.userId!, account.plan, {
      vatNumber: String(req.body?.vatNumber ?? ''),
      url: String(req.body?.url ?? ''),
    });
    res.redirect('/monitor');
  } catch (error) {
    // An invalid number, a refused URL, a full list: the form comes back with the reason.
    const message = refusalMessage(error);
    if (message === undefined) {
      next(error);
      return;
    }
    try {
      res.type('html').send(await renderMonitors(req, { error: message }));
    } catch (renderError) {
      next(renderError);
    }
  }
});

/**
 * The default callback URL, one route per feature: monitors and async lookups are independent.
 *
 * Validated here, so a URL the cron would refuse is never stored.
 */
function saveDefaultUrl(
  feature: 'monitor' | 'lookupAsync',
  render: (req: Request, options: { error?: string }) => Promise<string>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = String(req.body?.defaultUrl ?? '').trim();
      // Empty clears it.
      const url = raw === '' ? null : assertPublicUrl(raw);
      await getPrisma().account.update({
        where: { id: req.userId! },
        data: feature === 'monitor' ? { monitorUrl: url } : { lookupAsyncUrl: url },
      });
      res.redirect(feature === 'monitor' ? '/monitor?saved' : '/lookup-async?saved');
    } catch (error) {
      const message = refusalMessage(error);
      if (message === undefined) {
        next(error);
        return;
      }
      try {
        res.type('html').send(await render(req, { error: message }));
      } catch (renderError) {
        next(renderError);
      }
    }
  };
}

consoleRouter.post('/monitor/settings', requireSession, sameOrigin, saveDefaultUrl('monitor', renderMonitors));

/**
 * Rolls the signing secret. Receivers using the old one start rejecting signatures immediately,
 * hence a separate POST behind a confirmation.
 */
consoleRouter.post(
  '/callbacks/rotate',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await rotateCallbackSecret(req.userId!);
      // One secret for both features: only the page to return to differs. One of two constants, never a
      // path from the body.
      res.redirect(String(req.body?.from ?? '') === 'lookupAsync' ? '/lookup-async?saved' : '/monitor?saved');
    } catch (error) {
      next(error);
    }
  },
);

consoleRouter.get('/monitor/:vatNumber', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const monitor = await getMonitor(req.userId!, String(req.params.vatNumber ?? ''));
    if (!monitor) {
      res.redirect('/monitor');
      return;
    }
    const account = await callbackContext(req.userId!);

    res.type('html').send(
      monitorDetailPage({
        emailVerified: req.emailVerified,
        locale: account.locale,
        email: account.email,
        stripeReady: account.stripeReady,
        hasBillingAccount: account.hasBillingAccount,
        monitor: { ...monitor, last: monitor.lastPayload },
        // Resolved, so the page shows the URL that would really be called.
        effectiveUrl: callbackUrlOrDash(monitor.url, account.monitorUrl),
        deliveries: monitor.deliveries,
        tested: req.query.tested !== undefined,
        ...(req.query.failed !== undefined ? { error: String(req.query.failed).slice(0, 300) } : {}),
        ...(req.query.resent !== undefined ? { resent: true } : {}),
        ...(req.query.resendFailed !== undefined ? { resendError: String(req.query.resendFailed).slice(0, 300) } : {}),
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * The test button: a real signed request to the real endpoint, with sample company data in the
 * shape of a real change event.
 *
 * Needed because the followed company may not change for years. Recorded like any delivery, tagged
 * `monitor.test`.
 */
consoleRouter.post(
  '/monitor/:vatNumber/test',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    const vatNumber = String(req.params.vatNumber ?? '');
    try {
      const result = await sendTestDelivery(req.userId!, vatNumber);
      if (result === null) {
        res.redirect('/monitor');
        return;
      }
      // The failure goes in the query string: the endpoint answering 500 is what the button is for.
      const suffix = result.delivered ? '?tested' : `?failed=${encodeURIComponent(result.error ?? '')}`;
      res.redirect(`/monitor/${encodeURIComponent(vatNumber)}${suffix}`);
    } catch (error) {
      const message = refusalMessage(error);
      if (message === undefined) {
        next(error);
        return;
      }
      res.redirect(`/monitor/${encodeURIComponent(vatNumber)}?failed=${encodeURIComponent(message)}`);
    }
  },
);

consoleRouter.post(
  '/monitor/:vatNumber/delete',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteMonitor(req.userId!, String(req.params.vatNumber ?? ''));
      res.redirect('/monitor');
    } catch (error) {
      next(error);
    }
  },
);

/** The URL that would be called, or a dash. */
function callbackUrlOrDash(own: string | null, accountDefault: string | null): string {
  try {
    return resolveCallbackUrl(own, accountDefault);
  } catch {
    return '-';
  }
}

// -- async lookups --

async function renderAsyncLookups(
  req: Request,
  options: { saved?: boolean; error?: string; mode?: LookupMode; prefer?: LookupPreference } = {},
) {
  const userId = req.userId!;
  const account = await callbackContext(userId);
  const [lookups, keys] = await Promise.all([listAsyncLookups(userId, { limit: 50 }), listSecretKeys(userId)]);

  return asyncLookupsPage({
    emailVerified: req.emailVerified,
    locale: account.locale,
    email: account.email,
    stripeReady: account.stripeReady,
    hasBillingAccount: account.hasBillingAccount,
    lookups,
    maxDays: config.asyncLookup.maxDays,
    lookupAsyncUrl: account.lookupAsyncUrl ?? '',
    callbackSecret: await callbackSecret(userId),
    apiBaseUrl: config.apiBaseUrl,
    sampleKey: sampleKey(keys),
    // Keeps the selected mode when the page comes back with an error.
    mode: options.mode ?? 'single',
    prefer: options.prefer ?? 'completeness',
    ...options,
  });
}

consoleRouter.post(
  '/lookup-async/settings',
  requireSession,
  sameOrigin,
  saveDefaultUrl('lookupAsync', renderAsyncLookups),
);

consoleRouter.get('/lookup-async', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.type('html').send(await renderAsyncLookups(req, { saved: req.query.created !== undefined }));
  } catch (error) {
    next(error);
  }
});

/**
 * Creates one from the console, charged like the API: one unit now, refunded if no source answers
 * within a week.
 */
consoleRouter.post(
  '/lookup-async',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await callbackContext(req.userId!);
      const tr = t(account.locale);

      const quota = await peek(req.userId!, account.plan);
      if (quota.exceeded) {
        res.type('html').send(
          await renderAsyncLookups(req, {
            error: tr('asyncLookups.quotaExceeded'),
            mode: readMode(req.body?.mode),
            prefer: readPreference(req.body?.prefer),
          }),
        );
        return;
      }

      // Same switch as `/lookup`: every source, or one answer with or without proof.
      const mode = readMode(req.body?.mode);
      const prefer = readPreference(req.body?.prefer);
      const kind: AsyncKind = mode === 'all' ? 'all' : prefer === 'proof' ? 'proof' : 'single';

      await createAsyncLookup(req.userId!, {
        vatNumber: String(req.body?.vatNumber ?? ''),
        kind,
        url: String(req.body?.url ?? ''),
      });
      consume(req.userId!, 1);

      res.redirect('/lookup-async?created');
    } catch (error) {
      const message = refusalMessage(error);
      if (message === undefined) {
        next(error);
        return;
      }
      try {
        res.type('html').send(
          await renderAsyncLookups(req, {
            error: message,
            mode: readMode(req.body?.mode),
            prefer: readPreference(req.body?.prefer),
          }),
        );
      } catch (renderError) {
        next(renderError);
      }
    }
  },
);

consoleRouter.get(
  '/lookup-async/:publicId',
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lookup = await getAsyncLookup(req.userId!, String(req.params.publicId ?? ''));
      if (!lookup) {
        res.redirect('/lookup-async');
        return;
      }
      const account = await callbackContext(req.userId!);

      res.type('html').send(
        asyncLookupDetailPage({
          emailVerified: req.emailVerified,
          locale: account.locale,
          email: account.email,
          stripeReady: account.stripeReady,
          hasBillingAccount: account.hasBillingAccount,
          lookup,
          effectiveUrl: callbackUrlOrDash(lookup.url, account.lookupAsyncUrl),
          attempts: lookup.attemptLog,
          deliveries: lookup.deliveries,
          ...(req.query.resent !== undefined ? { resent: true } : {}),
          ...(req.query.resendFailed !== undefined
            ? { resendError: String(req.query.resendFailed).slice(0, 300) }
            : {}),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Sends the last delivery again, once.
 *
 * Shown only when the last attempt failed. Sends the exact body from `user_delivery`, not a
 * rebuilt event.
 *
 * The outcome goes in the query string.
 */
function resendRoute(
  kind: 'monitor' | 'lookupAsync',
  find: (userId: bigint, key: string) => Promise<{ id: bigint } | null>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = String(kind === 'monitor' ? (req.params.vatNumber ?? '') : (req.params.publicId ?? ''));
    const back =
      kind === 'monitor' ? `/monitor/${encodeURIComponent(key)}` : `/lookup-async/${encodeURIComponent(key)}`;
    try {
      const subject = await find(req.userId!, key);
      if (!subject) {
        res.redirect(kind === 'monitor' ? '/monitor' : '/lookup-async');
        return;
      }

      const result = await resendLastDelivery(
        req.userId!,
        kind === 'monitor' ? { monitorId: subject.id } : { asyncLookupId: subject.id },
      );
      if (result === null) {
        res.redirect(back);
        return;
      }

      // A successful resend marks the work delivered, like the cron would.
      if (result.delivered) {
        const now = new Date();
        if (kind === 'monitor') {
          await getPrisma().monitor.update({ where: { id: subject.id }, data: { lastDeliveredAt: now } });
        } else {
          await getPrisma().asyncLookup.update({ where: { id: subject.id }, data: { deliveredAt: now } });
        }
      }

      res.redirect(
        result.delivered ? `${back}?resent` : `${back}?resendFailed=${encodeURIComponent(result.error ?? '')}`,
      );
    } catch (error) {
      const message = refusalMessage(error);
      if (message === undefined) {
        next(error);
        return;
      }
      res.redirect(`${back}?resendFailed=${encodeURIComponent(message)}`);
    }
  };
}

consoleRouter.post(
  '/monitor/:vatNumber/resend',
  requireSession,
  sameOrigin,
  resendRoute('monitor', async (userId, vatNumber) => {
    const found = await getMonitor(userId, vatNumber, 1);
    return found ? { id: found.id } : null;
  }),
);

consoleRouter.post(
  '/lookup-async/:publicId/resend',
  requireSession,
  sameOrigin,
  resendRoute('lookupAsync', async (userId, publicId) => {
    const found = await getAsyncLookup(userId, publicId);
    return found ? { id: found.id } : null;
  }),
);

consoleRouter.post(
  '/lookup-async/:publicId/delete',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteAsyncLookup(req.userId!, String(req.params.publicId ?? ''));
      res.redirect('/lookup-async');
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Support page: community Discord for everyone, private channel for Pro accounts, email for the
 * rest. The plan is read from the database, not the session.
 */
consoleRouter.get('/contact', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { email: true, plan: true, locale: true, stripeCustomerId: true },
    });

    res.type('html').send(
      contactPage({
        emailVerified: req.emailVerified,
        locale: isLocale(account.locale) ? account.locale : DEFAULT_LOCALE,
        email: account.email,
        plan: account.plan,
        stripeReady: isStripeConfigured(),
        hasBillingAccount: account.stripeCustomerId !== null,
      }),
    );
  } catch (error) {
    next(error);
  }
});

consoleRouter.post('/locale', sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wanted = String(req.body?.locale ?? '');
    if (isLocale(wanted)) {
      rememberLocale(res, wanted);
      // No session on the login page: the cookie is the whole answer, and the account gets it at sign-in.
      const userId = await readSession(req);
      if (userId) await getPrisma().account.update({ where: { id: userId }, data: { locale: wanted } });
    }
    res.redirect(backTo(req));
  } catch (error) {
    next(error);
  }
});

/**
 * The path this POST came from when it is ours, otherwise `/`.
 *
 * `?lang=` is dropped: `resolveLocale` already used it, and leaving it would override the choice
 * just made.
 */
export function backTo(req: Request): string {
  const referer = req.get('referer');
  if (!referer?.startsWith(`${config.console.baseUrl}/`)) return '/';
  try {
    const url = new URL(referer);
    url.searchParams.delete('lang');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

consoleRouter.post('/keys', requireSession, sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await createSecretKey(req.userId!, String(req.body?.name ?? ''));
    res.redirect('/keys');
  } catch (error) {
    next(error);
  }
});

consoleRouter.post(
  '/keys/:id/revoke',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = BigInt(String(req.params.id));
      await revokeSecretKey(req.userId!, id);
      res.redirect('/keys');
    } catch (error) {
      next(error);
    }
  },
);

// -- account --

consoleRouter.get('/account', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tr = t(localeOf(req));
    const flag = (name: string) => req.query[name] !== undefined;
    const notice = flag('verified')
      ? tr('verify.done')
      : flag('verify-sent')
        ? tr('verify.sent')
        : flag('password-changed')
          ? tr('password.changed')
          : undefined;
    const error = flag('verify-expired')
      ? tr('verify.expired')
      : flag('verify-throttled')
        ? tr('verify.throttled')
        : undefined;
    res.type('html').send(await renderAccount(req, { saved: flag('saved'), notice, alert: error }));
  } catch (error) {
    next(error);
  }
});

/**
 * Erasure under GDPR Article 17. Requires a session, a same-origin POST and the confirmation word
 * typed in the account's language. The browser `confirm()` is only a courtesy.
 *
 * The session is destroyed after the erasure, so a failure leaves the holder signed in and able to
 * see why.
 */
consoleRouter.post(
  '/account/delete',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locale = localeOf(req);
      const tr = t(locale);
      const typed = String(req.body?.confirm ?? '').trim();

      if (typed.toUpperCase() !== tr('account.deleteConfirmWord').toUpperCase()) {
        res.type('html').send(await renderAccount(req, { error: tr('account.deleteMismatch') }));
        return;
      }

      const result = await deleteAccount(req.userId!);
      if (!result.ok) {
        const error =
          result.reason === 'subscription-active'
            ? tr('account.deleteBlockedPaid', { email: config.contact.email })
            : undefined;
        res.type('html').send(await renderAccount(req, { error }));
        return;
      }

      consoleLogger.info({ userId: req.userId!.toString() }, 'account erased on request');
      await destroySession(req, res);
      res.type('html').send(accountDeletedPage(locale));
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Changing the password from the console. The current password is required, so an open session on
 * a shared machine is not enough, except for old magic-link accounts that have none.
 *
 * Every other session is signed out.
 */
consoleRouter.post(
  '/account/password',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tr = t(localeOf(req));
      const current = String(req.body?.current ?? '');
      const password = String(req.body?.password ?? '');
      const account = await getPrisma().account.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { passwordHash: true },
      });

      if (account.passwordHash && !(await verifyPassword(current, account.passwordHash))) {
        res.type('html').send(await renderAccount(req, { passwordError: tr('password.currentWrong') }));
        return;
      }
      if (!isAcceptablePassword(password)) {
        res.type('html').send(
          await renderAccount(req, {
            passwordError: tr('password.tooShort', { min: PASSWORD_MIN, max: PASSWORD_MAX }),
          }),
        );
        return;
      }

      await setPassword(req.userId!, password);
      await destroyOtherSessions(req.userId!, currentSessionHash(req));
      await notifyPasswordChanged(req.userId!);
      res.redirect('/account?password-changed');
    } catch (error) {
      next(error);
    }
  },
);

async function renderAccount(
  req: Request,
  options: { error?: string; notice?: string; alert?: string; saved?: boolean; passwordError?: string },
) {
  const userId = req.userId!;
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      plan: true,
      locale: true,
      status: true,
      createdAt: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      cancelAt: true,
      termsVersion: true,
      termsAcceptedAt: true,
      emailVerifiedAt: true,
      passwordHash: true,
      passwordChangedAt: true,
      billingProfile: true,
      stripeCustomerId: true,
    },
  });
  const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
  const keys = await listSecretKeys(userId);
  const stored = account.billingProfile;

  return accountPage({
    emailVerified: req.emailVerified,
    locale,
    email: account.email,
    stripeReady: isStripeConfigured(),
    hasBillingAccount: account.stripeCustomerId !== null,
    createdAt: account.createdAt,
    plan: account.plan,
    quota: quotaForPlan(account.plan),
    status: account.status,
    activeKeys: keys.filter((key) => key.revokedAt === null).length,
    subscriptionStatus: account.subscriptionStatus ?? undefined,
    // Same rule as the billing page: only while the plan is still paid.
    cancelAt: account.plan === 'pro' ? (account.cancelAt ?? undefined) : undefined,
    currentPeriodEnd: account.currentPeriodEnd ?? undefined,
    termsVersion: account.termsVersion ?? undefined,
    termsAcceptedAt: account.termsAcceptedAt ?? undefined,
    emailVerifiedAt: account.emailVerifiedAt ?? undefined,
    // Whether a password exists. The hash never leaves this function.
    hasPassword: account.passwordHash !== null,
    passwordChangedAt: account.passwordChangedAt ?? undefined,
    profile: {
      companyName: stored?.companyName ?? '',
      vatNumber: stored?.vatNumber ?? '',
      line1: stored?.line1 ?? '',
      line2: stored?.line2 ?? '',
      postalCode: stored?.postalCode ?? '',
      city: stored?.city ?? '',
      country: stored?.country ?? '',
    },
    ...options,
  });
}

// -- personal data --

/**
 * The current session, read from the cookie: needed to tell "erase my other sessions" from
 * "sign me out".
 */
function currentSessionHash(req: Request): string | undefined {
  const secret = readCookie(req, COOKIE_NAME);
  return secret ? hashSecret(secret) : undefined;
}

consoleRouter.get('/data', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locale = localeOf(req);
    const tr = t(locale);
    const erased = String(req.query.erased ?? '');
    const blocked = String(req.query.blocked ?? '');
    const count = Number.parseInt(String(req.query.count ?? ''), 10);

    res.type('html').send(
      await renderPersonalData(req, {
        notice:
          isErasable(erased) && Number.isFinite(count)
            ? tr('data.eraseDone', { section: tr(`data.${erased}Title`), count })
            : undefined,
        error: blocked === 'billing' ? tr('data.eraseBlockedPaid') : undefined,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Portability (GDPR Article 20), as JSON and as text. Both render the same inventory, see
 * `services/personalData.ts`.
 *
 * `attachment` with a dated filename, and `no-store` to keep personal data out of browser caches.
 */
consoleRouter.get(
  ['/data/export.json', '/data/export.txt'],
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const json = req.path.endsWith('.json');
      const record = await collectPersonalData(req.userId!, currentSessionHash(req));
      const filename = `vatlas-personal-data-${record.generatedAt.slice(0, 10)}.${json ? 'json' : 'txt'}`;

      res
        .type(json ? 'application/json' : 'text/plain')
        .set('Content-Disposition', `attachment; filename="${filename}"`)
        .set('Cache-Control', 'no-store')
        .send(json ? toJsonExport(record) : toTextExport(record));
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Erases one category (GDPR Article 17) without closing the account.
 *
 * The section is checked against `ERASABLE` first. Other categories are needed by a counter, an
 * invoice or the current session, and the page says why.
 */
consoleRouter.post(
  '/data/erase',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const section = String(req.body?.section ?? '');
      if (!isErasable(section)) {
        res.redirect('/data');
        return;
      }

      const result = await eraseSection(req.userId!, section, { keepSessionHash: currentSessionHash(req) });
      if (!result.ok) {
        res.redirect(`/data?blocked=${encodeURIComponent(section)}`);
        return;
      }

      consoleLogger.info(
        { userId: req.userId!.toString(), section, deleted: result.deleted },
        'personal data erased on request',
      );
      res.redirect(`/data?erased=${encodeURIComponent(section)}&count=${result.deleted}`);
    } catch (error) {
      next(error);
    }
  },
);

async function renderPersonalData(req: Request, options: { notice?: string; error?: string }) {
  const userId = req.userId!;
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, locale: true, stripeCustomerId: true },
  });

  return personalDataPage({
    emailVerified: req.emailVerified,
    locale: isLocale(account.locale) ? account.locale : DEFAULT_LOCALE,
    email: account.email,
    stripeReady: isStripeConfigured(),
    hasBillingAccount: account.stripeCustomerId !== null,
    record: await collectPersonalData(userId, currentSessionHash(req)),
    ...options,
  });
}

// -- billing --

/** VAT autofill lookups allowed per IP, and the window. */
const VAT_LOOKUP_THROTTLE_MAX = 15;
const VAT_LOOKUP_THROTTLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Same count-in-window logic as `createEmailToken`'s throttle. No session exists yet when the
 * billing form autofills, so the IP is the key.
 */
async function checkVatLookupThrottle(ip: string | undefined): Promise<boolean> {
  const prisma = getPrisma();
  const key = ip?.slice(0, 45) ?? 'unknown';
  const recent = await prisma.consoleVatLookup.count({
    where: { ip: key, createdAt: { gte: new Date(Date.now() - VAT_LOOKUP_THROTTLE_WINDOW_MS) } },
  });
  if (recent >= VAT_LOOKUP_THROTTLE_MAX) return false;
  await prisma.consoleVatLookup.create({ data: { ip: key } });
  return true;
}

/**
 * Unauthenticated: it runs before the billing profile exists. Calls `lookupVat` in process, without
 * key or quota, protected by the throttle above.
 */
consoleRouter.get('/billing/vat-lookup/:vatNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allowed = await checkVatLookupThrottle(req.ip);
    if (!allowed) {
      res.status(429).json({ error: { code: 'RATE_LIMITED' } });
      return;
    }

    let outcome;
    try {
      outcome = await lookupVat(String(req.params.vatNumber ?? ''));
    } catch (error) {
      // An invalid number and an unknown one have the same outcome: fill the form by hand.
      if (error instanceof InvalidVatError) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } });
        return;
      }
      throw error;
    }
    if (outcome.status !== 'found') {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return;
    }

    const { statement, vat } = outcome;
    res.json({
      data: {
        companyName: statement.name ?? '',
        line1: statement.addressLine1 ?? '',
        line2: statement.addressLine2 ?? '',
        postalCode: statement.postalCode ?? '',
        city: statement.city ?? '',
        country: statement.addressCountry ?? vat.countryCode,
      },
    });
  } catch (error) {
    next(error);
  }
});

consoleRouter.get('/billing', requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.type('html').send(await renderBilling(req, { saved: req.query.saved !== undefined }));
  } catch (error) {
    next(error);
  }
});

consoleRouter.post('/billing', requireSession, sameOrigin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const body = req.body ?? {};
    const profile = {
      companyName: trim(body.companyName, 255),
      vatNumber: trim(body.vatNumber, 20) || null,
      line1: trim(body.line1, 255),
      line2: trim(body.line2, 255) || null,
      postalCode: trim(body.postalCode, 16),
      city: trim(body.city, 128),
      country: trim(body.country, 2).toUpperCase(),
    };

    await getPrisma().billingProfile.upsert({
      where: { userId },
      create: { userId, ...profile },
      update: profile,
    });

    // The form exists on two pages. One of two constants, never the submitted value, to avoid an open
    // redirect.
    res.redirect(body.from === 'account' ? '/account?saved' : '/billing?saved');
  } catch (error) {
    next(error);
  }
});

async function renderBilling(req: Request, options: { saved?: boolean; error?: string }) {
  const userId = req.userId!;
  const account = await getPrisma().account.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      plan: true,
      locale: true,
      billingProfile: true,
      currentPeriodEnd: true,
      cancelAt: true,
      stripeCustomerId: true,
    },
  });
  const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
  const stored = account.billingProfile;
  const monitorsUsed = await countMonitors(userId);

  return billingPage({
    emailVerified: req.emailVerified,
    locale,
    email: account.email,
    monitorsUsed,
    monitorsLimit: monitorLimitFor(account.plan),
    plan: account.plan,
    quota: quotaForPlan(account.plan),
    stripeReady: isStripeConfigured(),
    hasBillingAccount: account.stripeCustomerId !== null,
    // Only while still paid. Once on the free plan the date is in the past.
    cancelAt: account.plan === 'pro' ? (account.cancelAt ?? undefined) : undefined,
    currentPeriodEnd: account.currentPeriodEnd ?? undefined,
    profile: {
      companyName: stored?.companyName ?? '',
      vatNumber: stored?.vatNumber ?? '',
      line1: stored?.line1 ?? '',
      line2: stored?.line2 ?? '',
      postalCode: stored?.postalCode ?? '',
      city: stored?.city ?? '',
      country: stored?.country ?? '',
    },
    ...options,
  });
}

consoleRouter.post(
  '/billing/checkout',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const account = await getPrisma().account.findUniqueOrThrow({
        where: { id: userId },
        select: { locale: true, billingProfile: { select: { userId: true } } },
      });
      const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;

      // Stripe Tax needs an address to pick the VAT rate, and the invoice needs one to be compliant.
      if (!account.billingProfile) {
        res.type('html').send(await renderBilling(req, { error: t(locale)('billing.required') }));
        return;
      }

      const outcome = await createCheckoutUrl(userId, locale);
      if ('error' in outcome) {
        res.type('html').send(await renderBilling(req, { error: t(locale)('billing.unavailable') }));
        return;
      }
      res.redirect(303, outcome.url);
    } catch (error) {
      // Stripe being unreachable or misconfigured is a page error, not a console crash. A generic 500
      // would leave the visitor unsure whether they were charged.
      await renderBillingError(req, res, error, next);
    }
  },
);

consoleRouter.post(
  '/billing/portal',
  requireSession,
  sameOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await getPrisma().account.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { locale: true },
      });
      const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
      const outcome = await createPortalUrl(req.userId!, locale);
      if ('error' in outcome) {
        // Two different cases: Stripe not configured, or an account that never subscribed.
        const message =
          outcome.error === 'no-customer' ? t(locale)('billing.portalEmpty') : t(locale)('billing.unavailable');
        res.type('html').send(await renderBilling(req, { error: message }));
        return;
      }
      res.redirect(303, outcome.url);
    } catch (error) {
      await renderBillingError(req, res, error, next);
    }
  },
);

/**
 * Reports a payment provider failure on the billing page. The detail goes to the log, the visitor
 * is told nothing was charged.
 */
async function renderBillingError(req: Request, res: Response, error: unknown, next: NextFunction): Promise<void> {
  consoleLogger.error({ err: error, userId: req.userId?.toString() }, 'payment provider failed');
  try {
    const account = await getPrisma().account.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { locale: true },
    });
    const locale = isLocale(account.locale) ? account.locale : DEFAULT_LOCALE;
    res
      .status(502)
      .type('html')
      .send(await renderBilling(req, { error: t(locale)('billing.failed') }));
  } catch (renderError) {
    // Rendering the error page failed too: generic error.
    next(renderError);
  }
}

/** Mounted before any body parser: signature verification needs the raw bytes. */
export const stripeWebhookRouter: Router = Router();

stripeWebhookRouter.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    try {
      await handleWebhook(req.body as Buffer, req.get('stripe-signature'));
      res.json({ received: true });
    } catch (error) {
      // 400, not 500: Stripe retries 5xx, and a payload that fails verification never will pass.
      consoleLogger.warn({ err: error }, 'webhook rejected');
      res.status(400).json({ error: 'Webhook could not be processed' });
    }
  },
);

function trim(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}
