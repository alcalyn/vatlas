import { config } from '../../config.js';
import { historyBySource, latestBySource, recordStatement } from '../../db/companyHistory.js';
import { logger } from '../../lib/logger.js';
import type { ParsedVat } from '../../vat/parse.js';
import { names, pick, type Candidate, type Preference } from './pick.js';
import type { SourceTrace } from '../trace.js';
import { asDay, today, type CompanyStatement, type StatementInput, type StoredStatement } from '../types.js';
import type {
  BulkSourceAdapterInterface,
  LiveAnswer,
  LiveSourceAdapterInterface,
  SourceFailure,
} from '../sources/types.js';

/**
 * A country is a list of sources and a rule for reading them.
 *
 * Countries are declarations against one class. A country that needs something special says so in
 * its options (Greece asks one register after VIES).
 *
 * The rule, the same for every country:
 *
 * - a bulk source is only read from storage. Its statements never expire: the latest file is the
 *   most recent thing the register said.
 * - a live source is read from storage too, and asked again only when its statement is older than
 *   `LIVE_MAX_AGE_DAYS`. A stored VIES answer is the VIES cache.
 */

const countryLogger = logger.child({ component: 'country' });

/** What a resolution gives the country for one lookup. */
export interface ResolveContext {
  deadline: number;
  trace: SourceTrace;
  /**
   * What the caller wants favoured (`?prefer`), `completeness` by default.
   *
   * `proof`: only sources that issue a proof are asked, a statement with a proof beats any without,
   * and an answer without one is reported as unavailable.
   *
   * `completeness`: every source of the country, and the most complete answer wins.
   */
  prefer: Preference;
  /**
   * Whether the caller wants the history (`?history`).
   *
   * Read here because it changes the query: `resolveAll` reads every plateau, or only the newest.
   * The single lookup reads the history separately, once it knows which source won.
   */
  history: boolean;
}

/**
 * What a country concluded. A number reported as unregistered is final, an outage is worth
 * retrying, and a number nothing holds is neither.
 */
export type CountryVerdict =
  | { status: 'found'; statement: CompanyStatement; consulted: string[] }
  /**
   * `checkedAt` is only present when this request made the call. An answer from storage gets the
   * plateau's date instead.
   */
  | { status: 'not-registered'; statement: CompanyStatement; checkedAt?: Date; consulted: string[] }
  | { status: 'unavailable'; failure: SourceFailure; consulted: string[] }
  | { status: 'not-found'; consulted: string[] };

/** One source's history, plus the call made now when the history was stale. */
export interface SourceHistory {
  source: string;
  name: string;
  /**
   * How the register is reached: a file we import, an endpoint we call, or `both`.
   *
   * One entry per register, not per adapter: PRH's dump and API share an `id` and one history.
   */
  kind: 'bulk' | 'live' | 'both';
  /**
   * The live call made by this report, if any. Present with `status: 'unavailable'` when the source
   * could not be reached.
   */
  call?: LiveAnswer;
  /** Oldest first. Empty for a source that never said anything about this number. */
  history: StoredStatement[];
}

export interface AllReport {
  /** One entry per source the country declares. */
  sources: SourceHistory[];
}

export interface CountryAdapterInterface {
  /** VAT prefix as normalized by the parser: `EL`, never `GR`. */
  readonly code: string;
  /** English name of the country, for the CLI and `GET /v1/countries`. */
  readonly name: string;
  readonly bulkSources: readonly BulkSourceAdapterInterface[];
  readonly liveSources: readonly LiveSourceAdapterInterface[];
  /** Why this country imports nothing, if so. Printed by `import -- all`. */
  readonly importNote: string | null;
  /** One answer: storage, then the live sources that need asking, then a choice. */
  resolve(vat: ParsedVat, context: ResolveContext): Promise<CountryVerdict>;
  /** Everything every source has said, plus a call to each stale live source. */
  resolveAll(vat: ParsedVat, context: ResolveContext): Promise<AllReport>;
}

export interface CountryOptions {
  code: string;
  name: string;
  /** Sources only read from storage. Order does not matter. */
  bulk?: BulkSourceAdapterInterface[];
  /** Live sources, in the order the country wants them asked. */
  live?: LiveSourceAdapterInterface[];
  /**
   * Live sources only asked when the ones above returned nothing.
   *
   * For a register slower than the one in front of it: GEMI takes about 2.3 s to search by AFM,
   * VIES 0.3 s.
   */
  lateLive?: LiveSourceAdapterInterface[];
  importNote?: string;
}

