/**
 * KS-7 gc (design §3 decision 12, §14): the report is read-only; prune removes files only, through a
 * logged user action, all or nothing, and refuses anything referenced, too recent, an upload, still
 * pending extraction or outside the caller's tree (same answer as unknown).
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneArtifactsAsUser } from '../../../src/core/feedback/actions.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { gcReport, PruneError, pruneCheck } from '../../../src/core/knowledge/gc.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = new Date('2026-11-13T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function world() {
  const t = ks4(opened);
  /** Moves an artifact and its captures `days` into the past. */
  const age = (id: string, days: number) => {
    t.store.db.prepare('UPDATE artifacts SET captured_at = ? WHERE id = ?').run(daysAgo(days), id);
    t.store.db.prepare('UPDATE artifact_captures SET captured_at = ? WHERE artifact_id = ?').run(daysAgo(days), id);
  };
  const old = async (ws: string, text: string, extra = {}) => {
    const a = await t.page(ws, text, extra);
    age(a.id, 200);
    return a;
  };
  const file = (id: string) => t.artifacts.filePath(t.store.artifacts.get(id)!);
  const prune = (ids: string[], opts: { minAgeDays?: number; workspaceId?: string } = {}) =>
    pruneArtifactsAsUser({ store: t.store, files: t.artifacts, config: t.config }, opts.workspaceId ?? 'ws_a', ids, {
      actor: 'ana@acme', now: NOW, ...(opts.minAgeDays !== undefined ? { minAgeDays: opts.minAgeDays } : {}),
    });
  const refusal = (ids: string[], opts: { minAgeDays?: number; workspaceId?: string } = {}) => {
    try {
      prune(ids, opts);
    } catch (e) {
      if (e instanceof PruneError) return e;
      throw e;
    }
    throw new Error('expected a refusal');
  };
  return { t, age, old, file, prune, refusal };
}

describe('gc report', () => {
  it('reports reclaimable bytes by node and age, and what is referenced or too recent; changes nothing', async () => {
    const w = world();
    const free = await w.old('ws_c', 'An old page nobody cites.');
    const cited = await w.old('ws_d', 'An old page a fact cites.');
    w.t.fact('ws_d', 'Cited claim', { evidence: [cited.id] });
    await w.t.page('ws_c', 'A fresh page.');
    const r = gcReport(w.t.store, w.t.artifacts, w.t.config, { workspaceIds: ['ws_a', 'ws_c', 'ws_d', 'ws_g'], now: NOW });
    expect(r.minAgeDays).toBe(90);
    expect(r.totals.artifacts).toBe(3);
    expect(r.totals.reclaimable.count).toBe(1);
    expect(r.totals.referenced.count).toBe(1);
    expect(r.totals.tooRecent.count).toBe(1);
    expect(r.candidates.map((c) => c.artifactId)).toEqual([free.id]);
    expect(r.byNode).toEqual([{ workspaceId: 'ws_c', count: 1, bytes: r.totals.reclaimable.bytes }]);
    expect(r.byAge).toEqual([{ bucket: '180–364 days', count: 1, bytes: r.totals.reclaimable.bytes }]);
    expect(r.olderExtractorTexts).toBe(0);
    expect(existsSync(w.file(free.id))).toBe(true);
    // Scoped to the nodes asked for; never another tree.
    const beta = await w.old('ws_b', 'Beta page.');
    const onlyC = gcReport(w.t.store, w.t.artifacts, w.t.config, { workspaceIds: ['ws_c'], now: NOW });
    expect(onlyC.candidates.map((c) => c.artifactId)).toEqual([free.id]);
    expect(JSON.stringify(onlyC)).not.toContain(beta.id);
  });

  it('counts texts extracted by an older extractor version', async () => {
    const w = world();
    const a = await w.old('ws_c', 'Old extraction.');
    w.t.store.db.prepare(`UPDATE artifact_texts SET extractor = 'text@0' WHERE artifact_id = ?`).run(a.id);
    expect(gcReport(w.t.store, w.t.artifacts, w.t.config, { workspaceIds: ['ws_c'], now: NOW }).olderExtractorTexts).toBe(1);
  });

  it('refuses a minimum age below knowledge.retention.pruneMinAgeDays', () => {
    const w = world();
    expect(() => gcReport(w.t.store, w.t.artifacts, w.t.config, { workspaceIds: ['ws_c'], minAgeDays: 30 })).toThrow(/at least 90/);
  });
});

