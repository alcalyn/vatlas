/**
 * The meaning of a lookup answer, shared by both places that show one.
 *
 * The console renders HTML on the server and the site builds it in the browser. Both use this
 * module to agree on which fields matter, in which order, which verdict is green or red, and what
 * changed between two plateaus. It produces a list of things to show and says nothing about markup
 * (see `./lookupHtml.ts`).
 *
 * It must import nothing. `src/api/types.ts` imports the generated Prisma client, which a browser
 * bundle cannot include, so the shapes below are declared again from what `serialize()` and
 * `serializeAll()` send (`src/api/serialize.ts`).
 *
 * Every label is an i18n key, never a translated string: the console translates per request and
 * the site at build time.
 */

// -- vocabulary --

/**
 * How a verdict reads at a glance.
 *
 * `warn` is declared but never used: the API publishes no confidence measure, so there is nothing
 * to raise it on yet.
 */
export type Tone = 'ok' | 'bad' | 'neutral' | 'warn';

/** One line of the formatted view: an i18n key and the value. */
export interface Field {
  /** Key under `fmt`: `fmt.name`, `fmt.postalCode`... */
  key: string;
  /** A string, or null when the source published nothing. */
  value: string | null;
  /** An identifier: rendered in monospace. */
  mono?: boolean;
  /** A `YYYY-MM-DD` day or an ISO instant, for the renderer to localize. */
  date?: 'day' | 'instant';
}

/** The header: what the answer says about the number, in one line. */
export interface Verdict {
  tone: Tone;
  /** Key under `fmt`: `fmt.verdictActive`, `fmt.verdictNotRegistered`... */
  key: string;
  /**
   * Why, when the verdict needs explaining: an unknown status. The API's own error message goes in
   * `reason` instead.
   */
  reasonKey?: string;
  /** The API's `error.message`, as is. Never translated: it is stored in the audit trail. */
  reason?: string;
}

/** The proof of a consultation, as in `meta.proof`. */
export interface Proof {
  type: string;
  value: string;
}

/** The company as a record: name and legal form, identifiers, address block. */
export interface CompanyCard {
  /**
   * Null when the payload had no name, `''` when the source discloses none (Germany and Spain through
   * VIES).
   */
  name: string | null;
  legalForm: string | null;
  /** The number and the national identifier. */
  identifiers: Field[];
  /** The address as written on an envelope, one line per line. */
  address: string[];
  /** Separate from `address`: a code, not always the country of the number. */
  country: string | null;
}

/** A plain lookup (`/v1/lookup/:n`, with or without `?prefer=proof`), ready to render. */
export interface LookupView {
  kind: 'lookup';
  verdict: Verdict;
  /** The answering register: `SIRENE`, `VIES`... Null on an error. */
  source: string | null;
  proof?: Proof;
  /** The company. Empty on an error. */
  company: CompanyCard;
  /** Provenance and freshness. Empty on an error. */
  provenance: Field[];
  /** Present when the API answered with an error envelope. */
  error?: { code: string; message: string; reason?: string };
}

/** One plateau of a source's history. */
export interface PlateauView {
  /** First day the source was seen saying this. */
  from: string;
  /** Last day it was seen saying this. Equal to `from` when seen once. */
  to: string;
  tone: Tone;
  /** Key for the plateau's `status`, under `fmt`. */
  statusKey: string;
  /** What the source said over this period, in full. */
  company: CompanyCard;
  /** What changed against the previous plateau of the same source. Empty on the first one. */
  changes: Change[];
  file?: { name: string; url: string };
  /**
   * When the register last updated the record, as an ISO instant, if it publishes that. Not the same
   * as `from`/`to`, which are when we saw the statement.
   */
  sourceUpdatedAt?: string;
  proof?: Proof;
}

/** One field that changed between two consecutive plateaus. */
export interface Change {
  key: string;
  before: string | null;
  after: string | null;
}

/** The result of the live call this report made, if any. */
export interface CallView {
  tone: Tone;
  /** Key under `fmt`: `fmt.callFound`, `fmt.callUnavailable`... */
  key: string;
  checkedAt?: string;
  proof?: Proof;
  /** On an `unavailable` call: what went wrong and how many attempts. */
  error?: { code: string; message: string; fault?: string; attempts?: number };
}