/** How old a live source's stored statement may be before it is asked again. */
function staleBefore(): Date {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - config.lookup.liveMaxAgeDays);
  return asDay(cutoff);
}

export class BaseCountryAdapter implements CountryAdapterInterface {
  readonly code: string;
  readonly name: string;
  readonly bulkSources: readonly BulkSourceAdapterInterface[];
  readonly liveSources: readonly LiveSourceAdapterInterface[];
  readonly importNote: string | null;
  private readonly early: readonly LiveSourceAdapterInterface[];
  private readonly late: readonly LiveSourceAdapterInterface[];

  constructor(options: CountryOptions) {
    this.code = options.code;
    this.name = options.name;
    this.bulkSources = options.bulk ?? [];
    this.early = options.live ?? [];
    this.late = options.lateLive ?? [];
    this.liveSources = [...this.early, ...this.late];
    this.importNote = options.importNote ?? null;
  }

  /** Every source that can produce a row. */
  protected get sourceIds(): string[] {
    return [...new Set([...this.bulkSources, ...this.liveSources].map((source) => source.id))];
  }

  /**
   * The live sources usable for this call: configured, and able to issue a proof under
   * `?prefer=proof`.
   */
  protected usable(
    sources: readonly LiveSourceAdapterInterface[],
    context: ResolveContext,
  ): LiveSourceAdapterInterface[] {
    return sources.filter((source) => source.available && (context.prefer !== 'proof' || source.issuesProof));
  }

  async resolve(vat: ParsedVat, context: ResolveContext): Promise<CountryVerdict> {
    // A proof lookup skips storage: a stored row carries no proof that a check was made today.
    const stored = context.prefer === 'proof' ? new Map<string, StoredStatement>() : await this.storedFor(vat, context);
    const cutoff = staleBefore();
    const candidates: Candidate[] = [];

    // Everything storage already answers. Bulk statements never expire, live ones only count while
    // fresh.
    for (const source of this.bulkSources) {
      const statement = stored.get(source.id);
      if (statement) candidates.push({ statement, stored: true, bulk: true });
    }
    const live = [...this.usable(this.early, context), ...this.usable(this.late, context)];
    for (const source of live) {
      const statement = stored.get(source.id);
      // `dateEnd`, not `dateStart`: a plateau opened in June and confirmed since is fresh.
      if (statement && statement.dateEnd >= cutoff) candidates.push({ statement, stored: true, bulk: false });
    }

    // If storage already names the company, no live call is needed. A stored `not_registered` does not
    // count: the source is asked again in case it changed.
    let failure: SourceFailure | null = null;
    if (!this.answers(candidates)) {
      for (const source of live) {
        const held = stored.get(source.id);
        // Skipped above because it was fresh.
        if (held && held.dateEnd >= cutoff) continue;

        const answer = await source.fetch(vat, context);
        const statement = await this.persist(vat, source.id, answer);
        if (statement) {
          const checkedAt =
            answer.status === 'unavailable' || answer.status === 'not-found' ? undefined : answer.checkedAt;
          candidates.push({ statement, stored: false, bulk: false, checkedAt });
          if (this.answers(candidates)) break;
          continue;
        }

        if (answer.status === 'unavailable') {
          failure ??= answer.failure;
          // The source did not answer, but an old answer beats none. `date` tells the caller how old it is.
          if (held) candidates.push({ statement: held, stored: true, bulk: false });
        }
      }
    }

    return this.conclude(candidates, failure, context);
  }

  /**
   * Whether the walk can stop: a source returned a company name.
   *
   * Two answers do not stop it, though both are kept:
   *
   * - `not_registered`: the next source should still be asked;
   * - a positive answer without a name: VIES's `valid` with every field null, normal for Germany and
   *   Spain. The register behind it may have the full record.
   */
  private answers(candidates: Candidate[]): boolean {
    return candidates.some((candidate) => names(candidate.statement));
  }

  private conclude(candidates: Candidate[], failure: SourceFailure | null, context: ResolveContext): CountryVerdict {
    const consulted = context.trace.consulted;
    const winner = pick(candidates, context.prefer);

    if (!winner) {
      // Nothing answered. An outage is reported as such and can be retried. A plain miss is final.
      return failure ? { status: 'unavailable', failure, consulted } : { status: 'not-found', consulted };
    }

    // A proof was asked and the answer has none. Reported as unavailable, since it says nothing about
    // the number.
    if (context.prefer === 'proof' && !winner.statement.proof) {
      return {
        status: 'unavailable',
        failure: failure ?? { fault: 'NO_CONSULTATION_NUMBER', attempts: winner.stored ? 0 : 1 },
        consulted,
      };
    }

    return winner.statement.status === 'not_registered'
      ? { status: 'not-registered', statement: winner.statement, checkedAt: winner.checkedAt, consulted }
      : { status: 'found', statement: winner.statement, consulted };
  }

