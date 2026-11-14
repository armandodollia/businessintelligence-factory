/**
 * Extraction pipeline (KS-1; design §8.2–8.5). `ingestArtifact(id)`: bytes → `extract` (KS-1a) →
 * redaction and fence stripping → `artifact_texts` (the `pending` row KS-0's trigger wrote is
 * UPDATED) → duplicate check by `content_sha256` within the business tree → chunks, all in one
 * transaction. Never throws: every failure is recorded on the text row (status `failed`).
 *
 * Duplicates (design §8.4): an artifact whose text equals that of an earlier artifact of the same
 * tree gets `duplicate_of` = that artifact and no chunks. The canonical is always an artifact whose
 * own `duplicate_of` is NULL, so `duplicate_of` is followed one level. The migration-18 triggers
 * flag a duplicate as upload-derived when its canonical is (now or later); a duplicate that is
 * itself an upload is flagged by its kind — so a duplicate is upload-derived if either copy is.
 *
 * Two-pass OCR: when an `OcrQueue` is registered for the artifact store (`ocr/registry.ts`) and
 * `knowledge.ocr.enabled`, the rules of pass 1 (`ocr/rules.ts`) run here on the extractor's result
 * and write `ocr_status`; an artifact left `pending` is handed to the queue, whose model pass
 * (`ocr/worker.ts`) APPENDS chunks later. Without a queue nothing is planned (`ocr_status` NULL).
 *
 * `Ingestor` runs ingestion inline for files ≤ `extraction.inlineMaxBytes`, otherwise on an
 * in-process queue (`extraction.concurrency`). `requeuePending()` re-queues `pending` rows at
 * startup. One ingestor per `ArtifactStore` (`ingestorFor`), shared by tools and uploads.
 */
import { readFileSync, statSync } from 'node:fs';
import type { BifConfig } from '../config/schema.js';
import type { ArtifactStore } from '../evidence/artifacts.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { ExtractionState, OcrState } from '../types.js';
import { descendants, rootOf } from '../workspace/tree.js';
import { knowledgeSettings, type KnowledgeSettings } from './config.js';
import { blocksText, capBlocks, chunk, contentHash, estimateTokens, extract, normalizeText } from './extract/index.js';
import type { ExtractKind } from './extract/index.js';
import type { Block, Extracted, ExtractOptions } from './extract/types.js';
import { ocrSinkFor } from './ocr/registry.js';
import { planOcr, type OcrPlan } from './ocr/rules.js';
import { capText, chunkCount, SERVED_ERROR_MAX_CHARS, textTruncated } from './texts.js';
import { redactServed, stripFences, stripSecretTail, treeSecrets } from './trust.js';

export type IngestDeps = { store: Store; artifacts: ArtifactStore; config?: Pick<BifConfig, 'knowledge'> };

export type IngestOptions = {
  /** Extraction function (tests); default KS-1a `extract`. */
  extract?: (bytes: Uint8Array, mime: string, opts: ExtractOptions) => Promise<Extracted>;
};

/** What a save reports about extraction (`save_artifact` → `extraction`). */
export type ExtractionSummary = {
  status: ExtractionState;
  /** Chunks holding the text (the canonical's for a duplicate). */
  chunks: number;
  /** `too_large` with its start indexed: the document was cut at the cap. */
  truncated?: true;
  duplicateOf?: string;
  /** Queued (larger than `inlineMaxBytes`); `status` stays `pending` until it ran. */
  queued?: true;
  uploadDerived?: true;
  /** OCR state when a model has (or had) something to read: text may still be coming while `pending`. */
  ocr?: Exclude<OcrState, 'none'>;
};

/** Every node id of `workspaceId`'s tree (the workspace alone when unknown). */
function treeIds(store: Store, workspaceId: string): string[] {
  const root = rootOf(store, workspaceId);
  const ids = [root, ...descendants(store, root).map((w) => w.id)];
  return ids.includes(workspaceId) ? ids : [...ids, workspaceId];
}

/** The current extraction summary of an artifact; `undefined` when it has no text row. */
export function extractionSummary(store: Store, artifactId: string): ExtractionSummary | undefined {
  const row = knowledgeRepos(store).artifactTexts.get(artifactId);
  if (!row) return undefined;
  const out: ExtractionSummary = { status: row.status, chunks: chunkCount(store, artifactId) };
  if (textTruncated(row)) out.truncated = true;
  if (row.duplicateOf) out.duplicateOf = row.duplicateOf;
  if (store.artifacts.get(artifactId)?.uploadDerived) out.uploadDerived = true;
  if (row.ocrStatus && row.ocrStatus !== 'none') out.ocr = row.ocrStatus;
  return out;
}

