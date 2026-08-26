import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackSourceCallLog } from '../../db/companyRepository.js';
import { downloadFile, probePublished, type DownloadResult, type RequestOptions } from '../../lib/download.js';
import { HttpNotFoundError } from '../../lib/http.js';
import { logger as rootLogger, type AppLogger } from '../../lib/logger.js';
import type { SourceTrace } from '../trace.js';
import type { CompanyRecord } from '../types.js';
import type { ParsedVat } from '../../vat/parse.js';

/**
 * The two kinds of source.
 *
 * A source is a register, not a country: VIES serves many countries, and Greece has three sources.
 * A country is a list of sources plus a rule for reading them, and a source knows nothing about its
 * caller.
 *
 * A bulk source downloads a file on a schedule and reads it offline. A live source is asked about
 * one number while the caller waits. Four registers offer both: two adapters sharing an `id`, one
 * history.
 */

/** What every source exposes. */
export interface SourceAdapterInterface {
  /**
   * Short id of the register, written to `company.source`: SIRENE, KBO, PRH, MF_WL, VIES... It is
   * part of the history key, so it must never change once rows exist.
   */
  readonly id: string;
  /** The register's name as its publisher writes it, for the CLI and `GET /v1/countries`. */
  readonly name: string;
  /** The country it serves, or null for VIES, which serves many. */
  readonly countryCode: string | null;
  /**
   * Whether this deployment can use it. False when required credentials are not configured, which is
   * a normal state.
   */
  readonly available: boolean;
}

/** A file as the publisher offers it, and its date. */
export interface BulkArtefact {
  /** Where the file can be downloaded again, or the open-data page when the URL is generated. */
  url: string;
  /** The file name as the publisher writes it: `KboOpenData_0142_2026_08_29_Full.zip`. */
  fileName: string;
  /**
   * The file's publication date, not the download date. Every row read from it gets this date, so it
   * is required. Fall back to the download's `Last-Modified`, which `downloadFile` returns.
   */
  date: Date;
}

export interface ImportOptions {
  /**
   * Stop after this many records, null for everything. Counted per edition, so `--limit 100` over
   * six editions stores 100 rows from each.
   */
  limit: number | null;
  /**
   * How many months back to import, the current month included: 4 in September means June to
   * September. Null imports the current edition only.
   *
   * Only reaches what the publisher still offers. Most keep no archive, and the import logs that.
   */
  historyMonths: number | null;
  /** At most this many editions, newest first. Useful for daily publishers. */
  maxEditions: number | null;
  /**
   * The oldest edition to read: everything dated on or after this day, oldest first. Null leaves the
   * choice to `historyMonths` / `maxEditions`.
   *
   * With `maxEditions` it selects one old edition: `--since-date 2024-09-01 --max-files 1`.
   */
  sinceDate: Date | null;
  /**
   * Files to read from disk instead of downloading, keyed by slot (`fr_stock_unite_legale.parquet`,
   * `be_kbo_full`, ... as declared in each adapter's `slots`).
   *
   * The only way to import an old edition the publisher no longer offers. Slots not given are
   * downloaded as usual.
   */
  localFiles: ReadonlyMap<string, string> | null;
  /**
   * Edition date for the run, overriding the file and the server.
   *
   * Required with `localFiles`: a file on disk has no `Last-Modified`.
   */
  dumpDate: Date | null;
}

export interface ImportContext {
  logger: AppLogger;
  options: ImportOptions;
  /**
   * Declares which file the next records come from, resolving its `bulk` row. Call it as soon as the
   * file is known and before the first `save`. A source reading two files calls it between passes.
   *
   * Mappers know nothing about the file, which keeps them testable with small fixtures.
   */
  useArtefact(artefact: BulkArtefact): Promise<void>;
  /** Stores a batch of records and returns how many rows were created or refreshed. */
  save(records: CompanyRecord[]): Promise<{ inserted: number; updated: number }>;
  /**
   * Whether this file and edition were already read to the end by an earlier run.
   *
   * Re-reading writes nothing, but costs the reading (312 MB and four passes for a Belgian daily, an
   * hour for France).
   */
  alreadyImported(artefact: BulkArtefact): Promise<boolean>;
  /**
   * Same question for a download URL: was anything read to the end fetched from this URL?
   *
   * For the NTA, whose edition date is only inside the archive, this is the only way to know before
   * downloading. Only valid when the URL is specific to the edition, which is why the source asks
   * it and not `import`.
   */
  alreadyImportedUrl(url: string): Promise<boolean>;
  /**
   * Marks every file declared since the last call as read to the end. Called by `import` after
   * `run` returns, so an exception leaves the edition unmarked.
   */
  markImported(): Promise<void>;
}

