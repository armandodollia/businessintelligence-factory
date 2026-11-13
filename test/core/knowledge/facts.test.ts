import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config/schema.js';
import { isSynthesisEligible } from '../../../src/core/evidence/synthesis.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import {
  addObservation,
  applyObservations,
  claimSimilarity,
  factScope,
  findCandidates,
  freshness,
  normalizeClaim,
  recordStaleOutcome,
  retractFactByUser,
  setFactScopes,
} from '../../../src/core/knowledge/facts.js';
import { registerFeedbackOutcomes } from '../../../src/core/learning/feedbackOutcomes.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import { applyTaskStatus } from '../../../src/core/research/outputs.js';
import { reviewQueue } from '../../../src/core/scoring/reviewQueue.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Finding, Task } from '../../../src/core/types.js';

const opened: Store[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const r of releases.splice(0)) r();
});
const T0 = '2026-11-13T10:00:00.000Z';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ks2-facts-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  // Tree R → D, and a second tree Q.
  store.workspaces.insert({ id: 'R', name: 'R', sector: 's', createdAt: T0 });
  store.workspaces.insert({ id: 'D', name: 'D', sector: 's', createdAt: T0, parentWorkspaceId: 'R' });
  store.workspaces.insert({ id: 'Q', name: 'Q', sector: 's', createdAt: T0 });
  return { store, artifacts };
}

function task(store: Store, ws = 'R', extra: Partial<Task> = {}): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: ws, runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1,
    createdAt: T0, ...extra,
  });
}

function fact(store: Store, claim: string, extra: Partial<Finding> = {}): Finding {
  const t = extra.taskId ? undefined : task(store, extra.workspaceId ?? 'R');
  const f = store.findings.insert({
    id: newId('fnd'), workspaceId: 'R', runId: 'rrun_0', taskId: t?.id ?? extra.taskId!, subject: 'Acme', claim, criteria: {},
    evidence: [], status: 'verified', createdAt: T0, ...extra,
  });
  store.decisions.insert({
    id: newId('dec'), workspaceId: f.workspaceId, agentRunId: newId('arun'), role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    kind: 'score', payload: { tool: 'save_finding', findingId: f.id, criteria: {} }, refs: [f.id], promptVersion: 'pv', createdAt: T0,
  });
  return store.findings.get(f.id)!;
}

/** A pending replacement of `prior` saved by `t` (what `save_finding relation: replaces` writes). */
function replacement(store: Store, t: Task, prior: Finding, claim: string): Finding {
  const versions = store.findings.list({ lineageId: prior.lineageId! }).map((f) => f.version ?? 1);
  const n = store.findings.insert({
    id: newId('fnd'), workspaceId: t.workspaceId, runId: t.runId, taskId: t.id, subject: prior.subject, claim, criteria: {},
    evidence: [], status: 'pending', createdAt: T0, taskRound: t.round, lineageId: prior.lineageId!, version: Math.max(...versions) + 1,
    replacesId: prior.id, lifecycle: 'candidate',
  });
  addObservation(store, { workspaceId: t.workspaceId, finding: n, kind: 'replace', priorFindingId: prior.id, task: t, evidence: [] });
  return n;
}

const end = (store: Store, t: Task, status: 'verified' | 'unverified' | 'failed') =>
  store.transaction(() => applyTaskStatus(store, store.tasks.update(t.id, { status }), status));
const outcomesOf = (store: Store, id: string) => listOutcomes(store).filter((o) => o.subjectId === id);

