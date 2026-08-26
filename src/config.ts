import 'dotenv/config';
import { z } from 'zod';
import { parseVatNumber } from './vat/parse.js';

const booleanFromEnv = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

/**
 * An optional setting, undefined when blank. zod returns `FOO=` as `''`, which is not nullish and
 * would survive a `??` as a real value.
 */
const optionalFromEnv = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));

/**
 * An optional Stripe id, rejected at startup when present but malformed. Stripe's prefixes
 * (`sk_test_`, `whsec_`, `price_`) are stable, so a value without one cannot work, and failing here
 * names the variable.
 */
const stripeId = (pattern: RegExp, expected: string) =>
  optionalFromEnv.refine((value) => value === undefined || pattern.test(value), {
    message: `does not look like ${expected}`,
  });

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * Number of reverse proxies to trust for `X-Forwarded-For` (Express `trust proxy`). 0 in
     * development. In production it must match the real hop count: trusting one too many lets clients
     * spoof `req.ip`, which the per-IP limits rely on.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
    LOG_LEVEL: z.string().default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

    // Read by the prisma CLI too.
    DATABASE_URL: z.string().min(1),

    VIES_ENABLED: booleanFromEnv.default(true),
    /**
     * The VAT number sent with every VIES call. It turns `checkVat` into `checkVatApprox`, the only call
     * that returns a consultation number. Required when VIES is enabled.
     */
    VIES_REQUESTER_VAT: optionalFromEnv,
    /**
     * How old a live source's latest statement may be before it is asked again. Bulk sources are not
     * affected.
     */
    LIVE_MAX_AGE_DAYS: z.coerce.number().int().positive().default(7),
    VIES_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** How long a member state is skipped after reporting itself unavailable. */
    VIES_MS_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
    /** Time budget for one lookup, all sources included. */
    LOOKUP_DEADLINE_MS: z.coerce.number().int().positive().default(20_000),

    DOWNLOAD_DIR: z.string().default('./.cache'),

    // The developer console, a second process.
    CONSOLE_PORT: z.coerce.number().int().positive().default(3001),
    CONSOLE_BASE_URL: z.string().default('http://localhost:3001'),
    // The public API URL, only used for links and sample commands.
    API_BASE_URL: z.string().default('http://localhost:3000'),
    // The website, linked from the console and emails.
    SITE_URL: z.string().default('https://vatlas.dev'),

    // Support contacts, read by the console and by the site build.
    CONTACT_EMAIL: z.string().default('contact@vatlas.dev'),
    DISCORD_INVITE_URL: z.string().default('https://discord.gg/R28nneW5xU'),
    // The paid support server, only shown to Pro accounts on the console's contact page.
    DISCORD_PRO_INVITE_URL: z.string().default('https://discord.gg/SpjVdpNePr'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Mixed into every token hash, so a stolen database dump holds no usable key. Changing it
    // invalidates every key, session and email link.
    TOKEN_PEPPER: z.string().default('development-pepper'),

    // Monthly quotas per account.
    PLAN_FREE_QUOTA: z.coerce.number().int().positive().default(100),
    PLAN_PRO_QUOTA: z.coerce.number().int().positive().default(5_000),
    /**
     * Audit trail retention per plan. In the config because the pricing page and privacy policy quote
     * these figures and the site build reads the same `.env`.
     */
    AUDIT_FREE_KEEP: z.coerce.number().int().positive().default(3),
    AUDIT_PRO_DAYS: z.coerce.number().int().positive().default(730),

    /**
     * How many companies each plan may monitor. Monitors are not metered. The site build reads these
     * too.
     */
    MONITOR_FREE_MAX: z.coerce.number().int().positive().default(3),
    MONITOR_PRO_MAX: z.coerce.number().int().positive().default(100),

    /** Timeout of one callback delivery attempt. */
    CALLBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** Retries after a failed delivery. Every attempt is recorded and shown in the console. */
    CALLBACK_RETRIES: z.coerce.number().int().nonnegative().default(3),
    /**
     * Whether a callback may target a private address (localhost, RFC 1918, link-local).
     *
     * Must be false in production, otherwise customers can make the server call internal services.
     * True locally to test against a receiver on localhost.
     */
    CALLBACK_ALLOW_PRIVATE_URLS: booleanFromEnv.default(false),

    /** How long an async lookup is retried before it fails. */
    ASYNC_LOOKUP_MAX_DAYS: z.coerce.number().int().positive().default(7),
    /** Maximum delay between retries. It doubles from ten minutes up to this. */
    ASYNC_LOOKUP_MAX_BACKOFF_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),

    // Mailpit locally (see docker-compose.yml), a real relay in production.
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: booleanFromEnv.default(false),
    // Local relays may offer STARTTLS with a self-signed certificate. nodemailer uses it even when
    // SMTP_SECURE is false, and Node rejects the certificate unless this is set to false.
    SMTP_TLS_REJECT_UNAUTHORIZED: booleanFromEnv.default(true),
    SMTP_USER: optionalFromEnv,
    SMTP_PASSWORD: optionalFromEnv,
    EMAIL_FROM: z.string().default('Vatlas <noreply@vatlas.dev>'),

    // Optional: without them the console hides the upgrade button. A present but malformed value is
    // rejected at startup.
    STRIPE_SECRET_KEY: stripeId(/^(sk|rk)_(test|live)_/, 'a secret key, sk_test_… or sk_live_…'),
    STRIPE_WEBHOOK_SECRET: stripeId(/^whsec_/, 'a webhook signing secret, whsec_…'),
    STRIPE_PRICE_PRO: stripeId(/^price_/, 'a price id, price_…'),

    // Registers that need a free account. All optional: without credentials the source is skipped and
    // the lookup falls back to VIES.
    KBO_USER: optionalFromEnv,
    KBO_PASSWORD: optionalFromEnv,
    CVR_USER: optionalFromEnv,
    CVR_PASSWORD: optionalFromEnv,
    SUDREG_CLIENT_ID: optionalFromEnv,
    SUDREG_CLIENT_SECRET: optionalFromEnv,
    AADE_USER: optionalFromEnv,
    AADE_PASSWORD: optionalFromEnv,
    GEMI_API_KEY: optionalFromEnv,
    NZBN_API_KEY: optionalFromEnv,
  })
  .superRefine((env, ctx) => {
    // Checked at startup: a missing or malformed requester makes every VIES call fail with
    // `INVALID_REQUESTER_INFO`.
    if (!env.VIES_ENABLED) return;
    if (env.VIES_REQUESTER_VAT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['VIES_REQUESTER_VAT'],
        message: 'is required when VIES_ENABLED=true - VIES issues a consultation number only to a named requester',
      });
      return;
    }
    try {
      parseVatNumber(env.VIES_REQUESTER_VAT);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['VIES_REQUESTER_VAT'],
        message: `is not a valid VAT number (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  });

/** Splits the configured VAT number into the two SOAP fields. Already validated by `superRefine`. */
function requesterFrom(value: string): { countryCode: string; vatNumber: string } {
  const { countryCode, nationalNumber } = parseVatNumber(value);
  return { countryCode, vatNumber: nationalNumber };
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  logLevel: env.LOG_LEVEL,
  logFormat: env.LOG_FORMAT,
  mysql: {
    url: env.DATABASE_URL,
  },
  vies: {
    enabled: env.VIES_ENABLED,
    /**
     * Parsed once here, in the shape `lookupVies` takes. It also keeps `checkVatRaw` safe: both parts
     * are interpolated raw in the SOAP envelope, and `parseVatNumber` only returns alphanumerics.
     */
    requester: env.VIES_REQUESTER_VAT === undefined ? undefined : requesterFrom(env.VIES_REQUESTER_VAT),
    timeoutMs: env.VIES_TIMEOUT_MS,
    memberStateCooldownMs: env.VIES_MS_COOLDOWN_MS,
  },
  lookup: {
    deadlineMs: env.LOOKUP_DEADLINE_MS,
    /** How stale a live source's stored answer may be. */
    liveMaxAgeDays: env.LIVE_MAX_AGE_DAYS,
  },
  downloadDir: env.DOWNLOAD_DIR,
  console: {
    port: env.CONSOLE_PORT,
    baseUrl: env.CONSOLE_BASE_URL.replace(/\/$/, ''),
    sessionTtlDays: env.SESSION_TTL_DAYS,
  },
  apiBaseUrl: env.API_BASE_URL.replace(/\/$/, ''),
  siteUrl: env.SITE_URL.replace(/\/$/, ''),
  /** Support contacts: community server, paid server, and email. */
  contact: {
    email: env.CONTACT_EMAIL,
    discord: env.DISCORD_INVITE_URL,
    discordPro: env.DISCORD_PRO_INVITE_URL,
  },
  tokenPepper: env.TOKEN_PEPPER,
  /** Monthly quota per plan. */
  audit: {
    /** Audit rows kept on the free plan. */
    freeKeep: env.AUDIT_FREE_KEEP,
    /** Audit retention in days on the paid plan. */
    proDays: env.AUDIT_PRO_DAYS,
  },
  quotas: {
    free: env.PLAN_FREE_QUOTA,
    pro: env.PLAN_PRO_QUOTA,
  },
  /** Monitors allowed per plan. */
  monitors: {
    free: env.MONITOR_FREE_MAX,
    pro: env.MONITOR_PRO_MAX,
  },
  /** Callback delivery, used by monitors and async lookups. */
  callbacks: {
    timeoutMs: env.CALLBACK_TIMEOUT_MS,
    retries: env.CALLBACK_RETRIES,
    allowPrivateUrls: env.CALLBACK_ALLOW_PRIVATE_URLS,
  },
  asyncLookup: {
    maxDays: env.ASYNC_LOOKUP_MAX_DAYS,
    maxBackoffMs: env.ASYNC_LOOKUP_MAX_BACKOFF_MS,
  },
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.EMAIL_FROM,
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    pricePro: env.STRIPE_PRICE_PRO,
  },
  sources: {
    /** Belgium, KBO/BCE open data. */
    kbo: { user: env.KBO_USER, password: env.KBO_PASSWORD },
    /** Denmark, CVR system-to-system access. */
    cvr: { user: env.CVR_USER, password: env.CVR_PASSWORD },
    /** Croatia, Sudski registar open data. */
    sudreg: { clientId: env.SUDREG_CLIENT_ID, clientSecret: env.SUDREG_CLIENT_SECRET },
    /** Greece, AADE RgWsPublic2 (TAXISnet account). */
    aade: { user: env.AADE_USER, password: env.AADE_PASSWORD },
    /** Greece, GEMI open data. */
    gemi: { apiKey: env.GEMI_API_KEY },
    /** New Zealand, NZBN API. */
    nzbn: { apiKey: env.NZBN_API_KEY },
  },
} as const;

export type Config = typeof config;
