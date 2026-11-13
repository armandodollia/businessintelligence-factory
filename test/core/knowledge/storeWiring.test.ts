import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../../src/core/harness/tools/handlers.js';
import { mergeEntities, resolveEntity, type EntityRef } from '../../../src/core/knowledge/entities.js';
import { findingEntity, peekFindingEntity } from '../../../src/core/knowledge/entityLinks.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { neighbours } from '../../../src/core/knowledge/relations.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Finding, Task } from '../../../src/core/types.js';

// Cross-wiring of KS-1 (extraction, captures), KS-2 (living facts) and KS-3 (entities) through the
// real tool dispatcher: nothing here inserts capture rows or text rows by hand.

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

function setup(config: BifConfig = defaultConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-wiring-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const ws = (id: string, name: string, parent?: string) =>
    store.workspaces.insert({
      id, name, sector: 'saas', createdAt: T0, scope: { level: parent ? 'division' : 'company', name, description: '' },
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('R', 'Acme');
  ws('D', 'Acme Payments', 'R');
  ws('Q', 'Other');
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({ store, artifacts, config, events: new EventBus() });
  return { store, artifacts, handle, k: knowledgeRepos(store) };
}
type Env = ReturnType<typeof setup>;

function task(store: Store, ws = 'R'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: ws, runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
  });
}

const ctxFor = (t: Task): RunContext => ({
  agentRunId: newId('arun'), workspaceId: t.workspaceId, taskId: t.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
});

const data = <T = Record<string, unknown>>(r: { ok: boolean }): T => {
  if (!r.ok) throw new Error(`tool failed: ${(r as unknown as { error: string }).error}`);
  return (r as unknown as { data: T }).data;
};

async function saveText(env: Env, ctx: RunContext, content: string, extra: Record<string, unknown> = {}) {
  return data<{ artifactId: string; captureId: string; extraction: { status: string; queued?: true } }>(
    await env.handle(ctx, 'save_artifact', { kind: 'text', mime: 'text/plain', content, ...extra }),
  );
}

/** A verified current fact saved by an earlier task, through the tools. */
async function earlierFact(env: Env, claim: string, extra: Record<string, unknown> = {}): Promise<Finding> {
  const t = task(env.store);
  const c = ctxFor(t);
  const a = await saveText(env, c, `earlier evidence for ${claim}`);
  const r = data<{ findingId: string }>(
    await env.handle(c, 'save_finding', { claim, subject: 'Globex', evidence: [a.artifactId], relation: 'new', ...extra }),
  );
  env.store.findings.update(r.findingId, { status: 'verified' });
  return env.store.findings.get(r.findingId)!;
}

