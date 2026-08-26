const STORAGE_KEY = 'vatlas-theme'
const ICONS = { light: '☀', dark: '☾' }

const systemPrefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches

const stored = () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

const current = () => document.documentElement.dataset.theme || (systemPrefersDark() ? 'dark' : 'light')

/**
 * The console is another origin and cannot read this page's storage, so links to it carry the
 * theme as a parameter, like the language. Only an explicit choice is passed on.
 */
function carryThemeToConsole() {
  const origin = document.querySelector('meta[name="console-origin"]')?.content
  if (!origin) return

  const choice = stored()
  document.querySelectorAll(`a[href^="${origin}"]`).forEach((link) => {
    try {
      const url = new URL(link.href)
      if (choice) url.searchParams.set('theme', choice)
      else url.searchParams.delete('theme')
      link.href = url.toString()
    } catch {}
  })
}

/** Light/dark toggle. No stored choice means "follow the system". */
export function initTheme() {
  carryThemeToConsole()

  const button = document.querySelector('[data-theme-toggle]')
  if (!button) return

  const icon = button.querySelector('[data-theme-icon]')

  const paint = () => {
    const active = current()
    const next = active === 'dark' ? 'light' : 'dark'
    const label = button.dataset.labelTemplate.replace(
      '{mode}',
      next === 'dark' ? button.dataset.labelDark : button.dataset.labelLight,
    )
    button.setAttribute('aria-label', label)
    button.title = label
    if (icon) icon.textContent = ICONS[active]
  }

  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {}
    carryThemeToConsole()
    paint()
  })

  // Follow the system until a choice is made.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!stored()) paint()
    })
  }

  paint()
}
