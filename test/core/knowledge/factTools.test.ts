import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config/schema.js';
import { EventBus } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../../src/core/harness/tools/handlers.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { NO_TEXT_ERROR, QUOTE_MAX_CHARS, verifyEvidenceRefs } from '../../../src/core/knowledge/factTools.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Artifact, Finding, Task } from '../../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ks2-tools-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({ store, artifacts, config: defaultConfig, events: new EventBus() });
  store.workspaces.insert({ id: 'R', name: 'R', sector: 's', createdAt: T0 });
  store.workspaces.insert({ id: 'D', name: 'D', sector: 's', createdAt: T0, parentWorkspaceId: 'R' });
  store.workspaces.insert({ id: 'Q', name: 'Q', sector: 's', createdAt: T0 });
  return { store, artifacts, handle };
}
type Env = ReturnType<typeof setup>;

function task(store: Store, ws = 'R'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: ws, runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
  });
}

const ctxFor = (t: Task): RunContext => ({
  agentRunId: newId('arun'), workspaceId: t.workspaceId, taskId: t.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
});

/** An artifact saved by the task (the capture row KS-1 writes on every save). */
function captured(env: Env, t: Task, content = `page ${Math.random()}`, mime = 'text/plain'): Artifact {
  const a = env.artifacts.save({ workspaceId: t.workspaceId, kind: 'text', mime, bytes: content });
  knowledgeRepos(env.store).artifactCaptures.insert({ id: newId('cap'), artifactId: a.id, workspaceId: t.workspaceId, taskId: t.id, capturedAt: T0 });
  return a;
}

/** A verified current fact saved by an earlier task. */
function priorFact(env: Env, claim: string, extra: Partial<Finding> = {}): Finding {
  const t = task(env.store, extra.workspaceId ?? 'R');
  const a = env.artifacts.save({ workspaceId: t.workspaceId, kind: 'text', mime: 'text/plain', bytes: `old ${claim}` });
  const f = env.store.findings.insert({
    id: newId('fnd'), workspaceId: t.workspaceId, runId: t.runId, taskId: t.id, subject: 'Acme', claim, criteria: {},
    evidence: [a.id], status: 'verified', createdAt: T0, lastConfirmedAt: T0, ...extra,
  });
  return env.store.findings.get(f.id)!;
}

const retrievals = (store: Store, agentRunId: string) => knowledgeRepos(store).retrievalEvents.list({ agentRunId });

