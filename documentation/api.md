# API

## Endpoints

| Endpoint                                                                   | Description                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /health`                                                              | Liveness and a MySQL round trip. No key.                                               |
| `GET /v1/countries`                                                        | Countries served, with their sources. No key.                                          |
| `GET /v1/lookup/:vatNumber`                                                | Resolve a number. Takes `?prefer=completeness\|proof` and `?history`.                  |
| `GET /v1/lookup-all/:vatNumber`                                            | Every source of the country, each in the lookup shape. `?history=false` drops history. |
| `GET /v1/demo/lookup/:vatNumber`                                           | Same as the lookup, no key, 5 per IP per week.                                         |
| `GET /v1/demo/lookup-all/:vatNumber`                                       | Same as lookup-all, no key, shares the same 5.                                         |
| `GET /v1/audit`                                                            | The account's audit trail. No quota.                                                   |
| `GET /v1/monitor`, `POST`/`GET`/`DELETE /v1/monitor/:vatNumber`            | Monitors, see [callbacks.md](callbacks.md). No quota.                                  |
| `POST /v1/lookup-async/:vatNumber`, `POST /v1/lookup-async-all/:vatNumber` | Queue a lookup, see [callbacks.md](callbacks.md). One unit, charged now.               |
| `GET /v1/lookup-async`, `GET`/`DELETE /v1/lookup-async/id/:publicId`       | List, read or cancel async lookups. No quota.                                          |

The number may contain spaces or punctuation (`fr 95 884.831-538`).

Private endpoints take `Authorization: Bearer vtl_live_...`. They answer `401` with a
`WWW-Authenticate` header when the key is missing or invalid, and `429` past the quota. Metered
responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.

The demo routes are the only ones with `Access-Control-Allow-Origin: *`. They back the "try it"
box on the website. They are throttled per IP in `rate_limit_site_lookup` and answer
`429 DEMO_LIMIT_REACHED` past the limit.

## Errors

All errors use `{ "error": { "code": "...", "message": "..." } }`.

| Code                           | Status    | Meaning                                                                                                                 |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `INVALID_VAT_FORMAT`           | 400       | Bad syntax or checksum. No source was asked. `reason` says why.                                                         |
| `INVALID_QUERY`                | 400       | A query parameter is out of range or malformed.                                                                         |
| `INVALID_BODY`                 | 400       | The JSON body is not an object, or a field has the wrong type.                                                          |
| `VAT_NOT_REGISTERED`           | 404       | A source says the number is not registered for intra-community trade. This is not the same as the company not existing. |
| `COMPANY_NOT_FOUND`            | 404       | Nothing stored and no source left to ask.                                                                               |
| `SOURCE_UNAVAILABLE`           | 503       | No live source answered. Worth retrying.                                                                                |
| `PROOF_UNAVAILABLE`            | 503       | With `?prefer=proof` only: VIES gave no consultation number.                                                            |
| `DEMO_LIMIT_REACHED`           | 429       | The demo limit for this IP is reached.                                                                                  |
| `MONITOR_LIMIT_REACHED`        | 403       | The plan's monitor limit is reached.                                                                                    |
| `MONITOR_EXISTS`               | 409       | This account already follows that number.                                                                               |
| `CALLBACK_URL_MISSING`         | 400       | No callback URL on the monitor nor on the account.                                                                      |
| `INVALID_CALLBACK_URL`         | 400       | Not an absolute http(s) URL, has credentials, or points to a private address.                                           |
| `NOT_FOUND` / `INTERNAL_ERROR` | 404 / 500 | Unknown endpoint or unexpected failure.                                                                                 |

## Lookup

`meta.source` names the register that answered and `meta.sourceDate` when it said it: the
publication date of the file for an imported register, the day of the call for a live one.

### `?prefer`

- `completeness` (default): every source of the country can answer, and the most complete answer
  wins (name first, then address, then identifiers). The walk stops at the first source that
  returns a company name. VIES often answers `valid` with empty fields (Germany, Spain), so it
  does not stop the walk.
- `proof`: only an answer with `meta.proof` is accepted. The stored history and sources without a
  verification code are skipped, so the answer comes from VIES or not at all. It answers
  `503 PROOF_UNAVAILABLE` when VIES gives no consultation number.

```
GET /v1/lookup/FR08000325175                 -> meta.source "SIRENE", no proof
GET /v1/lookup/FR08000325175?prefer=proof    -> meta.source "VIES", meta.proof
```

A VIES proof looks like this:

```json
"proof": { "type": "vies_consultation_number", "value": "908a3b38-e0dc-4502-8b06-d057eeac6861" }
```

Read `meta.proof.type` to know which kind of proof you got. Any other value of `prefer` is a
`400 INVALID_QUERY`. Proof lookups are tagged `kind = 'proof'` in `log_lookup` and in the audit
trail.

### `?history`

Adds a `history` node next to `data` and `meta` with everything the answering source has said
about the number. Off by default because it costs an extra query.

## Lookup all

`GET /v1/lookup-all/:vatNumber` returns everything every source has said about the number, and
calls each live source whose last statement is older than `LIVE_MAX_AGE_DAYS`.

```
GET /v1/lookup-all/CZ27074358
{ "data": { "vatNumber": "CZ27074358", "countryCode": "CZ", "nationalNumber": "27074358",
    "sources": [
      { "data": { "vatNumber": "CZ27074358", "name": "...", "status": "active", "address": { ... } },
        "meta": { "source": "ARES", "name": "ARES (Ministerstvo financí)", "kind": "live",
                  "sourceDate": "2026-09-04", "sourceSince": "2026-09-04",
                  "call": { "status": "found", "checkedAt": "2026-09-04T22:03:00.505Z" } },
        "history": [
          { "from": "2026-06-14", "to": "2026-08-30", "status": "active", "name": "...", ... },
          { "from": "2026-09-04", "to": "2026-09-04", "status": "active", "name": "...", ... }
        ] },
      { "error": { "code": "SOURCE_UNAVAILABLE", "message": "...", "fault": "MS_UNAVAILABLE", "attempts": 4 },
        "meta": { "source": "VIES", "name": "VIES (European Commission)", "kind": "live",
                  "call": { "status": "unavailable", "error": { ... } } },
        "history": [] }
    ] } }
