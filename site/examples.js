/**
 * The example a country page ends with, built from `data/country-examples.json`.
 *
 * That file is recorded by `npm run country-examples` from the live API, one real number per
 * country. Refreshing every example is that command and a rebuild.
 *
 * The output is HTML, so every value from the recording is escaped. The token classes
 * (`tok-key`, `tok-str`, `tok-punc`...) are styled in `components.css`.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = resolve(here, '..', 'data', 'country-examples.json')

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const span = (token, text) => `<span class="tok-${token}">${text}</span>`

/** A JSON string with its quotes: `&quot;...&quot;`. */
const quoted = (token, value) => span(token, `&quot;${escapeHtml(value)}&quot;`)

const punc = (text) => span('punc', text)

/**
 * One value, pretty-printed and highlighted, two spaces per level.
 *
 * `indent` is the column of the closing brace. The opening one goes where the value starts.
 */
function highlight(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (value === null) return span('null', 'null')
  if (typeof value === 'boolean') return span('bool', String(value))
  if (typeof value === 'number') return span('num', String(value))
  if (typeof value === 'string') return quoted('str', value)

  if (Array.isArray(value)) {
    if (value.length === 0) return punc('[') + punc(']')
    const items = value.map(
      (item, index) => `${pad}  ${highlight(item, indent + 2)}${index === value.length - 1 ? '' : punc(',')}`,
    )
    return [punc('['), ...items, `${pad}${punc(']')}`].join('\n')
  }

  const keys = Object.keys(value)
  if (keys.length === 0) return punc('{') + punc('}')
  const entries = keys.map((key, index) => {
    const rendered = highlight(value[key], indent + 2)
    const comma = index === keys.length - 1 ? '' : punc(',')
    return `${pad}  ${quoted('key', key)}${punc(':')} ${rendered}${comma}`
  })
  return [punc('{'), ...entries, `${pad}${punc('}')}`].join('\n')
}

/**
 * The request that produced the answer. `{{apiBase}}` is resolved by the token pass that inserts
 * this block, since it differs between local preview and production.
 */
function curlFor(vatNumber) {
  return [
    `${span('cmd', 'curl')} ${quoted('str', `{{apiBase}}/v1/lookup/${vatNumber}`)} \\`,
    `  ${span('flag', '-H')} ${quoted('str', 'Authorization: Bearer $VATLAS_KEY')}`,
  ].join('\n')
}

/** Read on every build, so the dev server picks up a new recording. */
export function loadExamples() {
  return JSON.parse(readFileSync(FILE, 'utf8')).countries
}

/**
 * The rendered example for one country, or null when none is recorded yet. The page then ends
 * without an example.
 */
export function exampleFor(examples, code) {
  const example = examples[code]
  if (!example) return null
  return {
    exampleVat: escapeHtml(example.vat),
    exampleCurl: curlFor(example.vat),
    exampleJson: highlight(example.response),
  }
}
