/**
 * OCR pass 2 in the extraction pipeline: reads, with a small model (`ocr/haiku.ts`), what the rules
 * of pass 1 (`ocr/rules.ts`, run by `ingest.ts`) left `pending`, and APPENDS the text to the
 * artifact.
 *
 * - Append only. Chunks written by pass 1 keep their ids, `seq` and offsets (findings cite them);
 *   model text comes after them, one block per page with locator `page N (ocr)` (`image (ocr)` for
 *   an image), so a reader always sees which text a model transcribed.
 * - Model text is evidence text: identity secrets redacted, fence sequences stripped, capped at
 *   `maxTextChars` with the rest of the artifact, upload-derived when the artifact is.
 * - It takes no part in text-duplicate detection (`content_sha256` stays the text layer's): two
 *   transcriptions of the same scan need not be identical.
 * - Every model call is logged in `ocr_runs` (pages, tokens, cost), failed ones too.
 * - A rate limit leaves the artifact `pending` and pauses the queue.
 *
 * `OcrQueue` registers itself for the artifact store; `ingest.ts` plans OCR only while one is
 * registered. `requeuePending()` and `planExisting()` are the startup steps.
 */
import { readFileSync } from 'node:fs';
import { computeCost, defaultPricing, priceFor, type PriceTable } from '../../harness/pricing.js';
import { knowledgeRepos, newId } from '../../store/repos.js';
import type { Store } from '../../store/db.js';
import type { OcrRun, OcrState } from '../../types.js';
import { knowledgeSettings } from '../config.js';
import { BLOCK_SEPARATOR, blocksText, capBlocks, chunk, estimateTokens, extract, type ExtractKind } from '../extract/index.js';
import type { Block } from '../extract/types.js';
import { sanitizeBlocks, sanitizeError, type IngestDeps } from '../ingest.js';
import type { OcrPageText, OcrReadResult, OcrReader, OcrRequest } from './haiku.js';
import { registerOcr, unregisterOcr, type OcrSink } from './registry.js';
import { imageMediaType, planOcr, type OcrPlan } from './rules.js';

export { ocrTotals, type OcrTotals } from './totals.js';

/** Appended to `artifact_texts.extractor` once model text was added. Bump `n` when the prompt or rules change. */
export const OCR_EXTRACTOR = 'ocr@1';

export type OcrOutcome = 'done' | 'failed' | 'rate_limited' | 'noop';

type ReadPlan = Extract<OcrPlan, { action: 'read' }>;

function readPlan(raw: unknown): ReadPlan | undefined {
  const p = raw as Partial<ReadPlan> | null | undefined;
  if (!p || p.action !== 'read') return undefined;
  if (p.target === 'image') return p as ReadPlan;
  if (p.target === 'pdf' && Array.isArray(p.pages) && p.pages.every((n) => Number.isInteger(n) && n > 0)) return p as ReadPlan;
  return undefined;
}

const pagesOf = (req: OcrRequest): number[] => (req.target === 'image' ? [1] : req.pages);

const label = (req: OcrRequest): string => {
  if (req.target === 'image') return 'the image';
  return req.pages.length === 1 ? `page ${req.pages[0]}` : `pages ${req.pages[0]}–${req.pages.at(-1)}`;
};

function logRun(store: Store, art: { id: string; workspaceId: string }, reader: OcrReader, req: OcrRequest, res: OcrReadResult, durationMs: number, pricing: PriceTable): void {
  const u = res.usage;
  const cacheRead = u?.cacheReadTokens ?? 0;
  const cacheWrite = u?.cacheWriteTokens ?? 0;
  const input = Math.max(0, (u?.inputTokens ?? 0) - cacheRead - cacheWrite);
  const output = u?.outputTokens ?? 0;
  const model = res.model ?? reader.model;
  const row: OcrRun = {
    id: newId('ocr'),
    artifactId: art.id,
    workspaceId: art.workspaceId,
    target: req.target,
    pages: pagesOf(req),
    pagesRead: res.ok ? res.pages.length : 0,
    provider: 'claude',
    model,
    status: res.ok ? 'ok' : res.rateLimited ? 'rate_limited' : 'failed',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    durationMs,
    createdAt: new Date().toISOString(),
  };
  if (!res.ok) row.error = sanitizeError(store, art.workspaceId, res.error) ?? 'error';
  const price = u ? priceFor(pricing, 'claude', model) : undefined;
  if (price) {
    row.costUsd = computeCost(price, { input, output, cacheRead, cacheWrite });
    row.priceVersion = pricing.version;
  }
  if (typeof u?.costUsd === 'number' && Number.isFinite(u.costUsd)) row.cliReportedCostUsd = u.costUsd;
  knowledgeRepos(store).ocrRuns.insert(row);
}

