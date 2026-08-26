import { Router, type Request, type Response, type NextFunction } from 'express';
import { getPrisma } from '../db/prisma.js';
import { COUNTRIES, primarySourceOf, strategyOf } from './countries/registry.js';
import { lookupVat, type LookupOutcome } from './resolve.js';
import { lookupVatAll } from './resolveAll.js';
import {
  auditEntryFrom,
  allAuditEntryFrom,
  pageAudit,
  recordAudit,
  resolveCursor,
  type AuditRow,
} from '../services/audit.js';
import { ApiError } from './errors.js';
import { normalizeVatInput, parseVatNumber } from '../vat/parse.js';
import { countsAgainstQuota, requireSecretKey, requireSecretKeyUnmetered } from './auth.js';
import type { Preference } from './countries/pick.js';
import { proofOf, serialize, serializeAll, serializeHistory, toApiError } from './serialize.js';
import { createMonitor, deleteMonitor, getMonitor, listMonitors, monitorLimitFor } from '../services/monitors.js';
import {
  createAsyncLookup,
  deleteAsyncLookup,
  getAsyncLookup,
  listAsyncLookups,
  resolveAsyncCursor,
  type AsyncKind,
} from '../services/asyncLookups.js';
import { consume, peek } from '../services/usage.js';

export const router: Router = Router();

router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

/** The countries served and how. */
router.get('/v1/countries', (_req: Request, res: Response) => {
  res.json({
    data: COUNTRIES.map((country) => ({
      countryCode: country.code,
      name: country.name,
      source: primarySourceOf(country),
      strategy: strategyOf(country),
    })),
  });
});

/**
 * The plain lookup, metered behind `requireSecretKey`.
 *
 * `?prefer` says what to favour when sources disagree. `completeness` (default) picks the most
 * complete answer among every source of the country.
 *
 * `?prefer=proof` only accepts an answer with `meta.proof`. Storage and national registers are
 * skipped, so the answer comes from VIES or not at all. It still costs one unit.
 *
 * `?history` adds the answering source's history under `history`. Off by default since it costs a
 * second query.
 */
router.get('/v1/lookup/:vatNumber', requireSecretKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = { userId: req.secretKey?.userId, secretKeyId: req.secretKey?.keyId };
    refuseRetiredParams(req.query);
    const prefer = readPrefer(req.query.prefer);
    const history = readHistory(req.query.history, false);
    const outcome = await lookupVat(String(req.params.vatNumber ?? ''), caller, { prefer, history });

    // The envelope is built once, then sent and audited, so the audit trail stores exactly what the
    // caller received. Only 200, 404 and 503 get here: invalid numbers throw from `lookupVat`, and
    // unauthenticated calls never reach the handler.
    let failure: ApiError | null = null;
    let body: Record<string, unknown>;
    if (outcome.status === 'found') {
      body = serialize(outcome);
    } else {
      failure = toApiError(outcome, prefer);
      // A number reported as unregistered has a source, and therefore a history to return with the error.
      body = { ...failure.toBody(), ...historyBody(outcome) };
    }

    const entry = auditEntryFrom(outcome, body, failure?.status ?? 200, caller, { prefer });
    if (entry) recordAudit(entry);

    if (failure) throw failure;
    res.json(body);
  } catch (error) {
    next(error);
  }
});

/**
 * Every source's answer: `GET /v1/lookup-all/:vatNumber`.
 *
 * Unlike the lookup above, which stops at the first source that names a company, this asks every
 * register of the country and reports each one, with its date, including the failures.
 *
 * Each item has the lookup shape: `data` and `meta`, or `error` and `meta`.
 *
 * The status is 200 as soon as the number parses, even if every source failed. The results are in
 * `data.sources`, one entry per source that exists for this country and deployment.
 *
 * `?history=false` drops the `history` node and its query.
 *
 * Costs one unit.
 */
