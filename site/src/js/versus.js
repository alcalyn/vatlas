/**
 * The Vatlas vs VIES page. Every figure comes from /data/benchmark.bench-compare.json, the summary
 * of `npm run benchmark -- <list> --paired` copied into site/public/data/.
 *
 * A paired run looks each number up twice within a few hundred milliseconds, alternating which
 * side goes first: once through Vatlas, once directly on VIES.
 *
 * Every figure is shown the same way: VIES (red) and Vatlas (green) as two stacked bars, and the
 * gap as one number. Tables are sorted best first.
 */

/** Outcomes that count as an answer: found, or not registered. */
const ANSWERED = ['found', 'not-registered']

/** Below this, a gap is noise and is drawn neutral. */
const FLAT_POINTS = 0.05
const FLAT_FACTOR = 0.005

/** Completeness figures closer than this are shown as one approximate value. */
const CLOSE_POINTS = 1

const DATA_URL = '/data/benchmark.bench-compare.json'

/** `{date}` is a runtime placeholder, single braces so the build leaves it alone. */
const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))

/** How many of `outcomes` are an answer. */
const answered = (outcomes = {}) => ANSWERED.reduce((count, outcome) => count + (outcomes[outcome] || 0), 0)

export function initVersus() {
  const root = document.querySelector('[data-vs]')
  if (!root) return

  const t = root.dataset
  const lang = document.documentElement.lang || 'en'
  const runLine = document.querySelector('[data-vs-run]')
  const invalidLine = document.querySelector('[data-vs-invalid]')
  const legendBox = document.querySelector('[data-vs-legend]')
  const headlineBox = document.querySelector('[data-vs-headline]')
  const latencyRows = document.querySelector('[data-vs-latency-rows]')

  const number = new Intl.NumberFormat(lang)
  const date = new Intl.DateTimeFormat(lang, { dateStyle: 'long' })
  const decimals = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const ms = (value) => `${number.format(Math.round(value))} ms`

  /** The hidden label blocks of the template. */
  const text = (selector) =>
    new Map(
      [...document.querySelectorAll(selector)].map((element) => [element.dataset.code, element.textContent.trim()]),
    )
  const metricLabels = text('[data-vs-metrics] [data-code]')

  const el = (tag, className, content) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (content !== undefined) element.textContent = content
    return element
  }

  const share = (count, total) => (total ? (100 * count) / total : 0)

  /**
   * Completeness as two questions: can the company be named (name or legal form), and can it be
   * located (street, city or postal code). VIES puts the legal form in the name and returns the
   * address as one block, so scoring each field separately would compare formats, not content.
   *
   * The denominator is every request made, not only the answered ones. Otherwise a side answering
   * 5 numbers out of 50 with full records would score 100 %.
   *
   * Recent runs write this as `usable`, counted per record. Older summaries are approximated from
   * the field totals, using the largest field of each bucket.
   */
  const filledShare = (side, asked) => {
    if (side.usable) return share(side.usable.name + side.usable.address, 2 * asked)
    const parts = side.completeness || {}
    const named = Math.max(parts.name ?? 0, parts.legalForm ?? 0)
    const located = Math.max(parts.address ?? 0, parts.city ?? 0, parts.postalCode ?? 0)
    return share(named + located, 2 * asked)
  }

  /** A xN factor, without decimals once it is large. */
  const factor = (value) => (value >= 10 ? number.format(Math.round(value)) : decimals.format(value))

  /** The two stacked bars with their values. `ratio` is the bar length and `text` its label. */
  const pair = ({ vatlas, vies }, { values = true } = {}) => {
    const box = el('div', `vs-pair${values ? '' : ' vs-pair--bare'}`)
    for (const [side, reading] of [
      ['vies', vies],
      ['vatlas', vatlas],
    ]) {
      const track = el('span', `vs-pair__track vs-pair__track--${side}`)
      const bulk = el('span', 'vs-pair__fill')
      // A hairline for zero, so it does not read as missing data.
      bulk.style.width = `${Math.max(0.5, Math.min(100, reading.ratio * 100))}%`
      track.appendChild(bulk)
      box.appendChild(track)
      if (values) box.appendChild(el('span', `vs-pair__value vs-pair__value--${side}`, reading.text))
    }
    return box
  }

  /** The gap as one colored figure. `level` gives the direction. */
  const delta = (label, level) => el('span', `vs-delta vs-delta--${level}`, label)

  /** The headline form of the gap: the VIES value, then the Vatlas value. */
  const move = (from, to, level) => {
    const box = el('span', `vs-move vs-move--${level}`)
    box.append(el('span', 'vs-move__from', from), el('span', 'vs-move__arrow', '→'), el('span', 'vs-move__to', to))
    return box
  }

  /** A percentage comparison on a 0-100 scale. */
  const percentPair = (vatlasCount, vatlasTotal, viesCount, viesTotal, options) => {
    const ours = share(vatlasCount, vatlasTotal)
    const theirs = share(viesCount, viesTotal)
    const gap = ours - theirs
    return {
      bars: pair(
        {
          vatlas: { ratio: ours / 100, text: `${decimals.format(ours)} %` },
          vies: { ratio: theirs / 100, text: `${decimals.format(theirs)} %` },
        },
        options,
      ),
      move: move(
        `${decimals.format(theirs)} %`,
        `${decimals.format(ours)} %`,
        gap > FLAT_POINTS ? 'good' : gap < -FLAT_POINTS ? 'poor' : 'flat',
      ),
    }
  }

  /**
   * A response time comparison. Bars are scaled to the slower side, so shorter is better. The gap is
   * how many times faster Vatlas is.
   */
  const latencyPair = (vatlasMs, viesMs, options) => {
    const worst = Math.max(vatlasMs, viesMs, 1)
    const times = viesMs / (vatlasMs || 1)
    const level = times > 1 + FLAT_FACTOR ? 'good' : times < 1 - FLAT_FACTOR ? 'poor' : 'flat'
    return {
      score: times,
      bars: pair(
        {
          vatlas: { ratio: vatlasMs / worst, text: ms(vatlasMs) },
          vies: { ratio: viesMs / worst, text: ms(viesMs) },
        },
        options,
      ),
      move: move(ms(viesMs), ms(vatlasMs), level),
      delta: delta(`×${factor(times)}`, level),
    }
  }

  /**
   * A percentage next to its counterpart: a move when they differ, one muted value when equal, and
   * `~N %` when within a point. `lowerIsBetter` distinguishes error rates from completeness.
   */
  const comparison = (ours, theirs, { lowerIsBetter = false } = {}) => {
    const gap = ours - theirs
    if (Math.abs(gap) <= FLAT_POINTS) return el('span', 'vs-same', `${decimals.format(ours)} %`)
    if (Math.abs(gap) < CLOSE_POINTS) {
      return el('span', 'vs-same', `~${number.format(Math.round((ours + theirs) / 2))} %`)
    }
    const ahead = lowerIsBetter ? gap < 0 : gap > 0
    return move(`${decimals.format(theirs)} %`, `${decimals.format(ours)} %`, ahead ? 'good' : 'poor')
  }

  /**
   * Share of requests without an answer (unreachable source, timeout, refusal). It is the complement
   * of the response rate: "not registered" is an answer, not an error.
   */
  const errorRate = (side, asked) => share(asked - answered(side.outcomes), asked)

  /** One headline: label, bars without values, then the full move. */
  const line = (label, reading) => {
    const box = el('div', 'vs-line')
    box.appendChild(el('p', 'vs-line__label', label))
    box.appendChild(reading.bars)
    box.appendChild(reading.move)
    return box
  }

  /** One table row: header, bars, gap, and any extra cells. Country codes are monospace. */
  const row = (label, reading, { mono = false, extra = [] } = {}) => {
    const tr = document.createElement('tr')
    const head = el('th', '')
    head.scope = 'row'
    if (mono) head.appendChild(el('code', '', label))
    else head.textContent = label
    tr.appendChild(head)
    for (const [node, className] of [[reading.bars, ''], [reading.delta, 'vs-delta-col'], ...extra]) {
      const td = el('td', className)
      if (node) td.appendChild(node)
      tr.appendChild(td)
    }
    return tr
  }

  /** Best first. */
  const sorted = (readings) => readings.sort((a, b) => b.score - a.score).map((reading) => reading.node)

  const failed = (message) => {
    if (runLine) runLine.textContent = message
    if (headlineBox) headlineBox.replaceChildren(el('p', 'bench-empty', message))
    if (latencyRows) {
      const tr = document.createElement('tr')
      const td = el('td', '', message)
      td.setAttribute('colspan', '5')
      tr.appendChild(td)
      latencyRows.replaceChildren(tr)
    }
  }

  /** The color legend. */
  const renderLegend = () => {
    legendBox.replaceChildren(
      ...[
        ['vies', t.tVies],
        ['vatlas', t.tVatlas],
      ].map(([side, name]) => {
        const item = el('li', 'vs-legend__item')
        item.appendChild(el('span', `vs-swatch vs-swatch--${side}`))
        item.appendChild(el('span', '', name))
        return item
      }),
    )
  }

  // -- Headline: speed and response rate --
  const renderHeadline = (paired) => {
    const { n, vatlas, viesOnly } = paired.overall
    const bare = { values: false }
    // Response times on the left, results on the right. p95 can be red, since Vatlas retries.
    headlineBox.replaceChildren(
      line(metricLabels.get('p50'), latencyPair(vatlas.latencyMs.p50, viesOnly.latencyMs.p50, bare)),
      line(
        metricLabels.get('answered'),
        percentPair(answered(vatlas.outcomes), n, answered(viesOnly.outcomes), n, bare),
      ),
      line(metricLabels.get('p95'), latencyPair(vatlas.latencyMs.p95, viesOnly.latencyMs.p95, bare)),
      line(metricLabels.get('completeness'), {
        bars: pair(
          {
            vatlas: { ratio: filledShare(vatlas, n) / 100, text: '' },
            vies: { ratio: filledShare(viesOnly, n) / 100, text: '' },
          },
          bare,
        ),
        move: comparison(filledShare(vatlas, n), filledShare(viesOnly, n)),
      }),
    )
  }

  /**
   * Country table: response time, sorted best first, then share without answer and share usable.
   * Shown as a move only when the two sides differ.
   */
  const renderLatency = (paired) => {
    const rows = (paired.countries || []).map((country) => {
      const reading = latencyPair(country.vatlas.latencyMs.p50, country.viesOnly.latencyMs.p50)
      const errors = comparison(errorRate(country.vatlas, country.n), errorRate(country.viesOnly, country.n), {
        lowerIsBetter: true,
      })
      const filled = comparison(filledShare(country.vatlas, country.n), filledShare(country.viesOnly, country.n))
      return {
        score: reading.score,
        node: row(country.code, reading, {
          mono: true,
          extra: [
            [errors, 'vs-figure-col'],
            [filled, 'vs-figure-col'],
          ],
        }),
      }
    })
    if (rows.length) latencyRows.replaceChildren(...sorted(rows))
  }

  const render = (summary) => {
    const paired = summary && summary.paired
    if (!paired || !paired.overall || !paired.overall.n) {
      failed(t.tNodata)
      return
    }

    if (runLine) {
      runLine.textContent = fill(t.tRun, {
        date: date.format(new Date(summary.startedAt)),
        n: number.format(paired.overall.n),
      })
    }
    // A paired run that stopped early is not a valid comparison. The page says so first.
    if (invalidLine && paired.invalid) {
      invalidLine.textContent = fill(t.tInvalid, { reason: paired.invalidReason || '' })
      invalidLine.hidden = false
    }

    if (legendBox) renderLegend()
    if (headlineBox) renderHeadline(paired)
    if (latencyRows) renderLatency(paired)
  }

  fetch(DATA_URL, { headers: { accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then(render)
    .catch(() => failed(t.tError))
}