/**
 * Runs pass 2 for one artifact whose `ocr_status` is `pending` (otherwise `noop`). Never throws.
 * `rate_limited`: nothing was written and the artifact is still `pending`.
 */
export async function runOcr(deps: IngestDeps, artifactId: string, reader: OcrReader, pricing: PriceTable = defaultPricing()): Promise<OcrOutcome> {
  const { store, artifacts } = deps;
  const k = knowledgeRepos(store);
  const fail = (workspaceId: string, message: string): OcrOutcome => {
    try {
      if (k.artifactTexts.get(artifactId)?.ocrStatus === 'pending') {
        k.artifactTexts.update(artifactId, { ocrStatus: 'failed', ocrError: sanitizeError(store, workspaceId, message), ocrAt: new Date().toISOString() });
      }
    } catch {
      // nothing more to do
    }
    return 'failed';
  };
  let workspaceId = '';
  try {
    const art = store.artifacts.get(artifactId);
    const row = k.artifactTexts.get(artifactId);
    if (!art || row?.ocrStatus !== 'pending') return 'noop';
    workspaceId = art.workspaceId;
    const settings = knowledgeSettings(deps.config ?? {});
    const plan = readPlan(row.ocrPlan);
    if (!plan) return fail(workspaceId, 'the OCR plan is missing');

    const file = readFileSync(artifacts.filePath(art));
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const requests: OcrRequest[] = [];
    if (plan.target === 'image') {
      const mediaType = imageMediaType(bytes);
      if (!mediaType) return fail(workspaceId, 'image format cannot be read');
      requests.push({ target: 'image', bytes, mediaType });
    } else {
      const per = Math.max(1, settings.ocr.pagesPerCall);
      for (let i = 0; i < plan.pages.length; i += per) requests.push({ target: 'pdf', bytes, pages: plan.pages.slice(i, i + per) });
    }

    const read: OcrPageText[] = [];
    const problems: string[] = [];
    let failures = 0;
    for (const req of requests) {
      const t0 = Date.now();
      const res = await reader.read(req);
      logRun(store, art, reader, req, res, Date.now() - t0, pricing);
      if (res.ok) read.push(...res.pages);
      else if (res.rateLimited) return 'rate_limited';
      else {
        failures++;
        problems.push(`${label(req)} could not be read: ${res.error}`);
      }
    }

    const blocks: Block[] = read
      .sort((a, b) => a.page - b.page)
      .map((p) => ({ headingPath: '', locator: plan.target === 'image' ? 'image (ocr)' : `page ${p.page} (ocr)`, text: p.text }));
    const sanitized = sanitizeBlocks(store, workspaceId, blocks);
    if (plan.target === 'pdf' && plan.leftOut > 0) {
      problems.push(`${plan.leftOut} more pages need reading (over maxPages ${settings.ocr.maxPages})`);
    }

    let outcome: OcrOutcome = 'noop';
    store.transaction(() => {
      const cur = k.artifactTexts.get(artifactId);
      if (cur?.ocrStatus !== 'pending') return;
      const base = cur.charCount > 0 ? cur.charCount + BLOCK_SEPARATOR.length : 0;
      const room = settings.extraction.maxTextChars - base;
      let kept: Block[] = [];
      if (sanitized.length) {
        const capped = capBlocks(sanitized, Math.max(0, room));
        kept = capped.blocks;
        if (capped.cut) problems.push(`the artifact's text exceeds maxTextChars (${settings.extraction.maxTextChars}); the transcription was cut`);
      }
      const patch: Parameters<typeof k.artifactTexts.update>[1] = {};
      if (kept.length) {
        const text = blocksText(kept);
        const top = store.db.prepare('SELECT MAX(seq) AS n FROM chunks WHERE artifact_id = ?').get(artifactId) as { n: number | null };
        const seqBase = top.n === null ? 0 : Number(top.n) + 1;
        const uploadDerived = store.artifacts.get(artifactId)?.uploadDerived === true;
        for (const c of chunk(kept, { chunkTokens: settings.extraction.chunkTokens, maxChunkTokens: settings.extraction.maxChunkTokens })) {
          k.chunks.insert({
            id: newId('chk'),
            artifactId,
            workspaceId,
            seq: seqBase + c.seq,
            headingPath: c.headingPath,
            locator: c.locator,
            text: c.text,
            charStart: base + c.charStart,
            charEnd: base + c.charEnd,
            tokenEstimate: c.tokenEstimate,
            uploadDerived,
          });
        }
        patch.charCount = base + text.length;
        patch.tokenEstimate = cur.tokenEstimate + estimateTokens(text);
        patch.extractor = `${cur.extractor ?? 'none@1'}+${OCR_EXTRACTOR}`;
        if (cur.status === 'empty' || cur.status === 'unsupported') patch.status = 'ok';
      }
      const status: OcrState = failures > 0 && read.length === 0 ? 'failed' : 'done';
      outcome = status;
      k.artifactTexts.update(artifactId, {
        ...patch,
        ocrStatus: status,
        ocrError: problems.length ? sanitizeError(store, workspaceId, problems.join('; ')) : undefined,
        ocrAt: new Date().toISOString(),
      });
    });
    return outcome;
  } catch (e) {
    return fail(workspaceId, (e instanceof Error ? e.message : String(e)) || 'OCR failed');
  }
}

