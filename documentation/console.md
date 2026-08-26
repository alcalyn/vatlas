# Developer console

`npm run console:dev` serves the console on <http://localhost:3001>. It is a second Express
process sharing the config, the Prisma client and the database with the API.

| Page                | Content                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `/`                 | Plan, usage this month, twelve-month history, sample `curl`                 |
| `/lookup`           | Run a lookup with the account's own key (metered and audited like any call) |
| `/lookup-async`     | Async lookups, their default callback URL and the signing secret            |
| `/monitor`          | Monitors, their default callback URL, the signing secret and test events    |
| `/audits`           | Every answer the API gave the account, searchable by number                 |
| `/audits/:publicId` | One recorded answer and the rest of that number's history                   |
| `/keys`             | API keys, usage per key, key creation                                       |
| `/account`          | Company details, plan, subscription, accepted terms, account deletion       |
| `/data`             | Personal data inventory, exports and deletion per category                  |
| `/billing`          | Current plan and upgrade                                                    |
| `/contact`          | Support links                                                               |

## Sign-in

Accounts use an email and a password (scrypt, `src/services/passwords.ts`). Sign-up creates the
account, signs it in and shows its first key (`default`) right away. The email is verified
afterwards with a link, and a banner asks for it until then. Password resets go through
`/password/forgot`.

Sign-ups, reset requests and failed sign-ins are throttled per IP (`rate_limit_auth`). Six wrong
passwords within 15 minutes lock the account for the rest of the window.

In development, every email lands in Mailpit (<http://localhost:8025>).

## API keys

Each key is stored twice: as `sha256(secret + TOKEN_PEPPER)` for authentication, and encrypted
with AES-256-GCM so the console can display it. Changing `TOKEN_PEPPER` invalidates every key and
session.

The API caches key lookups for 60 seconds, so a revoked key stops working within a minute.

## Personal data

`/data` covers GDPR articles 15, 17 and 20. Both the page and the exports are built from
`collectPersonalData()` in `src/services/personalData.ts`, so they cannot disagree.

- Every table with a `user_id` must appear in the inventory. `test/personalData.test.ts` checks
  this against `prisma/schema.prisma`.
- `SECTION_TIER` sorts sections into `personal` (data about the account holder), `account`
  (contractual and technical data), `others` (data about looked-up companies), and `null`
  (exported but not shown).
- `pageSections()` filters what the page shows. The exports (JSON and text, always in English)
  include every section and field, up to `EXPORT_ROW_CAP` rows. They never include API keys or
  the signing secret.
- The purpose, legal basis and retention of each section are in `locales/*.json` under `data.*`.
  A missing string throws at render. Keep them in sync with `site/src/privacy/*/index.html`.
- `ERASABLE` lists the categories that can be deleted on their own. Deleting the whole account is
  on `/account`.

## Plans and quota

Free and Pro call the same endpoints and get the same fields. They differ by monthly quota
(`PLAN_FREE_QUOTA`, `PLAN_PRO_QUOTA`), audit retention (`AUDIT_FREE_KEEP`, `AUDIT_PRO_DAYS`) and
monitor limit (`MONITOR_FREE_MAX`, `MONITOR_PRO_MAX`). See [api.md](api.md#billing) for what is
billed.

## Payments

Stripe is optional. `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO` and `STRIPE_WEBHOOK_SECRET` are
required together. If one is missing, the upgrade button is hidden and the console logs which one
at startup.

The webhook endpoint is `POST /stripe/webhook` on the console, not the API. Select these events
in Stripe (others are recorded and ignored):

| Event                           | Effect                                               |
| ------------------------------- | ---------------------------------------------------- |
| `customer.subscription.created` | Grants the paid plan                                 |
| `customer.subscription.updated` | Status changes and portal cancellation (`cancel_at`) |
| `customer.subscription.deleted` | Back to the free plan                                |

Set the endpoint API version to `2026-07-29.dahlia` (the version pinned by `stripe@22`). Versions
before `2025-03-31.basil` put `current_period_end` on the subscription instead of its items, and
the billing page loses its dates.

Cancelling from the Customer Portal keeps the subscription `active` until the end of the period.
Stripe only sets `cancel_at`, stored in `user.cancel_at`.

In development, forward webhooks with `stripe listen --forward-to localhost:3001/stripe/webhook`.
`npm run stripe:webhook` posts a properly signed event to the real endpoint:

```bash
npm run stripe:webhook                  # grant the paid plan
npm run stripe:webhook -- --cancel      # cancel at period end
npm run stripe:webhook -- --cancel-now  # end now
npm run stripe:webhook -- --sync        # replay the real subscription from Stripe
npm run stripe:webhook -- --status past_due
```

`--sync` needs `STRIPE_SECRET_KEY` and an interactive terminal.
