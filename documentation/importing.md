# Importing data

Bulk registers are imported into the `company` table with one command, for one country or all of
them. Every run is recorded in `log_import` with its status, counters, error and the file it read.

```bash
npm run import                       # usage, country list and local file slots
npm run import -- lv                 # one country (Latvia is the smallest, a good first run)
npm run import -- fr --limit 10000   # a sample: the first N records of each edition
npm run import -- all                # every country, one after another
npm run import -- all --except fr    # every country but these
```

`--limit` caps the rows written, not the bytes read. For Brazil the whole company file is still
staged, so a small sample is cheap to write but expensive to read.

## History

`company` stores a history. Each row is a plateau: a period during which a source said the same
thing. A new edition either extends the current plateau or opens a new one when something
changed. The `counters` of a run show both: `inserted` counts opened plateaus, `updated` counts
extended or merged ones.

Rows are dated with the date of the file, not the day of the import. Re-importing the same file
writes nothing.

The order of the imports does not matter: an older edition is placed between the plateaus it falls
between. `npm run collapse` merges redundant plateaus left by older versions of the importer:

```bash
npm run collapse -- --dry-run     # report only
npm run collapse                  # report and merge
npm run collapse -- --samples 50  # more example numbers in the report
```

Run it when no import is running.

## Skipping editions already imported

An edition read to the end is recorded in `bulk.imported_at` and skipped next time, before any
download. A run interrupted halfway, or a `--limit` run, marks nothing. For publishers that only
reveal the edition inside the file (INSEE, Latvia), the run stops as soon as it knows. The log then
says `Import not necessary because ...`.

## Older editions

Only Belgium (31 daily extracts), Brazil (monthly folders since May 2023) and Russia (monthly
editions over ten years) keep an archive. Other publishers overwrite a single file, and asking
them for history only imports the current edition.

```bash
npm run import -- be --history 4                # every edition since the 1st of the month, 3 months ago
npm run import -- be --history 4 --max-files 6  # and keep only the 6 newest
npm run import -- be --max-files 7              # the 7 newest editions
npm run import -- br --since-date 2024-09-01 --max-files 1  # the first edition on or after that date
```

- `--history <n>` counts whole months, the current one included.
- `--max-files <n>` keeps the newest `n` editions, or the oldest `n` with `--since-date`.
- `--since-date` and `--history` cannot be combined.

Each edition is cached under its own name, so history runs use a lot of disk. `.cache/` can be
emptied at any time.

The KBO portal (Belgium) ends long sessions by returning its login page with a 200. The importer
logs in again once, then stops and keeps the editions already imported. Downloads are spaced by
30 seconds.

## Importing a file you already have

Publishers rarely keep old files, so a local copy is the only way to import an old edition:

```bash
npm run import -- ee --file ee_lihtandmed.csv.zip=/dumps/ee-2025-03.zip --date 2025-03-01
npm run import -- fr --date 2025-03-01 \
  --file fr_stock_unite_legale.parquet=/dumps/fr-units-2025-03.parquet \
  --file fr_stock_etablissement.parquet=/dumps/fr-estab-2025-03.parquet
```

- A slot is the name a source downloads under. `npm run import` lists them. A slot not given is
  downloaded as usual. Belgium's slot is `be_kbo_full`.
- `--date` is required with `--file`: it is the date the file holds, in `YYYY-MM-DD`.
- `--file` takes one country and does not combine with `--history`, `--max-files` or
  `--since-date`.
- Sources that do not download a file (Denmark, Germany, Croatia) cannot be imported from disk.

## Per-country notes

- **France**: the legal units file and the establishments file are both sorted by SIREN and merged
  while streaming, so each record is complete when written.
- **Latvia**: four passes (VAT payers, Business Register, public institutions...) filed under one
  date and marked imported together.
- **Multi-file editions** (Australia, Singapore, Japan, Brazil, Canada, Russia) are one edition
  under one date, marked imported only at the end.
- **Belgium, Denmark, Croatia** import nothing without credentials, see
  [credentials.md](credentials.md).
- **Greece** has no bulk file and is resolved on demand.

See [deployment.md](deployment.md#disk-sizing) for disk usage and
[deployment.md](deployment.md#cron) for scheduling.