/** Identity secrets of the tree redacted, fence sequences stripped, re-normalized; empty blocks dropped. */
export function sanitizeBlocks(store: Store, workspaceId: string, blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of redactServed(store, workspaceId, blocks)) {
    const text = normalizeText(stripFences(b.text));
    if (!text) continue;
    const block: Block = { headingPath: normalizeText(stripFences(b.headingPath)).replace(/\n/g, ' '), text };
    if (b.locator !== undefined) block.locator = b.locator;
    out.push(block);
  }
  return out;
}

export const sanitizeError = (store: Store, workspaceId: string, e: string | undefined): string | undefined => {
  if (!e) return undefined;
  // KS-1a cuts its message at 300 chars (marked `…`) before any redaction: drop a secret cut there.
  const raw = e.endsWith('…') ? `${stripSecretTail(e.slice(0, -1), treeSecrets(store, workspaceId))}…` : e;
  const line = normalizeText(stripFences(redactServed(store, workspaceId, raw))).replace(/\s+/g, ' ');
  return line ? capText(line, SERVED_ERROR_MAX_CHARS) : undefined;
};

/**
 * KS-4 ruling "redact before cutting": the full normalized text is redacted, THEN capped at
 * `maxTextChars` and chunked. `extract` is asked for `maxTextChars + margin` (margin = the longest
 * secret of the tree), so a secret straddling the configured cap is still whole when redaction runs;
 * if `extract` itself had to cut (at cap + margin), a secret it cut in half is dropped from the tail.
 */
