import { recorded, samples } from './demo-data.js'
import { highlightJson } from './highlight.js'
import { renderAllAnswer, renderLookupAnswer } from '../../../src/lib/lookupHtml.ts'
import { presentAll, presentLookup } from '../../../src/lib/lookupView.ts'

const NORMALIZE = /[\s.\-_/]/g
/**
 * localStorage key and size of the answer cache. The privacy policy lists this key: update
 * `site/src/privacy/{en,fr}/index.html` if it changes.
 */
const CACHE_KEY = 'vatlas.tryit.answers'
const CACHE_MAX = 20

/** The three calls and their query strings. */
const MODES = ['single', 'proof', 'all']
/** The path of each button, with the number in place of `{n}`. */
const MODE_PATH = { single: '/v1/lookup/{n}', proof: '/v1/lookup/{n}?prefer=proof', all: '/v1/lookup-all/{n}' }

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')
const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function normalize(raw) {
  return raw.toUpperCase().replace(NORMALIZE, '').replace(/^GR/, 'EL')
}

/**
 * Cached answers by number and mode. Storage can throw (private mode, blocked site data, full
 * quota), so every access is wrapped.
 */
function readCache() {
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

/**
 * Stores one answer and evicts the oldest past the limit. Only answers about the number are kept,
 * so a 429, 503 or network failure never replaces a good answer.
 *
 * The key includes the mode, since each call answers a different question.
 */
function writeCache(key, entry) {
  try {
    const cache = readCache()
    cache[key] = entry
    const kept = Object.entries(cache)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, CACHE_MAX)
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // The cache is optional.
  }
}

/**
 * The try-it box, with the three calls the console offers: plain lookup, lookup with proof, and
 * every source.
 *
 * Samples are replayed from `demo-data.js` and never call the API. Other numbers go to
 * `/v1/demo/lookup/:vatNumber` (or `/v1/demo/lookup-all/:vatNumber`), with no key, five per IP
 * per week. Typing a sample's number by hand is free too.
 *
 * Every live answer is cached in `localStorage` and shown again once the weekly limit is reached.
 */
