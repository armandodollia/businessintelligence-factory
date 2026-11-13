/**
 * KS-6 use linkage (design §13 "Use linkage"): a save that cites ids marks the cited ids that an
 * earlier retrieval of the SAME run returned, through the real dispatcher.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { recordRetrievalUses, savedRecordOf, stringsIn } from '../../../src/core/knowledge/uses.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function task(store: Store, workspaceId = 'ws_a'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId, runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
  });
}

type Hits = { hits: Array<{ id: string; kind: string; artifact_id?: string }> };

describe('retrieval_uses (KS-6)', () => {
  it('marks only the cited ids that an earlier retrieval of the same run returned', async () => {
    const t = ks4(opened);
    const page = await t.page('ws_a', 'Acme pricing page: the Pro plan costs 49 dollars per seat.');
    const known = t.fact('ws_a', 'Acme Pro costs 49 dollars per seat');
    const tk = task(t.store);
    const c = t.ctx('ws_a', 'worker', { taskId: tk.id });

    const found = await t.call<Hits>(c, 'search', { query: 'Pro seat' });
    expect(found.hits.map((h) => h.id)).toEqual(expect.arrayContaining([known.id]));
    const [searchEv] = t.rows(c.agentRunId);

    // A new fact citing the page the search returned (as a passage): the page is used.
    const saved = await t.call<{ findingId: string }>(c, 'save_finding', {
      claim: 'Acme charges per seat on every paid plan', subject: 'Acme', evidence: [page.id], relation: 'new',
    });
    const uses = () => knowledgeRepos(t.store).retrievalUses.list();
    expect(uses()).toEqual([
      expect.objectContaining({ retrievalEventId: searchEv!.id, itemId: page.id, usedByKind: 'finding', usedById: saved.findingId }),
    ]);

    // A confirmation of the fact the search returned: an observation uses the fact (and only that:
    // the fresh artifact was never returned to the run).
    const fresh = await t.call<{ artifactId: string }>(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'Pro still 49 per seat' });
    const obs = await t.call<{ observationId: string }>(c, 'confirm_finding', { finding_id: known.id, evidence: [fresh.artifactId] });
    expect(uses().filter((u) => u.usedById === obs.observationId)).toEqual([
      expect.objectContaining({ retrievalEventId: searchEv!.id, itemId: known.id, usedByKind: 'observation' }),
    ]);

    // A replay of the same save adds nothing.
    const before = uses().length;
    await t.call(c, 'confirm_finding', { finding_id: known.id, evidence: [fresh.artifactId] });
    expect(uses()).toHaveLength(before);
  });

  it('another run citing the same ids records no use; a handshake (nothing saved) records none', async () => {
    const t = ks4(opened);
    const page = await t.page('ws_a', 'Acme pricing: Pro 49 dollars per seat.');
    t.fact('ws_a', 'Acme Pro plan costs 49 dollars per seat per month');
    const reader = t.ctx('ws_a', 'worker', { taskId: task(t.store).id });
    await t.call(reader, 'search', { query: 'Pro seat' });

    const other = task(t.store);
    const writer = t.ctx('ws_a', 'worker', { taskId: other.id });
    await t.call(writer, 'save_finding', { claim: 'Acme bills per seat', subject: 'Acme', evidence: [page.id], relation: 'new' });
    expect(knowledgeRepos(t.store).retrievalUses.list()).toEqual([]);

    // The handshake of `reader` returns candidates and saves nothing: no use.
    const hs = await t.call<{ saved?: boolean }>(reader, 'save_finding', {
      claim: 'Acme Pro plan costs 49 dollars per seat each month', subject: 'Acme', evidence: [page.id],
    });
    expect(hs.saved).toBe(false);
    expect(knowledgeRepos(t.store).retrievalUses.list()).toEqual([]);
  });

  it('helpers: the saved record of a result, every string of an input, one row per returning retrieval', () => {
    expect(savedRecordOf({ findingId: 'fnd_1', observationId: 'obs_1' })).toEqual({ kind: 'observation', id: 'obs_1' });
    expect(savedRecordOf({ recommendationId: 'rec_1', priority: 3 })).toEqual({ kind: 'recommendation', id: 'rec_1' });
    expect(savedRecordOf({ saved: false, candidates: [] })).toBeUndefined();
    expect([...stringsIn({ a: ['x', { b: 'y' }], c: 3, d: 'x' })].sort()).toEqual(['x', 'y']);

    const t = ks4(opened);
    const run = newId('arun');
    const ev = (ids: string[]) =>
      knowledgeRepos(t.store).retrievalEvents.insert({
        id: newId('ret'), workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', agentRunId: run, role: 'synthesizer', tool: 'search', query: 'q',
        scope: 'node', resultIds: ids.map((id) => ({ id, kind: 'fact' })), resultCount: ids.length, tokensReturned: 10,
        truncated: false, relaxed: false, latencyMs: 1, uploadDerived: false, createdAt: T0,
      });
    const e1 = ev(['fnd_a', 'fnd_b']);
    const e2 = ev(['fnd_b']);
    const rows = recordRetrievalUses(t.store, { agentRunId: run, usedBy: { kind: 'recommendation', id: 'rec_1' }, cited: ['fnd_b', 'rec_1', 'fnd_z'] });
    expect(rows.map((r) => [r.retrievalEventId, r.itemId])).toEqual([[e1.id, 'fnd_b'], [e2.id, 'fnd_b']]);
  });
});
