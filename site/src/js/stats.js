/**
 * The home page stats strip, filled from /data/stats.json (written by `npm run stats`).
 *
 * The template already contains the last known values, so the strip works without JavaScript.
 * Only received values are replaced.
 */

const DATA_URL = '/data/stats.json'

/** Rounded down, no thousands separator: 27, 5k, 31M. */
const compact = (value) => {
  if (value < 1e3) return String(Math.floor(value))
  if (value < 1e6) return `${Math.floor(value / 1e3)}k`
  return `${Math.floor(value / 1e6)}M`
}

/** One formatter per key. Unknown keys are skipped. */
const FORMAT = {
  vatNumbers: compact,
  lookups: compact,
  countries: compact,
  latencyP50Ms: (value) => `${Math.round(value)} ms`,
  answeredPct: (value) => `${Math.floor(value)} %`,
}

export function initStats() {
  const root = document.querySelector('[data-stats]')
  if (!root) return

  fetch(DATA_URL, { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((stats) => {
      root.querySelectorAll('[data-stat]').forEach((node) => {
        const key = node.dataset.stat
        const value = stats[key]
        const format = FORMAT[key]
        if (!format || typeof value !== 'number' || !Number.isFinite(value)) return
        node.textContent = format(value)
      })
    })
    .catch(() => {
      // Keep the fallback values from the template.
    })
}
