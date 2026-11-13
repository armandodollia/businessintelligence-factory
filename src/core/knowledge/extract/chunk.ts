import { estimateTokens } from './normalize.js';
import type { Block, Chunk, ChunkOptions } from './types.js';

/** Separator between blocks in the document-wide text that chunk offsets refer to. */
export const BLOCK_SEPARATOR = '\n\n';

/** The document-wide text: block texts joined by a blank line. Chunk offsets index into it. */
export function blocksText(blocks: Block[]): string {
  return blocks.map((b) => b.text).join(BLOCK_SEPARATOR);
}

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Boundary finders, best first: paragraph break, line break, sentence end, any whitespace.
 * Each returns cut positions `c` such that a chunk may end at `c` (exclusive) inside [lo, hi].
 */
const BOUNDARIES: RegExp[] = [/\n[^\S\n]*\n/g, /\n/g, /[.!?\u3002\uFF01\uFF1F]["'\u2019\u201D)\]]*(?=\s)/g, /\s/g];

function cutsAt(re: RegExp, text: string, lo: number, hi: number, isSentence: boolean): number[] {
  const cuts: number[] = [];
  // Scan only a bounded window (a little before `lo`, so a match ending inside it is found, and
  // one character past `hi` for look-ahead), so long texts stay linear.
  const base = Math.max(0, lo - 8);
  const window = text.slice(base, hi + 1);
  re.lastIndex = 0;
  for (let m = re.exec(window); m; m = re.exec(window)) {
    const c = base + (isSentence ? m.index + m[0].length : m.index);
    if (c > hi) break;
    if (c >= lo) cuts.push(c);
    if (m[0].length === 0) re.lastIndex++;
  }
  return cuts;
}

function findCut(text: string, pos: number, end: number, target: number, max: number): number {
  const hi = Math.min(end, pos + max);
  const lo = Math.min(hi, pos + Math.max(1, Math.floor(target / 2)));
  const goal = pos + target;
  for (let level = 0; level < BOUNDARIES.length; level++) {
    const cuts = cutsAt(BOUNDARIES[level]!, text, lo, hi, level === 2);
    if (cuts.length === 0) continue;
    let best = cuts[0]!;
    for (const c of cuts) if (Math.abs(c - goal) < Math.abs(best - goal)) best = c;
    return best;
  }
  // No boundary at all: hard cut, never between the halves of a surrogate pair.
  const code = text.charCodeAt(hi - 1);
  return code >= 0xd800 && code <= 0xdbff && hi - 1 > pos ? hi - 1 : hi;
}

/**
 * Design §8.3: structure first (each block is a section, page, slide or sheet and chunks never
 * span blocks), then split to about `chunkTokens` and at most `maxChunkTokens` on paragraph,
 * line, sentence and word boundaries, with no overlap. Chunk edges are trimmed of whitespace;
 * offsets index `blocksText(blocks)`. Deterministic.
 */
export function chunk(blocks: Block[], opts: ChunkOptions): Chunk[] {
  const target = Math.max(1, Math.floor(opts.chunkTokens)) * 4;
  const max = Math.max(target, Math.floor(opts.maxChunkTokens) * 4);
  const text = blocksText(blocks);
  const out: Chunk[] = [];
  let offset = 0;
  for (const block of blocks) {
    const end = offset + block.text.length;
    const emit = (start: number, stop: number) => {
      let e = stop;
      while (e > start && isWs(text[e - 1])) e--;
      if (e <= start) return;
      const piece = text.slice(start, e);
      const c: Chunk = {
        seq: out.length,
        headingPath: block.headingPath,
        text: piece,
        charStart: start,
        charEnd: e,
        tokenEstimate: estimateTokens(piece),
      };
      if (block.locator !== undefined) c.locator = block.locator;
      out.push(c);
    };
    let pos = offset;
    while (pos < end) {
      while (pos < end && isWs(text[pos])) pos++;
      if (pos >= end) break;
      if (end - pos <= max) {
        emit(pos, end);
        break;
      }
      const cut = findCut(text, pos, end, target, max);
      emit(pos, cut);
      pos = cut;
    }
    offset = end + BLOCK_SEPARATOR.length;
  }
  return out;
}