describe('prune', () => {
  it('removes only the file, through a logged user action; row, hash, description and text stay', async () => {
    const w = world();
    const a = await w.old('ws_c', 'An old page nobody cites.', { description: 'Pricing page of Globex' });
    const chunks = knowledgeRepos(w.t.store).chunks.list({ artifactId: a.id }).length;
    const path = w.file(a.id);
    const r = w.prune([a.id]);
    expect(r.pruned.map((x) => x.artifactId)).toEqual([a.id]);
    expect(existsSync(path)).toBe(false);
    const row = w.t.store.artifacts.get(a.id)!;
    expect(row).toMatchObject({ sha256: a.sha256, description: 'Pricing page of Globex' });
    expect(knowledgeRepos(w.t.store).chunks.list({ artifactId: a.id }).length).toBe(chunks);
    // Logged: a system decision and an artifact_prune feedback event by the configured actor.
    const fb = listFeedback(w.t.store, { kind: 'artifact_prune' });
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ actor: 'ana@acme', targetType: 'artifact', targetId: a.id, workspaceId: 'ws_c', afterJson: { decisionId: r.decisionId } });
    const d = w.t.store.decisions.get(r.decisionId)!;
    expect(d).toMatchObject({ refs: [a.id], payload: { tool: 'artifact_prune', actorId: 'ana@acme' } });
    // The report now counts it as pruned; a second prune is refused.
    expect(gcReport(w.t.store, w.t.artifacts, w.t.config, { workspaceIds: ['ws_c'], now: NOW }).totals.pruned).toBe(1);
    expect(w.refusal([a.id]).refused).toEqual([{ artifactId: a.id, reason: 'already_pruned' }]);
    // Reading the bytes says the file is gone; capturing the same bytes again restores it.
    expect(() => w.t.artifacts.read(a.id)).toThrow(/not available/);
    w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'text', mime: 'text/plain', bytes: 'An old page nobody cites.' });
    expect(existsSync(path)).toBe(true);
  });

  it('refuses an artifact cited only by a replaced fact version', async () => {
    const w = world();
    const a = await w.old('ws_c', 'Evidence for the first version.');
    const v1 = w.t.fact('ws_c', 'Globex costs $10', { lifecycle: 'replaced', evidence: [a.id] });
    w.t.fact('ws_c', 'Globex costs $12', { lineageId: v1.id, version: 2, replacesId: v1.id });
    const e = w.refusal([a.id]);
    expect(e.status).toBe(409);
    expect(e.refused).toEqual([{ artifactId: a.id, reason: 'referenced', references: [{ kind: 'finding', id: v1.id }] }]);
    expect(existsSync(w.file(a.id))).toBe(true);
    expect(listFeedback(w.t.store, { kind: 'artifact_prune' })).toEqual([]);
  });

  it('refuses every other kind of reference', async () => {
    const w = world();
    const { store } = w.t;
    const quoted = await w.old('ws_c', 'Quoted page.');
    const f = w.t.fact('ws_c', 'A claim');
    knowledgeRepos(store).findingEvidence.insert({ findingId: f.id, seq: 0, artifactId: quoted.id, quote: 'Quoted' });
    const observed = await w.old('ws_c', 'Observed page.');
    knowledgeRepos(store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_c', lineageId: f.id, findingId: f.id, kind: 'confirm', evidence: [observed.id], status: 'rejected', createdAt: daysAgo(1),
    });
    const competitor = await w.old('ws_c', 'Competitor page.');
    store.competitors.insert({
      id: newId('cmp'), workspaceId: 'ws_c', name: 'Globex', threat: 3, directness: 3,
      comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [competitor.id], createdAt: daysAgo(1), updatedAt: daysAgo(1),
    } as never);
    const persona = await w.old('ws_c', 'Persona page.');
    store.personas.insert({
      id: newId('per'), workspaceId: 'ws_c', slug: 'cfo', segment: 'CFOs', agentMdPath: 'x', version: 1,
      profile: { goals: { value: 'save', confidence: 0.5, evidence: [persona.id] } },
    } as never);
    const symptom = await w.old('ws_c', 'Symptom page.');
    store.symptoms.insert({ id: newId('sym'), workspaceId: 'ws_c', kind: 'symptom', title: 'Churn', detail: 'd', criteria: {}, evidence: [symptom.id] });
    const flow = w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'screenshot', mime: 'image/png', bytes: 'png-1', flow: 'signup', step: 1 });
    w.age(flow.id, 200);
    const upload = w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'upload', mime: 'text/plain', bytes: 'internal notes' });
    w.age(upload.id, 200);
    const listed = await w.old('ws_c', 'Listed in the profile as an upload.');
    store.profiles.insert({ workspaceId: 'ws_c', data: { uploads: [listed.id] } } as never);
    const pending = w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'text', mime: 'text/plain', bytes: 'not yet extracted' });
    w.age(pending.id, 200);

    const reasons = Object.fromEntries(
      pruneCheck(store, w.t.artifacts, w.t.config, [quoted.id, observed.id, competitor.id, persona.id, symptom.id, flow.id, upload.id, listed.id, pending.id], {
        treeIds: ['ws_a', 'ws_c', 'ws_d', 'ws_g'], now: NOW,
      }).refused.map((r) => [r.artifactId, [r.reason, ...(r.references ?? []).map((x) => x.kind)]]),
    );
    expect(reasons).toEqual({
      [quoted.id]: ['referenced', 'finding'],
      [observed.id]: ['referenced', 'observation'],
      [competitor.id]: ['referenced', 'competitor'],
      [persona.id]: ['referenced', 'persona'],
      [symptom.id]: ['referenced', 'symptom'],
      [flow.id]: ['referenced', 'current_flow_capture'],
      [upload.id]: ['upload'],
      [listed.id]: ['upload', 'profile_upload'],
      [pending.id]: ['text_pending'],
    });
  });

  it('an older capture of a flow step is prunable once a later capture replaced it', async () => {
    const w = world();
    const first = w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'screenshot', mime: 'image/png', bytes: 'png-old', flow: 'signup', step: 1, description: 'Signup step one, old' });
    w.age(first.id, 300);
    const later = w.t.artifacts.save({ workspaceId: 'ws_c', kind: 'screenshot', mime: 'image/png', bytes: 'png-new', flow: 'signup', step: 1, description: 'Signup step one, new' });
    w.age(later.id, 200);
    knowledgeRepos(w.t.store).artifactTexts.update(first.id, { status: 'unsupported' });
    const check = pruneCheck(w.t.store, w.t.artifacts, w.t.config, [first.id, later.id], { treeIds: ['ws_a', 'ws_c', 'ws_d', 'ws_g'], now: NOW });
    expect(check.eligible.map((x) => x.artifactId)).toEqual([first.id]);
    expect(check.refused.map((x) => x.reason)).toEqual(['referenced']);
  });

  it('too recent, other tree and unknown ids are refused, and one refusal prunes nothing', async () => {
    const w = world();
    const ok = await w.old('ws_c', 'Old and free.');
    const fresh = await w.t.page('ws_c', 'Fresh page.');
    const beta = await w.old('ws_b', 'Beta page.');
    const e = w.refusal([ok.id, fresh.id, beta.id, 'art_nope']);
    expect(e.refused).toEqual([
      { artifactId: fresh.id, reason: 'too_recent', ageDays: 0 },
      { artifactId: beta.id, reason: 'not_found' },
      { artifactId: 'art_nope', reason: 'not_found' },
    ]);
    expect(existsSync(w.file(ok.id))).toBe(true);
    expect(existsSync(w.file(beta.id))).toBe(true);
    // An older cut than the configured one is allowed; a younger one is not.
    expect(w.refusal([ok.id], { minAgeDays: 365 }).refused).toEqual([{ artifactId: ok.id, reason: 'too_recent', ageDays: 200 }]);
    expect(w.refusal([ok.id], { minAgeDays: 10 }).status).toBe(400);
    expect(w.prune([ok.id], { minAgeDays: 120 }).pruned).toHaveLength(1);
  });
});
