/**
 * Minimal XML helpers. The SOAP payloads read here (VIES checkVat, AADE RgWsPublic2) are small and
 * flat, so a tag extractor is enough.
 */
export function extractTag(xml: string, tag: string): string | null {
  // The opening tag may have attributes: the ABN extract writes
  // `<ABN status="ACT" ABNStatusFromDate="19991101">11000000948</ABN>`. The space before attributes is
  // required, so `<ABN>` and `<ABNStatus>` stay distinct.
  const match = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return match ? decodeXmlEntities((match[1] ?? '').trim()) : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes entities: "H &amp; M Hennes &amp; Mauritz AB" must come back readable. */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * An attribute value on the first `<tag ...>`. Peppol business cards use attributes
 * (`<participant value="9930:de811335517"/>`).
 */
export function extractAttribute(xml: string, tag: string, attribute: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?\\b${attribute}="([^"]*)"`).exec(xml);
  return match ? decodeXmlEntities(match[1] ?? '') : null;
}

/**
 * Splits a large XML document into repeated elements without holding it in memory (the Peppol
 * export is 1.7 GB of `<businesscard>`).
 *
 * `encoding` is for non-UTF-8 files (the Ukrainian register is windows-1251). Passed to
 * `TextDecoder`, used in streaming mode so multi-byte characters survive chunk boundaries.
 *
 * Elements and characters can span chunks, so the decoder uses `stream: true` and the end of a
 * chunk is carried over.
 */
export async function* streamXmlElements(
  input: AsyncIterable<Uint8Array>,
  tag: string,
  encoding = 'utf-8',
): AsyncGenerator<string> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const decoder = new TextDecoder(encoding);
  let buffer = '';

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });

    for (let end = buffer.indexOf(close); end !== -1; end = buffer.indexOf(close)) {
      const start = buffer.indexOf(open);
      if (start !== -1 && start < end) yield buffer.slice(start, end + close.length);
      buffer = buffer.slice(end + close.length);
    }

    // Drop the prologue and text between elements, so the buffer holds one element at most.
    const next = buffer.indexOf(open);
    if (next > 0) buffer = buffer.slice(next);
  }
}

/**
 * Re-indents a SOAP document for the terminal. Splits on tag boundaries rather than parsing, so it
 * never fails (a VIES fault can be a Java stack trace).
 *
 * Text is never changed, only whitespace between tags, so addresses keep their line breaks.
 */
export function indentXml(xml: string, indent = '  '): string {
  const tokens = xml.trim().match(/<[^>]*>|[^<]+/g) ?? [];
  const lines: string[] = [];
  let depth = 0;
  // True when the last line ends with text, so the closing tag joins it: `<name>ACME</name>`.
  let onText = false;

  const push = (line: string): void => {
    lines.push(`${indent.repeat(depth)}${line}`);
  };
  const append = (text: string): void => {
    if (lines.length === 0) push(text);
    else lines[lines.length - 1] += text;
  };

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      // Whitespace between tags is layout, and the only thing removed.
      if (token.trim().length === 0) continue;
      append(token);
      onText = true;
      continue;
    }

    if (token.startsWith('</')) {
      if (onText) append(token);
      else {
        depth = Math.max(0, depth - 1);
        push(token);
      }
      // The element is closed. Its parent is what the next tag nests under.
      if (onText) depth = Math.max(0, depth - 1);
      onText = false;
      continue;
    }

    push(token);
    // `<a/>`, `<?xml ...?>` and `<!-- ... -->` open nothing.
    if (!/^<[!?]/.test(token) && !token.endsWith('/>')) depth += 1;
    onText = false;
  }

  return lines.join('\n');
}
