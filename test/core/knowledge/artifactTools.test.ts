import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { createToolHandlers } from '../../../src/core/harness/tools/handlers.js';
import { ROLE_TOOLS } from '../../../src/core/harness/tools/registry.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';

// KS-1: save_artifact (captions, entity, applies_to, capture + extraction) and describe_artifact.

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';
const PNG64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const CAPTION = 'Pricing page: Pro plan 49 USD per seat, Start trial button';

function setup(config: BifConfig = defaultConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ktools-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  for (const [id, parent] of [['R', undefined], ['D', 'R'], ['S', 'R'], ['Q', undefined]] as const) {
    store.workspaces.insert({ id, name: id, sector: 's', createdAt: T0, ...(parent ? { parentWorkspaceId: parent } : {}) });
  }
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({ store, artifacts, config, events: new EventBus() });
  const k = knowledgeRepos(store);
  return { dir, store, artifacts, handle, k, config };
}

function ctx(role: RunContext['role'], workspaceId = 'D', extra: Partial<RunContext> = {}): RunContext {
  return { agentRunId: newId('arun'), workspaceId, role, model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv_1', ...extra };
}

const data = <T>(r: { ok: boolean }) => {
  if (!r.ok) throw new Error(`tool failed: ${(r as unknown as { error: string }).error}`);
  return (r as unknown as { data: T }).data;
};

describe('save_artifact (KS-1)', () => {
  it('returns artifactId, sha256, captureId and the extraction; the capture carries run, task and research run', async () => {
    const t = setup();
    const task = t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'D', runId: 'rrun_1', phase: 'deep_dives', type: 'flow_walkthrough', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['x'], status: 'running', round: 1, createdAt: T0,
    });
    const c = ctx('worker', 'D', { taskId: task.id });
    const d = data<{ artifactId: string; sha256: string; captureId: string; extraction: { status: string; chunks: number } }>(
      await t.handle(c, 'save_artifact', {
        kind: 'page_snapshot', mime: 'text/html', source_url: 'https://acme.test/pricing?utm_medium=x',
        content: '<html><body><main><h1>Pricing</h1><p>Pro is 49 dollars per seat.</p></main></body></html>',
        flow: 'pricing', step: 2,
      }),
    );
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.extraction).toEqual({ status: 'ok', chunks: 1 });
    expect(t.k.artifactCaptures.get(d.captureId)).toMatchObject({
      artifactId: d.artifactId, workspaceId: 'D', agentRunId: c.agentRunId, taskId: task.id, runId: 'rrun_1',
      flow: 'pricing', step: 2, urlKey: 'https://acme.test/pricing',
    });
    // Same bytes again from another run: same artifact, a second capture, extraction state reported.
    const again = data<{ artifactId: string; captureId: string; extraction: { status: string } }>(
      await t.handle(ctx('worker'), 'save_artifact', {
        kind: 'page_snapshot', mime: 'text/html', flow: 'pricing', step: 5,
        content: '<html><body><main><h1>Pricing</h1><p>Pro is 49 dollars per seat.</p></main></body></html>',
      }),
    );
    expect(again.artifactId).toBe(d.artifactId);
    expect(again.captureId).not.toBe(d.captureId);
    expect(again.extraction.status).toBe('ok');
    expect(t.k.artifactCaptures.list({ artifactId: d.artifactId }).map((x) => x.step)).toEqual([2, 5]);
  });

  it('caption rule: image artifacts from agents need a description of at least minChars', async () => {
    const t = setup();
    const c = ctx('worker');
    const none = await t.handle(c, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: PNG64 });
    expect(none).toMatchObject({ ok: false, error: expect.stringMatching(/description is required/) });
    const short = await t.handle(c, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: PNG64, description: 'a page' });
    expect(short).toMatchObject({ ok: false, error: expect.stringMatching(/at least 20/) });
    // An image mime under another kind counts too.
    const doc = await t.handle(c, 'save_artifact', { kind: 'document', mime: 'image/jpeg', content_base64: PNG64 });
    expect(doc.ok).toBe(false);
    expect(t.store.artifacts.list()).toHaveLength(0);
    const ok = data<{ artifactId: string; extraction: { status: string } }>(
      await t.handle(c, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: PNG64, description: CAPTION }),
    );
    expect(ok.extraction.status).toBe('unsupported');
    expect(t.store.artifacts.get(ok.artifactId)!.description).toBe(CAPTION);
    // Text artifacts need none.
    expect((await t.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'plain' })).ok).toBe(true);
    // Config can turn the rule off.
    const off = setup({ ...defaultConfig, knowledge: { captions: { required: false } } });
    expect((await off.handle(c, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: PNG64 })).ok).toBe(true);
  });

  it('uploads are exempt from the caption rule', async () => {
    const t = setup();
    const up = uploadInternal('D', { name: 'whiteboard.png', bytes: Buffer.from(PNG64, 'base64'), mime: 'image/png' }, t);
    await ingestorFor(t).idle();
    expect(t.store.artifacts.get(up.id)!.description).toBeUndefined();
    expect(t.k.artifactTexts.get(up.id)!.status).toBe('unsupported');
  });

  it('entity: {kind, name} resolves or creates the entity in the tree; an id must be in the tree', async () => {
    const t = setup();
    const c = ctx('worker');
    const a = data<{ captureId: string }>(
      await t.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'acme pricing', entity: { kind: 'competitor', name: 'Acme  Corp' } }),
    );
    const entityId = t.k.artifactCaptures.get(a.captureId)!.entityId!;
    expect(t.k.entities.get(entityId)).toMatchObject({ rootWorkspaceId: 'R', kind: 'competitor', name: 'Acme Corp' });
    const b = data<{ captureId: string }>(
      await t.handle(ctx('worker', 'S'), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'more', entity: { kind: 'competitor', name: 'acme corp' } }),
    );
    expect(t.k.artifactCaptures.get(b.captureId)!.entityId).toBe(entityId);
    const byId = data<{ captureId: string }>(await t.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'by id', entity: entityId }));
    expect(t.k.artifactCaptures.get(byId.captureId)!.entityId).toBe(entityId);
    // Another tree's entity and an unknown id get the same "not found".
    const foreign = await t.handle(ctx('worker', 'Q'), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'x', entity: entityId });
    expect(foreign).toEqual({ ok: false, error: `entity '${entityId}' not found` });
    const unknown = await t.handle(ctx('worker', 'Q'), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'x', entity: 'ent_nope' });
    expect(unknown).toEqual({ ok: false, error: `entity 'ent_nope' not found` });
    expect(t.store.artifacts.list({ workspaceId: 'Q' })).toHaveLength(0);
  });

  it('applies_to replaces the home scope with nodes of the same tree (validated), and is logged', async () => {
    const t = setup();
    const c = ctx('worker', 'D');
    const a = data<{ artifactId: string }>(await t.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'about S', applies_to: ['S'] }));
    expect(t.k.itemScopes.list({ itemKind: 'artifact', itemId: a.artifactId }).map((s) => [s.workspaceId, s.source])).toEqual([['S', 'agent']]);
    const decision = t.store.decisions.list({ agentRunId: c.agentRunId }).find((d) => (d.payload as { tool?: string }).tool === 'save_artifact');
    expect(decision).toMatchObject({ refs: [a.artifactId], payload: { appliesTo: ['S'] } });
    // Out of tree and unknown: same error, nothing saved.
    for (const ws of ['Q', 'ws_nope']) {
      const r = await t.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: `bad ${ws}`, applies_to: [ws] });
      expect(r).toEqual({ ok: false, error: `workspace '${ws}' not found` });
    }
    expect(t.store.artifacts.list()).toHaveLength(1);
    // Saving the same bytes again with applies_to only adds labels (never narrows what others saw).
    await t.handle(ctx('worker', 'D'), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'about S', applies_to: ['R'] });
    expect(t.k.itemScopes.list({ itemKind: 'artifact', itemId: a.artifactId }).map((s) => s.workspaceId).sort()).toEqual(['R', 'S']);
  });

  it('large files are queued: extraction reports pending, then completes', async () => {
    const t = setup({ ...defaultConfig, knowledge: { extraction: { inlineMaxBytes: 4 } } });
    const d = data<{ artifactId: string; extraction: { status: string; queued?: boolean } }>(
      await t.handle(ctx('worker'), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'longer than four bytes' }),
    );
    expect(d.extraction).toMatchObject({ status: 'pending', queued: true });
    await ingestorFor(t).idle();
    expect(t.k.artifactTexts.get(d.artifactId)!.status).toBe('ok');
  });
});

