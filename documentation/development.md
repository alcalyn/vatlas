# Development

## Requirements

- Node.js >= 20.11
- MySQL >= 8.0. The importers use the legacy `VALUES(col)` syntax so MariaDB stays an option.
- Docker for the local stack (optional, any MySQL >= 8.0 works).

Without Docker, create the database by hand and point `DATABASE_URL` at it:

```bash
mysql -e "CREATE DATABASE vatlas CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
```

## Local stack

| Command               | Starts                       | URL                     |
| --------------------- | ---------------------------- | ----------------------- |
| `npm run dev`         | the three apps below at once |                         |
| `npm run api:dev`     | the API (`tsx watch`)        | <http://localhost:3000> |
| `npm run console:dev` | the developer console        | <http://localhost:3001> |
| `npm run site:dev`    | the website (Vite)           | <http://localhost:5173> |

`docker-compose.yml` (development only):

| Service | URL                     | Notes                                               |
| ------- | ----------------------- | --------------------------------------------------- |
| MySQL   | `127.0.0.1:3306`        | User `root`, password `vatlas` |
| Adminer | <http://localhost:8081> | database browser, server `mysql`                    |
| Mailpit | <http://localhost:8025> | catches every email the app sends (SMTP on 1025)    |

MySQL uses a named volume: `docker compose down` keeps the data, `down -v` deletes it.

## Gotchas

- `tsx watch` does not reload `.env`. Restart the process after editing it.
- `cd site && npm run build` refuses localhost URLs, because the build bakes `.env` into the HTML.
- After the MySQL container restarts, the first connection can fail and the API hangs. MySQL 8
  uses `caching_sha2_password` and the Prisma MariaDB adapter cannot do the full handshake. One
  connection from the `mysql` client fills the auth cache:

  ```bash
  mysql -h 127.0.0.1 -u root -pvatlas --get-server-public-key -e 'SELECT 1'
  ```

- `src/generated/` is gitignored. `npm run typecheck` and `npm run build` run `prisma generate`.

## Commands

```bash
npm test                    # vitest, no network, no database
npm run lint                # ESLint
npm run lint:fix            # ESLint with autofix
npm run format              # Prettier, rewrites files
npm run format:check        # Prettier, check only
npm run typecheck           # prisma generate && tsc --noEmit
npm run build               # compile to dist/
npm run db:setup            # prisma migrate deploy
npm run db:migrate          # prisma migrate dev, after editing prisma/schema.prisma

npm run import -- <cc>      # see importing.md
npm run source -- <vat>     # ask a country's live sources directly, see sources.md
npm run monitors            # check followed companies, see callbacks.md
npm run lookups:async       # retry pending async lookups, see callbacks.md
npm run retention           # apply the data retention windows
npm run audit:prune         # prune the audit trail by age or count
npm run email:test -- you@example.com   # send one email through the app's SMTP config
npm run stripe:webhook      # replay a signed Stripe webhook, see console.md
npm run collapse            # merge redundant history rows, see importing.md
npm run sanitize -- list.txt            # clean a list of VAT numbers, see benchmarking.md
npm run benchmark -- list.txt           # see benchmarking.md
npm run compare -- a.json b.json        # diff two benchmark summaries
npm run unpair -- paired.json           # extract the vatlas leg of a paired benchmark
npm run stats               # home page figures -> site/public/data/stats.json
npm run country-examples    # one real company per country -> data/country-examples.json
npm run i18n -- fr          # strings missing from a locale, see site.md

npx httpyac send "http/*.http" --all    # run every request in http/ (needs VATLAS_KEY)
```

After a build, the CLIs also run from `dist/`: `node dist/cli/import.js lv`.

## Project layout

```
src/
  server.ts              API entry point
  consoleServer.ts       developer console entry point
  config.ts              environment parsing (zod)
  api/                   number resolution and the HTTP routes
    resolve.ts           single-answer lookup
    resolveAll.ts        every source's answer
    sources/bulk/        one importer per register that publishes a file
    sources/live/        one client per register that answers a request
    countries/           one declaration per country, plus the registry
  console/               console pages and Stripe integration
  services/              accounts, usage, audit, retention, monitors, callbacks...
  db/                    Prisma client, mysql2 pool, history rules
  vat/                   normalization, syntax and checksums per country
  lib/                   streaming download, CSV, ZIP, HTTP, time helpers
  cli/                   command line tools
prisma/                  schema and migrations
site/                    the website (Vite), builds to docs/
locales/                 translations shared by the site and the console
http/                    httpyac request collection, one file per endpoint
test/                    vitest tests and fixtures
```

## Tests

Importers are tested through their pure mapping functions with small committed fixtures, so the
suite never touches the network or the database.

- `test/fixtures/valid-vat-numbers.txt` holds real VAT numbers for all 27 member states, each
  confirmed by VIES when collected.
- `test/fixtures/valid-tax-numbers-non-eu.txt` holds numbers for the other countries, read from
  the registers themselves.

Prefer fixtures captured from real responses over fixtures written from a published schema.

## Changing the schema

Edit `prisma/schema.prisma`, run `npm run db:migrate`, and commit the generated folder in
`prisma/migrations/` with the schema change. Tables and columns are snake_case in MySQL and
camelCase in the client (`@map` / `@@map`).

When changing the width of a `company` text column, update `COLUMN_WIDTHS` in
`src/db/companyHistory.ts` in the same commit.