export interface ImportResult {
  /** Rows read. */
  fetched: number;
  inserted: number;
  updated: number;
  /** Rows read but not stored, usually because they have no VAT number. */
  skipped: number;
  durationMs: number;
  /**
   * The editions read, oldest first, as the publisher names them. Absent for a source without archive
   * that names no file before its `run`.
   */
  editions?: string[];
  /**
   * Set when nothing was imported on purpose (no usable bulk file, or no credentials). Reported, not
   * thrown.
   */
  notImportedReason?: string;
  /** Editions skipped because they were already read to the end. */
  skippedEditions?: string[];
  /**
   * Why a history run stopped before its last edition after importing some. Unlike
   * `notImportedReason`, this run did import something.
   */
  stoppedReason?: string;
}

export interface BulkSourceAdapterInterface extends SourceAdapterInterface {
  readonly kind: 'bulk';
  /**
   * The slots that accept a local file (`--file <slot>=<path>`). Empty for a source without a file
   * (API or stream).
   */
  readonly slots: readonly string[];
  /** Reads the whole register and passes records to `context.save()` in batches. */
  import(context: ImportContext): Promise<ImportResult>;
}

/** What the resolution gives a live source for one call. */
export interface FetchContext {
  /**
   * Epoch milliseconds after which no attempt is made: one budget for the whole lookup. Pass it to
   * every HTTP call (`fetchJson`, `postJson`, the VIES retries).
   */
  deadline: number;
  /** Every source consulted and its duration, for `log_lookup.timings`. Filled by the base class. */
  trace: SourceTrace;
}

/** Why a source did not answer, stored in `log_lookup`. */
export interface SourceFailure {
  /** The fault the source returned, or the failure type: `MS_UNAVAILABLE`, `TIMEOUT`... */
  fault: string;
  /** Number of live calls made, retries included. Zero when nothing was attempted. */
  attempts: number;
}

/**
 * The result of one live call.
 *
 * - `not-registered` is a final answer: the number exists and is not valid for intra-community
 *   trade. It is stored.
 * - `not-found` means the register has no record of the number, which says nothing about its VAT
 *   status. Not stored, and the country asks its next source.
 * - `unavailable` means the source did not answer: a 503, worth retrying.
 */
export type LiveAnswer =
  | { status: 'found'; record: CompanyRecord; checkedAt: Date; proof?: string }
  | { status: 'not-registered'; checkedAt: Date; proof?: string }
  | { status: 'not-found' }
  | { status: 'unavailable'; failure: SourceFailure };

export interface LiveSourceAdapterInterface extends SourceAdapterInterface {
  readonly kind: 'live';
  /** Whether the source issues a verification code. Only VIES does. Selected by `?prefer=proof`. */
  readonly issuesProof: boolean;
  /** Asks the register about one number. Never throws and never writes: the country stores. */
  fetch(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer>;
}

export type SourceAdapter = BulkSourceAdapterInterface | LiveSourceAdapterInterface;

/**
 * The common part of every live source: timing, tracing, logging the call, and never throwing.
 *
 * A throwing source would take down the country's other sources. Every failure becomes
 * `unavailable`.
 */
export abstract class LiveSource implements LiveSourceAdapterInterface {
  readonly kind = 'live' as const;
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly countryCode: string | null;
  readonly issuesProof: boolean = false;

  /** Overridden by registers that need credentials. */
  get available(): boolean {
    return true;
  }

  /**
   * Set by a source that writes its own `log_source_call` rows (VIES, one row per retry). Others make
   * one request per lookup, recorded by the wrapper below.
   */
  protected readonly logsOwnCalls: boolean = false;

  protected get logger(): AppLogger {
    return rootLogger.child({ source: this.id });
  }

