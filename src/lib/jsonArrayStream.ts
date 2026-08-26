import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Yields the objects of a top-level JSON array one at a time.
 *
 * The Finnish bulk file is one 1.4 GB array. Elements are small, so tracking brace depth (with
 * strings and escapes) is enough to split the stream.
 */
export async function* streamJsonArray<T>(input: Readable): AsyncGenerator<T> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  // Where the scan stopped in the previous chunk, since elements, strings and escapes can span
  // chunks.
  let cursor = 0;

  for await (const chunk of input) {
    buffer += decoder.write(chunk as Buffer);

    for (let i = cursor; i < buffer.length; i += 1) {
      const char = buffer[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          yield JSON.parse(buffer.slice(start, i + 1)) as T;
          // Drop consumed text so the buffer stays about one element long.
          buffer = buffer.slice(i + 1);
          start = -1;
          i = -1;
        }
      }
    }

    cursor = buffer.length;
  }
}