function redactThenCap(
  store: Store,
  workspaceId: string,
  extracted: Extracted,
  maxTextChars: number,
  secrets: readonly string[],
): { blocks: Block[]; status: ExtractionState; error?: string } {
  let blocks = sanitizeBlocks(store, workspaceId, extracted.blocks);
  const cutUpstream = extracted.status === 'too_large' && extracted.blocks.length > 0;
  if (cutUpstream && blocks.length) {
    const last = blocks[blocks.length - 1]!;
    const text = stripSecretTail(last.text, secrets).trimEnd();
    blocks = text ? [...blocks.slice(0, -1), { ...last, text }] : blocks.slice(0, -1);
  }
  const capped = capBlocks(blocks, maxTextChars);
  if (!capped.cut && !cutUpstream) return { blocks, status: extracted.status, ...(extracted.error ? { error: extracted.error } : {}) };
  const error = capped.error ?? `text exceeds maxTextChars (${maxTextChars}); kept the first ${blocksText(capped.blocks).length} characters`;
  return { blocks: capped.blocks, status: 'too_large', error };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || 'extraction failed';

/** Earliest artifact of the tree with this text hash that is itself canonical (one-level invariant). */
function findCanonical(store: Store, artifactId: string, workspaceId: string, hash: string): string | undefined {
  const row = store.db
    .prepare(
      `SELECT t.artifact_id AS id FROM artifact_texts t JOIN artifacts a ON a.id = t.artifact_id
       WHERE t.content_sha256 = ? AND t.duplicate_of IS NULL AND t.artifact_id <> ?
         AND t.status IN ('ok', 'too_large')
         AND a.workspace_id IN (SELECT value FROM json_each(?))
       ORDER BY a.rowid LIMIT 1`,
    )
    .get(hash, artifactId, JSON.stringify(treeIds(store, workspaceId))) as { id: string } | undefined;
  return row?.id;
}

/**
 * Extracts and indexes one artifact whose text row is `pending` (otherwise returns the current
 * summary and changes nothing). Never throws.
 */
export async function ingestArtifact(deps: IngestDeps, artifactId: string, opts: IngestOptions = {}): Promise<ExtractionSummary> {
  const { store, artifacts } = deps;
  const failedSummary: ExtractionSummary = { status: 'failed', chunks: 0 };
  try {
    const art = store.artifacts.get(artifactId);
    if (!art) return failedSummary;
    const k = knowledgeRepos(store);
    const before = k.artifactTexts.get(artifactId);
    if (before && before.status !== 'pending') return extractionSummary(store, artifactId)!;
    if (!before) k.artifactTexts.insert({ artifactId, workspaceId: art.workspaceId, status: 'pending', charCount: 0, tokenEstimate: 0 });

    const settings = knowledgeSettings(deps.config ?? {}).extraction;
    const secrets = treeSecrets(store, art.workspaceId);
    const margin = secrets.reduce((m, x) => Math.max(m, x.length), 0);
    let extracted: Extracted;
    let plan: OcrPlan | undefined;
    try {
      const bytes = readFileSync(artifacts.filePath(art));
      const filename = art.title && /\.[A-Za-z0-9]{1,10}$/.test(art.title) ? art.title : art.path;
      extracted = await (opts.extract ?? extract)(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), art.mime, {
        maxTextChars: settings.maxTextChars + margin,
        xlsxMaxRows: settings.xlsxMaxRows,
        filename,
      });
      // OCR pass 1 (rules): what, if anything, a model has to read. Only when OCR is available.
      const ocr = knowledgeSettings(deps.config ?? {}).ocr;
      if (ocr.enabled && ocrSinkFor(artifacts)) {
        const kind = extracted.extractor.split('@')[0] as ExtractKind;
        plan = planOcr({ kind, pages: extracted.pages, bytes, artifactKind: art.kind }, ocr);
      }
    } catch (e) {
      extracted = { status: 'failed', extractor: 'none@1', blocks: [], error: messageOf(e) };
    }

    const served = redactThenCap(store, art.workspaceId, extracted, settings.maxTextChars, secrets);
    const blocks = served.blocks;
    let status: ExtractionState = served.status;
    if (status === 'ok' && blocks.length === 0) status = 'empty';
    const hasText = blocks.length > 0 && (status === 'ok' || status === 'too_large');
    const text = hasText ? blocksText(blocks) : '';
    const hash = hasText ? contentHash(blocks) : undefined;
    const pieces = hasText ? chunk(blocks, { chunkTokens: settings.chunkTokens, maxChunkTokens: settings.maxChunkTokens }) : [];
    const error = sanitizeError(store, art.workspaceId, served.error);

    let ocrPending = false;
    store.transaction(() => {
      const cur = k.artifactTexts.get(artifactId);
      if (cur && cur.status !== 'pending') return; // ingested concurrently
      // An artifact others already point at stays canonical (keeps the one-level invariant).
      const isTarget = store.db.prepare('SELECT 1 FROM artifact_texts WHERE duplicate_of = ? LIMIT 1').get(artifactId) !== undefined;
      const duplicateOf = hash && !isTarget ? findCanonical(store, artifactId, art.workspaceId, hash) : undefined;
      k.artifactTexts.update(artifactId, {
        status,
        extractor: extracted.extractor,
        error,
        charCount: text.length,
        tokenEstimate: estimateTokens(text),
        contentSha256: hash,
        duplicateOf,
        extractedAt: new Date().toISOString(),
      });
      if (plan) {
        // A text duplicate has no chunks of its own: its canonical is the one that gets read.
        const p: OcrPlan = duplicateOf ? { action: 'none' } : plan;
        ocrPending = p.action === 'read';
        k.artifactTexts.update(artifactId, {
          ocrStatus: p.action === 'read' ? 'pending' : p.action === 'skip' ? 'skipped' : 'none',
          ocrPlan: p.action === 'read' ? p : undefined,
          ocrError: p.action === 'skip' ? p.reason : undefined,
        });
      }
      store.db.prepare('DELETE FROM chunks WHERE artifact_id = ?').run(artifactId);
      if (duplicateOf) return;
      for (const c of pieces) {
        k.chunks.insert({
          id: newId('chk'),
          artifactId,
          workspaceId: art.workspaceId,
          seq: c.seq,
          headingPath: c.headingPath,
          locator: c.locator,
          text: c.text,
          charStart: c.charStart,
          charEnd: c.charEnd,
          tokenEstimate: c.tokenEstimate,
          uploadDerived: art.uploadDerived === true,
        });
      }
    });
    if (ocrPending) ocrSinkFor(artifacts)?.enqueue(artifactId);
    return extractionSummary(store, artifactId) ?? failedSummary;
  } catch (e) {
    // Last resort (e.g. the database went away): record what we can, never throw to the caller.
    try {
      const k = knowledgeRepos(store);
      const art = store.artifacts.get(artifactId);
      if (art && k.artifactTexts.get(artifactId)?.status === 'pending') {
        k.artifactTexts.update(artifactId, {
          status: 'failed',
          error: sanitizeError(store, art.workspaceId, messageOf(e)),
          extractedAt: new Date().toISOString(),
        });
      }
    } catch {
      // nothing more to do
    }
    return failedSummary;
  }
}

