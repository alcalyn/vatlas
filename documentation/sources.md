# Sources and countries

A source knows one register. A country knows which sources it has and in which order to ask them.

- **Bulk sources** (`src/api/sources/bulk/`) import a file published by a register.
- **Live sources** (`src/api/sources/live/`) query a register's API for one number.
- **Countries** (`src/api/countries/`) declare their bulk and live sources.

EU member states also declare VIES. Countries outside the EU never do: VIES does not know their
numbers.

## Asking a source directly

`npm run source` skips the stored history and asks every live source of the number's country.
Answers are stored like a normal lookup. It exits with code 1 when a number is malformed or no
source confirms it.

```bash
npm run source -- IT00743110157
npm run source -- DE811907980 FR95884831538
npm run source -- PL7342867148 --source=MF_WL     # one named source
npm run source -- IT00743110157 --json --raw --requester=IT00743110157
```

`--raw` prints the VIES SOAP body. VIES answers its faults with HTTP 200, so the status code says
nothing.

## Adding a live source

Create `src/api/sources/live/<cc>-<register>.ts`:

1. Export a pure `mapXxx` function that turns one payload into a `CompanyRecord`, and test it with
   a small committed fixture. `vatNumber` is the full number, prefix included.
2. Extend `LiveSource` and implement `query()`. Exceptions become `unavailable`, an
   `HttpNotFoundError` becomes `not-found`, and `this.answer(record)` builds the verdict. Override
   `available` if the source needs credentials.
3. Register it in `src/api/sources/registry.ts`.

Things to know:

- A register that answers a miss with a 200 and an empty body needs `fetchJsonOrNull` instead of
  `fetchJson`.
- SOAP registers use `postXml`, which returns faults to the caller instead of retrying.
- A 4xx other than 408 and 429 is not retried (`HttpPermanentError`).
- Some registers sit behind bot filters that check the `User-Agent` and the caller's IP. Test new
  sources from the production server too. If you have to send a borrowed `User-Agent`, explain why
  in the adapter (see `cr-hacienda.ts`).
- Mappers do not need to respect column widths: `fitStatement()` truncates long values before
  writing.

## Adding a bulk source

Create `src/api/sources/bulk/<cc>-<register>.ts`, extend `BulkSource` and implement `run()`. Call
`context.useArtefact({ url, fileName, date })` as soon as the file is known, and `this.batch(...)`
to stream records. Write each record complete: a row written partially and fixed later would be two
different statements for the same day.

## Adding a country

Create `src/api/countries/<cc>.ts` with a `new BaseCountryAdapter({ code, name, bulk, live,
lateLive, importNote })` and register it in `src/api/countries/registry.ts`.

- `live` is the order in which sources are asked. `lateLive` is for sources asked after VIES
  (only Greece's GEMI today).
- A country needs at least one source, bulk or live.
- A country without a bulk source explains why in `importNote`.

Then add the number's syntax and checksum to `src/vat/rules.ts`. If the number has several written
forms, add a `normalize` function so they share one key (for example `CA106679285RT0001` and
`CA106679285`).

Nothing country-specific belongs above the country adapter: the API only sees a
`CompanyStatement`.

## Data licensing

Being allowed to consult a register is not the same as being allowed to redistribute it through an
API, or to build a permanent database from it. The sources used here were picked for permissive
terms (Licence Ouverte, CC0, open data licences, public ministry APIs), but check each source's
terms before exposing the data commercially, and check any new country on its own.
