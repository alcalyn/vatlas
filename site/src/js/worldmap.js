/**
 * The home page world map: covered countries in green, others in grey.
 *
 * Drawn with `jsvectormap`, whose coloring is a JavaScript API, so adding a country is a line in
 * covered-countries.js.
 *
 * Loaded with `import()` by main.js only where a map exists (about 140 kB). The two imports below
 * must stay in this order: the map file registers on the library's global.
 *
 * Hovering a covered country shows a real VAT number and its company, from
 * `data/country-examples.json` (keyed by VAT prefix, so Greece is `EL` there and `GR` on the map).
 * Countries without an example show nothing.
 *
 * The library's CSS is not imported. The rules we need are in components.css.
 */
import jsVectorMap from 'jsvectormap'
import 'jsvectormap/dist/maps/world.js'
import { COVERED, COVERED_MARKERS } from './covered-countries.js'
import examples from '@data/country-examples.json'

/** Colors come from the stylesheet tokens so the map follows the theme. */
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Examples keyed by map code, with only the two fields the bubble shows. Translates `EL` to `GR`. */
const MAP_CODE = { EL: 'GR' }

const EXAMPLES = Object.fromEntries(
  Object.entries(examples.countries).map(([code, { vat, response }]) => [
    MAP_CODE[code] ?? code,
    { vat, name: response.data.name },
  ]),
)

/** Company names are text, never markup. */
const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The bubble: "example", then the number and the company. Some countries (Spain) have no name
 * from VIES, and the bubble shows that too.
 */
const bubbleHtml = (example, { label, noName }) =>
  [
    `<span class="jvm-tooltip__label">${escapeHtml(label)}</span>`,
    `<span class="jvm-tooltip__vat">${escapeHtml(example.vat)}</span>`,
    example.name
      ? `<span class="jvm-tooltip__name">${escapeHtml(example.name)}</span>`
      : `<span class="jvm-tooltip__name jvm-tooltip__name--none">${escapeHtml(noName)}</span>`,
  ].join('')

export function initWorldMap() {
  const container = document.querySelector('[data-worldmap]')
  if (!container) return

  /** The bubble's own strings, translated by the build. */
  const strings = { label: container.dataset.tExample ?? '', noName: container.dataset.tNoName ?? '' }

  const map = jsVectorMap({
    selector: container,
    map: 'world',
    backgroundColor: 'transparent',
    // No zoom, no pan, no selection.
    draggable: false,
    zoomButtons: false,
    zoomOnScroll: false,
    bindTouchEvents: false,
    regionsSelectable: false,
    showTooltip: true,
    regionStyle: {
      initial: { fill: token('--map-land'), fillOpacity: 1, stroke: 'none', strokeWidth: 0 },
      // Set per region in paint(), so only covered countries react to the pointer.
      hover: {},
      selected: {},
      selectedHover: {},
    },
    // Countries without a region, see COVERED_MARKERS.
    markers: COVERED_MARKERS,
    markerStyle: {
      initial: { r: 3.5, fill: token('--map-covered'), fillOpacity: 1, stroke: 'none', strokeWidth: 0 },
      hover: { cursor: 'pointer' },
      selected: {},
      selectedHover: {},
    },
    // Two series, one per element type, holding the fills repainted on theme change.
    series: {
      regions: [{ attribute: 'fill', attributes: {} }],
      markers: [{ attribute: 'fill', attributes: {} }],
    },
    /**
     * Fires on mouseover before the tooltip is shown. Replaces its content, or cancels it for
     * countries without an example.
     */
    onRegionTooltipShow(event, tooltip, code) {
      const example = EXAMPLES[code]
      if (!example || !COVERED.includes(code)) return event.preventDefault()
      tooltip.text(bubbleHtml(example, strings), true)
    },
    onMarkerTooltipShow(event, tooltip, index) {
      const example = EXAMPLES[COVERED_MARKERS[index]?.name]
      if (!example) return event.preventDefault()
      tooltip.text(bubbleHtml(example, strings), true)
    },
  })

  const paint = () => {
    const covered = token('--map-covered')
    const land = token('--map-land')
    map.series.regions[0].setAttributes(
      Object.fromEntries(Object.keys(map.regions).map((code) => [code, COVERED.includes(code) ? covered : land])),
    )
    map.series.markers[0].setAttributes(Object.fromEntries(COVERED_MARKERS.map((_, index) => [index, covered])))
  }

  paint()

  /** Only covered countries get a pointer cursor and a hover effect. */
  Object.entries(map.regions).forEach(([code, region]) => {
    if (!EXAMPLES[code] || !COVERED.includes(code)) return
    region.element.shape.style.hover = { fillOpacity: 0.78 }
    region.element.setStyle('cursor', 'pointer')
  })

  // The library sizes the SVG from its container only once.
  if (window.ResizeObserver) new ResizeObserver(() => map.updateSize()).observe(container)

  /**
   * On touch screens, a tap opens the bubble and nothing closes it. A tap outside the map, or on the
   * bubble, closes it.
   */
  if (!window.matchMedia?.('(hover: hover)').matches) {
    const tooltip = map._tooltip
    document.addEventListener('click', (event) => {
      if (!container.contains(event.target)) tooltip.hide()
    })
    tooltip.getElement().addEventListener('click', () => tooltip.hide())
  }

  // The theme changes through the header toggle (`data-theme`) or the system preference.
  new MutationObserver(paint).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', paint)
}
