/**
 * The countries painted green on the home page map.
 *
 * Adding a country is one line here. The map comes from `jsvectormap` (see worldmap.js).
 *
 * Codes are ISO 3166-1 alpha-2 as the map file spells them (`GR`, not `EL`). Keep this in sync
 * with the coverage table in `_pages/index.html`.
 */

/**
 * Every covered country, alphabetical.
 *
 * Northern Ireland (XI) has no region on the map, so it is a marker below.
 */
export const COVERED = [
  'AT',
  'AU',
  'BE',
  'BG',
  'BR',
  'CA',
  'CH',
  'CR',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EC',
  'EE',
  'ES',
  'FI',
  'FR',
  'GL',
  'GR',
  'HR',
  'HU',
  'IE',
  'IL',
  'IT',
  'JP',
  'LT',
  'LU',
  'LV',
  'MT',
  'NG',
  'NL',
  'NO',
  'NZ',
  'PE',
  'PL',
  'PT',
  'RO',
  'RU',
  'SE',
  'SG',
  'SI',
  'SK',
  'TW',
  'UA',
  'VN',
]

/**
 * Covered countries without a region on the map, drawn as dots: islands too small for the map
 * (MT, SG), or a part of a larger state (XI, in the United Kingdom, which stays grey).
 *
 * `name` is the code used to look up the example, as in COVERED.
 */
export const COVERED_MARKERS = [
  { name: 'MT', coords: [35.9, 14.4] },
  { name: 'SG', coords: [1.35, 103.82] },
  { name: 'XI', coords: [54.65, -6.7] },
]