describe('KS-1 × KS-2: captures written by save_artifact carry the task (design §7.3)', () => {
  it('confirm_finding, retract_finding and the exact-match auto-confirm accept artifacts saved through save_artifact', async () => {
    const env = setup();
    const f1 = await earlierFact(env, 'Globex Pro plan costs $10 per month');
    const f2 = await earlierFact(env, 'Globex offers a free tier for teams');
    const f3 = await earlierFact(env, 'Globex supports single sign-on on every plan');

    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'Globex pricing page, visited today');
    expect(env.k.artifactCaptures.list({ artifactId: a.artifactId })).toMatchObject([{ taskId: t.id, agentRunId: c.agentRunId }]);

    expect(data(await env.handle(c, 'confirm_finding', { finding_id: f1.id, evidence: [a.artifactId] }))).toMatchObject({
      findingId: f1.id, relation: 'confirms', status: 'pending',
    });
    expect(
      data(await env.handle(c, 'retract_finding', { finding_id: f2.id, reason: 'free tier removed', evidence: [a.artifactId] })),
    ).toMatchObject({ findingId: f2.id, relation: 'retracts', status: 'pending' });
    const auto = data(await env.handle(c, 'save_finding', { claim: f3.claim, subject: 'Globex', evidence: [a.artifactId] }));
    expect(auto).toMatchObject({ findingId: f3.id, autoConfirmed: true });
    expect(env.k.factObservations.list({ taskId: t.id }).map((o) => o.kind).sort()).toEqual(['confirm', 'confirm', 'retract']);
  });

  it('identical bytes saved earlier by another task still count once this task saves them (captures never dedupe)', async () => {
    const env = setup();
    const f = await earlierFact(env, 'Globex Pro plan costs $10 per month');
    const other = task(env.store);
    const first = await saveText(env, ctxFor(other), 'the same pricing page bytes');
    const t = task(env.store);
    const c = ctxFor(t);
    // Not saved by this task yet: rejected.
    const refused = await env.handle(c, 'confirm_finding', { finding_id: f.id, evidence: [first.artifactId] });
    expect(refused).toMatchObject({ ok: false });
    const again = await saveText(env, c, 'the same pricing page bytes');
    expect(again.artifactId).toBe(first.artifactId);
    expect(again.captureId).not.toBe(first.captureId);
    expect(await env.handle(c, 'confirm_finding', { finding_id: f.id, evidence: [again.artifactId] })).toMatchObject({ ok: true });
  });

  it('a quote on a still-queued artifact extracts it inline through the KS-1 pipeline (stored, chunk-resolved)', async () => {
    const env = setup({ ...defaultConfig, knowledge: { extraction: { inlineMaxBytes: 4 } } });
    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'Globex Pricing. The Pro plan costs 12 dollars per seat per month.');
    expect(a.extraction).toMatchObject({ status: 'pending', queued: true });
    // The background queue must not be what extracts it.
    await ingestorFor({ store: env.store, artifacts: env.artifacts }).stop();
    expect(env.k.artifactTexts.get(a.artifactId)?.status).toBe('pending');

    const r = data<{ findingId: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Globex Pro costs $12 per seat', subject: 'Globex', evidence: [a.artifactId], relation: 'new',
        evidence_refs: [{ artifact_id: a.artifactId, quote: 'The Pro plan costs 12 dollars per seat' }],
      }),
    );
    expect(env.k.artifactTexts.get(a.artifactId)?.status).toBe('ok');
    const chunks = env.k.chunks.list({ artifactId: a.artifactId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(env.k.findingEvidence.list({ findingId: r.findingId })).toMatchObject([
      { artifactId: a.artifactId, chunkId: chunks[0]!.id, quote: 'The Pro plan costs 12 dollars per seat' },
    ]);
  });
});

describe('KS-1 × KS-3: save_artifact resolves its entity with resolveEntity and links it (design §7.4)', () => {
  it('a near-match name is created with a merge suggestion; an alias resolves to the survivor', async () => {
    const env = setup();
    const c = ctxFor(task(env.store));
    const scope = scopeFor(env.store, 'R');
    const globex = resolveEntity(env.store, scope, { kind: 'competitor', name: 'Globex' });
    const a = await saveText(env, c, 'globex corp homepage', { entity: { kind: 'competitor', name: 'Globex Corp' } });
    const created = env.k.artifactCaptures.get(a.captureId)!.entityId!;
    expect(created).not.toBe(globex.id);
    expect(env.k.entities.get(created)).toMatchObject({ kind: 'competitor', name: 'Globex Corp', createdByRun: c.agentRunId });
    expect(env.k.entityMergeSuggestions.list({ rootWorkspaceId: 'R' })).toMatchObject([{ status: 'open' }]);
    // After a merge, the loser's name (now an alias) and its id resolve to the survivor.
    mergeEntities(env.store, globex.id, created, 'user');
    const byName = await saveText(env, c, 'globex corp blog', { entity: { kind: 'competitor', name: 'globex corp' } });
    const byOldId = await saveText(env, c, 'globex corp docs', { entity: { id: created } });
    const byString = await saveText(env, c, 'globex corp careers', { entity: created });
    for (const s of [byName, byOldId, byString]) expect(env.k.artifactCaptures.get(s.captureId)!.entityId).toBe(globex.id);
  });

  it('an artifact with a flow and an entity gets the has_flow edge (source: the artifact)', async () => {
    const env = setup();
    const c = ctxFor(task(env.store, 'D'));
    const a = await saveText(env, c, 'signup step one', { entity: { kind: 'product', name: 'Widget' }, flow: 'Signup', step: 1 });
    const widget = env.k.artifactCaptures.get(a.captureId)!.entityId!;
    const edges = neighbours(env.store, scopeFor(env.store, 'D'), widget, { depth: 1, usableOnly: true });
    expect(edges).toMatchObject([{ type: 'has_flow', fromEntityId: widget, sourceKind: 'artifact', sourceId: a.artifactId }]);
    expect(env.k.entities.get(edges[0]!.toEntityId)).toMatchObject({ kind: 'flow', name: 'Signup', workspaceId: 'D' });
    // Saving the same step again adds no second edge; without an entity there is no edge.
    await saveText(env, c, 'signup step one', { entity: { id: widget }, flow: 'Signup', step: 1 });
    await saveText(env, c, 'signup step two', { flow: 'Signup', step: 2 });
    expect(env.k.relations.list({ rootWorkspaceId: 'R' })).toHaveLength(1);
  });

  it('another tree’s entity id fails like an unknown one, in either form, and writes nothing', async () => {
    const env = setup();
    const foreign = resolveEntity(env.store, scopeFor(env.store, 'Q'), { kind: 'product', name: 'Secret' });
    const c = ctxFor(task(env.store));
    const before = env.store.artifacts.list().length;
    for (const entity of [foreign.id, { id: foreign.id }]) {
      expect(await env.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'x', entity })).toEqual({
        ok: false, error: `entity '${foreign.id}' not found`,
      });
    }
    expect(await env.handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'x', entity: { id: 'ent_nope' } })).toEqual({
      ok: false, error: `entity 'ent_nope' not found`,
    });
    expect(env.store.artifacts.list()).toHaveLength(before);
  });
});