describe('describe_artifact (KS-1)', () => {
  it('is available to worker, orchestrator, interviewer and synthesizer only', () => {
    for (const role of ['worker', 'orchestrator', 'interviewer', 'synthesizer'] as const) expect(ROLE_TOOLS[role]).toContain('describe_artifact');
    for (const role of ['reviewer', 'persona', 'escalation'] as const) expect(ROLE_TOOLS[role]).not.toContain('describe_artifact');
  });

  it('adds a description when there is none; replaces only when the caller run saved the artifact', async () => {
    const t = setup({ ...defaultConfig, knowledge: { captions: { required: false } } });
    const saver = ctx('worker', 'D');
    const own = data<{ artifactId: string }>(
      await t.handle(saver, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: PNG64, description: CAPTION }),
    );
    // The saving run may replace its own caption.
    const replaced = await t.handle(saver, 'describe_artifact', { artifact_id: own.artifactId, description: 'Pricing page: Pro 49 USD, Team 99 USD' });
    expect(replaced.ok).toBe(true);
    expect(t.store.artifacts.get(own.artifactId)!.description).toBe('Pricing page: Pro 49 USD, Team 99 USD');
    // Another run may not replace an existing description.
    const other = await t.handle(ctx('orchestrator', 'R'), 'describe_artifact', { artifact_id: own.artifactId, description: 'Something else entirely here' });
    expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/already has a description/) });
    // An artifact without one can be described by any allowed role in the tree.
    const bare = data<{ artifactId: string }>(await t.handle(saver, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: Buffer.from([9, 9]).toString('base64') }));
    const ok = await t.handle(ctx('interviewer', 'R'), 'describe_artifact', { artifact_id: bare.artifactId, description: 'Dashboard showing churn by month' });
    expect(ok.ok).toBe(true);
    // Too short; another tree (same error as unknown).
    expect((await t.handle(saver, 'describe_artifact', { artifact_id: bare.artifactId, description: 'short' })).ok).toBe(false);
    const foreign = await t.handle(ctx('worker', 'Q'), 'describe_artifact', { artifact_id: bare.artifactId, description: 'Dashboard showing churn by month' });
    expect(foreign).toEqual({ ok: false, error: `artifact '${bare.artifactId}' not found` });
    const unknown = await t.handle(ctx('worker', 'Q'), 'describe_artifact', { artifact_id: 'art_nope', description: 'Dashboard showing churn by month' });
    expect(unknown).toEqual({ ok: false, error: `artifact 'art_nope' not found` });
    expect((await t.handle(ctx('reviewer', 'D'), 'describe_artifact', { artifact_id: bare.artifactId, description: 'x'.repeat(30) })).ok).toBe(false);
  });

  it('a description of an upload-derived artifact is upload-derived and searchable', async () => {
    const t = setup();
    const up = uploadInternal('D', { name: 'board.png', bytes: Buffer.from(PNG64, 'base64'), mime: 'image/png' }, t);
    await ingestorFor(t).idle();
    const r = await t.handle(ctx('worker', 'D'), 'describe_artifact', { artifact_id: up.id, description: 'Internal board slide with quarterly churn target' });
    expect(r).toMatchObject({ ok: true, data: { artifactId: up.id, uploadDerived: true } });
    const row = t.store.artifacts.get(up.id)!;
    expect(row).toMatchObject({ uploadDerived: true, description: 'Internal board slide with quarterly churn target' });
    const hits = t.store.db
      .prepare(`SELECT a.id, a.upload_derived AS u FROM artifacts_fts f JOIN artifacts a ON a.rowid = f.rowid WHERE artifacts_fts MATCH '"churn" AND "quarterly"'`)
      .all() as Array<{ id: string; u: number }>;
    expect(hits).toEqual([{ id: up.id, u: 1 }]);
  });
});