/** One register and its whole history. */
export interface SourceView {
  source: string;
  /** The register's name as its publisher writes it. */
  name: string;
  /** Key under `fmt` for `bulk` / `live` / `both`. */
  kindKey: string;
  call?: CallView;
  /** Oldest first, as the API publishes it. */
  history: PlateauView[];
}

/** Every source's answer: `/v1/lookup-all/:n`. */
export interface AllView {
  kind: 'all';
  vatNumber: string;
  countryCode: string;
  nationalNumber: string;
  sources: SourceView[];
  /** Present when the report could not be produced (malformed number). */
  error?: { code: string; message: string; reason?: string };
}

// -- plain lookup --

/**
 * `data.status` alone decides the header.
 *
 * `unknown` is neutral, not a warning: it is what a self-declared directory like Peppol gives.
 */
const STATUS_TONE: Record<string, Tone> = {
  active: 'ok',
  inactive: 'bad',
  not_registered: 'bad',
  unknown: 'neutral',
};

/** `active` -> `fmt.statusActive`. The four `CompanyStatus` values. */
const STATUS_KEY: Record<string, string> = {
  active: 'statusActive',
  inactive: 'statusInactive',
  not_registered: 'statusNotRegistered',
  unknown: 'statusUnknown',
};

/**
 * An error is not always a failure. `404 VAT_NOT_REGISTERED` is a definitive answer and reads red;
 * a `503` says nothing about the number and is neutral.
 */
const ERROR_TONE: Record<string, Tone> = {
  VAT_NOT_REGISTERED: 'bad',
  INVALID_VAT_FORMAT: 'bad',
  COMPANY_NOT_FOUND: 'neutral',
  SOURCE_UNAVAILABLE: 'neutral',
  PROOF_UNAVAILABLE: 'neutral',
  DEMO_LIMIT_REACHED: 'neutral',
};

/** Header key for an error code. Unknown codes fall back to `fmt.verdictError`. */
const ERROR_KEY: Record<string, string> = {
  VAT_NOT_REGISTERED: 'verdictNotRegistered',
  INVALID_VAT_FORMAT: 'verdictInvalid',
  COMPANY_NOT_FOUND: 'verdictNotFound',
  SOURCE_UNAVAILABLE: 'verdictUnavailable',
  PROOF_UNAVAILABLE: 'verdictNoProof',
  DEMO_LIMIT_REACHED: 'verdictLimited',
};

/**
 * Any response, success or error, as the formatted tab shows it.
 *
 * Takes the status too: the two 404s and two 503s are told apart by code, and a body that did not
 * parse must still show something.
 */
export function presentLookup(status: number, body: unknown): LookupView {
  const envelope = asRecord(body) ?? {};
  const error = asRecord(envelope.error);

  if (error || status >= 400) {
    const code = str(error?.code) ?? 'INTERNAL_ERROR';
    const message = str(error?.message) ?? '';
    const reason = str(error?.reason) ?? undefined;
    const meta = asRecord(envelope.meta) ?? {};
    // A `VAT_NOT_REGISTERED` carries when the check was made and the consultation number. Keep both.
    const proof = proofOf(meta.proof);

    return {
      kind: 'lookup',
      verdict: {
        tone: ERROR_TONE[code] ?? 'bad',
        key: ERROR_KEY[code] ?? 'verdictError',
        // The API's own sentence, not translated: it is stored as is in the audit trail.
        ...(message ? { reason: message } : {}),
      },
      source: null,
      ...(proof ? { proof } : {}),
      company: emptyCard(),
      provenance: provenanceOf(meta),
      error: { code, message, ...(reason ? { reason } : {}) },
    };
  }

  const data = asRecord(envelope.data) ?? {};
  const meta = asRecord(envelope.meta) ?? {};
  const companyStatus = str(data.status) ?? 'unknown';
  const proof = proofOf(meta.proof);

  return {
    kind: 'lookup',
    verdict: {
      tone: STATUS_TONE[companyStatus] ?? 'neutral',
      key: STATUS_KEY[companyStatus] ?? 'statusUnknown',
      // The only status that needs explaining: a company no register certified.
      ...(companyStatus === 'unknown' ? { reasonKey: 'reasonUnknown' } : {}),
    },
    source: str(meta.source) ?? null,
    ...(proof ? { proof } : {}),
    company: companyCard(data),
    provenance: provenanceOf(meta),
  };
}