describe('claims and similarity (similarityFloor measure)', () => {
  it('normalizes claims and measures Jaccard token overlap in 0–1', () => {
    expect(normalizeClaim('  Acme  raises PRICES. ')).toBe('acme raises prices');
    expect(claimSimilarity('Acme raises prices', 'acme raises prices!')).toBe(1);
    expect(claimSimilarity('Acme charges $10 a month', 'Acme charges $12 a month')).toBeCloseTo(4 / 6);
    expect(claimSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
});

describe('findCandidates (duplicate handshake)', () => {
  it('returns same-entity current facts of the caller’s tree above the floor, exact match apart', () => {
    const { store } = setup();
    const exact = fact(store, 'Acme Pro plan costs $10 per month');
    const near = fact(store, 'Acme Pro plan costs $12 per month', { workspaceId: 'D' });
    fact(store, 'Acme Pro plan costs $10 per month', { workspaceId: 'Q' }); // other tree
    fact(store, 'Acme Pro plan costs $10 per month', { subject: 'Globex' }); // other entity
    fact(store, 'Acme Pro plan costs $10 per month', { lifecycle: 'replaced' });
    fact(store, 'Acme Pro plan costs $10 per month', { status: 'superseded' });
    fact(store, 'Acme hired a new chief executive in Berlin'); // shares "acme" only: below the floor
    const r = findCandidates(store, factScope(store, 'D'), { claim: 'Acme Pro plan costs $10 per month.', subject: 'acme' });
    expect(r.exact?.id).toBe(exact.id);
    expect(r.candidates.map((c) => c.id)).toEqual([near.id]);
    expect(r.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.5);
    // Never from another tree, whatever the claim.
    const q = findCandidates(store, factScope(store, 'Q'), { claim: 'Acme Pro plan costs $12 per month', subject: 'Acme' });
    expect(q.exact).toBeUndefined();
    expect(q.candidates.map((c) => c.workspaceId)).toEqual(['Q']);
  });

  it('uses entity ids when both sides have one, skips the saving task, caps at candidateLimit and flags uploads', () => {
    const { store, artifacts } = setup();
    const up = uploadInternal('R', { name: 'k.csv', bytes: new TextEncoder().encode('kpi'), mime: 'text/csv' }, { store, artifacts });
    const ent = knowledgeRepos(store).entities.insert({
      id: 'ent_1', rootWorkspaceId: 'R', workspaceId: 'R', kind: 'competitor', name: 'Acme Corp', nameKey: 'acme corp', aliases: [], createdAt: T0, updatedAt: T0,
    });
    const own = task(store);
    const a = fact(store, 'Acme Pro plan costs $11 per month', { entityId: ent.id, subject: 'Acme Corp', evidence: [up.id] });
    fact(store, 'Acme Pro plan costs $13 per month', { entityId: 'ent_other' });
    fact(store, 'Acme Pro plan costs $14 per month', { taskId: own.id });
    for (let i = 0; i < 4; i++) fact(store, `Acme Pro plan costs $2${i} per month`, { entityId: ent.id });
    const r = findCandidates(store, factScope(store, 'R'), { claim: 'Acme Pro plan costs $10 per month', subject: 'whatever', entityId: ent.id, excludeTaskId: own.id });
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates.every((c) => c.id !== own.id)).toBe(true);
    const all = findCandidates(store, factScope(store, 'R'), { claim: 'Acme Pro plan costs $10 per month', subject: 'x', entityId: ent.id }, { candidateLimit: 20, similarityFloor: 0.5 });
    expect(all.candidates.find((c) => c.id === a.id)?.uploadDerived).toBe(true);
    expect(all.candidates.map((c) => c.claim)).not.toContain('Acme Pro plan costs $13 per month');
  });
});

describe('freshness', () => {
  it('is stale strictly after the TTL; fact ttl beats entity kind beats the default', () => {
    const f = { createdAt: T0, lastConfirmedAt: T0 } as Finding;
    const at = (days: number, ms = 0) => new Date(Date.parse(T0) + days * 86_400_000 + ms);
    expect(freshness(f, defaultConfig, at(90))).toMatchObject({ stale: false, ageDays: 90, ttlDays: 90, since: T0 });
    expect(freshness(f, defaultConfig, at(90, 1)).stale).toBe(true);
    const cfg = { knowledge: { freshness: { byEntityKind: { competitor: 30 } } } };
    expect(freshness(f, cfg, at(31), 'competitor').stale).toBe(true);
    expect(freshness({ ...f, ttlDays: 400 }, cfg, at(31), 'competitor').stale).toBe(false);
    expect(freshness({ createdAt: T0, firstSeenAt: '2026-01-01T00:00:00.000Z' } as Finding, defaultConfig, at(0)).since).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records one stale outcome per confirmation date', () => {
    const { store } = setup();
    const f = fact(store, 'Acme has 3 plans', { lastConfirmedAt: T0 });
    const later = new Date(Date.parse(T0) + 100 * 86_400_000);
    expect(recordStaleOutcome(store, defaultConfig, f, later)).toMatchObject({ label: 'stale', sourceKey: T0, subjectId: f.id });
    recordStaleOutcome(store, defaultConfig, f, later);
    expect(outcomesOf(store, f.id)).toHaveLength(1);
    expect(recordStaleOutcome(store, defaultConfig, f, new Date(T0))).toBeUndefined();
  });
});

describe('applying observations at task end (design §7.2)', () => {
  it('verified confirm updates the fact and records a confirmed outcome keyed by the observation', () => {
    const { store } = setup();
    const f = fact(store, 'Acme has 3 plans', { lastConfirmedAt: T0 });
    const t = task(store);
    const o = addObservation(store, { workspaceId: 'R', finding: f, kind: 'confirm', task: t, evidence: [] });
    end(store, t, 'verified');
    const after = store.findings.get(f.id)!;
    expect(after.confirmCount).toBe(1);
    expect(after.lastConfirmedAt! > T0).toBe(true);
    expect(knowledgeRepos(store).factObservations.get(o.id)).toMatchObject({ status: 'applied' });
    expect(outcomesOf(store, f.id)).toEqual([expect.objectContaining({ label: 'confirmed', sourceKey: o.id, subjectType: 'fact_version', source: 'fact_lineage' })]);
    expect(outcomesOf(store, f.id)[0]!.decisionId).toBeDefined();
    end(store, t, 'verified'); // idempotent
    expect(store.findings.get(f.id)!.confirmCount).toBe(1);
  });

  it('unverified / failed tasks reject observations and leave facts untouched', () => {
    const { store } = setup();
    const f = fact(store, 'Acme has 3 plans', { lastConfirmedAt: T0 });
    for (const status of ['unverified', 'failed'] as const) {
      const t = task(store);
      const o = addObservation(store, { workspaceId: 'R', finding: f, kind: 'retract', task: t, evidence: [] });
      end(store, t, status);
      expect(knowledgeRepos(store).factObservations.get(o.id)!.status).toBe('rejected');
    }
    expect(store.findings.get(f.id)).toMatchObject({ lifecycle: 'current', confirmCount: 0, lastConfirmedAt: T0 });
    expect(outcomesOf(store, f.id)).toEqual([]);
  });

  it('verified replace retires the prior version and records `changed` on it', () => {
    const { store } = setup();
    const p = fact(store, 'Acme Pro costs $10');
    const t = task(store);
    const n = replacement(store, t, p, 'Acme Pro costs $12');
    end(store, t, 'verified');
    expect(store.findings.get(p.id)!.lifecycle).toBe('replaced');
    expect(store.findings.get(n.id)).toMatchObject({ lifecycle: 'current', version: 2, status: 'verified', lineageId: p.id });
    expect(outcomesOf(store, p.id).map((o) => o.label)).toEqual(['changed']);
    expect(isSynthesisEligible(store.findings.get(p.id)!)).toBe(false);
    expect(isSynthesisEligible(store.findings.get(n.id)!)).toBe(true);
  });

  it('an unverified replacement stays a candidate until the user includes it', () => {
    const { store } = setup();
    releases.push(registerFeedbackOutcomes());
    const p = fact(store, 'Acme Pro costs $10');
    const t = task(store);
    const n = replacement(store, t, p, 'Acme Pro costs $12');
    end(store, t, 'unverified');
    expect(store.findings.get(n.id)).toMatchObject({ lifecycle: 'candidate', status: 'unverified' });
    expect(store.findings.get(p.id)!.lifecycle).toBe('current');
    expect(isSynthesisEligible({ ...store.findings.get(n.id)!, includeInSynthesis: true })).toBe(false); // candidate
    setIncludeOverride(store, 'finding', n.id, true, { actor: 'alice' });
    expect(store.findings.get(n.id)!.lifecycle).toBe('current');
    expect(store.findings.get(p.id)!.lifecycle).toBe('replaced');
    expect(isSynthesisEligible(store.findings.get(n.id)!)).toBe(true);
    const fb = listFeedback(store, { kind: 'fact_replacement_accept' });
    expect(fb).toEqual([expect.objectContaining({ actor: 'alice', targetType: 'finding', targetId: n.id })]);
    expect(outcomesOf(store, p.id)).toEqual([expect.objectContaining({ label: 'changed', source: 'user_override', actor: 'alice' })]);
  });

  it('verified retract retires the fact', () => {
    const { store } = setup();
    const f = fact(store, 'Acme offers a free tier');
    const t = task(store);
    addObservation(store, { workspaceId: 'R', finding: f, kind: 'retract', task: t, evidence: [], reason: 'removed' });
    end(store, t, 'verified');
    expect(store.findings.get(f.id)!.lifecycle).toBe('retracted');
    expect(outcomesOf(store, f.id).map((o) => o.label)).toEqual(['retracted']);
  });

  it('applies onto the lineage head and flags a conflict when the named version is no longer the head', () => {
    const { store } = setup();
    const p = fact(store, 'Acme Pro costs $10');
    const a = task(store);
    const b = task(store);
    const na = replacement(store, a, p, 'Acme Pro costs $12');
    const nb = replacement(store, b, p, 'Acme Pro costs $15');
    end(store, b, 'verified');
    end(store, a, 'verified');
    expect(store.findings.get(p.id)!.lifecycle).toBe('replaced');
    expect(store.findings.get(nb.id)!.lifecycle).toBe('replaced');
    const head = store.findings.get(na.id)!;
    expect(head).toMatchObject({ lifecycle: 'current', lineageConflict: true });
    expect(head.version).toBeGreaterThan(store.findings.get(nb.id)!.version!);
    expect(outcomesOf(store, nb.id).map((o) => o.label)).toEqual(['changed']);
    // A confirmation of the retired version confirms nothing and flags the head.
    const c = task(store);
    addObservation(store, { workspaceId: 'R', finding: store.findings.get(p.id)!, kind: 'confirm', task: c, evidence: [] });
    end(store, c, 'verified');
    expect(store.findings.get(p.id)!.confirmCount).toBe(0);
  });

  it('confirmations not re-submitted in the final round are superseded', () => {
    const { store } = setup();
    const f = fact(store, 'Acme has 3 plans');
    const g = fact(store, 'Acme has 4 seats');
    const t = task(store, 'R', { round: 2, submittedRound: 2 });
    const old = addObservation(store, { workspaceId: 'R', finding: f, kind: 'confirm', task: { ...t, round: 1 }, evidence: [] });
    const cited = addObservation(store, { workspaceId: 'R', finding: g, kind: 'confirm', task: { ...t, round: 1 }, evidence: [] });
    store.tasks.update(t.id, { result: { summary: `still true: ${g.id}` } });
    end(store, t, 'verified');
    expect(knowledgeRepos(store).factObservations.get(old.id)!.status).toBe('superseded');
    expect(knowledgeRepos(store).factObservations.get(cited.id)!.status).toBe('applied');
    expect(store.findings.get(f.id)!.confirmCount).toBe(0);
  });

  it('a confirmation citing an upload flags the fact at record time, even if the task fails', () => {
    const { store, artifacts } = setup();
    const up = uploadInternal('R', { name: 'k.csv', bytes: new TextEncoder().encode('kpi'), mime: 'text/csv' }, { store, artifacts });
    const f = fact(store, 'Acme has 3 plans');
    const t = task(store);
    const o = addObservation(store, { workspaceId: 'R', finding: f, kind: 'confirm', task: t, evidence: [up.id] });
    expect(store.findings.get(f.id)).toMatchObject({ uploadDerived: true, uploadCause: `observation:${o.id}` });
    end(store, t, 'failed');
    expect(store.findings.get(f.id)!.uploadDerived).toBe(true);
  });

  it('applyObservations without pending rows is a no-op', () => {
    const { store } = setup();
    expect(applyObservations(store, task(store), 'verified')).toEqual([]);
  });
});

describe('human fact actions', () => {
  it('retractFactByUser writes an applied observation, a feedback event and a user-rejected outcome', () => {
    const { store } = setup();
    releases.push(registerFeedbackOutcomes());
    const f = fact(store, 'Acme offers a free tier');
    retractFactByUser(store, f.id, { actor: 'bob', reason: 'gone' });
    expect(store.findings.get(f.id)!.lifecycle).toBe('retracted');
    const obs = knowledgeRepos(store).factObservations.list({ findingId: f.id });
    expect(obs).toEqual([expect.objectContaining({ kind: 'retract', status: 'applied', reason: 'gone' })]);
    expect(listFeedback(store, { kind: 'fact_retract' })).toEqual([expect.objectContaining({ actor: 'bob', targetId: f.id })]);
    expect(outcomesOf(store, f.id)).toEqual([expect.objectContaining({ label: 'user-rejected', sourceKey: obs[0]!.id, actor: 'bob' })]);
    expect(() => retractFactByUser(store, f.id)).toThrow(/retracted/);
  });

  it('setFactScopes relabels within the tree and records fact_scope_change', () => {
    const { store } = setup();
    const f = fact(store, 'Acme D-division has 40 staff');
    expect(setFactScopes(store, f.id, ['D'], { actor: 'bob' })).toEqual(['D']);
    expect(knowledgeRepos(store).itemScopes.list({ itemId: f.id })).toEqual([expect.objectContaining({ workspaceId: 'D', source: 'user' })]);
    expect(listFeedback(store, { kind: 'fact_scope_change' })[0]).toMatchObject({ beforeJson: { scopes: ['R'] }, afterJson: { scopes: ['D'] } });
    expect(() => setFactScopes(store, f.id, ['Q'])).toThrow(/not found/);
  });
});

describe('review queue re-queue (design §13)', () => {
  it('lists the live version of a lineage; replaced versions leave the queue', () => {
    const { store } = setup();
    const p = fact(store, 'Acme Pro costs $10', { criteria: { relevance: 3 } });
    expect(reviewQueue('R', { store }).map((i) => i.targetId)).toContain(p.id);
    const t = task(store);
    const n = replacement(store, t, p, 'Acme Pro costs $12');
    store.findings.update(n.id, { criteria: { relevance: 4 } });
    end(store, t, 'verified');
    const ids = reviewQueue('R', { store }).map((i) => i.targetId);
    expect(ids).toContain(n.id);
    expect(ids).not.toContain(p.id);
  });
});
