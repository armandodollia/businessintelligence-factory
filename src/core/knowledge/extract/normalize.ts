import { createHash } from 'node:crypto';
import type { Block } from './types.js';

/**
 * Invisible characters removed by normalization (design §8.2): zero-width characters, bidi
 * controls, soft hyphen, Mongolian vowel separator, invisible math operators, BOM, interlinear
 * annotation marks, and the Unicode tag block (used to smuggle hidden instructions). C0/C1
 * controls other than tab and newline go too.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]/g;

/** Line separators unified to `\n`. */
const LINE_BREAK = /\r\n?|[\u0085\u2028\u2029]/g;

/** Horizontal whitespace, including NBSP and the Unicode space separators. */
const HSPACE = /[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

/**
 * Design §8.2 normalization: NFC, invisible and control characters stripped, line breaks unified,
 * horizontal whitespace collapsed to one space, lines trimmed, at most one blank line in a row,
 * trimmed. Idempotent. The `maxTextChars` cap is applied by `extract`, not here.
 */
export function normalizeText(s: string): string {
  return s
    .replace(LINE_BREAK, '\n')
    .replace(INVISIBLE, '')
    .normalize('NFC')
    .replace(HSPACE, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Token estimate used everywhere in the knowledge store: `ceil(chars / 4)` (UTF-16 units). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * sha256 (hex) of a document's normalized text: each non-empty block contributes its normalized
 * heading path and text. Locators (page/slide numbers) are layout, not content, and are ignored.
 */
export function contentHash(blocks: Block[]): string {
  const h = createHash('sha256');
  for (const b of blocks) {
    const text = normalizeText(b.text);
    if (!text) continue;
    const heading = normalizeText(b.headingPath).replace(/\n/g, ' ');
    // U+0000 cannot survive normalization, so it is an unambiguous separator.
    h.update(`${heading}\u0000${text}\u0000`, 'utf8');
  }
  return h.digest('hex');
}
