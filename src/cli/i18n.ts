import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Completes a translation file with an LLM. Prints the English strings missing from the target
 * language as JSON (nested like the source), then reads the translated JSON from stdin and writes
 * it in place.
 *
 * `locales/en.json` is the source and always complete.
 */

const LOCALES_DIR = 'locales';
const SOURCE_LANG = 'en';

/** A locale file: strings nested in objects. */
export type Tree = { [key: string]: string | Tree };

function usage(): string {
  return [
    'Usage: npm run i18n -- <lang>',
    '',
    `Compares ${LOCALES_DIR}/<lang>.json against ${LOCALES_DIR}/${SOURCE_LANG}.json - the source,`,
    'always complete - and prints the missing strings as a prompt to paste into a LLM:',
    '',
    '  Translate to French:',
    '',
    '  {',
    '    "nav": { "beta": "Beta" }',
    '  }',
    '',
    'Then it waits: paste the translated JSON back and press Ctrl+D. The keys must be exactly',
    'the ones asked for, neither more nor fewer, and the file is rewritten with them in place.',
    'Nothing is written when the paste does not match, and nothing is asked when nothing is',
    'missing.',
    '',
    'Options:',
    '  --help        This text',
  ].join('\n');
}

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readTree(path: string, optional: boolean): Promise<Tree> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isTree(parsed)) throw new Error(`${path} must hold a JSON object`);
  return parsed;
}

/** A leaf is translated when it is a non-empty string. */
function isTranslated(value: string | Tree | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The source branches the target has not translated, with English text and the source nesting.
 * Fully translated branches are left out.
 */
export function missingTree(source: Tree, target: Tree, path: string[] = []): Tree | undefined {
  const missing: Tree = {};

  for (const [key, sourceValue] of Object.entries(source)) {
    const here = [...path, key];
    const targetValue = target[key];

    if (isTree(sourceValue)) {
      if (targetValue !== undefined && !isTree(targetValue)) {
        throw new Error(`${here.join('.')} is an object in ${SOURCE_LANG}.json but a string here`);
      }
      const branch = missingTree(sourceValue, targetValue ?? {}, here);
      if (branch) missing[key] = branch;
      continue;
    }

    if (isTree(targetValue)) {
      throw new Error(`${here.join('.')} is a string in ${SOURCE_LANG}.json but an object here`);
    }
    if (!isTranslated(targetValue)) missing[key] = sourceValue;
  }

  return Object.keys(missing).length > 0 ? missing : undefined;
}

/** Every leaf path, dotted, to compare trees as sets. */
export function leafPaths(tree: Tree, path: string[] = []): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const here = [...path, key];
    if (isTree(value)) paths.push(...leafPaths(value, here));
    else paths.push(here.join('.'));
  }
  return paths;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, 10).map((path) => `    ${path}`);
  if (paths.length > shown.length) shown.push(`    … and ${paths.length - shown.length} more`);
  return shown.join('\n');
}

/** The pasted tree must have exactly the requested leaves. Otherwise nothing is written. */
export function checkAnswer(expected: Tree, answer: Tree): void {
  const wanted = new Set(leafPaths(expected));
  const given = new Set(leafPaths(answer));

  const absent = [...wanted].filter((path) => !given.has(path));
  const unknown = [...given].filter((path) => !wanted.has(path));

  const problems: string[] = [];
  if (absent.length > 0) problems.push(`  ${absent.length} key(s) not translated:\n${listPaths(absent)}`);
  if (unknown.length > 0) problems.push(`  ${unknown.length} key(s) that were not asked for:\n${listPaths(unknown)}`);
  if (problems.length > 0) {
    throw new Error(`The pasted JSON does not match what was asked:\n${problems.join('\n')}`);
  }

  const empty = leafPaths(answer).filter((path) => {
    const value = path
      .split('.')
      .reduce<string | Tree | undefined>((node, key) => (isTree(node) ? node[key] : undefined), answer);
    return !isTranslated(value);
  });
  if (empty.length > 0) {
    throw new Error(`These translations are empty:\n${listPaths(empty)}`);
  }
}

/**
 * The target completed with the answer, in the source's key order. Keys only in the target are
 * kept and reported by the caller.
 */
export function mergeTree(source: Tree, target: Tree, answer: Tree): Tree {
  const merged: Tree = {};

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    const answerValue = answer[key];

    if (isTree(sourceValue)) {
      merged[key] = mergeTree(
        sourceValue,
        isTree(targetValue) ? targetValue : {},
        isTree(answerValue) ? answerValue : {},
      );
      continue;
    }

    if (typeof answerValue === 'string') merged[key] = answerValue;
    else if (targetValue !== undefined) merged[key] = targetValue;
  }

  for (const [key, targetValue] of Object.entries(target)) {
    if (!(key in source)) merged[key] = targetValue;
  }

  return merged;
}

/** Paths in the target that the source does not have (obsolete or renamed). */
export function extraPaths(source: Tree, target: Tree, path: string[] = []): string[] {
  const paths: string[] = [];
  for (const [key, targetValue] of Object.entries(target)) {
    const here = [...path, key];
    const sourceValue = source[key];
    if (sourceValue === undefined)
      paths.push(...(isTree(targetValue) ? leafPaths(targetValue, here) : [here.join('.')]));
    else if (isTree(sourceValue) && isTree(targetValue)) paths.push(...extraPaths(sourceValue, targetValue, here));
  }
  return paths;
}

function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * LLM answers are often wrapped (a sentence, a ```json fence), so only what lies between the
 * outermost braces is parsed.
 */
export function extractJson(text: string): Tree {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('No JSON object found in what was pasted');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`The pasted text is not valid JSON: ${(error as Error).message}`);
  }
  if (!isTree(parsed)) throw new Error('The pasted JSON must be an object');
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const lang = args.find((arg) => !arg.startsWith('-'));
  if (!lang) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
  if (lang === SOURCE_LANG) {
    process.stderr.write(`${SOURCE_LANG} is the source language; there is nothing to translate into it\n`);
    process.exit(1);
  }

  const sourcePath = join(LOCALES_DIR, `${SOURCE_LANG}.json`);
  const targetPath = join(LOCALES_DIR, `${lang}.json`);
  const source = await readTree(sourcePath, false);
  const target = await readTree(targetPath, true);

  const missing = missingTree(source, target);
  const extra = extraPaths(source, target);
  if (extra.length > 0) {
    process.stderr.write(
      `${targetPath} holds ${extra.length} key(s) absent from ${sourcePath}, kept as they are:\n${listPaths(extra)}\n\n`,
    );
  }

  if (!missing) {
    process.stderr.write(`${targetPath} is up to date - ${leafPaths(source).length} keys, none missing\n`);
    return;
  }

  const count = leafPaths(missing).length;
  process.stdout.write(`Translate to ${languageName(lang)}:\n\n${JSON.stringify(missing, null, 2)}\n`);
  process.stderr.write(`\n${count} missing key(s). Paste the translated JSON below, then press Ctrl+D.\n`);

  const pasted = await readStdin();
  if (pasted.trim().length === 0) {
    process.stderr.write(`Nothing pasted; ${targetPath} left untouched\n`);
    process.exit(1);
  }

  const answer = extractJson(pasted);
  checkAnswer(missing, answer);

  const merged = mergeTree(source, target, answer);
  await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  process.stderr.write(`${targetPath}: ${count} key(s) added\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
