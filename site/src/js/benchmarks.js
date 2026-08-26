/**
 * The benchmarks page. Every figure comes from /data/benchmark.json, the summary written by
 * `npm run benchmark` and copied into site/public/data/. The country list follows the run.
 */

/** Completeness fields, in table column order. No legal form: VIES never returns one. */
const FIELDS = ['name', 'address', 'postalCode', 'city']

/**
 * Outcomes that count as an answer: found, or not registered. Anything else (unreachable source,
 * timeout) is a lookup without answer.
 */
const ANSWERED = ['found', 'not-registered']

/** Thresholds for a good and a middling percentage. */
const GOOD = 50
const FAIR = 25

/** Same thresholds for latency, in milliseconds, reversed. */
const FAST = 500
const SLOW = 1000

const DATA_URL = '/data/benchmark.json'

/** `{date}` is a runtime placeholder, single braces so the build leaves it alone. */
const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))

/** How many of `outcomes` are an answer. */
const answered = (outcomes = {}) => ANSWERED.reduce((count, outcome) => count + (outcomes[outcome] || 0), 0)

export function initBenchmarks() {
  const root = document.querySelector('[data-bench]')
  if (!root) return

  const t = root.dataset
  const lang = document.documentElement.lang || 'en'
  const runLine = document.querySelector('[data-bench-run]')
  const fieldsBox = document.querySelector('[data-bench-fields]')
  const rowsBody = document.querySelector('[data-bench-rows]')
  const footnotes = document.querySelector('[data-bench-footnotes]')

  const number = new Intl.NumberFormat(lang)
  const date = new Intl.DateTimeFormat(lang, { dateStyle: 'long' })
  const ms = (value) => `${number.format(Math.round(value))} ms`

  /** A latency, colored with the same levels as a percentage. */
  const latency = (value) => ({
    text: ms(value),
    level: value < FAST ? 'good' : value < SLOW ? 'fair' : 'poor',
  })

  /**
   * A count out of `total`, shown as a colored percentage. Raw counts are not shown, since they
   * depend on the list used.
   */
  const percent = (count, total) => {
    if (!total) return { text: '-', level: '' }
    const value = Math.round((100 * count) / total)
    return { text: `${value} %`, level: value >= GOOD ? 'good' : value >= FAIR ? 'fair' : 'poor' }
  }

  /** The two hidden template blocks: field labels and country notes. */
  const text = (selector) =>
    new Map(
      [...document.querySelectorAll(selector)].map((element) => [element.dataset.code, element.textContent.trim()]),
    )
  const fieldLabels = text('[data-bench-fields-labels] [data-code]')
  const notes = text('[data-bench-notes] [data-code]')

  const paint = (element, { text: value, level }) => {
    element.textContent = value
    element.classList.add('bench-pct')
    if (level) element.classList.add(`bench-pct--${level}`)
    return element
  }

  const cell = (row, value, { head = false } = {}) => {
    const element = document.createElement(head ? 'th' : 'td')
    if (head) element.scope = 'row'
    element.textContent = value
    row.appendChild(element)
    return element
  }

  /** One message across a whole table row, for errors and empty runs. */
  const fullRow = (body, message) => {
    const row = document.createElement('tr')
    const td = document.createElement('td')
    // The header has two rows, so the width is the sum of the first row's colspans.
    const columns = [...body.closest('table').querySelectorAll('thead tr:first-child th')].reduce(
      (total, th) => total + (Number(th.getAttribute('colspan')) || 1),
      0,
    )
    td.setAttribute('colspan', String(columns || 1))
    td.textContent = message
    row.appendChild(td)
    body.replaceChildren(row)
  }

  const failed = (message) => {
    if (runLine) runLine.textContent = message
    if (fieldsBox) {
      const paragraph = document.createElement('p')
      paragraph.className = 'bench-empty'
      paragraph.textContent = message
      fieldsBox.replaceChildren(paragraph)
    }
    if (rowsBody) fullRow(rowsBody, message)
  }

  // p50, p95 and response rate.
  const renderStats = (lookups) => {
    const stats = {
      p50: latency(lookups.latencyMs.p50),
      p95: latency(lookups.latencyMs.p95),
      answered: percent(answered(lookups.outcomes), lookups.measured),
    }
    document.querySelectorAll('[data-bench-stat]').forEach((element) => {
      const stat = stats[element.dataset.benchStat]
      if (stat) paint(element, stat)
    })
  }

  // Completeness is a share of the records found.
  const renderFields = (lookups) => {
    const tiles = FIELDS.map((field) => {
      const tile = document.createElement('div')
      tile.className = 'stat'
      const value = document.createElement('p')
      value.className = 'stat__value'
      paint(value, percent(lookups.completeness[field] ?? 0, lookups.found))
      const label = document.createElement('p')
      label.className = 'stat__label'
      label.textContent = fieldLabels.get(field) || field
      tile.append(value, label)
      return tile
    })
    fieldsBox.replaceChildren(...tiles)
  }

  /** Filled by renderCountries, read by renderFootnotes: one entry per referenced note. */
  const numbered = []

  const renderCountries = (lookups) => {
    const rows = (lookups.countries || []).map((country) => {
      const row = document.createElement('tr')
      const head = cell(row, '', { head: true })
      const code = document.createElement('code')
      code.textContent = country.code
      head.appendChild(code)

      paint(cell(row, ''), percent(answered(country.outcomes), country.n))
      paint(cell(row, ''), latency(country.latencyMs.p50))
      paint(cell(row, ''), latency(country.latencyMs.p95))
      for (const field of FIELDS) {
        paint(cell(row, ''), percent(country.completeness[field] ?? 0, country.found))
      }
      // Notes are shown as references in the table and as text under it.
      const marker = cell(row, '')
      marker.classList.add('bench-note')
      const note = notes.get(country.code)
      if (note) {
        const rank = numbered.push({ code: country.code, note })
        const link = document.createElement('a')
        link.href = `#bench-note-${rank}`
        link.id = `bench-ref-${rank}`
        link.textContent = `[${rank}]`
        marker.appendChild(link)
      }
      return row
    })

    if (rows.length) rowsBody.replaceChildren(...rows)
    else fullRow(rowsBody, t.tNodata)
  }

  /** The notes, under the table, in reference order. */
  const renderFootnotes = () => {
    const items = numbered.map(({ code, note }, index) => {
      const item = document.createElement('li')
      item.id = `bench-note-${index + 1}`
      const back = document.createElement('a')
      back.href = `#bench-ref-${index + 1}`
      back.className = 'bench-notes__code'
      back.textContent = code
      item.append(back, document.createTextNode(` ${note}`))
      return item
    })
    footnotes.replaceChildren(...items)
  }

  const render = (summary) => {
    const lookups = summary && summary.lookups
    if (!lookups || !lookups.measured) {
      failed(t.tNodata)
      return
    }

    if (runLine) {
      runLine.textContent = fill(t.tRun, { date: date.format(new Date(summary.startedAt)) })
    }
    renderStats(lookups)
    if (fieldsBox) renderFields(lookups)
    if (rowsBody) renderCountries(lookups)
    if (footnotes) renderFootnotes()
  }

  fetch(DATA_URL, { headers: { accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then(render)
    .catch(() => failed(t.tError))
}