/** An empty card, for errors. */
function emptyCard(): CompanyCard {
  return { name: null, legalForm: null, identifiers: [], address: [], country: null };
}

/**
 * The company as a record.
 *
 * `name` is kept even when empty, other fields are dropped when the source published nothing.
 * Germany and Spain disclose no name through VIES, and the blank name is their answer.
 */
function companyCard(data: Record<string, unknown>): CompanyCard {
  const address = asRecord(data.address) ?? {};

  const identifiers: Field[] = [
    { key: 'vatNumber', value: str(data.vatNumber), mono: true },
    { key: 'nationalId', value: str(data.nationalId), mono: true },
  ].filter((field) => field.value !== null);

  return {
    name: str(data.name) ?? '',
    legalForm: str(data.legalForm),
    identifiers,
    address: addressLines(address),
    country: str(address.country),
  };
}

/**
 * The address as written on an envelope.
 *
 * Postal code and town are only joined when present: Poland puts the whole address in `line1` and
 * leaves the rest null.
 */
function addressLines(address: Record<string, unknown>): string[] {
  const town = [str(address.postalCode), str(address.city)].filter(Boolean).join(' ');
  return [str(address.line1), str(address.line2), town].filter((line): line is string => Boolean(line));
}

/**
 * The card flattened back to labelled values, to diff two plateaus field by field (otherwise a
 * postal code change would show as a whole new address).
 */
function comparable(card: CompanyCard, data: Record<string, unknown>): Field[] {
  const address = asRecord(data.address) ?? {};

  const fields: Field[] = [
    { key: 'name', value: card.name },
    { key: 'legalForm', value: card.legalForm },
    { key: 'nationalId', value: str(data.nationalId) },
    { key: 'addressLine1', value: str(address.line1) },
    { key: 'addressLine2', value: str(address.line2) },
    { key: 'postalCode', value: str(address.postalCode) },
    { key: 'city', value: str(address.city) },
    { key: 'addressCountry', value: card.country },
  ];

  return fields.filter((field) => field.value !== null && field.value !== '');
}

/**
 * Provenance and freshness (`meta` minus the source, already in the header).
 *
 * `sourceSince` only shows when it differs from `sourceDate`.
 */
function provenanceOf(meta: Record<string, unknown>): Field[] {
  const date = str(meta.sourceDate);
  const since = str(meta.sourceSince);

  const fields: Field[] = [
    { key: 'sourceDate', value: date, date: 'day' },
    { key: 'sourceSince', value: since === date ? null : since, date: 'day' },
    { key: 'sourceUpdatedAt', value: str(meta.sourceUpdatedAt), date: 'instant' },
    { key: 'checkedAt', value: str(meta.checkedAt), date: 'instant' },
  ];

  return fields.filter((field) => field.value !== null);
}

// -- lookup-all --

/** `bulk` -> `fmt.kindBulk`. Four registers are `both`: a file and an API. */
const KIND_KEY: Record<string, string> = {
  bulk: 'kindBulk',
  live: 'kindLive',
  both: 'kindBoth',
};

/** The result of the live call made by this request, using `serializeCall`'s values. */
const CALL: Record<string, { tone: Tone; key: string }> = {
  found: { tone: 'ok', key: 'callFound' },
  'not-registered': { tone: 'bad', key: 'callNotRegistered' },
  'not-found': { tone: 'neutral', key: 'callNotFound' },
  unavailable: { tone: 'neutral', key: 'callUnavailable' },
};

/**
 * Every source's answer, source by source.
 *
 * No overall verdict: the endpoint publishes no summary, and deciding which register is right is up
 * to the caller.
 */
export function presentAll(body: unknown): AllView {
  const envelope = asRecord(body) ?? {};
  const error = asRecord(envelope.error);

  if (error) {
    const reason = str(error.reason) ?? undefined;
    return {
      kind: 'all',
      vatNumber: '',
      countryCode: '',
      nationalNumber: '',
      sources: [],
      error: {
        code: str(error.code) ?? 'INTERNAL_ERROR',
        message: str(error.message) ?? '',
        ...(reason ? { reason } : {}),
      },
    };
  }

  const data = asRecord(envelope.data) ?? {};
  const sources = Array.isArray(data.sources) ? data.sources : [];

  return {
    kind: 'all',
    vatNumber: str(data.vatNumber) ?? '',
    countryCode: str(data.countryCode) ?? '',
    nationalNumber: str(data.nationalNumber) ?? '',
    sources: sources.map((source) => presentSource(source)),
  };
}