  async resolveAll(vat: ParsedVat, context: ResolveContext): Promise<AllReport> {
    // `?history=false` skips the full history query and only reads the current plateau.
    const history = context.history
      ? await historyBySource(vat.formatted, this.sourceIds)
      : new Map<string, StoredStatement[]>(
          [...(await latestBySource(vat.formatted, this.sourceIds))].map(([id, row]) => [id, [row]]),
        );
    const cutoff = staleBefore();

    // Every stale live source is asked at once, without short-circuit: the report shows what each
    // source said.
    const calls = new Map<string, Promise<LiveAnswer>>();
    for (const source of this.liveSources) {
      if (!source.available) continue;
      const latest = history.get(source.id)?.at(-1);
      if (latest && latest.dateEnd >= cutoff) continue;
      calls.set(source.id, source.fetch(vat, context));
    }
    const answered = new Map(await Promise.all([...calls].map(async ([id, call]) => [id, await call] as const)));

    // Add the statements from those calls to the history.
    for (const [id, answer] of answered) {
      const statement = await this.persist(vat, id, answer);
      if (!statement) continue;
      // The call extended the newest plateau or opened one, so use what the write returned.
      const entries = (history.get(id) ?? []).filter(
        (row) => row.dateStart.getTime() !== statement.dateStart.getTime(),
      );
      entries.push({ ...statement, bulk: null });
      history.set(id, entries);
    }

    // One entry per register in a stable order: imported ones first, then live-only ones. A register
    // that is both is listed once, with the bulk ones.
    const bulk = new Map(this.bulkSources.map((source) => [source.id, source]));
    const live = new Map(this.liveSources.filter((source) => source.available).map((source) => [source.id, source]));
    const ids = [...new Set([...bulk.keys(), ...live.keys()])];

    return {
      sources: ids.map((id) => {
        const source = bulk.get(id) ?? live.get(id)!;
        const kind = bulk.has(id) && live.has(id) ? 'both' : bulk.has(id) ? 'bulk' : 'live';
        return {
          source: id,
          name: source.name,
          kind,
          ...(answered.has(id) ? { call: answered.get(id)! } : {}),
          history: history.get(id) ?? [],
        };
      }),
    };
  }

  /** The newest stored row per source, timed but not listed as a source. */
  private async storedFor(vat: ParsedVat, context: ResolveContext): Promise<Map<string, StoredStatement>> {
    context.trace.measure('stored');
    try {
      return await latestBySource(vat.formatted, this.sourceIds);
    } finally {
      context.trace.end('stored');
    }
  }

  /**
   * Turns a live answer into a statement and stores it.
   *
   * `not-found` is not stored: the register made no claim. `not-registered` is stored, since it is
   * a dated claim.
   *
   * A positive answer without a name is stored too. Germany and Spain return name and address as
   * null through VIES, and that is their normal answer. `pick()` weights a name at 10, so any named
   * statement still wins. Importers drop nameless rows from bulk files, where they are defects.
   */
  private async persist(vat: ParsedVat, source: string, answer: LiveAnswer): Promise<CompanyStatement | null> {
    if (answer.status === 'not-found' || answer.status === 'unavailable') return null;

    const input: StatementInput =
      answer.status === 'found'
        ? { ...answer.record, source, date: today(), bulkId: null, proof: answer.proof ?? null }
        : {
            vatNumber: vat.formatted,
            nationalId: null,
            name: null,
            legalForm: null,
            status: 'not_registered',
            addressLine1: null,
            addressLine2: null,
            postalCode: null,
            city: null,
            addressCountry: null,
            // Not `answer.checkedAt`: this column is when the register last updated the record, and a "not
            // registered" answer has no record. The consultation time travels on the verdict.
            companyLastUpdatedAt: null,
            source,
            date: today(),
            bulkId: null,
            proof: answer.proof ?? null,
          };

    // The stored plateau rather than the input, since `dateStart` may be older than today.
    //
    // A failed write is logged and the answer still returned.
    return recordStatement(input).catch((error: unknown) => {
      countryLogger.error({ err: error, source, vatNumber: vat.formatted }, 'failed to store a statement');
      return { ...input, dateStart: input.date, dateEnd: input.date };
    });
  }
}
