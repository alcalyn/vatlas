/**
 * The markup of a lookup answer, shared by every place that shows one.
 *
 * `./lookupView.ts` decides what an answer means (verdict tone, which fields, what changed between
 * plateaus). This module turns a `LookupView` or `AllView` into HTML. The hosts (the console's
 * `views.ts` and the site's `tryit.js`) only provide translations and date formatting.
 *
 * It must only import types: the site bundles it for the browser, and a runtime import reaching
 * Prisma or `node:` would break the page. Same rule as `./lookupView.ts`.
 *
 * The class names are shared with `site/src/styles/pages.css` and `src/console/styles.ts`. Rename
 * in both.
 */

import type {
  CallView,
  Change,
  CompanyCard,
  Field,
  AllView,
  LookupView,
  PlateauView,
  Proof,
  SourceView,
  Tone,
} from './lookupView.js';

/**
 * What a host provides: its translations and date formatting.
 *
 * `label` takes an `fmt` key (`statusActive`, `proofNumber`) and returns the string, or the key
 * itself when missing, which {@link translated} checks.
 */
export interface AnswerContext {
  /** An `fmt` key -> the reader's language. */
  label(key: string): string;
  /** A `YYYY-MM-DD` day -> the reader's locale. */
  day(value: string): string;
  /** An ISO instant -> the reader's locale, to the minute. */
  instant(value: string): string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const label = (ctx: AnswerContext, key: string): string => escapeHtml(ctx.label(key));

/**
 * Whether the host has a string for this key.
 *
 * Both hosts return the key itself when missing (i18next returns `fmt.proofTypeFoo`, the site
 * `proofTypeFoo`), so a value ending with the key is a miss and the caller falls back to something
 * readable.
 */
function translated(ctx: AnswerContext, key: string): string | null {
  const text = ctx.label(key);
  return text && text !== key && !text.endsWith(`.${key}`) ? text : null;
}

/** `ok` -> green band and check mark, `bad` -> red band and cross. */
const TONE_CLASS: Record<Tone, string> = {
  ok: 'verdict--ok',
  bad: 'verdict--bad',
  warn: 'verdict--warn',
  neutral: '',
};

/** The same tones as a badge, for a plateau or a live call in a report. */
const TONE_BADGE: Record<Tone, string> = {
  ok: 'badge badge--ok',
  bad: 'badge badge--danger',
  warn: 'badge badge--warn',
  neutral: 'badge',
};

/** A check mark, cross or dash, drawn so the band reads before the words. */
const VERDICT_MARK: Record<Tone, string> = {
  ok: '<polyline points="4 12.5 9.5 18 20 6"/>',
  bad: '<line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/>',
  warn: '<path d="M12 3.5 22 20H2z"/><line x1="12" y1="10" x2="12" y2="14.5"/><line x1="12" y1="17" x2="12" y2="17"/>',
  neutral: '<line x1="5" y1="12" x2="19" y2="12"/>',
};

/** A shield with a check mark. */
const PROOF_MARK =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3 20 6v6c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6z"/>' +
  '<polyline points="8.6 12 11 14.4 15.4 9.6"/></svg>';

// -- whole answer --

/** Either kind of answer. */
export function renderAnswer(view: LookupView | AllView, ctx: AnswerContext): string {
  return view.kind === 'all' ? renderAllAnswer(view, ctx) : renderLookupAnswer(view, ctx);
}

/**
 * A plain lookup: verdict at the top, the company below with its proof, and the provenance as a
 * footer.
 */
export function renderLookupAnswer(view: LookupView, ctx: AnswerContext): string {
  return `${verdictBand(view, ctx)}
  ${companyCard(view.company, ctx)}
  ${view.proof ? proofBlock(view.proof, ctx) : ''}
  ${view.provenance.length > 0 ? provenanceStrip(view.provenance, ctx) : ''}`;
}

function verdictBand(view: LookupView, ctx: AnswerContext): string {
  const { verdict } = view;
  const mark =
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${VERDICT_MARK[verdict.tone]}</svg>`;

  // `reasonKey` is ours to translate. `reason` is the API's own sentence, stored as is in the audit
  // trail, so it is never reworded.
  const why = verdict.reasonKey
    ? `<p class="verdict__why">${label(ctx, verdict.reasonKey)}</p>`
    : verdict.reason
      ? `<p class="verdict__why">${escapeHtml(verdict.reason)}</p>`
      : '';

  // The register next to the verdict, since the source is part of what the verdict means.
  const badges = [
    view.source ? `<span class="badge">${escapeHtml(view.source)}</span>` : '',
    view.proof ? `<span class="badge badge--ok">${label(ctx, 'proof')}</span>` : '',
  ].join('');

  return `<div class="verdict ${TONE_CLASS[verdict.tone]}">
    <div class="verdict__line">
      <span class="verdict__mark">${mark}</span>
      <span class="verdict__label">${label(ctx, verdict.key)}</span>
      ${badges}
    </div>
    ${why}
  </div>`;
}

/**
 * The consultation number, as a sealed block.
 *
 * It is the part of an answer used later to prove the check was made, so it gets its own block with
 * the accent color, the same everywhere an answer has one.
 *
 * The heading is the translated proof type (a VIES consultation number), since the type says which
 * authority the number is valid for. An unknown type falls back to the generic heading.
 */
export function proofBlock(proof: Proof, ctx: AnswerContext): string {
  const heading = translated(ctx, proofTypeKey(proof.type)) ?? ctx.label('proofNumber');

  return `<div class="proof">
    <span class="proof__mark">${PROOF_MARK}</span>
    <div class="proof__body">
      <p class="proof__label">${escapeHtml(heading)}</p>
      <p class="proof__value">${escapeHtml(proof.value)}</p>
      <p class="proof__hint">${label(ctx, 'proofHint')}</p>
    </div>
  </div>`;
}

/** `vies_consultation_number` -> `proofTypeViesConsultationNumber`, an `fmt` key. */
export function proofTypeKey(type: string): string {
  const camel = type
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
  return `proofType${camel}`;
}

/**
 * The company as a record: name as heading, legal form below, identifiers, and the address as
 * written on an envelope.
 */
export function companyCard(company: CompanyCard, ctx: AnswerContext): string {
  if (company.name === null && company.identifiers.length === 0 && company.address.length === 0) return '';

  // An empty name is not a missing one: Germany and Spain disclose none through VIES. Say so rather
  // than leave a blank.
  const name =
    company.name === ''
      ? `<p class="card__name card__name--none">${label(ctx, 'nameUndisclosed')}</p>`
      : `<p class="card__name">${escapeHtml(company.name ?? '')}</p>`;

  const identifiers = company.identifiers
    .map(
      (field) =>
        `<span class="card__id"><b>${label(ctx, field.key)}</b> ` +
        `<code class="key">${escapeHtml(field.value ?? '')}</code></span>`,
    )
    .join('');

  const address = company.address.length
    ? `<div class="card__block"><h4>${label(ctx, 'address')}</h4>` +
      `<address>${company.address.map((line) => escapeHtml(line)).join('<br>')}` +
      `${company.country ? `<br><span class="dim">${escapeHtml(company.country)}</span>` : ''}</address></div>`
    : '';

  return `<div class="card">
    <div class="card__head">
      ${name}
      ${company.legalForm ? `<p class="card__form">${escapeHtml(company.legalForm)}</p>` : ''}
    </div>
    ${identifiers ? `<div class="card__ids">${identifiers}</div>` : ''}
    ${address}
  </div>`;
}

/** Provenance and freshness, as a footer. */
function provenanceStrip(fields: Field[], ctx: AnswerContext): string {
  const items = fields
    .map((field) => `<span><b>${label(ctx, field.key)}</b> ${fieldValue(field, ctx)}</span>`)
    .join('');
  return `<div class="card__meta"><h4>${label(ctx, 'provenance')}</h4><div class="facts">${items}</div></div>`;
}

/**
 * A value: localized if it is a date, shown as is otherwise, and a dash when the source published
 * nothing.
 *
 * `presentLookup` keeps `name` even when blank, since that is the answer for two countries.
 */
function fieldValue(field: Field, ctx: AnswerContext): string {
  const value = field.value ?? '';
  if (value === '') return '<span class="dim">-</span>';
  if (field.date === 'day') return escapeHtml(ctx.day(value));
  if (field.date === 'instant') return escapeHtml(ctx.instant(value));
  return escapeHtml(value);
}

// -- lookup-all --

/** A lookup-all: one panel per register, each with its own timeline. */
export function renderAllAnswer(view: AllView, ctx: AnswerContext): string {
  if (view.error) return `<p class="answer__error">${escapeHtml(view.error.message)}</p>`;
  if (view.sources.length === 0) return `<p class="dim">${label(ctx, 'noSources')}</p>`;
  return `<div class="sources">${view.sources.map((source) => sourceBlock(source, ctx)).join('')}</div>`;
}

function sourceBlock(source: SourceView, ctx: AnswerContext): string {
  const history =
    source.history.length === 0
      ? `<p class="dim">${label(ctx, 'noHistory')}</p>`
      : // Newest first. The API publishes the history oldest-first, which is the right order to
        // Oldest first is how the history is stored, but readers want the current statement first. Reversed
        // here rather than in the view-model, so `changes` keeps meaning what changed when the entry
        // appeared.
        `<ol class="timeline">${source.history
          .map((plateau, index) =>
            plateauItem(
              plateau,
              { latest: index === source.history.length - 1, oldest: index === 0, kindKey: source.kindKey },
              ctx,
            ),
          )
          .reverse()
          .join('')}</ol>`;

  // The panel heading is the register's name only. How each statement was obtained (file or call) is
  // shown in that entry's provenance.
  //
  // A live call and the statement it produced share the same consultation number. The number is shown
  // on the statement in the timeline, and the call strip only shows one the history does not already
  // have.
  const dated = new Set(source.history.map((plateau) => plateau.proof?.value).filter(Boolean));
  const callProof = source.call?.proof && !dated.has(source.call.proof.value);

  return `<section class="source">
    <header class="source__head">
      <span class="source__prefix">${label(ctx, 'sourcePrefix')}</span>
      <code class="source__id">${escapeHtml(source.source)}</code>
      <span class="source__name dim">${escapeHtml(source.name)}</span>
    </header>
    ${source.call ? callStrip(source.call, ctx, Boolean(callProof)) : ''}
    ${history}
  </section>`;
}

/**
 * The result of the live call this report made, and its proof when the timeline does not already
 * show it, in the same sealed block as a plain lookup.
 */
function callStrip(call: CallView, ctx: AnswerContext, showProof: boolean): string {
  const facts = `<div class="facts">
    <span><b>${label(ctx, 'call')}</b> <span class="${TONE_BADGE[call.tone]}">${label(ctx, call.key)}</span></span>
    ${call.checkedAt ? `<span><b>${label(ctx, 'checkedAt')}</b> ${fieldValue({ key: 'checkedAt', value: call.checkedAt, date: 'instant' }, ctx)}</span>` : ''}
    ${call.error?.fault ? `<span><b>${label(ctx, 'fault')}</b> <code>${escapeHtml(call.error.fault)}</code></span>` : ''}
    ${typeof call.error?.attempts === 'number' ? `<span><b>${label(ctx, 'attempts')}</b> ${call.error.attempts}</span>` : ''}
  </div>`;

  return `${facts}${showProof && call.proof ? proofBlock(call.proof, ctx) : ''}`;
}

/**
 * One timeline entry: when, and what changed.
 *
 * The oldest entry shows the company as first described. Each later one shows the diff against the
 * entry before.
 */
function plateauItem(
  plateau: PlateauView,
  where: { latest: boolean; oldest: boolean; kindKey: string },
  ctx: AnswerContext,
): string {
  const day = (value: string): string => escapeHtml(ctx.day(value));
  const span = plateau.from === plateau.to ? day(plateau.from) : `${day(plateau.from)} → ${day(plateau.to)}`;

  const marks = [
    // Marks the current entry, since the list is read from newest to oldest.
    where.latest ? `<span class="badge badge--ok">${label(ctx, 'latest')}</span>` : '',
    plateau.proof ? `<span class="badge badge--ok">${label(ctx, 'proof')}</span>` : '',
  ].join('');

  // Where this statement came from, as text rather than a link: the URL downloads a whole register
  // dump.
  //
  // `sourceUpdatedAt` is here rather than next to the dates in the head: the head says when we saw
  // the statement, this says when the register last updated the record.
  const detail = [
    `<dt>${label(ctx, 'reachedBy')}</dt><dd>${label(ctx, where.kindKey)}</dd>`,
    plateau.sourceUpdatedAt
      ? `<dt>${label(ctx, 'sourceUpdatedAt')}</dt><dd>${escapeHtml(ctx.instant(plateau.sourceUpdatedAt))}</dd>`
      : '',
    plateau.file?.url ? `<dt>${label(ctx, 'fileUrl')}</dt><dd>${escapeHtml(plateau.file.url)}</dd>` : '',
    plateau.file ? `<dt>${label(ctx, 'fileName')}</dt><dd>${escapeHtml(plateau.file.name)}</dd>` : '',
  ].join('');
  const file = `<dl class="plateau__file">${detail}</dl>`;

  // The current entry shows the full company. Older entries only show what changed, except the
  // oldest, which shows the company as first described.
  const body = [
    where.latest || where.oldest ? companyCard(plateau.company, ctx) : '',
    plateau.changes.length > 0
      ? diffList(plateau.changes, day(plateau.from), ctx)
      : where.latest || where.oldest
        ? ''
        : `<p class="dim">${label(ctx, 'noChange')}</p>`,
    // The statement's own consultation number, shown where it sits.
    plateau.proof ? proofBlock(plateau.proof, ctx) : '',
  ].join('');

  return `<li class="timeline__item timeline__item--${plateau.tone}${where.latest ? ' timeline__item--latest' : ''}">
    <div class="timeline__head">
      <span class="timeline__when">${span}</span>
      <span class="${TONE_BADGE[plateau.tone]}">${label(ctx, plateau.statusKey)}</span>
      ${marks}
    </div>
    <div class="timeline__body">${body}${file}</div>
  </li>`;
}

/**
 * What a register changed, as a diff: old value struck through, new value below.
 *
 * `<del>` and `<ins>`, which screen readers announce as deletion and insertion.
 */
function diffList(changes: Change[], when: string, ctx: AnswerContext): string {
  const rows = changes
    .map((change) => {
      const before = change.before ? `<del>${escapeHtml(change.before)}</del>` : '';
      const after = change.after
        ? `<ins>${escapeHtml(change.after)}</ins>`
        : `<ins class="diff--none">${label(ctx, 'nothing')}</ins>`;
      return `<div class="diff">
      <span class="diff__field">${label(ctx, change.key)}</span>
      <span class="diff__values">${before}${after}</span>
    </div>`;
    })
    .join('');
  // Dated, with a heading, so the diff does not read as part of the company card above it.
  return `<div class="diffs">
    <p class="diffs__head"><b>${label(ctx, 'changedOn')}</b> ${when}</p>
    ${rows}
  </div>`;
}

// -- inspecting an answer --

/**
 * Whether an answer has a consultation number anywhere.
 *
 * A plain lookup has at most one (`meta.proof`). A lookup-all can have several (the live call, any
 * statement with a proof), and any one makes the answer provable. Read from the view rather than
 * the audit columns, which hold one proof at most.
 */
export function hasProof(view: LookupView | AllView): boolean {
  if (view.kind === 'lookup') return view.proof !== undefined;
  return view.sources.some(
    (source) => source.call?.proof !== undefined || source.history.some((plateau) => plateau.proof !== undefined),
  );
}
