/**
 * Extraction library types (knowledge store, design §8.2–8.3). Pure: no store, no I/O.
 */

export type ExtractStatus = 'ok' | 'empty' | 'unsupported' | 'too_large' | 'failed';

/** A structural unit of a document: a section under a heading, a page, a slide or a sheet. */
export type Block = { headingPath: string; locator?: string; text: string };

export type Extracted = {
  status: ExtractStatus;
  extractor: string;
  blocks: Block[];
  error?: string;
  /**
   * PDF only (when it parsed): the normalized text of every page in order, `''` for a page without
   * a text layer. `blocks` drops the empty pages; OCR pass 1 (`ocr/rules.ts`) needs them all.
   */
  pages?: string[];
};

export type ExtractOptions = {
  /** Cap on the normalized text of one artifact (config `knowledge.extraction.maxTextChars`). */
  maxTextChars: number;
  /** Rows kept per xlsx sheet (config `knowledge.extraction.xlsxMaxRows`). */
  xlsxMaxRows: number;
  /** Rows kept from a csv; defaults to `xlsxMaxRows`. */
  csvMaxRows?: number;
  /** Inputs larger than this are `too_large` without parsing. Default `DEFAULT_MAX_INPUT_BYTES`. */
  maxInputBytes?: number;
  /** Cap on the declared uncompressed size of the zip parts an office extractor reads. */
  maxUnzippedBytes?: number;
  /** Original file name, used only to pick an extractor when `mime` is generic. */
  filename?: string;
};

export type Chunk = {
  seq: number;
  headingPath: string;
  locator?: string;
  text: string;
  /** Offsets into `blocksText(blocks)`; `blocksText(blocks).slice(charStart, charEnd) === text`. */
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
};

export type ChunkOptions = { chunkTokens: number; maxChunkTokens: number };

/** Defaults from design §8.2 / §16 (`knowledge.extraction`). */
export const DEFAULT_MAX_TEXT_CHARS = 2_000_000;
export const DEFAULT_XLSX_MAX_ROWS = 2_000;
export const DEFAULT_CHUNK_TOKENS = 400;
export const DEFAULT_MAX_CHUNK_TOKENS = 600;
/** Same as the artifact store's limit (`MAX_ARTIFACT_BYTES`, 50 MB). */
export const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  maxTextChars: DEFAULT_MAX_TEXT_CHARS,
  xlsxMaxRows: DEFAULT_XLSX_MAX_ROWS,
};

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkTokens: DEFAULT_CHUNK_TOKENS,
  maxChunkTokens: DEFAULT_MAX_CHUNK_TOKENS,
};

/** Thrown inside extractors when a size cap is hit; `extract` maps it to `too_large`. */
export class ExtractTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractTooLargeError';
  }
}
