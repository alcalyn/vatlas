// The handful of strings the client needs, injected by the footer partial.
const fallback = { copy: 'copy', copied: 'copied', copyFailed: 'failed' }

export const strings = (() => {
  const node = document.querySelector('script[data-i18n]')
  if (!node) return fallback
  try {
    return { ...fallback, ...JSON.parse(node.textContent) }
  } catch {
    return fallback
  }
})()