  /** What a subclass implements. Exceptions are allowed and become `unavailable`. */
  protected abstract query(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer>;

  /**
   * The verdict of a register that has the company or not.
   *
   * `not-found`, not `not-registered`: only VIES can say a number is not VAT registered.
   */
  protected answer(record: CompanyRecord | null): LiveAnswer {
    return record ? { status: 'found', record, checkedAt: new Date() } : { status: 'not-found' };
  }

  async fetch(vat: ParsedVat, context: FetchContext): Promise<LiveAnswer> {
    if (!this.available) {
      // A source this deployment cannot use leaves no trace entry and reports why.
      return { status: 'unavailable', failure: { fault: 'SOURCE_NOT_CONFIGURED', attempts: 0 } };
    }

    const startedAt = Date.now();
    context.trace.begin(this.id);
    let answer: LiveAnswer;
    try {
      answer = await this.query(vat, context);
    } catch (error) {
      if (error instanceof HttpNotFoundError) {
        // A 404 means the register holds nothing under this number: an answer, handled once here.
        answer = { status: 'not-found' };
      } else {
        // `fetchJson` throws a plain Error for timeouts, 500s and malformed bodies alike.
        this.logger.warn({ err: error, vatNumber: vat.formatted }, 'live source failed');
        answer = {
          status: 'unavailable',
          failure: { fault: error instanceof Error ? error.message.slice(0, 255) : 'UNKNOWN', attempts: 1 },
        };
      }
    }
    context.trace.end(this.id);

    if (!this.logsOwnCalls) this.recordCall(vat, answer, Date.now() - startedAt);
    return answer;
  }

  /**
   * One row in `log_source_call`. Not awaited, so it adds no latency, and a failure is only logged.
   *
   * Goes through `trackSourceCallLog`, which keeps the promise until it settles so a shutdown does
   * not lose it.
   */
  private recordCall(vat: ParsedVat, answer: LiveAnswer, durationMs: number): void {
    const record = answer.status === 'found' ? answer.record : null;
    trackSourceCallLog(
      {
        source: this.id,
        vatNumber: vat.formatted,
        operation: null,
        attempt: 1,
        calledAt: new Date(Date.now() - durationMs),
        durationMs,
        outcome: answer.status === 'found' ? 'valid' : answer.status,
        error: answer.status === 'unavailable',
        fault: answer.status === 'unavailable' ? answer.failure.fault : null,
        httpStatus: null,
        // Null rather than false when there was no answer to measure.
        hasName: record === null ? null : Boolean(record.name),
        hasAddress: record === null ? null : Boolean(record.addressLine1 ?? record.city),
        hasProof: answer.status === 'unavailable' || answer.status === 'not-found' ? null : Boolean(answer.proof),
      },
      (error: unknown) => {
        this.logger.error({ err: error }, 'failed to write a source call log');
      },
    );
  }
}

/**
 * The common part of every bulk source: timing, counters, batch buffer, and the two ways of
 * importing nothing on purpose.
 */
/**
 * One edition the publisher refused to serve, in a run over several.
 *
 * The editions already read are kept and the run stops there. A source raises it only after its own
 * recovery failed.
 */
export class EditionUnavailableError extends Error {
  override readonly name = 'EditionUnavailableError';
}

/**
 * Raised by `useArtefact` when the file just resolved was already read to the end.
 *
 * Sources without archive only know their file inside `run` (INSEE resolves the month's URL,
 * Latvia dates `register.csv` by a header), so this skips the passes over the file. Only raised on
 * the first file of a run: after that, rows have been written.
 */
export class ArtefactAlreadyImportedError extends Error {
  override readonly name = 'ArtefactAlreadyImportedError';
}

export abstract class BulkSource implements BulkSourceAdapterInterface {
  readonly kind = 'bulk' as const;
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly countryCode: string | null;

  get available(): boolean {
    return true;
  }

  /**
   * The editions the publisher still offers, in any order: the archive `--history` walks.
   *
   * Empty by default, since most publishers overwrite one file in place. INSEE included: last
   * month's path is a 404 once the new one is out.
   *
   * A source that overrides it (Belgium keeps 31 dailies) reads the edition `run` is given.
   */
  protected async editions(_context: ImportContext): Promise<BulkArtefact[]> {
    return [];
  }

  /**
   * What a subclass implements: read the file, save the rows, count.
   *
   * `edition` is null for a source without archive, which resolves the current file itself.
   * Otherwise it is one of `editions()`, and that is the one to read.
   */
  protected abstract run(context: ImportContext, counters: Counters, edition: BulkArtefact | null): Promise<void>;

