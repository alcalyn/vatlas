import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `locales/*.json` has no types, so these tests check that every language is complete and that
 * placeholders match.
 */
const localesDir = resolve(import.meta.dirname, '..', 'locales');

type Tree = { [key: string]: string | Tree };

const files = readdirSync(localesDir)
  .filter((name) => name.endsWith('.json'))
  .map(
    (name) =>
      [name.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(localesDir, name), 'utf8')) as Tree] as const,
  );

/** Every leaf as `group.key`, in file order. */
function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const bundles = files.map(([locale, tree]) => [locale, flatten(tree)] as const);
const [referenceLocale, reference] = bundles[0]!;

/** `{{name}}`, interpolated by i18next. */
const doubles = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort();
/** `{name}`, filled by the browser (or a manual replace). */
const singles = (value: string) => [...value.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((match) => match[1]!).sort();

describe('locales', () => {
  it('has at least two languages to compare', () => {
    expect(bundles.length).toBeGreaterThan(1);
  });

  it('nests two levels deep at most', () => {
    for (const [locale, tree] of files) {
      for (const [group, value] of Object.entries(tree)) {
        if (typeof value === 'string') continue;
        for (const [key, leaf] of Object.entries(value)) {
          expect(typeof leaf, `${locale}: ${group}.${key} is a third level`).toBe('string');
        }
      }
    }
  });

  it.each(bundles.slice(1))('%s holds exactly the same keys as the reference', (locale, bundle) => {
    const missing = Object.keys(reference).filter((key) => !(key in bundle));
    const extra = Object.keys(bundle).filter((key) => !(key in reference));
    expect({ missing, extra }, `${locale} against ${referenceLocale}`).toEqual({ missing: [], extra: [] });
  });

  it.each(bundles.slice(1))('%s interpolates the same values as the reference', (locale, bundle) => {
    for (const [key, value] of Object.entries(bundle)) {
      const source = reference[key];
      if (source === undefined) continue;
      expect(doubles(value), `${locale}: ${key}`).toEqual(doubles(source));
      expect(singles(value), `${locale}: ${key}`).toEqual(singles(source));
    }
  });

  it('declares a plural form in every language or in none', () => {
    const forms = (bundle: Record<string, string>) => {
      const out = new Map<string, string[]>();
      for (const key of Object.keys(bundle)) {
        const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
        if (!match) continue;
        const list = out.get(match[1]!) ?? [];
        list.push(match[2]!);
        out.set(match[1]!, list);
      }
      return out;
    };
    const counted = new Set(bundles.flatMap(([, bundle]) => [...forms(bundle).keys()]));
    for (const base of counted) {
      for (const [locale, bundle] of bundles) {
        const own = forms(bundle).get(base);
        expect(own, `${locale}: ${base} has no plural forms`).toBeDefined();
        // Every language must have singular and plural. Languages needing `few`/`many` may declare more.
        expect(own, `${locale}: ${base}`).toEqual(expect.arrayContaining(['one', 'other']));
        // A counted key never also exists without suffix: i18next would never use it.
        expect(bundle[base], `${locale}: ${base} shadows its own plural forms`).toBeUndefined();
      }
    }
  });

  it('never leaves an empty string', () => {
    for (const [locale, bundle] of bundles) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(value.trim(), `${locale}: ${key}`).not.toBe('');
      }
    }
  });
});