describe('save_finding: duplicate handshake (design §7.2)', () => {
  it('returns likely duplicates without saving, logs the read and the decision', async () => {
    const env = setup();
    const f = priorFact(env, 'Acme Pro plan costs $10 per month');
    const t = task(env.store);
    const ctx = ctxFor(t);
    const a = captured(env, t);
    const r = await env.handle(ctx, 'save_finding', { claim: 'Acme Pro plan costs $12 per month', subject: 'Acme', evidence: [a.id] });
    expect(r.ok).toBe(true);
    const data = (r as { data: { saved: boolean; candidates: Array<{ id: string; claim: string }> } }).data;
    expect(data.saved).toBe(false);
    expect(data.candidates.map((c) => c.id)).toEqual([f.id]);
    expect(env.store.findings.list({ taskId: t.id })).toHaveLength(0);
    const [ev] = retrievals(env.store, ctx.agentRunId);
    expect(ev).toMatchObject({ tool: 'save_finding', resultIds: [{ id: f.id, kind: 'fact' }], resultCount: 1, uploadDerived: false, taskId: t.id });
    expect(ev!.tokensReturned).toBeGreaterThan(0);
    const d = env.store.decisions.list({ agentRunId: ctx.agentRunId });
    expect(d).toEqual([expect.objectContaining({ kind: 'decision', refs: [t.id, f.id] })]);
    expect(d[0]!.payload).toMatchObject({ event: 'duplicate_handshake', retrievalEventId: ev!.id });
  });

  it('relation "new" always saves a current fact with a create observation', async () => {
    const env = setup();
    priorFact(env, 'Acme Pro plan costs $10 per month');
    const t = task(env.store);
    const a = captured(env, t);
    const r = await env.handle(ctxFor(t), 'save_finding', { claim: 'Acme Pro plan costs $12 per month', subject: 'Acme', evidence: [a.id], relation: 'new' });
    const id = (r as { data: { findingId: string } }).data.findingId;
    expect(env.store.findings.get(id)).toMatchObject({ lifecycle: 'current', version: 1, lineageId: id });
    expect(knowledgeRepos(env.store).factObservations.list({ findingId: id })).toEqual([expect.objectContaining({ kind: 'create', status: 'pending', taskId: t.id })]);
  });

  it('auto-confirms an exact same-entity match when the evidence was captured by this task', async () => {
    const env = setup();
    const f = priorFact(env, 'Acme Pro plan costs $10 per month');
    const t = task(env.store);
    const ctx = ctxFor(t);
    const a = captured(env, t);
    const r = await env.handle(ctx, 'save_finding', { claim: 'acme pro plan costs $10 per month.', subject: 'ACME', evidence: [a.id] });
    expect(r).toMatchObject({ ok: true, data: { findingId: f.id, relation: 'confirms', autoConfirmed: true } });
    expect(env.store.findings.list({ taskId: t.id })).toHaveLength(0);
    expect(knowledgeRepos(env.store).factObservations.list({ findingId: f.id })).toEqual([expect.objectContaining({ kind: 'confirm', evidence: [a.id] })]);
    expect(retrievals(env.store, ctx.agentRunId).map((e) => e.resultIds)).toEqual([[{ id: f.id, kind: 'fact' }]]);
    const confirm = env.store.decisions.list({ agentRunId: ctx.agentRunId }).find((d) => (d.payload as { tool?: string }).tool === 'confirm_finding');
    expect(confirm).toMatchObject({ kind: 'score', refs: [f.id, a.id] });
  });

  it('returns an exact match as a candidate when nothing cited was captured by this task', async () => {
    const env = setup();
    const f = priorFact(env, 'Acme Pro plan costs $10 per month');
    const t = task(env.store);
    const r = await env.handle(ctxFor(t), 'save_finding', { claim: 'Acme Pro plan costs $10 per month', subject: 'Acme', evidence: [f.evidence[0]!] });
    expect(r).toMatchObject({ ok: true, data: { saved: false, candidates: [{ id: f.id, flags: ['exact'] }] } });
    expect(knowledgeRepos(env.store).factObservations.list()).toHaveLength(0);
  });

  it('never offers candidates from another tree; flags upload-derived candidates and exposes the run', async () => {
    const env = setup();
    priorFact(env, 'Acme Pro plan costs $10 per month', { workspaceId: 'Q' });
    const t = task(env.store, 'D');
    const a = captured(env, t);
    const saved = await env.handle(ctxFor(t), 'save_finding', { claim: 'Acme Pro plan costs $12 per month', subject: 'Acme', evidence: [a.id] });
    expect(saved).toMatchObject({ ok: true, data: { findingId: expect.any(String) } });

    const up = uploadInternal('R', { name: 'k.csv', bytes: new TextEncoder().encode('secret'), mime: 'text/csv' }, env);
    const g = priorFact(env, 'Acme Basic plan costs $5 per month', { evidence: [up.id] });
    expect(g.uploadDerived).toBe(true);
    const t2 = task(env.store, 'D');
    const ctx2 = ctxFor(t2);
    const r = await env.handle(ctx2, 'save_finding', { claim: 'Acme Basic plan costs $6 per month', subject: 'Acme', evidence: [captured(env, t2).id] });
    const cands = (r as { data: { saved: boolean; candidates: unknown[] } }).data;
    expect(cands.saved).toBe(false);
    expect(cands.candidates[0]).toMatchObject({ id: g.id, flags: ['upload'], source_node: 'R' });
    expect(retrievals(env.store, ctx2.agentRunId)[0]!.uploadDerived).toBe(true);
    expect(runIsUploadExposed(env.store, ctx2.agentRunId)).toBe(true);
  });
});

