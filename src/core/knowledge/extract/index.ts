/**
 * Knowledge-store extraction library (KS-1a; design §8.1–8.4). Pure and deterministic: bytes in,
 * blocks out. No store, no network, never executes or renders the input. `extract` never throws:
 * a parser error becomes `status: 'failed'` with its message.
 */
import { BLOCK_SEPARATOR, blocksText } from './chunk.js';
import { extractHtml } from './html.js';
import { normalizeText } from './normalize.js';
import { extractDocx, extractPptx, extractXlsx, zipEntryNames } from './office.js';
import { extractPdf } from './pdf.js';
import { decodeBytes, extractCsv, extractMarkdown, extractPlain, parseMime } from './text.js';
import {
  type Block,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_UNZIPPED_BYTES,
  type Extracted,
  type ExtractOptions,
  ExtractTooLargeError,
} from './types.js';

export { blocksText, BLOCK_SEPARATOR, chunk } from './chunk.js';
export { contentHash, estimateTokens, normalizeText } from './normalize.js';
export { urlKey } from './urlKey.js';
export * from './types.js';

export type ExtractKind = 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'markdown' | 'csv' | 'json' | 'text' | 'image' | 'none';

/** Extractor name and version per kind (`name@n`). Bump `n` when an extractor's output changes. */
export const EXTRACTORS: Record<ExtractKind, string> = {
  html: 'html@1',
  pdf: 'pdf@1',
  docx: 'docx@1',
  pptx: 'pptx@1',
  xlsx: 'xlsx@1',
  markdown: 'markdown@1',
  csv: 'csv@1',
  json: 'json@1',
  text: 'text@1',
  image: 'image@1',
  none: 'none@1',
};

const MIME_KIND: Record<string, ExtractKind> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/json': 'json',
  'text/json': 'json',
  'text/plain': 'text',
};

const EXT_KIND: Record<string, ExtractKind> = {
  html: 'html', htm: 'html', xhtml: 'html', pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx',
  md: 'markdown', markdown: 'markdown', csv: 'csv', tsv: 'csv', json: 'json', txt: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image',
};

/** Mimes that say nothing about the content; the bytes (then the file name) decide. */
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/zip', 'application/x-zip-compressed']);

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

function sniff(bytes: Uint8Array, filename: string | undefined): ExtractKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const names = new Set(zipEntryNames(bytes));
      if (names.has('word/document.xml')) return 'docx';
      if (names.has('ppt/presentation.xml')) return 'pptx';
      if (names.has('xl/workbook.xml')) return 'xlsx';
    } catch {
      // not a readable zip: fall through
    }
  }
  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || // GIF8
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) // RIFF....WEBP
  ) {
    return 'image';
  }
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1]?.toLowerCase();
  return (ext && EXT_KIND[ext]) || 'none';
}

/** Which extractor handles this input. */
export function extractKind(bytes: Uint8Array, mime: string, filename?: string): ExtractKind {
  const { base } = parseMime(mime);
  const known = MIME_KIND[base];
  if (known) return known;
  if (base.startsWith('image/')) return 'image';
  if (base.endsWith('+json')) return 'json';
  if (GENERIC.has(base)) return sniff(bytes, filename);
  if (base.startsWith('text/')) return 'text';
  return 'none';
}

async function run(kind: ExtractKind, bytes: Uint8Array, charset: string | undefined, opts: ExtractOptions): Promise<Block[]> {
  const maxUnzipped = opts.maxUnzippedBytes ?? DEFAULT_MAX_UNZIPPED_BYTES;
  switch (kind) {
    case 'html':
      return extractHtml(bytes, charset);
    case 'pdf':
      return extractPdf(bytes);
    case 'docx':
      return extractDocx(bytes, maxUnzipped);
    case 'pptx':
      return extractPptx(bytes, maxUnzipped);
    case 'xlsx':
      return extractXlsx(bytes, opts.xlsxMaxRows, maxUnzipped);
    case 'markdown':
      return extractMarkdown(decodeBytes(bytes, charset));
    case 'csv':
      return extractCsv(decodeBytes(bytes, charset), opts.csvMaxRows ?? opts.xlsxMaxRows);
    case 'json':
    case 'text':
      return extractPlain(decodeBytes(bytes, charset));
    default:
      return [];
  }
}