describe('KS-2 × KS-3: save_finding files facts under the resolved entity (design §7.2, §7.4)', () => {
  const entityCount = (env: Env) => env.k.entities.list({ rootWorkspaceId: 'R' }).length;

  it('a new fact stores and returns its entity; relations are linked from it', async () => {
    const env = setup();
    const c = ctxFor(task(env.store));
    const a = await saveText(env, c, 'widget page');
    const r = data<{ findingId: string; entityId: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Widget ships SSO', subject: 'Widget', evidence: [a.artifactId], relation: 'new',
        entity: { kind: 'product', name: 'Widget' }, relations: [{ type: 'part_of', to: { kind: 'competitor', name: 'Globex' } }],
      }),
    );
    expect(env.k.entities.get(r.entityId)).toMatchObject({ kind: 'product', name: 'Widget' });
    expect(env.store.findings.get(r.findingId)!.entityId).toBe(r.entityId);
    expect(env.k.relations.list({ sourceKind: 'fact', sourceId: r.findingId })).toMatchObject([{ fromEntityId: r.entityId, type: 'part_of' }]);
  });

  it('the duplicate handshake and a confirmation never create an entity (§12: an unreferenced name reads as public)', async () => {
    const env = setup();
    const prior = await earlierFact(env, 'Globex Pro plan costs $10 per month');
    // A legacy fact without an entity: sameness falls back to the subject key.
    const legacy = env.store.findings.insert({ ...prior, id: newId('fnd'), entityId: undefined, subject: 'Zeta Labs', claim: 'Zeta Labs Pro plan costs $10 per month', lineageId: undefined });
    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'zeta pricing today');
    const n = entityCount(env);
    const hs = data<{ saved: boolean; candidates: Array<{ id: string }> }>(
      await env.handle(c, 'save_finding', { claim: 'Zeta Labs Pro plan costs $12 per month', subject: 'Zeta Labs', evidence: [a.artifactId] }),
    );
    expect(hs.saved).toBe(false);
    expect(hs.candidates.map((x) => x.id)).toEqual([legacy.id]);
    const conf = data(
      await env.handle(c, 'save_finding', {
        claim: 'Zeta Labs Pro plan costs $10 per month', subject: 'Zeta Labs', evidence: [a.artifactId], relation: { confirms: legacy.id },
        entity: { kind: 'competitor', name: 'Zeta Labs' },
      }),
    );
    expect(conf).toMatchObject({ findingId: legacy.id, relation: 'confirms' });
    expect(entityCount(env)).toBe(n);
  });

  it('peekFindingEntity answers what findingEntity would resolve, without writing', () => {
    const env = setup();
    const scope = scopeFor(env.store, 'R');
    const cases: Array<[string, EntityRef | undefined]> = [
      ['Acme Payments', undefined], // a node's company entity, created on first use
      ['Pricing pages', undefined], // a topic
      ['x', { kind: 'product', name: 'Widget' }],
    ];
    for (const [subject, ref] of cases) {
      const n = env.k.entities.list().length;
      expect(peekFindingEntity(env.store, 'R', subject, ref)).toBeNull();
      expect(env.k.entities.list()).toHaveLength(n);
      const e = findingEntity(env.store, { workspaceId: 'R', subject }, ref)!;
      expect(peekFindingEntity(env.store, 'R', subject, ref)).toBe(e.id);
    }
    const foreign = resolveEntity(env.store, scopeFor(env.store, 'Q'), { kind: 'product', name: 'Secret' });
    expect(() => peekFindingEntity(env.store, 'R', 'x', { id: foreign.id })).toThrow(`entity '${foreign.id}' not found`);
    expect(peekFindingEntity(env.store, 'ws_missing', 'x', undefined)).toBeUndefined();
    expect(scope.rootId).toBe('R');
  });

  it('"same entity" in the handshake is the resolved entity, not the subject text', async () => {
    const env = setup();
    const globex = resolveEntity(env.store, scopeFor(env.store, 'R'), { kind: 'competitor', name: 'Globex' });
    const prior = await earlierFact(env, 'Globex Pro plan costs $10 per month', { entity: { id: globex.id } });
    expect(prior.entityId).toBe(globex.id);
    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'pricing page today');
    // Other subject text, same entity → offered as a duplicate.
    const same = data<{ saved: boolean; candidates: Array<{ id: string }> }>(
      await env.handle(c, 'save_finding', {
        claim: 'Globex Pro plan costs $12 per month', subject: 'GX Holdings', evidence: [a.artifactId], entity: { id: globex.id },
      }),
    );
    expect(same).toMatchObject({ saved: false, candidates: [{ id: prior.id }] });
    // Same subject text, another entity → not a duplicate: saved.
    const other = data<{ findingId: string; entityId: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Globex Pro plan costs $12 per month on mobile', subject: 'Globex', evidence: [a.artifactId],
        entity: { kind: 'product', name: 'Globex Mobile' },
      }),
    );
    expect(other.findingId).toBeDefined();
    expect(env.k.entities.get(other.entityId)).toMatchObject({ kind: 'product', name: 'Globex Mobile' });
    // The subject alone resolves to the competitor entity (subject rule) → duplicate again.
    const bySubject = data<{ saved: boolean }>(
      await env.handle(c, 'save_finding', { claim: 'Globex Pro plan now costs $12 per month', subject: 'globex', evidence: [a.artifactId] }),
    );
    expect(bySubject.saved).toBe(false);
  });

  it('replaces keeps the prior fact’s entity (its survivor) unless an entity is given', async () => {
    const env = setup();
    const scope = scopeFor(env.store, 'R');
    const widget = resolveEntity(env.store, scope, { kind: 'product', name: 'Widget' });
    const globex = resolveEntity(env.store, scope, { kind: 'competitor', name: 'Globex' });
    const prior = await earlierFact(env, 'Widget costs $10', { entity: { id: widget.id } });
    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'widget pricing today');
    const n = entityCount(env);
    const r = data<{ findingId: string; entityId: string; relation: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Widget costs $12', subject: 'Widget Pro edition', evidence: [a.artifactId], relation: { replaces: prior.id },
        relations: [{ type: 'part_of', to: { id: globex.id } }],
      }),
    );
    expect(r).toMatchObject({ relation: 'replaces', entityId: widget.id });
    expect(env.store.findings.get(r.findingId)!.entityId).toBe(widget.id);
    expect(entityCount(env)).toBe(n); // no topic "Widget Pro edition"
    expect(env.k.relations.list({ sourceKind: 'fact', sourceId: r.findingId })).toMatchObject([
      { fromEntityId: widget.id, type: 'part_of', toEntityId: globex.id },
    ]);

    // The prior's entity was merged away: the replacement follows the survivor.
    const gizmo = resolveEntity(env.store, scope, { kind: 'product', name: 'Gizmo' });
    const p2 = await earlierFact(env, 'Gizmo has 3 plans', { entity: { id: gizmo.id } });
    mergeEntities(env.store, widget.id, gizmo.id, 'user');
    const r2 = data<{ entityId: string }>(
      await env.handle(c, 'save_finding', { claim: 'Gizmo has 4 plans', subject: 'Gizmo', evidence: [a.artifactId], relation: { replaces: p2.id } }),
    );
    expect(r2.entityId).toBe(widget.id);

    // An explicit entity wins.
    const p3 = await earlierFact(env, 'Widget has an API', { entity: { id: widget.id } });
    const r3 = data<{ entityId: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Widget has a public API', subject: 'Widget', evidence: [a.artifactId], relation: { replaces: p3.id },
        entity: { kind: 'feature', name: 'Widget API' },
      }),
    );
    expect(env.k.entities.get(r3.entityId)).toMatchObject({ kind: 'feature', name: 'Widget API' });
  });
});
