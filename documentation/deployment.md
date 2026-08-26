# Deployment

The production setup runs three hosts: the website (static files built into `docs/`, served by
nginx), the API (`dist/server.js`) and the console (`dist/consoleServer.js`). Both Node processes
read the same `.env`.

## First start

```bash
npm run build
pm2 start dist/server.js        --name vatlas-api      # PORT
pm2 start dist/consoleServer.js --name vatlas-console  # CONSOLE_PORT
pm2 save
pm2 startup                     # prints the command that installs the boot service
```

## Deploy

```bash
git pull && npm install && npm run build && npm run db:setup \
  && pm2 restart vatlas-api vatlas-console
cd site && npm ci && npm run build      # rewrites docs/
```

- `db:setup` (`prisma migrate deploy`) does nothing when no migration is pending.
- The console reads `locales/*.json` from the working tree at runtime, so `git pull` is enough to
  ship a wording change.
- The site must be built on the production host: the build bakes the production `.env` into the
  HTML, and it refuses localhost URLs.

Before going live, set a real `TOKEN_PEPPER`, keep `CALLBACK_ALLOW_PRIVATE_URLS=false`, and set
`TRUST_PROXY_HOPS` to the number of reverse proxies in front of the apps.

## Logs

Both servers and every CLI log to stdout through pino:

```
2026-09-07 12:03:01.123 INFO : vatlas listening {"port":3000}
2026-09-07 12:03:02.007 INFO : [http] GET /v1/lookup/FR12345678901 200 {"responseTime":34}
2026-09-07 12:03:09.881 ERROR: [import fr fr-sirene] source failed
```

Dates are UTC. Colors are only added when writing to a terminal. Request logs never include
headers, so keys and cookies do not end up in the logs. Use `LOG_FORMAT=json` for a log
aggregator.

## Cron

```cron
# m    h  dom mon dow   command
  30   2   *   *   *    cd /srv/vatlas && npm run import -- all --history 2 >> /var/log/vatlas/import.log 2>&1
  0    5   *   *   *    cd /srv/vatlas && npm run retention                 >> /var/log/vatlas/retention.log 2>&1
  0    6   *   *   *    cd /srv/vatlas && npm run monitors                  >> /var/log/vatlas/monitors.log 2>&1
  */10 *   *   *   *    cd /srv/vatlas && npm run lookups:async             >> /var/log/vatlas/async-lookups.log 2>&1
```

- Keep the `--` after `npm run import`, otherwise npm swallows the flags.
- `import all` goes through every country. A country that fails is logged and the others continue.
- `--history 2` lets a run catch up on missed editions for the publishers that keep an archive.
  Editions already imported are skipped.
- The import must start after 02:00 UTC, when the German Peppol export is regenerated.
- France republishes monthly. That night the import takes hours. Use `all --except fr` plus a
  separate monthly line if this is a problem.
- `monitors` runs at 06:00 so it never reads a half-imported edition.
- `retention` applies the windows published in the privacy policy: call logs, audit trail,
  sessions, used links, throttle tables, callback deliveries (90 days), finished async lookups
  (90 days) and dormant accounts. Monitors are never purged.
- Every job accepts `--dry-run` and is safe to run twice.

## Download cache

Bulk files are cached in `DOWNLOAD_DIR`. Before downloading, a HEAD request compares length,
`ETag` and `Last-Modified` with what was recorded next to the cached file. A file is downloaded
again only when it changed or is incomplete.

Whether an edition was already imported is checked first, from `bulk.imported_at`, so the cache
can be deleted at any time. Canada and Japan are exceptions: their edition date is only inside the
archive, so it is known after download (Japan reads it from the download URL).

Finland's PRH allows about one request per minute per IP, HEAD included. Requests to that host are
spaced by 90 seconds and a 429 is waited out for up to five minutes.

## Disk sizing

| Country   | Download                                                      |
| --------- | ------------------------------------------------------------- |
| Brazil    | 20 ZIPs, 6.7 GB per monthly edition, about 118 million rows   |
| France    | about 709 MB (legal units) + 2.2 GB (establishments), Parquet |
| Russia    | 2.1 GB per month, 7519 files                                  |
| Australia | about 1 GB per week                                           |
| Peru      | about 390 MB per day, 1.5 GB unpacked                         |
| Ukraine   | 319 MB per week, 1.9 GB of XML unpacked                       |
| Canada    | 215 MB per month, 2.6 GB of XML unpacked                      |
| Singapore | about 500 MB per month                                        |
| Japan     | under 150 MB                                                  |

The `company` table takes about 341 bytes per row. Plan about 10 GB for a full French import.

`company` stores one row per plateau, a period during which a source said the same thing. A
company that never changes costs one row however many editions are imported, so only the first
import is expensive. InnoDB does not return freed space to the filesystem, so watch the peak.