  async import(context: ImportContext): Promise<ImportResult> {
    const startedAt = Date.now();
    const total = new Counters();
    if (!this.available) {
      return { ...total.snapshot(), durationMs: 0, notImportedReason: this.unavailableReason };
    }

    // A local import has no archive to walk.
    const published = context.options.localFiles ? [] : await this.editions(context);
    const wantsHistory =
      context.options.historyMonths !== null ||
      context.options.maxEditions !== null ||
      context.options.sinceDate !== null;

    if (published.length === 0) {
      if (wantsHistory) {
        // Asked for several months and got one file: log it. The logger is already bound to the source.
        context.logger.info('this publisher keeps no archive: the current edition is the only one it offers');
      }
      try {
        await this.run(context, total, null);
      } catch (error) {
        if (!(error instanceof ArtefactAlreadyImportedError)) throw error;
        return { ...total.snapshot(), durationMs: Date.now() - startedAt, notImportedReason: error.message };
      }
      await context.markImported();
      return { ...total.snapshot(), durationMs: Date.now() - startedAt };
    }

    const chosen = selectEditions(published, context.options);
    if (chosen.length === 0) {
      return {
        ...total.snapshot(),
        durationMs: Date.now() - startedAt,
        notImportedReason: 'no edition this publisher still offers falls inside the requested window',
      };
    }

    // Oldest first, so an interrupted run leaves a prefix of the history, not a hole.
    const read: string[] = [];
    const skipped: string[] = [];
    let stoppedReason: string | undefined;

    for (const [index, edition] of chosen.entries()) {
      // Checked before downloading, so a history run resumes where it stopped.
      if (await context.alreadyImported(edition)) {
        context.logger.info(
          { file: edition.fileName, date: edition.date, edition: index + 1, of: chosen.length },
          'this edition has already been imported in full, skipping it',
        );
        skipped.push(edition.fileName);
        continue;
      }

      context.logger.info(
        { file: edition.fileName, date: edition.date, edition: index + 1, of: chosen.length },
        'importing an edition',
      );
      // Counters per edition, so `--limit` samples each one.
      const counters = new Counters();
      try {
        await this.run(context, counters, edition);
      } catch (error) {
        // Same answer as the check above, reached from inside `run`. Not a failure.
        if (error instanceof ArtefactAlreadyImportedError) {
          skipped.push(edition.fileName);
          continue;
        }
        // A refusal on the first edition imported nothing: a normal failure.
        if (!(error instanceof EditionUnavailableError) || read.length === 0) throw error;
        stoppedReason = error.message;
        context.logger.warn(
          { file: edition.fileName, imported: read.length, of: chosen.length, reason: error.message },
          'stopping this history run early: the editions already imported are kept',
        );
        break;
      }
      await context.markImported();
      total.add(counters);
      read.push(edition.fileName);
    }

    return {
      ...total.snapshot(),
      durationMs: Date.now() - startedAt,
      // The editions actually read, not the ones chosen.
      editions: read,
      ...(skipped.length === 0 ? {} : { skippedEditions: skipped }),
      ...(stoppedReason === undefined ? {} : { stoppedReason }),
      // Every requested edition was already imported.
      ...(read.length === 0 && stoppedReason === undefined
        ? { notImportedReason: `every edition asked for has already been imported (${skipped.length})` }
        : {}),
    };
  }

  /**
   * Why an unavailable source imported nothing, printed by `import -- all`.
   *
   * Overridden by the four registers that need an account, to name the variables to set.
   */
  protected get unavailableReason(): string {
    return `the ${this.id} download is not configured on this deployment`;
  }

  /**
   * The cache slots this source downloads into, also the names `--file <slot>=<path>` accepts.
   *
   * Empty for sources that download no file (Denmark scrolls Elasticsearch, Germany streams XML,
   * Croatia reads an API). The CLI rejects `--file` for them.
   */
  readonly slots: readonly string[] = [];

  /**
   * The file's bytes: the local file when one was given for this slot, otherwise a download.
   *
   * Every bulk source goes through this, so `--file` works the same everywhere and no HEAD is sent
   * for a local file.
   */
  protected async download(
    context: ImportContext,
    url: string,
    slot: string,
    options: RequestOptions = {},
  ): Promise<DownloadResult> {
    const local = context.options.localFiles?.get(slot);
    if (!local) return downloadFile(url, slot, context.logger, options);

    const { size } = await stat(local);
    context.logger.info({ slot, path: local, bytes: size }, 'reading a local file instead of downloading');
    return { path: local, fromCache: true, bytes: size, lastModified: context.options.dumpDate };
  }

  /**
   * A slot's bytes, with the file declared before downloading.
   *
   * A HEAD gives the `Last-Modified` beforehand, so an edition already imported costs one request
   * even with an empty cache.
   *
   * When the server answers no usable HEAD, the file is declared after the download from the
   * response header.
   */
  protected async fetchArtefact(
    context: ImportContext,
    slot: string,
    published: { url: string; fileName: string; date?: Date | null },
    options: RequestOptions = {},
  ): Promise<DownloadResult> {
    const local = context.options.localFiles?.has(slot) === true;
    // A local file has no header, and `--date` is required with it.
    const probe = { ...options, logger: context.logger };
    const known = published.date ?? (local ? context.options.dumpDate : await probePublished(published.url, probe));

    if (known) await context.useArtefact(this.artefactOf(context, slot, { ...published, date: known }));

    const archive = await this.download(context, published.url, slot, options);
    if (!known) {
      await context.useArtefact(this.artefactOf(context, slot, { ...published, date: archive.lastModified }));
    }
    return archive;
  }

