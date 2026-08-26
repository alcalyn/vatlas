# Configuration

Everything is read from `.env` at the repository root, by the API, the console, the CLIs and the
site build. `.env.example` lists every variable with a comment, and `src/config.ts` validates them
at startup.

## General

| Variable           | Default    | Description                                                                |
| ------------------ | ---------- | -------------------------------------------------------------------------- |
| `PORT`             | 3000       | API port                                                                   |
| `CONSOLE_PORT`     | 3001       | Console port                                                               |
| `TRUST_PROXY_HOPS` | 0          | Number of reverse proxies in front of the apps, used to read the client IP |
| `DATABASE_URL`     |            | MySQL connection string                                                    |
| `DOWNLOAD_DIR`     | `./.cache` | Where bulk files are downloaded. Safe to empty.                            |
| `LOG_LEVEL`        | `info`     | `trace`, `debug`, `info`, `warn`, `error`, `fatal`                         |
| `LOG_FORMAT`       | `pretty`   | `pretty`, or `json` for a log aggregator                                   |

## Lookups

| Variable              | Default | Description                                                                                                                            |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `VIES_ENABLED`        | true    | Use VIES as a source                                                                                                                   |
| `VIES_REQUESTER_VAT`  |         | VAT number sent with every VIES call. Required when VIES is enabled, since VIES only gives a consultation number to a named requester. |
| `VIES_TIMEOUT_MS`     | 10000   | One VIES attempt                                                                                                                       |
| `VIES_MS_COOLDOWN_MS` | 60000   | How long a member state is skipped after reporting itself down                                                                         |
| `LIVE_MAX_AGE_DAYS`   | 7       | Age after which a live source's stored answer is refreshed. Does not apply to bulk sources.                                            |
| `LOOKUP_DEADLINE_MS`  | 20000   | Total time budget for one lookup, all sources included                                                                                 |

## Public URLs

Nothing hardcodes a hostname. These values are used for links, emails and sample commands, and
the site build reads them too.

| Variable                 | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `SITE_URL`               | The website, linked from the console and emails               |
| `API_BASE_URL`           | The API URL shown in docs and sample `curl` commands          |
| `CONSOLE_BASE_URL`       | Target of verification and reset links, and of "Log in"       |
| `CONTACT_EMAIL`          | Contact address shown on the site and the console             |
| `DISCORD_INVITE_URL`     | Community Discord server                                      |
| `DISCORD_PRO_INVITE_URL` | Private support server, shown only to Pro accounts            |
| `UMAMI_WEBSITE_ID`       | Umami analytics. Empty means no tracking and no script tag.   |
| `UMAMI_SCRIPT_URL`       | Umami script URL (`https://eu.umami.is/script.js` for the EU) |
| `UMAMI_DOMAINS`          | Optional list of hostnames allowed to report                  |

## Accounts and plans

| Variable           | Default              | Description                                                                                                              |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TOKEN_PEPPER`     | `development-pepper` | Secret mixed into key and session hashes. Set a real value in production. Changing it invalidates every key and session. |
| `SESSION_TTL_DAYS` | 30                   | Console session lifetime                                                                                                 |
| `PLAN_FREE_QUOTA`  | 100                  | Monthly lookups on the Free plan                                                                                         |
| `PLAN_PRO_QUOTA`   | 5000                 | Monthly lookups on the Pro plan                                                                                          |
| `AUDIT_FREE_KEEP`  | 3                    | Audit rows kept on the Free plan                                                                                         |
| `AUDIT_PRO_DAYS`   | 730                  | Audit retention on the Pro plan                                                                                          |
| `MONITOR_FREE_MAX` | 3                    | Monitors allowed on the Free plan                                                                                        |
| `MONITOR_PRO_MAX`  | 100                  | Monitors allowed on the Pro plan                                                                                         |

The site build reads the plan figures too, so the pricing page matches what is enforced. The
privacy policy (`site/src/privacy/*/index.html`) quotes the retention windows in plain text: update
it when changing them.

## Callbacks and async lookups

| Variable                      | Default  | Description                                                     |
| ----------------------------- | -------- | --------------------------------------------------------------- |
| `CALLBACK_TIMEOUT_MS`         | 10000    | One delivery attempt                                            |
| `CALLBACK_RETRIES`            | 3        | Extra attempts after the first                                  |
| `CALLBACK_ALLOW_PRIVATE_URLS` | false    | Allow callbacks to private addresses. Keep false in production. |
| `ASYNC_LOOKUP_MAX_DAYS`       | 7        | How long an async lookup is retried                             |
| `ASYNC_LOOKUP_MAX_BACKOFF_MS` | 86400000 | Maximum delay between two attempts                              |

## Email

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, and
`SMTP_TLS_REJECT_UNAUTHORIZED` (set to false for a local relay with a self-signed certificate).
The defaults point at Mailpit.

## Stripe

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_PRO`. All three are required
together, see [console.md](console.md#payments).

## Register credentials

`KBO_USER`, `KBO_PASSWORD`, `CVR_USER`, `CVR_PASSWORD`, `SUDREG_CLIENT_ID`,
`SUDREG_CLIENT_SECRET`, `AADE_USER`, `AADE_PASSWORD`, `GEMI_API_KEY`, `NZBN_API_KEY`. All
optional, see [credentials.md](credentials.md).
