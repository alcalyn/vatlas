const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
export const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESCAPE[c])

/** Minimal JSON syntax highlighter for the samples. */
export function highlightJson(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return escapeHtml(json).replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?)/g,
    (match, key, str, bool, nul, num) => {
      if (key) return `<span class="tok-key">${key.slice(0, -1)}</span><span class="tok-punc">:</span>`
      if (str) return `<span class="tok-str">${str}</span>`
      if (bool) return `<span class="tok-bool">${bool}</span>`
      if (nul) return `<span class="tok-null">${nul}</span>`
      if (num) return `<span class="tok-num">${num}</span>`
      return match
    },
  )
}
