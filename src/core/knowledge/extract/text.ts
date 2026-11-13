import type { Block } from './types.js';

/** Splits a mime type into its lowercase base and its `charset` parameter (if any). */
export function parseMime(mime: string): { base: string; charset?: string } {
  const [base = '', ...params] = mime.split(';');
  const out: { base: string; charset?: string } = { base: base.trim().toLowerCase() };
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(p);
    if (m) out.charset = m[1]!.toLowerCase();
  }
  return out;
}

function decoderFor(label: string | undefined): TextDecoder {
  if (label) {
    try {
      return new TextDecoder(label);
    } catch {
      // unknown label: fall through to utf-8
    }
  }
  return new TextDecoder('utf-8');
}

/**
 * Bytes → string. A byte-order mark wins, then `charset`, then utf-8. Invalid sequences become
 * U+FFFD; decoding never throws.
 */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  return decoderFor(charset).decode(bytes);
}

/** Plain text and JSON: as is, one block. */
export function extractPlain(text: string): Block[] {
  return [{ headingPath: '', text }];
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const NOT_SETEXT_TEXT = /^ {0,3}(?:[-*+>]|\d+[.)]|#|\||$)/;

/**
 * Markdown: text as is; ATX and setext headings (outside fenced code and front matter) become
 * the heading path and are not repeated in the text.
 */
export function extractMarkdown(text: string): Block[] {
  const lines = text.split(/\r\n?|\n/);
  const blocks: Block[] = [];
  const stack: { level: number; text: string }[] = [];
  let body: string[] = [];
  const flush = () => {
    if (body.some((l) => l.trim())) blocks.push({ headingPath: stack.map((h) => h.text).join(' > '), text: body.join('\n') });
    body = [];
  };
  const heading = (level: number, title: string) => {
    flush();
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    if (title) stack.push({ level, text: title });
  };
  let i = 0;
  // Front matter is body text, never a heading.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) {
      body.push(...lines.slice(0, close + 1));
      i = close + 1;
    }
  }
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined;
      body.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      body.push(line);
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      heading(atx[1]!.length, (atx[2] ?? '').trim());
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !NOT_SETEXT_TEXT.test(line) && (SETEXT_H1.test(next) || SETEXT_H2.test(next))) {
      heading(SETEXT_H1.test(next) ? 1 : 2, line.trim());
      i++;
      continue;
    }
    body.push(line);
  }
  flush();
  return blocks;
}

/** Number of rows in csv text, honouring quoted fields that contain line breaks. */
function csvRowEnds(text: string, limit: number): { cut: number; rows: number } {
  let inQuotes = false;
  let rows = 0;
  let cut = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 34 /* " */) inQuotes = !inQuotes;
    else if (!inQuotes && (ch === 10 || ch === 13)) {
      if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
      rows++;
      if (rows === limit) cut = i + 1;
    }
  }
  if (text.length && !/[\r\n]$/.test(text)) rows++;
  return { cut: rows > limit ? cut : text.length, rows };
}

/** csv / tsv: as is, first `maxRows` rows, with a note when cut. */
export function extractCsv(text: string, maxRows: number): Block[] {
  const limit = Math.max(1, Math.floor(maxRows));
  const { cut, rows } = csvRowEnds(text, limit);
  if (rows <= limit) return [{ headingPath: '', text }];
  return [{ headingPath: '', text: `${text.slice(0, cut).replace(/\r?\n$/, '')}\n[truncated: first ${limit} of ${rows} rows]` }];
}