router.get('/v1/lookup-all/:vatNumber', requireSecretKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = { userId: req.secretKey?.userId, secretKeyId: req.secretKey?.keyId };
    refuseRetiredParams(req.query);
    const history = readHistory(req.query.history, true);
    const report = await lookupVatAll(String(req.params.vatNumber ?? ''), caller, { history });

    // Audited from the envelope about to be sent, like the lookup endpoint.
    const body = serializeAll(report);
    const entry = allAuditEntryFrom(report, body, caller);
    if (entry) recordAudit(entry);

    res.json(body);
  } catch (error) {
    next(error);
  }
});

/** Demo lookups allowed per IP, and the window. */
const DEMO_THROTTLE_MAX = 5;
const DEMO_THROTTLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Throttle state for one visitor: remaining budget, and when the oldest call leaves the window. */
type DemoBudget = { remaining: number; resetAt: number };

/**
 * Same count-in-window logic as the console's autofill throttle, in `rate_limit_site_lookup`. There
 * is no account here, so the IP is the key.
 *
 * Counting and recording are separate so a malformed number costs nothing. At most
 * `DEMO_THROTTLE_MAX` rows exist per IP, so they are read whole to know when the next slot frees up.
 */
async function demoBudget(ip: string): Promise<DemoBudget> {
  const since = new Date(Date.now() - DEMO_THROTTLE_WINDOW_MS);
  const spent = await getPrisma().siteVatLookup.findMany({
    where: { ip, createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: DEMO_THROTTLE_MAX,
  });

  // Sliding window: a call is allowed again as soon as the oldest one expires.
  const oldest = spent[0]?.createdAt.getTime() ?? Date.now();
  return {
    remaining: Math.max(0, DEMO_THROTTLE_MAX - spent.length),
    resetAt: Math.floor((oldest + DEMO_THROTTLE_WINDOW_MS) / 1000),
  };
}

/** Which of the three calls a demo request is. */
type DemoMode = 'single' | 'proof' | 'all';

/**
 * The demo behind the "try it" box, with the three calls the console offers: plain lookup, lookup
 * with `?prefer=proof`, and every source. Same `lookupVat` and `lookupVatAll`, same envelopes, no
 * key, no account, no quota. Five calls per IP per week, shared between the three.
 *
 * Not audited and not billed. The lookup still goes to `log_lookup` like every other one.
 */
function demoHandler(mode: DemoMode) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      refuseRetiredParams(req.query);
      const history = readHistory(req.query.history, mode === 'all');
      const ip = req.ip?.slice(0, 45) ?? 'unknown';

      // Parsed before the budget is read, so a typo costs nothing.
      const vatNumber = parseVatNumber(normalizeVatInput(String(req.params.vatNumber ?? ''))).formatted;

      const budget = await demoBudget(ip);
      setDemoHeaders(res, budget);
      if (budget.remaining < 1) {
        throw new ApiError(
          429,
          'DEMO_LIMIT_REACHED',
          `The public demo answers ${DEMO_THROTTLE_MAX} lookups per week, whichever call is made. ` +
            'Create a free account for a key and call the API directly.',
        );
      }

      // One row per call, counted by the sliding window.
      const spent = (await getPrisma().siteVatLookup.create({ data: { ip } })).id;
      setDemoHeaders(res, { ...budget, remaining: budget.remaining - 1 });

      /** Gives the call back and updates the headers. */
      const refund = async (): Promise<void> => {
        await getPrisma().siteVatLookup.delete({ where: { id: spent } });
        setDemoHeaders(res, budget);
      };

      // A lookup-all is a 200 as soon as the number parses, so there is nothing to refund. The two
      // single-answer modes follow the metered endpoint's rule.
      if (mode === 'all') {
        try {
          res.json(serializeAll(await lookupVatAll(vatNumber, {}, { history })));
        } catch (error) {
          await refund();
          throw error;
        }
        return;
      }

      let outcome;
      try {
        outcome = await lookupVat(vatNumber, {}, { prefer: mode === 'proof' ? 'proof' : 'completeness', history });
      } catch (error) {
        // Unexpected failure on our side: refund.
        await refund();
        throw error;
      }

      // Same billing rule as the metered endpoint, through the same function: an answer costs one, a 503
      // does not, and a malformed number never gets here.
      if (outcome.status !== 'found') {
        const failure = toApiError(outcome, mode === 'proof' ? 'proof' : 'completeness');
        if (!countsAgainstQuota(failure.status)) await refund();
        throw failure;
      }

      res.json(serialize(outcome));
    } catch (error) {
      next(error);
    }
  };
}