  /**
   * The file to declare for a slot: the publisher's name and URL, or the local file's name and
   * `file://` path.
   *
   * The name is half of the `bulk` deduplication key, so importing the same local file twice is
   * skipped.
   */
  protected artefactOf(
    context: ImportContext,
    slot: string,
    published: { url: string; fileName: string; date: Date | null },
  ): BulkArtefact {
    const local = context.options.localFiles?.get(slot);
    return {
      url: local ? pathToFileURL(local).href : published.url,
      fileName: local ? basename(local) : published.fileName,
      date: this.published(published.date, context),
    };
  }

  /**
   * The date to use when the publisher gives none.
   *
   * `company.date` cannot be null, and most publishers only give `Last-Modified`. Without it, the run
   * date is used and logged, since every re-import would otherwise create a new history generation.
   */
  protected published(date: Date | null, context: ImportContext): Date {
    // A date given by the operator wins over the name and the header.
    if (context.options.dumpDate) return context.options.dumpDate;
    if (date) return date;
    context.logger.warn(
      { source: this.id },
      'the artefact carries no date; filing it under today, which makes every run a new generation',
    );
    return new Date();
  }

  /** A self-flushing buffer. */
  protected batch(context: ImportContext, counters: Counters, size = 1000): Batch {
    return new Batch(context, counters, size);
  }
}

/** The four counters of an import, updated in place. */
export class Counters {
  fetched = 0;
  inserted = 0;
  updated = 0;
  skipped = 0;

  snapshot(): Omit<ImportResult, 'durationMs'> {
    return { fetched: this.fetched, inserted: this.inserted, updated: this.updated, skipped: this.skipped };
  }

  /** Adds one edition's counters to the run total. */
  add(other: Counters): void {
    this.fetched += other.fetched;
    this.inserted += other.inserted;
    this.updated += other.updated;
    this.skipped += other.skipped;
  }
}

/** Accumulates records and writes them in batches, respecting `--limit`. */
export class Batch {
  private buffer: CompanyRecord[] = [];

  constructor(
    private readonly context: ImportContext,
    private readonly counters: Counters,
    private readonly size: number,
  ) {}

  /** True once `--limit` is reached: stop reading. */
  get full(): boolean {
    return this.context.options.limit !== null && this.counters.fetched >= this.context.options.limit;
  }

  /** Adds one mapped record. A null counts as skipped. */
  async add(record: CompanyRecord | null): Promise<void> {
    if (!record) {
      this.counters.skipped += 1;
      return;
    }
    this.counters.fetched += 1;
    this.buffer.push(record);
    if (this.buffer.length >= this.size) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const saved = await this.context.save(this.buffer);
    this.counters.inserted += saved.inserted;
    this.counters.updated += saved.updated;
    this.buffer = [];
  }
}

/**
 * Which editions to read, oldest first.
 *
 * The window counts whole months, the current one included: `--history 4` in September reaches back
 * to 1 June, four monthly editions.
 *
 * `--max-files` then keeps the newest ones (a daily register has about 120 in four months). Alone,
 * it means "the n most recent editions".
 *
 * `--since-date` starts from the other end: everything on or after that day, oldest first, and
 * `--max-files` keeps the oldest. It is the only way to select one old edition.
 *
 * Without flags, the current edition.
 */
export function selectEditions(
  published: readonly BulkArtefact[],
  options: Pick<ImportOptions, 'historyMonths' | 'maxEditions'> & { sinceDate?: Date | null },
  now = new Date(),
): BulkArtefact[] {
  const newestFirst = [...published].sort((a, b) => b.date.getTime() - a.date.getTime());

  if (options.sinceDate) {
    const since = options.sinceDate.getTime();
    const oldestFirst = newestFirst.filter((edition) => edition.date.getTime() >= since).reverse();
    // With `--since-date` the cap counts from the oldest.
    return oldestFirst.slice(0, options.maxEditions ?? oldestFirst.length);
  }

  const cutoff =
    options.historyMonths === null
      ? null
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (options.historyMonths - 1), 1);
  const inWindow = cutoff === null ? newestFirst : newestFirst.filter((edition) => edition.date.getTime() >= cutoff);

  const cap = options.maxEditions ?? (options.historyMonths === null ? 1 : inWindow.length);
  return inWindow.slice(0, cap).reverse();
}