/** Cuts a string at `n` UTF-16 units without splitting a surrogate pair. */
function cutAt(s: string, n: number): string {
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Normalizes every block, drops empty ones, and caps `blocksText(blocks)` at `maxTextChars`.
 * Over the cap: `too_large`, with the blocks that fit (the last one cut) so the caller may
 * still index the start of the document.
 */
function finish(raw: Block[], extractor: string, maxTextChars: number): Extracted {
  const blocks: Block[] = [];
  for (const b of raw) {
    const text = normalizeText(b.text);
    if (!text) continue;
    const out: Block = { headingPath: normalizeText(b.headingPath).replace(/\n/g, ' '), text };
    if (b.locator !== undefined) out.locator = b.locator;
    blocks.push(out);
  }
  if (blocks.length === 0) return { status: 'empty', extractor, blocks: [] };
  const capped = capBlocks(blocks, maxTextChars);
  if (!capped.cut) return { status: 'ok', extractor, blocks };
  return { status: 'too_large', extractor, blocks: capped.blocks, error: capped.error };
}

/**
 * Caps `blocksText(blocks)` at `maxTextChars`: the blocks that fit, the last one cut (exported for
 * KS-1 ingest, which redacts identity secrets BEFORE applying the cap). `cut` and the `too_large`
 * message when anything was left out.
 */
export function capBlocks(blocks: Block[], maxTextChars: number): { blocks: Block[]; cut: boolean; error?: string } {
  const max = Math.max(0, Math.floor(maxTextChars));
  if (blocksText(blocks).length <= max) return { blocks, cut: false };
  const kept: Block[] = [];
  let used = 0;
  for (const b of blocks) {
    const sep = kept.length ? BLOCK_SEPARATOR.length : 0;
    const room = max - used - sep;
    if (room <= 0) break;
    if (b.text.length <= room) {
      kept.push(b);
      used += sep + b.text.length;
      continue;
    }
    const text = cutAt(b.text, room).trimEnd();
    if (text) kept.push({ ...b, text });
    break;
  }
  return { blocks: kept, cut: true, error: `text exceeds maxTextChars (${max}); kept the first ${blocksText(kept).length} characters` };
}

/** One line, bounded: parser messages can quote input, and the error is stored and shown. */
function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = normalizeText(raw).replace(/\s+/g, ' ');
  return (line.length > 300 ? `${cutAt(line, 300)}…` : line) || 'extraction failed';
}

/**
 * Extracts text blocks from an artifact's bytes (design §8.2). Never throws.
 * - `unsupported`: images and unknown types (searchable by title/description only);
 * - `too_large`: input over `maxInputBytes`, zip parts over `maxUnzippedBytes` (no blocks), or
 *   text over `maxTextChars` (blocks cut at the cap);
 * - `empty`: parsed, but no text (e.g. a PDF without a text layer);
 * - `failed`: the parser threw; `error` holds its message.
 */
export async function extract(bytes: Uint8Array, mime: string, opts: ExtractOptions): Promise<Extracted> {
  let extractor = EXTRACTORS.none;
  try {
    const kind = extractKind(bytes, mime ?? '', opts.filename);
    extractor = EXTRACTORS[kind];
    if (kind === 'image' || kind === 'none') return { status: 'unsupported', extractor, blocks: [] };
    const maxInput = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (bytes.byteLength > maxInput) {
      return { status: 'too_large', extractor, blocks: [], error: `input is ${bytes.byteLength} bytes; the limit is ${maxInput}` };
    }
    const raw = await run(kind, bytes, parseMime(mime ?? '').charset, opts);
    const out = finish(raw, extractor, opts.maxTextChars);
    // One raw block per PDF page (`extractPdf`), text or not.
    if (kind === 'pdf') out.pages = raw.map((b) => normalizeText(b.text));
    return out;
  } catch (e) {
    if (e instanceof ExtractTooLargeError) return { status: 'too_large', extractor, blocks: [], error: errorMessage(e) };
    return { status: 'failed', extractor, blocks: [], error: errorMessage(e) };
  }
}
