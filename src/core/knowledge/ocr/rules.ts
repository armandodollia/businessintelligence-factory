/**
 * OCR pass 1 (rules): decides, without any model call, which parts of an artifact have no usable
 * text and must be read by a model in pass 2 (`ocr/haiku.ts`). Pure: no store, no I/O.
 *
 * - PDF: the text layer settles every page that has one. A page goes to pass 2 only when its text
 *   layer is missing (`no_text`) or unusable (`garbled`).
 * - Image: no text layer at all; `images` says which images are read (uploads only, all, none).
 * - Everything else is settled by its extractor.
 *
 * Pass 2 sends the WHOLE file (a PDF as one document, an image as one image), so a file over
 * `maxFileBytes` or a PDF over `MAX_PDF_PAGES` is skipped, with the reason.
 */
import type { Artifact } from '../../types.js';
import type { ExtractKind } from '../extract/index.js';

export type OcrImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type OcrRuleSettings = {
  /** Which images are read: uploads only, every image, or none. */
  images: 'uploads' | 'all' | 'none';
  /** A PDF page with fewer non-space characters than this has no text layer worth keeping. */
  minPageChars: number;
  /** Pages of one document sent to the model; the rest are left out and counted. */
  maxPages: number;
  /** Files larger than this are not sent. */
  maxFileBytes: number;
};

export type OcrPlan =
  /** Nothing for a model to read. */
  | { action: 'none' }
  /** A model would be needed, but a rule forbids sending the file. */
  | { action: 'skip'; reason: string }
  | { action: 'read'; target: 'image'; mediaType: OcrImageMediaType }
  /** `pages` are 1-based; `leftOut` pages also need reading but are over `maxPages`. */
  | { action: 'read'; target: 'pdf'; pages: number[]; leftOut: number };

/** Most pages a PDF may have to be sent as one document. */
export const MAX_PDF_PAGES = 100;
/** Largest image the model accepts. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images smaller than this hold no readable text (icons, tracking pixels). */
export const MIN_IMAGE_BYTES = 1024;

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** The image format by its magic bytes; `undefined` for a format the model cannot be sent. */
export function imageMediaType(bytes: Uint8Array): OcrImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/**
 * Why a PDF page's text layer does not settle the page, or `undefined` when it does.
 * `no_text`: fewer than `minPageChars` non-space characters (blank, a scan, or just a page number).
 * `garbled`: enough characters, but under half are letters or digits, or over a tenth are U+FFFD
 * (a font without a usable character map).
 */
export function pageNeedsOcr(text: string, minPageChars: number): 'no_text' | 'garbled' | undefined {
  const chars = [...text.replace(/\s+/gu, '')];
  if (chars.length < minPageChars) return 'no_text';
  let words = 0;
  let replaced = 0;
  for (const c of chars) {
    if (c === '�') replaced++;
    else if (/[\p{L}\p{N}]/u.test(c)) words++;
  }
  if (replaced / chars.length > 0.1 || words / chars.length < 0.5) return 'garbled';
  return undefined;
}

export type OcrPlanInput = {
  kind: ExtractKind;
  /** PDF only: the text of every page in order (`''` for a page without text). Absent when the PDF was not parsed. */
  pages?: readonly string[];
  bytes: Uint8Array;
  artifactKind: Artifact['kind'];
};

/** What pass 2 has to read of this artifact, if anything. */
export function planOcr(input: OcrPlanInput, s: OcrRuleSettings): OcrPlan {
  const size = input.bytes.byteLength;
  if (input.kind === 'image') {
    if (s.images === 'none' || (s.images === 'uploads' && input.artifactKind !== 'upload')) return { action: 'none' };
    if (size < MIN_IMAGE_BYTES) return { action: 'none' };
    const mediaType = imageMediaType(input.bytes);
    if (!mediaType) return { action: 'skip', reason: 'image format cannot be read (png, jpeg, gif and webp can)' };
    const limit = Math.min(s.maxFileBytes, MAX_IMAGE_BYTES);
    if (size > limit) return { action: 'skip', reason: `image is ${size} bytes; the limit is ${limit}` };
    return { action: 'read', target: 'image', mediaType };
  }
  if (input.kind === 'pdf' && input.pages) {
    const flagged: number[] = [];
    input.pages.forEach((text, i) => {
      if (pageNeedsOcr(text, s.minPageChars)) flagged.push(i + 1);
    });
    if (!flagged.length) return { action: 'none' };
    if (size > s.maxFileBytes) return { action: 'skip', reason: `pdf is ${size} bytes; the limit is ${s.maxFileBytes}` };
    if (input.pages.length > MAX_PDF_PAGES) return { action: 'skip', reason: `pdf has ${input.pages.length} pages; the limit is ${MAX_PDF_PAGES}` };
    const max = Math.max(0, Math.floor(s.maxPages));
    return { action: 'read', target: 'pdf', pages: flagged.slice(0, max), leftOut: Math.max(0, flagged.length - max) };
  }
  return { action: 'none' };
}