export function initTryIt() {
  const panel = document.querySelector('[data-tryit-i18n]')
  const form = document.querySelector('[data-tryit]')
  if (!panel || !form) return

  const t = panel.dataset
  const input = form.querySelector('[data-tryit-input]')
  const buttons = [...form.querySelectorAll('[data-tryit-mode]')]
  const chips = panel.querySelector('[data-tryit-samples]')
  const json = panel.querySelector('[data-tryit-json]')
  const formatted = panel.querySelector('[data-tryit-formatted]')
  const statusEl = panel.querySelector('[data-tryit-status]')
  const hint = panel.querySelector('[data-tryit-hint]')

  // The chips come from `demo-data.js`.
  chips.innerHTML = samples
    .map(
      (sample) =>
        `<button class="chip" type="button" data-tryit-sample="${escapeHtml(sample.vat)}">${escapeHtml(sample.vat)}</button>`,
    )
    .join('')

  const render = ({ status, timing, body, note, vat, mode }) => {
    const ok = status === 200
    const number = vat || (body.data ? body.data.vatNumber : '')
    statusEl.innerHTML =
      `<span class="badge ${ok ? 'badge--bulk' : 'badge--vies'}">${status} ${ok ? 'OK' : t.tError}</span>` +
      `<span>${escapeHtml(timing)}</span>` +
      `<span>GET ${escapeHtml((MODE_PATH[mode] ?? MODE_PATH.single).replace('{n}', number))}</span>`
    formatted.innerHTML = renderFormatted(status, body, mode, t)
    json.innerHTML = highlightJson(body)
    hint.innerHTML = note || ''
  }

  /** "3 of 5 free lookups left this week", from the rate limit headers. */
  const budget = (response) => {
    const remaining = response.headers.get('X-RateLimit-Remaining')
    const limit = response.headers.get('X-RateLimit-Limit')
    return remaining === null || limit === null ? '' : fill(t.tLeft, { remaining, limit })
  }

  /** The weekly demo limit is reached. */
  const limited = (response) => {
    const text = escapeHtml(fill(t.tLimited, { limit: response.headers.get('X-RateLimit-Limit') ?? '' }))
    return `${text} <a href="${escapeHtml(t.consoleUrl)}">${escapeHtml(t.tLimitedCta)}</a>`
  }

  const noteFor = (response, body) => {
    if (response.status === 200) {
      const meta = body.meta ?? {}
      // A lookup-all names no single source, so the line only shows the remaining count.
      return `${meta.source ? escapeHtml(fill(t.tLive, meta)) : ''} ${escapeHtml(budget(response))}`.trim()
    }
    if (response.status === 429) return limited(response)
    // A malformed number never reached a source and cost nothing.
    if (response.status === 400) return escapeHtml(t.tRejected)
    return escapeHtml(budget(response))
  }

  /** Shows the cached answer when the API refuses. `note` describes what just happened. */
  const renderCached = (vat, mode, note) => {
    const entry = readCache()[`${vat}:${mode}`]
    // Validated rather than trusted: storage may hold anything.
    if (!entry || typeof entry.status !== 'number' || typeof entry.at !== 'number' || !entry.body) return false

    const time = new Date(entry.at).toLocaleTimeString(document.documentElement.lang || undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
    render({
      status: entry.status,
      timing: t.tCacheBadge,
      body: entry.body,
      note: `${escapeHtml(fill(t.tCached, { time }))} ${note}`,
      vat,
      mode,
    })
    return true
  }

  /** A sample, replayed. */
  const replay = (vat, mode) => {
    const answer = recorded(vat, mode)
    if (!answer) return false
    render({
      status: answer.status,
      timing: `${answer.latency} ms`,
      body: answer.body,
      note: escapeHtml(t.tRecorded),
      vat,
      mode,
    })
    return true
  }

  /** The current mode. Clicking a sample keeps it. */
  let shown = 'single'

  /** Highlights the active button with `aria-pressed`, which the stylesheet uses too. */
  const showMode = (mode) => {
    shown = mode
    buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tryitMode === mode)))
  }

  const lookup = async (mode) => {
    const vat = normalize(input.value || '')
    showMode(mode)
    if (replay(vat, mode)) return

    buttons.forEach((button) => (button.disabled = true))
    statusEl.innerHTML = `<span class="badge">${t.tPending}</span>`
    formatted.innerHTML = '<span class="dim">…</span>'
    json.innerHTML = '<span class="dim">…</span>'
    hint.textContent = ''

    const startedAt = performance.now()
    try {
      // An empty path segment matches no route, so an empty field is sent as a space and the API
      // answers INVALID_VAT_FORMAT instead of 404.
      const path = (
        mode === 'all' ? '/v1/demo/lookup-all/{n}' : MODE_PATH[mode].replace('/v1/lookup/', '/v1/demo/lookup/')
      ).replace('{n}', encodeURIComponent(vat || ' '))
      const response = await fetch(`${t.apiBase}${path}`)
      const body = await response.json()
      const note = noteFor(response, body)

      // A 429 says nothing about the number, so keep the previous answer.
      if (response.status === 429 && renderCached(vat, mode, note)) return

      // Only 200 and 404 are answers worth caching.
      if (response.status === 200 || response.status === 404) {
        writeCache(`${vat}:${mode}`, { status: response.status, body, at: Date.now() })
      }

      render({
        status: response.status,
        timing: `${Math.round(performance.now() - startedAt)} ms`,
        body,
        note,
        vat,
        mode,
      })
    } catch {
      const note = escapeHtml(t.tFailed)
      if (renderCached(vat, mode, note)) return
      render({
        status: '-',
        timing: `${Math.round(performance.now() - startedAt)} ms`,
        body: { error: { code: 'UNREACHABLE' } },
        note,
        vat,
        mode,
      })
    } finally {
      buttons.forEach((button) => (button.disabled = false))
    }
  }

  // Three buttons for the call, one field for the number. Submitting the form runs the plain lookup.
  buttons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const mode = MODES.includes(button.dataset.tryitMode) ? button.dataset.tryitMode : 'single'
      lookup(mode)
    })
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    lookup('single')
  })

  // A chip changes the number, not the mode.
  chips.querySelectorAll('[data-tryit-sample]').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.tryitSample
      lookup(shown)
    })
  })

  // First paint: the first sample.
  input.value = samples[0].vat
  showMode('single')
  replay(samples[0].vat, 'single')
}

// -- formatted answer --

/**
 * The formatted answer.
 *
 * Meaning lives in `src/lib/lookupView.ts` and markup in `src/lib/lookupHtml.ts`, shared with the
 * console. This file only provides the labels and the date formatting.
 *
 * Labels come from `data-t-*` attributes, since i18next only runs at build time.
 */
function renderFormatted(status, body, mode, t) {
  const ctx = answerContext(readLabels(t))
  return mode === 'all' ? renderAllAnswer(presentAll(body), ctx) : renderLookupAnswer(presentLookup(status, body), ctx)
}

/** `data-t-fmt` holds the whole `fmt` group as JSON. */
function readLabels(t) {
  try {
    return JSON.parse(t.tFmt || '{}')
  } catch {
    return {}
  }
}

/**
 * The browser side of the shared template. A missing key returns the key itself, which the
 * template checks to fall back to a generic heading.
 *
 * Dates use the document language, or the ISO string if the browser cannot format it.
 */
function answerContext(labels) {
  const format = (value, iso, options) => {
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return value
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || undefined, options).format(at)
    } catch {
      return value
    }
  }

  return {
    label: (key) => labels[key] ?? key,
    day: (value) => format(value, `${value}T00:00:00Z`, { day: 'numeric', month: 'short', year: 'numeric' }),
    instant: (value) =>
      format(value, value, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
  }
}