/**
 * Pass 1 for an artifact that was ingested while OCR was unavailable (`ocr_status` NULL): re-reads
 * the file and writes its plan. Returns true when it is now `pending`. Never throws.
 */
async function planArtifact(deps: IngestDeps, artifactId: string): Promise<boolean> {
  const { store, artifacts } = deps;
  const k = knowledgeRepos(store);
  try {
    const art = store.artifacts.get(artifactId);
    const row = k.artifactTexts.get(artifactId);
    if (!art || !row || row.ocrStatus !== undefined || row.status === 'pending') return false;
    const settings = knowledgeSettings(deps.config ?? {});
    let plan: OcrPlan = { action: 'none' };
    if (!row.duplicateOf) {
      const file = readFileSync(artifacts.filePath(art));
      const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
      const kind = (row.extractor ?? '').split('@')[0] as ExtractKind;
      const pages =
        kind === 'pdf'
          ? (await extract(bytes, 'application/pdf', { maxTextChars: settings.extraction.maxTextChars, xlsxMaxRows: settings.extraction.xlsxMaxRows })).pages
          : undefined;
      plan = planOcr({ kind, pages, bytes, artifactKind: art.kind }, settings.ocr);
    }
    let pending = false;
    store.transaction(() => {
      if (k.artifactTexts.get(artifactId)?.ocrStatus !== undefined) return;
      pending = plan.action === 'read';
      k.artifactTexts.update(artifactId, {
        ocrStatus: plan.action === 'read' ? 'pending' : plan.action === 'skip' ? 'skipped' : 'none',
        ocrPlan: plan.action === 'read' ? plan : undefined,
        ocrError: plan.action === 'skip' ? plan.reason : undefined,
      });
    });
    return pending;
  } catch {
    return false; // e.g. the file is gone: stays unplanned
  }
}