```

- The status is `200` as soon as the number parses, even if every source failed. Only a malformed
  number gives a `400`.
- Each entry has the lookup shape: `data` and `meta`, or `error` and `meta`. `meta` also has
  `name`, `kind`, and `call` when this request made a live call.
- `data` is the latest statement of that source. `error` replaces it with `VAT_NOT_REGISTERED`,
  `SOURCE_UNAVAILABLE` (the call failed) or `COMPANY_NOT_FOUND` (the source never said anything).
- `history` lists changes, oldest first, each bounded by `from` and `to`. A company that did not
  change since 2019 is one entry. A gap between two entries means no file was read in between.
- Sources that do not apply are absent: no live register for France, no bulk source for Bulgaria,
  registers with missing credentials, or VIES when `VIES_ENABLED=false`.

There is no summary: deciding which register is right is up to the caller.

## Audit

`GET /v1/audit` takes `?vatNumber=`, `?limit=` (1-100, default 25) and `?before=` (the
`meta.nextBefore` of the previous page). A bad `limit` or `before` is a `400 INVALID_QUERY`.

## Billing

Every metered call costs one unit, whatever the endpoint. A call is billed when it produces an
answer: a `200`, or a `404` for a number that is not registered. A `400` or a `503` is not billed.
`/health` and `/v1/countries` are free.

## Request collection

`http/` holds requests for [httpyac](https://httpyac.github.io) (also readable by the VS Code REST
Client), one file per endpoint, each with assertions. Running the folder works as a smoke test.
