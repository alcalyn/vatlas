import { emitKeypressEvents } from 'node:readline';

/**
 * A minimal arrow-key picker, to avoid a prompt library dependency for a development command.
 *
 * The list is redrawn in place by moving the cursor back up. Without a TTY the caller is told,
 * rather than waiting for input that cannot come.
 */
export interface SelectOptions<T> {
  items: T[];
  /** One line per item. The caller formats, the picker adds the marker. */
  render: (item: T, index: number) => string;
  header?: string;
}

const ESC = '\u001b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export async function select<T>({ items, render, header }: SelectOptions<T>): Promise<T | undefined> {
  if (items.length === 0) return undefined;
  if (!process.stdin.isTTY) {
    throw new Error('Selecting needs an interactive terminal; run this command directly, not through a pipe');
  }

  let cursor = 0;
  let drawnLines = 0;

  const draw = (): void => {
    const lines: string[] = [];
    if (header) lines.push(header, '');
    items.forEach((item, index) => {
      const selected = index === cursor;
      // Caret and bold together, in case the terminal drops escape sequences.
      const marker = selected ? `${ESC}[1m> ` : '  ';
      lines.push(`${marker}${render(item, index)}${selected ? `${ESC}[0m` : ''}`);
    });
    lines.push('', '  up/down move - enter select - q cancel');

    // Back to the top of the previous drawing, then clear below.
    const up = drawnLines > 0 ? `${ESC}[${drawnLines}A` : '';
    process.stdout.write(`${up}${ESC}[0J${lines.join('\n')}\n`);
    drawnLines = lines.length;
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(HIDE_CURSOR);
  draw();

  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const onKey = (_: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
        if (!key) return;
        if (key.name === 'up' || key.name === 'k') {
          cursor = (cursor - 1 + items.length) % items.length;
          draw();
        } else if (key.name === 'down' || key.name === 'j') {
          cursor = (cursor + 1) % items.length;
          draw();
          // Both names: a pty Enter arrives as '\r' (`return`), an LF as `enter`.
        } else if (key.name === 'return' || key.name === 'enter') {
          process.stdin.off('keypress', onKey);
          resolve(items[cursor]);
        } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl === true && key.name === 'c')) {
          process.stdin.off('keypress', onKey);
          resolve(undefined);
        }
      };
      process.stdin.on('keypress', onKey);
      process.stdin.once('error', reject);
    });
  } finally {
    process.stdout.write(SHOW_CURSOR);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
