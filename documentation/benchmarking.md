# Benchmarking

`npm run benchmark` measures response time and completeness through the HTTP API, like a customer
would, so it needs an API key.

## Preparing a list

`npm run sanitize` reads a file of VAT numbers (one per line, blank lines and `#` comments
ignored), reports what it holds and writes a clean copy. It calls nothing.

```bash
npm run sanitize -- data/vats.txt                           # -> data/vats-sanitized.txt
npm run sanitize -- data/vats.txt --out data/clean.txt
npm run sanitize -- data/vats.txt --stats-only              # report only
npm run sanitize -- data/vats.txt --limit-per-country 100
```

Malformed lines, duplicates and blanks are dropped, and numbers are written in canonical form
(`fr 08 000.325-175` -> `FR08000325175`). The report is also written to
`<file>.sanitize-report.txt`.

Use `--limit-per-country` so countries stay interleaved and one member state is not hit many times
in a row.

## Running

```bash
export VATLAS_KEY=vtl_live_...
npm run benchmark -- benchmarks/bench-50.txt --url https://api.vatlas.dev            # vatlas
npm run benchmark -- benchmarks/bench-50.txt --paired --url https://api.vatlas.dev   # vatlas vs VIES
npm run benchmark -- benchmarks/bench-50.txt --vies-only                             # VIES only
```

Options: `--url` (default `API_BASE_URL`), `--key`, `--concurrency` (default 1), `--limit`,
`--timeout` (30 s), `--out`, `--stats-only`, `--vies-only`, `--paired`. Unknown options are
rejected.

A run writes four files named after the list: `.bench-summary.txt`, `.bench-summary.json`,
`.bench-details.txt` and `.bench-debug.json` (every raw response). Use `--out` to keep two modes
on the same list apart. Ctrl+C or a spent quota stops the run and keeps the results, except in
`--paired` mode where the run becomes invalid.

```bash
jq '.entries[] | select(.vies.success and (.vatlas.success | not)) | .vatNumber' \
  benchmarks/bench-50-paired.bench-debug.json
```

`npm run compare -- <vatlas>.json <vies>.json` diffs two summaries (vatlas file first).
`npm run unpair` extracts the vatlas side of a paired run in the plain format.

## Publishing new figures on the site

1. Deploy the version to measure on the production host.
2. Check in the console that the key has enough credits left.
3. Clear live answers on the production database, otherwise they are served from storage:

   ```sql
   DELETE FROM company WHERE bulk_id IS NULL;
   ```

   `bulk_id IS NULL` means the row came from a live call. Imported registers are untouched. Add
   `AND vat_number LIKE 'CZ%'` to clear one country.

4. Run the paired benchmark:

   ```bash
   npm run benchmark -- benchmarks/bench-50-paired.txt --paired --url https://api.vatlas.dev --key vtl_live_...
   ```

5. Publish both pages from that run:

   ```bash
   cp benchmarks/bench-50-paired.bench-summary.json site/public/data/benchmark.bench-compare.json
   npm run unpair -- site/public/data/benchmark.bench-compare.json --out site/public/data/benchmark.json
   ```

6. Refresh the home page figures on the production host:

   ```bash
   npm run stats
   ```

`npm run stats` writes `site/public/data/stats.json` (gitignored) from the production database and
`benchmark.json`. The same figures are also written in `site/src/_pages/index.html` as a fallback
when JavaScript is off.

Re-read `versus.method.bias` and `benchmarks.notes.*` in the locale files: they describe the run
in plain text and nothing checks them.