/** In-process extraction queue (design §8.2). See the module doc. */
export class Ingestor {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly inflight = new Map<string, Promise<ExtractionSummary>>();
  private running = 0;
  private stopped = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly deps: IngestDeps,
    private readonly opts: IngestOptions = {},
  ) {}

  /** Read on every use: the runtime config object is updated in place (`PUT /api/config`). */
  private get settings(): KnowledgeSettings['extraction'] {
    return knowledgeSettings(this.deps.config ?? {}).extraction;
  }

  /**
   * Ingests `artifactId` now when its file is ≤ `inlineMaxBytes` (resolves with the result),
   * otherwise queues it (resolves at once with `status: 'pending', queued: true`). An artifact
   * already extracted resolves with its current summary. Never rejects.
   */
  submit(artifactId: string): Promise<ExtractionSummary> {
    const running = this.inflight.get(artifactId);
    if (running) return running;
    const current = extractionSummary(this.deps.store, artifactId);
    if (!current) return Promise.resolve({ status: 'failed', chunks: 0 });
    if (current.status !== 'pending') return Promise.resolve(current);
    if (this.sizeOf(artifactId) <= this.settings.inlineMaxBytes && !this.stopped) return this.run(artifactId);
    this.enqueue(artifactId);
    return Promise.resolve({ ...current, queued: true });
  }

  /**
   * Ingests `artifactId` now whatever its size, joining a run already in flight (KS-2 quote checks
   * via `FactToolEnv.ensureExtracted`: the quote is checked against stored chunks, not a queued
   * future). Also runs after `stop()`; `ingestArtifact` itself never re-ingests a non-`pending` row.
   */
  ensure(artifactId: string): Promise<ExtractionSummary> {
    return this.inflight.get(artifactId) ?? this.run(artifactId);
  }

  /** Adds `artifactId` to the queue (once). */
  enqueue(artifactId: string): void {
    if (this.stopped || this.queued.has(artifactId) || this.inflight.has(artifactId)) return;
    this.queue.push(artifactId);
    this.queued.add(artifactId);
    setImmediate(() => this.pump());
  }

  /** Queues every artifact whose text is still `pending` (startup). Returns how many. */
  requeuePending(): number {
    const rows = this.deps.store.db
      .prepare(`SELECT artifact_id AS id FROM artifact_texts WHERE status = 'pending' ORDER BY rowid`)
      .all() as Array<{ id: string }>;
    for (const r of rows) this.enqueue(r.id);
    return rows.length;
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Drops the queue and waits for running work (shutdown). Later submits only report state. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    this.queued.clear();
    await Promise.allSettled([...this.inflight.values()]);
    this.settle();
  }

  private sizeOf(artifactId: string): number {
    try {
      const art = this.deps.store.artifacts.get(artifactId);
      return art ? statSync(this.deps.artifacts.filePath(art)).size : 0;
    } catch {
      return 0; // missing file: ingest inline, which records the failure
    }
  }

  private run(artifactId: string): Promise<ExtractionSummary> {
    const p = ingestArtifact(this.deps, artifactId, this.opts)
      .catch((): ExtractionSummary => ({ status: 'failed', chunks: 0 }))
      .finally(() => {
        this.inflight.delete(artifactId);
        this.settle();
      });
    this.inflight.set(artifactId, p);
    return p;
  }

  private pump(): void {
    while (!this.stopped && this.running < Math.max(1, this.settings.concurrency) && this.queue.length) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      this.running++;
      void (this.inflight.get(id) ?? this.run(id)).finally(() => {
        this.running--;
        this.pump();
        this.settle();
      });
    }
    this.settle();
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.inflight.size === 0 && this.running === 0;
  }

  private settle(): void {
    if (!this.isIdle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}

const ingestors = new WeakMap<ArtifactStore, Ingestor>();

/**
 * The ingestor of an artifact store (one per runtime; created on first use with `deps.config`).
 * Tool handlers, uploads and the startup re-queue share it.
 */
export function ingestorFor(deps: IngestDeps): Ingestor {
  let ing = ingestors.get(deps.artifacts);
  if (!ing) {
    ing = new Ingestor(deps);
    ingestors.set(deps.artifacts, ing);
  }
  return ing;
}
