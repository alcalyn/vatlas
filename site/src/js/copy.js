import { strings } from './i18n.js'

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Adds a copy button to every [data-copy] block and wires [data-copy-text] buttons. */
export function initCopy() {
  document.querySelectorAll('[data-copy]').forEach((block) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'copy-btn'
    button.textContent = strings.copy
    button.addEventListener('click', async () => {
      const source = block.querySelector('pre')
      const ok = await writeClipboard(source ? source.innerText : block.innerText)
      button.textContent = ok ? strings.copied : strings.copyFailed
      setTimeout(() => {
        button.textContent = strings.copy
      }, 1600)
    })
    block.appendChild(button)
  })

  document.querySelectorAll('[data-copy-text]').forEach((button) => {
    const feedback = document.querySelector(button.dataset.copyFeedback || '')
    button.addEventListener('click', async () => {
      const ok = await writeClipboard(button.dataset.copyText)
      if (feedback) feedback.textContent = ok ? button.dataset.copyOk : button.dataset.copyKo
    })
  })
}