/** In-process queue of OCR pass 2. See the module doc. */
export class OcrQueue implements OcrSink {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly inflight = new Map<string, Promise<OcrOutcome>>();
  private running = 0;
  private stopped = false;
  private pauseTimer: NodeJS.Timeout | undefined;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly deps: IngestDeps,
    private readonly reader: OcrReader,
    private readonly pricing: PriceTable = defaultPricing(),
  ) {
    registerOcr(deps.artifacts, this);
  }

  /** Read on every use: the runtime config object is updated in place (`PUT /api/config`). */
  private get settings() {
    return knowledgeSettings(this.deps.config ?? {}).ocr;
  }

  /** True while the queue waits after a rate limit. */
  get paused(): boolean {
    return this.pauseTimer !== undefined;
  }

  enqueue(artifactId: string): void {
    if (this.stopped || this.queued.has(artifactId)) return;
    this.queue.push(artifactId);
    this.queued.add(artifactId);
    setImmediate(() => this.pump());
  }

  async ensure(artifactId: string): Promise<void> {
    const running = this.inflight.get(artifactId);
    if (running) {
      await running;
      return;
    }
    if (this.stopped || this.paused || !this.settings.enabled) return;
    if (knowledgeRepos(this.deps.store).artifactTexts.get(artifactId)?.ocrStatus !== 'pending') return;
    const at = this.queue.indexOf(artifactId);
    if (at >= 0) this.queue.splice(at, 1);
    this.queued.delete(artifactId);
    await this.start(artifactId);
  }

  /** Queues every artifact whose OCR is `pending` (startup, and after a rate-limit pause). Returns how many. */
  requeuePending(): number {
    const rows = this.deps.store.db
      .prepare(`SELECT artifact_id AS id FROM artifact_texts WHERE ocr_status = 'pending' ORDER BY rowid`)
      .all() as Array<{ id: string }>;
    for (const r of rows) this.enqueue(r.id);
    return rows.length;
  }

  /**
   * Runs pass 1 for PDFs and images ingested while OCR was unavailable (`ocr_status` NULL) and
   * queues the ones a model has to read. Returns how many were queued.
   */
  async planExisting(): Promise<number> {
    if (!this.settings.enabled) return 0;
    const rows = this.deps.store.db
      .prepare(
        `SELECT artifact_id AS id FROM artifact_texts
         WHERE ocr_status IS NULL AND status <> 'pending' AND (extractor LIKE 'pdf@%' OR extractor LIKE 'image@%')
         ORDER BY rowid`,
      )
      .all() as Array<{ id: string }>;
    let queued = 0;
    for (const r of rows) {
      if (this.stopped) break;
      if (await planArtifact(this.deps, r.id)) {
        queued++;
        this.enqueue(r.id);
      }
    }
    return queued;
  }

  /** Resolves when nothing is running and nothing can start (queue empty, paused or stopped). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Drops the queue, waits for running calls and unregisters (shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    this.queued.clear();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    unregisterOcr(this.deps.artifacts, this);
    if (this.running > 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Runs pass 2 for one artifact now; a second call while it runs joins it. */
  private start(artifactId: string): Promise<OcrOutcome> {
    const existing = this.inflight.get(artifactId);
    if (existing) return existing;
    this.running++;
    const p = runOcr(this.deps, artifactId, this.reader, this.pricing)
      .catch((): OcrOutcome => 'failed')
      .then((outcome) => {
        if (outcome === 'rate_limited') this.pause();
        this.inflight.delete(artifactId);
        this.running--;
        this.pump();
        return outcome;
      });
    this.inflight.set(artifactId, p);
    return p;
  }

  private pause(): void {
    if (this.pauseTimer || this.stopped) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.requeuePending();
      this.pump();
    }, this.settings.rateLimitPauseMinutes * 60_000);
    this.pauseTimer.unref();
  }

  private pump(): void {
    while (!this.stopped && !this.paused && this.settings.enabled && this.running < Math.max(1, this.settings.concurrency) && this.queue.length) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      void this.start(id);
    }
    this.settle();
  }

  private isIdle(): boolean {
    if (this.running > 0) return false;
    return this.queue.length === 0 || this.paused || this.stopped || !this.settings.enabled;
  }

  private settle(): void {
    if (!this.isIdle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}