/**
 * One item of `/v1/lookup-all`, in the lookup shape: the register in `meta`, the company in `data`
 * (or an `error`), and its history. No `history` with `?history=false`.
 */
function presentSource(raw: unknown): SourceView {
  const source = asRecord(raw) ?? {};
  const meta = asRecord(source.meta) ?? {};
  const call = asRecord(meta.call);
  const history = Array.isArray(source.history) ? source.history : [];

  return {
    source: str(meta.source) ?? '',
    name: str(meta.name) ?? '',
    kindKey: KIND_KEY[str(meta.kind) ?? ''] ?? 'kindLive',
    ...(call ? { call: presentCall(call) } : {}),
    history: presentHistory(history),
  };
}

function presentCall(call: Record<string, unknown>): CallView {
  const status = str(call.status) ?? 'unavailable';
  const verdict = CALL[status] ?? CALL.unavailable!;
  const error = asRecord(call.error);
  const proof = proofOf(call.proof);

  return {
    tone: verdict.tone,
    key: verdict.key,
    ...(str(call.checkedAt) ? { checkedAt: str(call.checkedAt)! } : {}),
    ...(proof ? { proof } : {}),
    ...(error
      ? {
          error: {
            code: str(error.code) ?? 'SOURCE_UNAVAILABLE',
            message: str(error.message) ?? '',
            ...(str(error.fault) ? { fault: str(error.fault)! } : {}),
            ...(typeof error.attempts === 'number' ? { attempts: error.attempts } : {}),
          },
        }
      : {}),
  };
}

/**
 * The plateaus, oldest first, each with what it changed against the previous one.
 *
 * Computed here so both renderers show the same diff. It compares the fields `companyFields`
 * publishes, so a new field appears in both the detail and the diff.
 */
function presentHistory(history: unknown[]): PlateauView[] {
  let previous: Field[] | null = null;

  return history.map((raw) => {
    const entry = asRecord(raw) ?? {};
    const status = str(entry.status) ?? 'unknown';
    const from = str(entry.from) ?? '';
    // A plateau in the shape of a lookup's `data`, without the number.
    const card = companyCard(entry);
    card.identifiers = card.identifiers.filter((field) => field.key !== 'vatNumber');
    const comparison = comparable(card, entry);
    const file = asRecord(entry.file);
    const proof = proofOf(entry.proof);

    const plateau: PlateauView = {
      from,
      to: str(entry.to) ?? from,
      tone: STATUS_TONE[status] ?? 'neutral',
      statusKey: STATUS_KEY[status] ?? 'statusUnknown',
      company: card,
      changes: previous ? diff(previous, comparison) : [],
      ...(file && str(file.name) ? { file: { name: str(file.name)!, url: str(file.url) ?? '' } } : {}),
      ...(str(entry.sourceUpdatedAt) ? { sourceUpdatedAt: str(entry.sourceUpdatedAt)! } : {}),
      ...(proof ? { proof } : {}),
    };

    previous = comparison;
    return plateau;
  });
}

/**
 * The fields that differ between two consecutive plateaus, in display order.
 *
 * A field present in one and missing from the other counts as a change, hence the union of both
 * key sets.
 */
function diff(before: Field[], after: Field[]): Change[] {
  const byKey = (fields: Field[]): Map<string, string | null> =>
    new Map(fields.map((field) => [field.key, field.value]));

  const left = byKey(before);
  const right = byKey(after);
  const keys = [...after.map((f) => f.key), ...before.map((f) => f.key).filter((key) => !right.has(key))];

  const changes: Change[] = [];
  for (const key of keys) {
    const from = left.get(key) ?? null;
    const to = right.get(key) ?? null;
    if (from !== to) changes.push({ key, before: from, after: to });
  }
  return changes;
}

// -- reading untrusted payloads --

/**
 * The body is untrusted: the site restores answers from `localStorage`, which may hold anything.
 * Unknown shapes are dropped rather than thrown on.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `meta.proof` when valid, nothing otherwise (every non-VIES answer). */
function proofOf(value: unknown): Proof | undefined {
  const proof = asRecord(value);
  const type = str(proof?.type);
  const val = str(proof?.value);
  return type && val ? { type, value: val } : undefined;
}