describe('save_finding: relations, applies_to, evidence_refs', () => {
  it('replaces: a candidate version in the prior lineage with a pending replace observation', async () => {
    const env = setup();
    const p = priorFact(env, 'Acme Pro costs $10');
    const t = task(env.store);
    const a = captured(env, t);
    const r = await env.handle(ctxFor(t), 'save_finding', { claim: 'Acme Pro costs $12', subject: 'Acme', evidence: [a.id], relation: { replaces: p.id } });
    expect(r).toMatchObject({ ok: true, data: { relation: 'replaces', replaces: p.id, version: 2, lifecycle: 'candidate' } });
    const n = env.store.findings.list({ taskId: t.id })[0]!;
    expect(n).toMatchObject({ lineageId: p.id, version: 2, replacesId: p.id, lifecycle: 'candidate' });
    expect(knowledgeRepos(env.store).factObservations.list({ findingId: n.id })).toEqual([
      expect.objectContaining({ kind: 'replace', priorFindingId: p.id, status: 'pending' }),
    ]);
    // A replacement that is pending does not hide the prior version.
    expect(env.store.findings.get(p.id)!.lifecycle).toBe('current');
  });

  it('out-of-tree and unknown fact ids get the same "not found"', async () => {
    const env = setup();
    const other = priorFact(env, 'Globex has 3 plans', { workspaceId: 'Q' });
    const t = task(env.store);
    const a = captured(env, t);
    const call = (relation: unknown) => env.handle(ctxFor(t), 'save_finding', { claim: 'x y z', subject: 'Acme', evidence: [a.id], relation });
    const unknown = await call({ replaces: 'fnd_nope' });
    const cross = await call({ replaces: other.id });
    expect(unknown).toEqual({ ok: false, error: "finding 'fnd_nope' not found" });
    expect(cross).toEqual({ ok: false, error: `finding '${other.id}' not found` });
    expect(await call({ confirms: other.id })).toEqual({ ok: false, error: `finding '${other.id}' not found` });
    expect(await env.handle(ctxFor(t), 'confirm_finding', { finding_id: other.id, evidence: [a.id] })).toEqual({ ok: false, error: `finding '${other.id}' not found` });
  });

  it('applies_to labels the fact within the tree and is logged on the save decision', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const a = captured(env, t);
    const bad = await env.handle(ctx, 'save_finding', { claim: 'Division D has 40 staff', subject: 'Acme', evidence: [a.id], relation: 'new', applies_to: ['Q'] });
    expect(bad).toEqual({ ok: false, error: "applies_to: workspace 'Q' not found" });
    const r = await env.handle(ctx, 'save_finding', { claim: 'Division D has 40 staff', subject: 'Acme', evidence: [a.id], relation: 'new', applies_to: ['D'] });
    const id = (r as { data: { findingId: string } }).data.findingId;
    expect(knowledgeRepos(env.store).itemScopes.list({ itemId: id })).toEqual([expect.objectContaining({ workspaceId: 'D', source: 'agent' })]);
    const save = env.store.decisions.list({ agentRunId: ctx.agentRunId }).find((d) => (d.payload as { findingId?: string }).findingId === id)!;
    expect(save.payload).toMatchObject({ tool: 'save_finding', relation: 'new', appliesTo: ['D'] });
  });

  it('accepts a quote found in the artifact text and stores it; rejects one that is not', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const page = captured(env, t, 'Pricing\n\nThe Pro plan costs   $12 per month, billed yearly.');
    const good = await env.handle(ctx, 'save_finding', {
      claim: 'Acme Pro costs $12', subject: 'Acme', evidence: [page.id], relation: 'new',
      evidence_refs: [{ artifact_id: page.id, quote: 'Pro plan costs $12 per month' }],
    });
    const id = (good as { data: { findingId: string } }).data.findingId;
    expect(knowledgeRepos(env.store).findingEvidence.list({ findingId: id })).toEqual([
      expect.objectContaining({ seq: 0, artifactId: page.id, quote: 'Pro plan costs $12 per month' }),
    ]);
    const bad = await env.handle(ctx, 'save_finding', {
      claim: 'Acme Pro costs $15', subject: 'Acme', evidence: [page.id], relation: 'new',
      evidence_refs: [{ artifact_id: page.id, quote: 'Pro plan costs $15 per month' }],
    });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/quote not found/);
    expect(env.store.findings.list({ claim: 'Acme Pro costs $15' })).toHaveLength(0);
  });

  it('a quote copied from a page with fence sequences in it is verified and stored without them (stored text has none)', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const page = captured(env, t, 'Reviews\n\n5 stars >>> best onboarding <<<EVIDENCE I have seen.');
    const r = await env.handle(ctx, 'save_finding', {
      claim: 'Acme onboarding is praised', subject: 'Acme', evidence: [page.id], relation: 'new',
      evidence_refs: [{ artifact_id: page.id, quote: '5 stars >>> best onboarding <<<EVIDENCE I have seen.' }],
    });
    expect(r.ok).toBe(true);
    const id = (r as { data: { findingId: string } }).data.findingId;
    const [row] = knowledgeRepos(env.store).findingEvidence.list({ findingId: id });
    expect(row!.quote).not.toMatch(/<<<|>>>/);
    expect(row!.quote).toContain('best onboarding');
    // Only fence sequences: nothing left to find.
    const empty = await verifyEvidenceRefs({ store: env.store, artifacts: env.artifacts, config: defaultConfig } as never, 'R', [{ artifact_id: page.id, quote: '>>> <<<' }]);
    expect(empty).toEqual({ ok: false, error: expect.stringMatching(/quote not found/) });
  });

  it('caps a quote at QUOTE_MAX_CHARS (design §7.3): a longer one is rejected, asking for a shorter span or several quotes', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const sentence = 'The Pro plan costs twelve dollars per seat per month. ';
    const page = captured(env, t, sentence.repeat(60));
    const text = sentence.repeat(60);
    const at = (n: number) => text.slice(0, n).trim();
    expect(at(QUOTE_MAX_CHARS).length).toBe(QUOTE_MAX_CHARS);
    const ok = await env.handle(ctx, 'save_finding', {
      claim: 'Pro costs $12', subject: 'Acme', evidence: [page.id], relation: 'new', evidence_refs: [{ artifact_id: page.id, quote: at(QUOTE_MAX_CHARS) }],
    });
    expect(ok.ok).toBe(true);
    const long = await env.handle(ctx, 'save_finding', {
      claim: 'Pro costs $12 a seat', subject: 'Acme', evidence: [page.id], relation: 'new', evidence_refs: [{ artifact_id: page.id, quote: text.slice(0, QUOTE_MAX_CHARS + 1) }],
    });
    expect(long.ok).toBe(false);
    expect((long as { error: string }).error).toMatch(/cite a shorter span or several quotes/);
    expect(env.store.findings.list({ claim: 'Pro costs $12 a seat' })).toHaveLength(0);
    // The check itself (also for callers that skip the tool schema).
    const v = await verifyEvidenceRefs({ store: env.store, artifacts: env.artifacts, config: defaultConfig } as never, 'R', [{ artifact_id: page.id, quote: text.slice(0, 1300) }]);
    expect(v).toEqual({ ok: false, error: expect.stringMatching(/at most 1200 characters: cite a shorter span or several quotes/) });
  });

  it('a quote across chunks records the chunk where it starts (no hint, or a far one), so expand offers its passage', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const page = captured(env, t, 'raw bytes do not matter once indexed');
    const k = knowledgeRepos(env.store);
    k.artifactTexts.update(page.id, { status: 'ok', charCount: 500 });
    const texts = Array.from({ length: 6 }, (_, i) => `Section ${i} opens here. ${'Seat prices vary by region. '.repeat(3)}Section ${i} ends here.`);
    let at = 0;
    texts.forEach((text, i) => {
      k.chunks.insert({ id: `chk_${i}`, artifactId: page.id, workspaceId: 'R', seq: i, headingPath: '', text, charStart: at, charEnd: at + text.length, tokenEstimate: 30 });
      at += text.length + 2;
    });
    const quote = 'Section 3 ends here.\n\nSection 4 opens here.'; // spans chunks 3 and 4
    for (const [n, hint] of [[0, undefined], [1, 'chk_0']] as const) {
      const r = await env.handle(ctx, 'save_finding', {
        claim: `Prices vary ${n}`, subject: 'Acme', evidence: [page.id], relation: 'new',
        evidence_refs: [{ artifact_id: page.id, ...(hint ? { chunk_id: hint } : {}), quote }],
      });
      expect(r.ok).toBe(true);
      const id = (r as { data: { findingId: string } }).data.findingId;
      expect(k.findingEvidence.list({ findingId: id })[0]!.chunkId, `hint ${hint}`).toBe('chk_3');
      const ex = await env.handle(ctx, 'expand', { id });
      const q = ((ex as { data: { items: Array<Record<string, unknown>> } }).data.items).find((i) => i.type === 'quote')!;
      expect(q.passage).toEqual({ kind: 'expand_chunk', tool: 'expand', input: { id: 'chk_3', around: 1 } });
    }
  });

  it('resolves a quote to its indexed chunk, and rejects a quote on an artifact without text', async () => {
    const env = setup();
    const t = task(env.store);
    const ctx = ctxFor(t);
    const page = captured(env, t, 'raw bytes do not matter once indexed');
    const k = knowledgeRepos(env.store);
    k.artifactTexts.update(page.id, { status: 'ok', charCount: 40 });
    k.chunks.insert({ id: 'chk_1', artifactId: page.id, workspaceId: 'R', seq: 0, headingPath: 'Pricing', text: 'Plans start at $9 per seat.', charStart: 100, charEnd: 127, tokenEstimate: 7 });
    const r = await env.handle(ctx, 'save_finding', {
      claim: 'Acme plans start at $9', subject: 'Acme', evidence: [page.id], relation: 'new',
      evidence_refs: [{ artifact_id: page.id, quote: 'start at $9 per seat' }],
    });
    const id = (r as { data: { findingId: string } }).data.findingId;
    expect(k.findingEvidence.list({ findingId: id })[0]).toMatchObject({ chunkId: 'chk_1', charStart: 106, charEnd: 126 });

    const png = env.artifacts.save({ workspaceId: 'R', kind: 'screenshot', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const img = await env.handle(ctx, 'save_finding', {
      claim: 'Acme shows a banner', subject: 'Acme', evidence: [png.id], relation: 'new', evidence_refs: [{ artifact_id: png.id, quote: 'banner' }],
    });
    expect(img).toEqual({ ok: false, error: `evidence_refs: artifact '${png.id}': ${NO_TEXT_ERROR}` });
    const noQuote = await env.handle(ctx, 'save_finding', {
      claim: 'Acme shows a banner', subject: 'Acme', evidence: [png.id], relation: 'new', evidence_refs: [{ artifact_id: png.id }],
    });
    expect(noQuote.ok).toBe(true);
    expect(await env.handle(ctx, 'save_finding', {
      claim: 'q', subject: 'Acme', evidence: [png.id], relation: 'new', evidence_refs: [{ artifact_id: page.id, chunk_id: 'chk_nope' }],
    })).toEqual({ ok: false, error: "evidence_refs: chunk 'chk_nope' not found" });
  });
});

