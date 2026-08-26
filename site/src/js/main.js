import { initBenchmarks } from './benchmarks.js'
import { initCopy } from './copy.js'
import { initStats } from './stats.js'
import { initTheme } from './theme.js'
import { initTryIt } from './tryit.js'
import { initVersus } from './versus.js'

/** Closes the language menu on outside click or Escape. */
function initLangMenu() {
  const menu = document.querySelector('.langmenu')
  if (!menu) return

  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false
      menu.querySelector('summary')?.focus()
    }
  })
}

function initNav() {
  const toggle = document.querySelector('[data-nav-toggle]')
  const nav = document.getElementById('site-nav')
  if (!toggle || !nav) return

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open')
    toggle.setAttribute('aria-expanded', String(open))
  })

  nav.addEventListener('click', (event) => {
    if (event.target.tagName === 'A') {
      nav.classList.remove('is-open')
      toggle.setAttribute('aria-expanded', 'false')
    }
  })
}

function initTabs() {
  document.querySelectorAll('[data-tabs]').forEach((group) => {
    const tabs = [...group.querySelectorAll('[role="tab"]')]
    const select = (tab) => {
      tabs.forEach((other) => {
        const on = other === tab
        other.setAttribute('aria-selected', String(on))
        other.tabIndex = on ? 0 : -1
        document.getElementById(other.getAttribute('aria-controls')).hidden = !on
      })
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab))
      tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const next = tabs[(index + step + tabs.length) % tabs.length]
        next.focus()
        select(next)
      })
    })
  })
}

function initScrollSpy() {
  const links = [...document.querySelectorAll('[data-scrollspy] a')]
  if (!links.length) return

  const byId = new Map(links.map((link) => [link.getAttribute('href').slice(1), link]))
  const sections = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean)

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        links.forEach((link) => link.classList.remove('is-current'))
        byId.get(entry.target.id)?.classList.add('is-current')
      })
    },
    { rootMargin: '-96px 0px -70% 0px', threshold: 0 },
  )

  sections.forEach((section) => observer.observe(section))
}

initTheme()
initNav()
initLangMenu()
initTabs()
initCopy()
initScrollSpy()
initTryIt()
initBenchmarks()
initStats()
initVersus()

// The map is about 140 kB, so it is only loaded on pages that have one. See worldmap.js.
if (document.querySelector('[data-worldmap]')) {
  import('./worldmap.js').then(({ initWorldMap }) => initWorldMap())
}