router.get('/v1/demo/lookup-all/:vatNumber', demoCors, demoHandler('all'));

/** One path for the two single-answer modes, told apart by `?prefer` like the metered endpoint. */
router.get('/v1/demo/lookup/:vatNumber', demoCors, (req: Request, res: Response, next: NextFunction) => {
  let prefer: Preference;
  try {
    refuseRetiredParams(req.query);
    prefer = readPrefer(req.query.prefer);
  } catch (error) {
    next(error);
    return;
  }
  void demoHandler(prefer === 'proof' ? 'proof' : 'single')(req, res, next);
});

/**
 * The only endpoint meant to be called from another origin. `*` rather than the site's origin: the
 * answer is public, with no cookie and no key, and an allowlist would stop nothing (`curl` ignores
 * it). The throttle is the protection.
 */
function demoCors(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Lets the page read the remaining count.
  res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  next();
}

/** Same rate limit headers as the metered endpoint. */
function setDemoHeaders(res: Response, budget: DemoBudget): void {
  res.setHeader('X-RateLimit-Limit', String(DEMO_THROTTLE_MAX));
  res.setHeader('X-RateLimit-Remaining', String(budget.remaining));
  res.setHeader('X-RateLimit-Reset', String(budget.resetAt));
}

/** Default and maximum page size. */
const AUDIT_DEFAULT_LIMIT = 25;
const AUDIT_MAX_LIMIT = 100;

/**
 * The account's audit trail over HTTP, the same rows the console shows.
 *
 * Authenticated with the secret key, not metered.
 *
 * `?vatNumber=` narrows to one number, otherwise the most recent calls are returned. Paginated by
 * keyset (`meta.nextBefore` goes back as `?before=`) along the `(user_id, fetched_at)` index.
 *
 * What it holds depends on the plan. Retention is applied by the retention job only.
 */
