import { afterEach, describe, expect, it } from 'vitest';
import { ingestArtifact } from '../../../src/core/knowledge/ingest.js';
import type { OcrReadResult, OcrReader } from '../../../src/core/knowledge/ocr/haiku.js';
import { OcrQueue } from '../../../src/core/knowledge/ocr/worker.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { makePdf } from '../../fixtures/knowledge/build.js';
import { ks4, T0 } from './ks4fixture.js';

// What an agent sees of two-pass OCR through the read tools.

const opened: Store[] = [];
const queues: OcrQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) await q.stop();
  for (const s of opened.splice(0)) s.close();
});

type Expanded = { notes: string[]; items: Array<Record<string, unknown>> };
const extractionOf = (ex: Expanded) => ex.items.find((i) => i.type === 'meta')!.extraction as Record<string, unknown>;

describe('two-pass OCR through the read tools', () => {
  it('an agent is told while a model is still reading, then finds and reads the transcribed text', async () => {
    const t = ks4(opened);
    let release!: (r: OcrReadResult) => void;
    const reader: OcrReader = { model: 'haiku', read: () => new Promise((resolve) => (release = resolve)) };
    const q = new OcrQueue({ store: t.store, artifacts: t.artifacts, config: t.config }, reader);
    queues.push(q);
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'document', mime: 'application/pdf', title: 'Signed order form.pdf', bytes: makePdf([null]) });
    await ingestArtifact({ store: t.store, artifacts: t.artifacts, config: t.config }, a.id);
    const c = t.ctx('ws_a');

    const before = await t.call<Expanded>(c, 'expand', { id: a.id });
    expect(extractionOf(before)).toMatchObject({ status: 'empty', ocr: 'pending' });
    expect(before.notes.join(' ')).toMatch(/model is still transcribing/);

    await new Promise((r) => setImmediate(r));
    release({ ok: true, pages: [{ page: 1, text: 'Order form: 120 seats of the Enterprise plan at 61 dollars per seat.' }] });
    await q.idle();

    const after = await t.call<Expanded>(c, 'expand', { id: a.id });
    expect(extractionOf(after)).toMatchObject({ status: 'ok', ocr: 'done', chunks: 1 });
    expect(after.notes.join(' ')).toMatch(/\(ocr\).*transcribed by a model/);
    const found = await t.call<{ hits: Array<Record<string, unknown>> }>(c, 'search', { query: 'Enterprise seats' });
    expect(found.hits[0]).toMatchObject({ kind: 'passage', artifact_id: a.id });
    const text = await t.call<{ items: Array<Record<string, unknown>> }>(c, 'read_artifact', { artifact_id: a.id, mode: 'text' });
    const passage = text.items.find((i) => i.type === 'chunk')!;
    expect(passage).toMatchObject({ locator: 'page 1 (ocr)' });
    expect(String(passage.text)).toMatch(/61 dollars per seat/);
  });

  it('a quote from a scanned page is checked against the transcription, waiting for the model when it is still reading', async () => {
    const t = ks4(opened);
    let reads = 0;
    const reader: OcrReader = {
      model: 'haiku',
      async read() {
        reads++;
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, pages: [{ page: 2, text: 'Order form: 120 seats of the Enterprise plan at 61 dollars per seat.' }] };
      },
    };
    const q = new OcrQueue({ store: t.store, artifacts: t.artifacts, config: t.config }, reader);
    queues.push(q);
    const task = t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'document', mime: 'application/pdf', bytes: makePdf([['Cover page of the signed order form for the Enterprise plan.'], null]) });
    knowledgeRepos(t.store).artifactCaptures.insert({ id: newId('cap'), artifactId: a.id, workspaceId: 'ws_a', taskId: task.id, capturedAt: T0 });
    await ingestArtifact({ store: t.store, artifacts: t.artifacts, config: t.config }, a.id);
    expect(knowledgeRepos(t.store).artifactTexts.get(a.id)!.ocrStatus).toBe('pending');

    const c = t.ctx('ws_a', 'worker', { taskId: task.id });
    const saved = await t.handle(c, 'save_finding', {
      claim: 'Acme sold 120 Enterprise seats at $61', subject: 'Acme', evidence: [a.id], relation: 'new',
      evidence_refs: [{ artifact_id: a.id, quote: '120 seats of the Enterprise plan at 61 dollars per seat' }],
    });
    expect(saved).toMatchObject({ ok: true, data: { findingId: expect.any(String) } });
    expect(reads).toBe(1);
    const id = (saved as { data: { findingId: string } }).data.findingId;
    const ref = knowledgeRepos(t.store).findingEvidence.list({ findingId: id })[0]!;
    expect(knowledgeRepos(t.store).chunks.get(ref.chunkId!)).toMatchObject({ locator: 'page 2 (ocr)' });
    // The queue had it too: it is not read a second time.
    await q.idle();
    expect(reads).toBe(1);
  });

  it('says so when the scanned parts could not be read', async () => {
    const t = ks4(opened);
    const reader: OcrReader = { model: 'haiku', read: async () => ({ ok: false, error: 'boom' }) };
    const q = new OcrQueue({ store: t.store, artifacts: t.artifacts, config: t.config }, reader);
    queues.push(q);
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'document', mime: 'application/pdf', bytes: makePdf([null]) });
    await ingestArtifact({ store: t.store, artifacts: t.artifacts, config: t.config }, a.id);
    await q.idle();
    const ex = await t.call<Expanded>(t.ctx('ws_a'), 'expand', { id: a.id });
    expect(extractionOf(ex)).toMatchObject({ ocr: 'failed' });
    expect(ex.notes.join(' ')).toMatch(/scanned parts.*not in its text/);
  });
});
