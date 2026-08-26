# Monitors, async lookups and callbacks

## Monitors

A monitor follows one company and sends a callback when a register changes its name, status or
address.

```
GET    /v1/monitor              -> followed companies, and meta.limit
POST   /v1/monitor/:vatNumber   -> follow one, optional body {"url": "https://..."}
GET    /v1/monitor/:vatNumber   -> one monitor, with its delivery attempts
DELETE /v1/monitor/:vatNumber
```

- Monitors are addressed by VAT number, since an account follows a company once.
- The body `url` is optional and defaults to `user.monitor_url`, set on the console's `/monitor`
  page. Without either, creation fails with `400 CALLBACK_URL_MISSING`.
- Monitors are not metered. Each plan has a limit (`MONITOR_FREE_MAX`, `MONITOR_PRO_MAX`), shown
  as `meta.limit` and enforced with `403 MONITOR_LIMIT_REACHED`. Following the same number twice
  is `409 MONITOR_EXISTS`.

`npm run monitors` runs once a night. For each monitor it calls `lookupVat`, like the API does,
and compares `payloadHash()` with `user_monitor.last_payload_hash`.

- The first check sends nothing. It only records the current state.
- A source that did not answer updates `last_checked_at` and keeps the hash.
- The new hash is stored even if the delivery failed, so the same change is not sent every night.

## Async lookups

When a source is down, an async lookup retries it for the caller.

```
POST   /v1/lookup-async/:vatNumber              -> 202, ?prefer=proof for a proof
POST   /v1/lookup-async-all/:vatNumber          -> 202, every source at once
GET    /v1/lookup-async?status=pending&limit=25&before=...
GET    /v1/lookup-async/id/:publicId            -> attempts, deliveries and answer
DELETE /v1/lookup-async/id/:publicId
```

- The delivered payload is exactly the envelope of the matching synchronous call.
- The optional body `{"url": "..."}` overrides `user.lookup_async_url`.
- `npm run lookups:async` runs every ten minutes. The first attempt happens on the next pass, then
  the delay doubles with +/- 50% jitter (10 min, 20, 40, ...) up to `ASYNC_LOOKUP_MAX_BACKOFF_MS`.
- Only `unavailable` results (including `PROOF_UNAVAILABLE`) are retried. A lookup-all counts as
  answered when at least one source has history or a successful call.
- It costs one unit at creation. After `ASYNC_LOOKUP_MAX_DAYS` without an answer, the lookup is
  marked `failed`, a `lookup.failed` event is sent and the unit is refunded. Deleting a lookup
  refunds nothing.

## Callbacks

Monitors and async lookups both `POST` JSON to a URL owned by the account. They have separate
default URLs and share one signing secret per account.

```
POST /hooks/vatlas
Content-Type: application/json
X-Vatlas-Event: company.changed
X-Vatlas-Delivery: f9b8936a-a499-489f-9099-6feb93f23bfb
X-Vatlas-Signature: t=1788855521,v1=6bc87dd5523b8a5b...
```

Events: `company.changed`, `monitor.test`, `lookup.completed`, `lookup.failed`.

The signature is `HMAC-SHA256(secret, "<t>.<body>")`, the same scheme as Stripe. Verify it against
the raw body, before parsing:

```js
const [t, v1] = header.split(',').map((part) => part.split('=')[1]);
const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');

// timingSafeEqual throws on buffers of different length, so check the length first.
const mine = Buffer.from(expected);
const theirs = Buffer.from(v1);
const ok = mine.length === theirs.length && timingSafeEqual(mine, theirs) && Date.now() / 1000 - Number(t) < 300;
```

The secret is shown on the console's `/monitor` page and can be rolled there. It is stored
encrypted, like the API keys.

Any `2xx` is a success. Other answers are retried `CALLBACK_RETRIES` times with a doubling
backoff. Every attempt, failed or not, is stored in `user_delivery`.

The console's "Send a test event" button sends a real signed `monitor.test` request with sample
data, so an integration can be tested without waiting for a real change.

### Private addresses

Keep `CALLBACK_ALLOW_PRIVATE_URLS=false` in production, otherwise callbacks can reach internal
services (cloud metadata on 169.254.169.254, admin panels...). Set it to `true` locally to test
against a receiver on localhost. `src/lib/ssrf.ts` resolves the host and checks the address before
connecting, which also covers DNS rebinding.
