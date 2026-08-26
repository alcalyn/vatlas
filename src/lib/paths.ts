import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks up to the nearest package.json, so paths outside `src/` (like the download cache) resolve
 * the same from `src/` (tsx) and `dist/`.
 */
export function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Project root not found: no package.json in any parent directory');
    dir = parent;
  }
}

export const projectRoot = findProjectRoot();