router.get('/v1/audit', requireSecretKeyUnmetered, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.secretKey!.userId;

    // Normalized like the lookup. An invalid number is a 400 `INVALID_VAT_FORMAT`, thrown by
    // `parseVatNumber`.
    const raw = String(req.query.vatNumber ?? '').trim();
    const vatNumber = raw ? parseVatNumber(normalizeVatInput(raw)).formatted : undefined;

    // The cursor is a `publicId`, the query uses the internal id. Resolving it within the account is
    // also the access check: another account's cursor finds nothing.
    const cursor = readCursor(req.query.before);
    const before = cursor === undefined ? undefined : await resolveCursor(userId, cursor);
    if (cursor !== undefined && before === null) {
      throw new ApiError(400, 'INVALID_QUERY', '"before" is not the id of a row in your audit trail.');
    }

    const page = await pageAudit(userId, {
      ...(vatNumber ? { vatNumber } : {}),
      ...(before ? { before } : {}),
      limit: readLimit(req.query.limit),
    });

    res.json({
      data: page.rows.map(serializeAuditRow),
      meta: {
        count: page.rows.length,
        // Null rather than absent, so a client can loop on it.
        nextBefore: page.nextBefore ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/** Exposed as `publicId`, never `id`: the internal auto-increment id is never sent. */
function serializeAuditRow(row: AuditRow): Record<string, unknown> {
  return {
    publicId: row.publicId,
    vatNumber: row.vatNumber,
    kind: row.kind,
    fetchedAt: row.fetchedAt,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    companyName: row.companyName,
    source: row.source,
    // A DATE column: a day, without time or zone.
    sourceDate: row.sourceDate === null ? null : row.sourceDate.toISOString().slice(0, 10),
    sources: row.sources,
    ...proofOf(row.proof ?? undefined),
    response: row.response,
  };
}

/** Rejected rather than clamped. */
function readLimit(value: unknown): number {
  const raw = String(value ?? '');
  if (raw === '') return AUDIT_DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > AUDIT_MAX_LIMIT) {
    throw new ApiError(400, 'INVALID_QUERY', `"limit" must be a whole number between 1 and ${AUDIT_MAX_LIMIT}.`);
  }
  return Number(raw);
}

/** A malformed cursor is a bug in the caller, not a request for page one. */
function readCursor(value: unknown): string | undefined {
  const raw = String(value ?? '');
  if (raw === '') return undefined;
  if (!PUBLIC_ID.test(raw)) {
    throw new ApiError(400, 'INVALID_QUERY', '"before" must be the id of a row from a previous page.');
  }
  return raw;
}

/** Shape only. Whether it belongs to the account is checked by `resolveCursor`. */
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?prefer`: `completeness` (default) or `proof`.
 *
 * Anything else is a 400, including the old `?requireProof`. Silently answering without a proof
 * to a caller who asked for one is a failure they could not see.
 */
function readPrefer(value: unknown): Preference {
  if (value === undefined || value === '') return 'completeness';
  const raw = String(value);
  if (raw === 'completeness' || raw === 'proof') return raw;
  throw new ApiError(400, 'INVALID_QUERY', '"prefer" takes "completeness" or "proof".');
}

/**
 * `?requireProof` is refused rather than ignored. Unknown parameters are normally ignored, but
 * this one used to ask for a proof, and ignoring it would silently return an answer without one.
 */
function refuseRetiredParams(query: Request['query']): void {
  if (query.requireProof === undefined) return;
  throw new ApiError(
    400,
    'INVALID_QUERY',
    '"requireProof" is gone: write "?prefer=proof" for an answer that carries a proof, ' +
      'or "?prefer=completeness" - the default - for the fullest answer.',
  );
}

/**
 * `?history` as a flag: present means yes, `=false` means no. `=true` and `=false` are accepted
 * for clients that build query strings from booleans.
 *
 * The default is up to the caller: off for the single lookup, on for `/v1/lookup-all`.
 */
function readHistory(value: unknown, byDefault: boolean): boolean {
  // Express gives `undefined` when the parameter is missing and `''` for `?history`, which means yes.
  if (value === undefined) return byDefault;
  const raw = String(value);
  if (raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ApiError(400, 'INVALID_QUERY', '"history" takes no value - write "?history" - or "true" or "false".');
}

/** The `history` node of a miss that has a source (`not-registered`). */
function historyBody(outcome: LookupOutcome): Record<string, unknown> {
  return outcome.status === 'not-registered' && outcome.history ? { history: serializeHistory(outcome.history) } : {};
}

// -- monitors --

/**
 * The companies this account follows.
 *
 * Not metered. The plan limit is returned in `meta` on every listing.
 */
router.get('/v1/monitor', requireSecretKeyUnmetered, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.secretKey!;
    const rows = await listMonitors(key.userId);
    res.json({
      data: rows.map(serializeMonitor),
      meta: { count: rows.length, limit: monitorLimitFor(key.plan) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Follows a company. `url` is optional and defaults to the account's callback URL. Without
 * either, the request is a 400.
 */
router.post(
  '/v1/monitor/:vatNumber',
  requireSecretKeyUnmetered,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = readObject(req.body);
      const monitor = await createMonitor(req.secretKey!.userId, req.secretKey!.plan, {
        vatNumber: String(req.params.vatNumber ?? ''),
        url: body.url === undefined || body.url === null ? null : readString(body.url, 'url'),
      });
      res.status(201).json({
        data: serializeMonitor({
          ...monitor,
          lastSource: null,
          lastPayload: null,
          lastCheckedAt: null,
          lastChangedAt: null,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

/** One monitor, with its deliveries. */
router.get(
  '/v1/monitor/:vatNumber',
  requireSecretKeyUnmetered,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const monitor = await getMonitor(req.secretKey!.userId, String(req.params.vatNumber ?? ''));
      if (!monitor) throw notFound('monitor');
      res.json({
        data: {
          ...serializeMonitor(monitor),
          deliveries: monitor.deliveries.map(serializeDelivery),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Stops following. 204, and the deliveries are deleted too. */
router.delete(
  '/v1/monitor/:vatNumber',
  requireSecretKeyUnmetered,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gone = await deleteMonitor(req.secretKey!.userId, String(req.params.vatNumber ?? ''));
      if (!gone) throw notFound('monitor');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

// -- async lookups --

/** Default and maximum page size. */
const LOOKUP_DEFAULT_LIMIT = 25;
const LOOKUP_MAX_LIMIT = 100;

/**
 * The account's async lookups, newest first. `?status=pending|success|failed` filters,
 * `?before=` paginates over `publicId` like `/v1/audit`.
 *
 * Not metered.
 */
router.get('/v1/lookup-async', requireSecretKeyUnmetered, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.secretKey!.userId;

    const cursor = readCursor(req.query.before);
    const before = cursor === undefined ? undefined : await resolveAsyncCursor(userId, cursor);
    if (cursor !== undefined && before === null) {
      throw new ApiError(400, 'INVALID_QUERY', '"before" is not the id of one of your asynchronous lookups.');
    }

    const limit = readLookupLimit(req.query.limit);
    const rows = await listAsyncLookups(userId, {
      ...(readStatus(req.query.status) ? { status: readStatus(req.query.status)! } : {}),
      ...(before ? { before } : {}),
      // Fetch one more than asked to know whether there is a next page.
      limit: limit + 1,
    });

    const page = rows.slice(0, limit);
    res.json({
      data: page.map(serializeAsyncLookup),
      meta: {
        count: page.length,
        nextBefore: rows.length > limit ? (page[page.length - 1]?.publicId ?? null) : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Queues a lookup that retries until a source answers. 202, the answer is posted to the callback
 * URL and can be read at `GET /v1/lookup-async/id/:publicId`.
 *
 * `/v1/lookup-async` for one answer, `/v1/lookup-async-all` for every source, like the synchronous
 * pair. `?prefer` works the same way. The optional body is `{"url": "..."}`. No `?history`: the
 * lookup-all answer already includes it.
 *
 * Costs one unit at creation, so an account cannot queue more than its quota. After
 * `ASYNC_LOOKUP_MAX_DAYS` without an answer the unit is refunded.
 *
 * A malformed number is rejected before charging.
 */
function queueAsyncLookup(kind: AsyncKind | 'from-query') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.secretKey!;
      refuseRetiredParams(req.query);
      const body = readObject(req.body);
      const wanted: AsyncKind =
        kind === 'from-query' ? (readPrefer(req.query.prefer) === 'proof' ? 'proof' : 'single') : kind;

      // Quota is checked and charged here rather than by the metering guard, since this endpoint bills
      // for work not done yet.
      const quota = await peek(key.userId, key.plan);
      if (quota.exceeded) {
        throw new ApiError(
          429,
          'QUOTA_EXCEEDED',
          `The monthly quota of ${quota.limit} requests for this account is spent. ` +
            'It renews at the start of the next month.',
          { limit: quota.limit, resetAt: new Date(quota.resetAt * 1000).toISOString() },
        );
      }

      const lookup = await createAsyncLookup(key.userId, {
        vatNumber: String(req.params.vatNumber ?? ''),
        kind: wanted,
        url: body.url === undefined || body.url === null ? null : readString(body.url, 'url'),
      });

      // Charge after the row exists, so there is always a row to refund against.
      const spent = consume(key.userId, 1) ?? quota;
      res.setHeader('X-RateLimit-Limit', String(spent.limit));
      res.setHeader('X-RateLimit-Remaining', String(spent.remaining));
      res.setHeader('X-RateLimit-Reset', String(spent.resetAt));

      res.status(202).json({ data: serializeAsyncLookup(lookup) });
    } catch (error) {
      next(error);
    }
  };
}

// Two paths, mirroring the synchronous pair.
router.post('/v1/lookup-async-all/:vatNumber', requireSecretKeyUnmetered, queueAsyncLookup('all'));
router.post('/v1/lookup-async/:vatNumber', requireSecretKeyUnmetered, queueAsyncLookup('from-query'));

/** One lookup with its attempts, deliveries and answer. */
router.get(
  '/v1/lookup-async/id/:publicId',
  requireSecretKeyUnmetered,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lookup = await getAsyncLookup(req.secretKey!.userId, String(req.params.publicId ?? ''));
      if (!lookup) throw notFound('asynchronous lookup');
      res.json({
        data: {
          ...serializeAsyncLookup(lookup),
          response: lookup.response ?? null,
          attempts: lookup.attemptLog.map((row) => ({
            attemptedAt: row.attemptedAt,
            outcome: row.outcome,
            httpStatus: row.httpStatus,
            errorCode: row.errorCode,
            fault: row.fault,
            durationMs: row.durationMs,
          })),
          deliveries: lookup.deliveries.map(serializeDelivery),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Cancels one. No refund, otherwise create-then-cancel would be free. */
router.delete(
  '/v1/lookup-async/id/:publicId',
  requireSecretKeyUnmetered,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gone = await deleteAsyncLookup(req.secretKey!.userId, String(req.params.publicId ?? ''));
      if (!gone) throw notFound('asynchronous lookup');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

/** Same 404 for a missing row and another account's row, so ids cannot be probed. */
function notFound(what: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', `No ${what} of yours has that id.`);
}

/** A monitor on the wire. `url` is null when it uses the account default. */
function serializeMonitor(row: {
  publicId: string;
  vatNumber: string;
  url: string | null;
  lastSource: string | null;
  lastPayload: unknown;
  lastCheckedAt: Date | null;
  lastChangedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    publicId: row.publicId,
    vatNumber: row.vatNumber,
    url: row.url,
    createdAt: row.createdAt,
    lastCheckedAt: row.lastCheckedAt,
    lastChangedAt: row.lastChangedAt,
    lastSource: row.lastSource,
    /** The last state sent to the account, in the lookup envelope. Null before the first check. */
    last: row.lastPayload ?? null,
  };
}

function serializeAsyncLookup(row: {
  publicId: string;
  vatNumber: string;
  kind: string;
  url: string | null;
  status: string;
  retryAfter: Date;
  expiresAt: Date;
  createdAt: Date;
  attempts?: number;
  completedAt?: Date | null;
}): Record<string, unknown> {
  return {
    publicId: row.publicId,
    vatNumber: row.vatNumber,
    kind: row.kind,
    url: row.url,
    status: row.status,
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.status === 'pending' ? row.retryAfter : null,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
  };
}

/** One delivery attempt. */
function serializeDelivery(row: {
  publicId: string;
  event: string;
  url: string;
  attempt: number;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  sentAt: Date;
}): Record<string, unknown> {
  return {
    publicId: row.publicId,
    event: row.event,
    url: row.url,
    attempt: row.attempt,
    httpStatus: row.httpStatus,
    error: row.error,
    durationMs: row.durationMs,
    sentAt: row.sentAt,
  };
}

/** A JSON object body, or a 400 that names the problem. */
function readObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_BODY', 'The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'INVALID_BODY', `"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

function readStatus(value: unknown): 'pending' | 'success' | 'failed' | undefined {
  const raw = String(value ?? '');
  if (raw === '') return undefined;
  if (raw === 'pending' || raw === 'success' || raw === 'failed') return raw;
  throw new ApiError(400, 'INVALID_QUERY', '"status" must be one of pending, success or failed.');
}

/** Rejected rather than clamped. */
function readLookupLimit(value: unknown): number {
  const raw = String(value ?? '');
  if (raw === '') return LOOKUP_DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > LOOKUP_MAX_LIMIT) {
    throw new ApiError(400, 'INVALID_QUERY', `"limit" must be a whole number between 1 and ${LOOKUP_MAX_LIMIT}.`);
  }
  return Number(raw);
}

// The wire format lives in `serialize.ts` so the cron processes can use it without importing the
// router. Re-exported here for existing callers.
export { serialize, serializeAll, toApiError };