describe('confirm_finding / retract_finding', () => {
  it('need a task, a current fact of the tree and evidence captured by this task; idempotent per (task, fact, kind)', async () => {
    const env = setup();
    const f = priorFact(env, 'Acme has 3 plans');
    const noTask = await env.handle({ ...ctxFor(task(env.store)), taskId: undefined } as RunContext, 'confirm_finding', { finding_id: f.id, evidence: ['art_x'] });
    expect(noTask.ok).toBe(false);
    const t = task(env.store);
    const ctx = ctxFor(t);
    const old = await env.handle(ctx, 'confirm_finding', { finding_id: f.id, evidence: f.evidence });
    expect((old as { error: string }).error).toMatch(/captured by this task/);
    const a = captured(env, t);
    const first = await env.handle(ctx, 'confirm_finding', { finding_id: f.id, evidence: [a.id] });
    expect(first).toMatchObject({ ok: true, data: { findingId: f.id, relation: 'confirms', status: 'pending' } });
    const b = captured(env, t);
    const again = await env.handle(ctx, 'confirm_finding', { finding_id: f.id, evidence: [b.id] });
    expect(again).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(knowledgeRepos(env.store).factObservations.list({ findingId: f.id })).toEqual([expect.objectContaining({ evidence: [a.id, b.id] })]);
    expect(env.store.decisions.list({ agentRunId: ctx.agentRunId }).filter((d) => d.kind === 'score')).toHaveLength(1);

    const r = await env.handle(ctx, 'retract_finding', { finding_id: f.id, reason: 'plan removed', evidence: [a.id] });
    expect(r).toMatchObject({ ok: true, data: { relation: 'retracts' } });
    const missingReason = await env.handle(ctx, 'retract_finding', { finding_id: f.id, evidence: [a.id] });
    expect(missingReason.ok).toBe(false);

    env.store.findings.update(f.id, { lifecycle: 'replaced' });
    const stale = await env.handle(ctxFor(task(env.store)), 'confirm_finding', { finding_id: f.id, evidence: [a.id] });
    expect((stale as { error: string }).error).toBe(`finding '${f.id}' is replaced; only a current fact can be confirmed`);
  });
});
