/**
 * KS-6 (design §13 "WP-A"): every human knowledge action writes one `feedback_events` row with the
 * acting user (`config.user.id` through `actorOf`), and a new fact version re-queues its lineage in
 * the review queue (the rated revision is no longer current).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config/schema.js';
import { mergeEntitiesAsUser, renameEntityAsUser, setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { FEEDBACK_KINDS, actorOf, listFeedback, recordFeedback } from '../../../src/core/feedback/events.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { retractFactByUser, setFactScopes } from '../../../src/core/knowledge/facts.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import { reviewQueue } from '../../../src/core/scoring/reviewQueue.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('human knowledge actions write feedback events with the configured actor (KS-6)', () => {
  it('fact scope change, retraction, accepted update, entity merge and rename, artifact prune — one row each', async () => {
    const t = ks4(opened);
    const config = structuredClone(defaultConfig);
    config.user = { id: 'alice' };
    const actor = actorOf(config);
    expect(actor).toBe('alice');

    const f = t.fact('ws_a', 'Acme ships weekly');
    setFactScopes(t.store, f.id, ['ws_c'], { actor });
    retractFactByUser(t.store, t.fact('ws_a', 'Acme has a free tier').id, { actor, reason: 'gone' });
    // An unverified replacement the user includes is applied (`fact_replacement_accept`).
    const prior = t.fact('ws_a', 'Acme Pro costs $10');
    const cand = t.fact('ws_a', 'Acme Pro costs $12', {
      lineageId: prior.id, version: 2, replacesId: prior.id, lifecycle: 'candidate', status: 'unverified', taskId: 'tsk_r',
    });
    knowledgeRepos(t.store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_a', lineageId: prior.id, findingId: cand.id, priorFindingId: prior.id, kind: 'replace', taskId: 'tsk_r',
      evidence: [], status: 'rejected', createdAt: T0,
    });
    setIncludeOverride(t.store, 'finding', cand.id, true, { actor });
    const scope = scopeFor(t.store, 'ws_a');
    const a = resolveEntity(t.store, scope, { kind: 'competitor', name: 'Globex' });
    const b = resolveEntity(t.store, scope, { kind: 'competitor', name: 'Globex Inc' });
    t.fact('ws_a', 'Globex is a competitor', { entityId: a.id });
    t.fact('ws_a', 'Globex Inc is a competitor', { entityId: b.id });
    mergeEntitiesAsUser(t.store, a.id, b.id, { actor });
    renameEntityAsUser(t.store, a.id, 'Globex Corp', { actor });
    const page = await t.page('ws_a', 'old page');
    recordFeedback(t.store, { workspaceId: 'ws_a', actor, kind: 'artifact_prune', targetType: 'artifact', targetId: page.id, beforeJson: { file: true }, afterJson: { file: false } });

    const kinds = ['fact_scope_change', 'fact_retract', 'fact_replacement_accept', 'entity_merge', 'entity_rename', 'artifact_prune'] as const;
    for (const kind of kinds) {
      expect(FEEDBACK_KINDS).toContain(kind);
      const rows = listFeedback(t.store, { kind });
      expect(rows, kind).toHaveLength(1);
      expect(rows[0]!.actor, kind).toBe('alice');
    }
  });
});

describe('a new fact version re-queues its lineage for review (KS-6 check of KS-2)', () => {
  it('the rated version leaves the queue when replaced; the new version is queued unrated', () => {
    const t = ks4(opened);
    const v1 = t.fact('ws_a', 'Acme Pro costs $10', { criteria: { relevance: 4, reliability: 4, novelty: 3 } });
    for (const criterion of ['relevance', 'reliability', 'novelty']) {
      rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: v1.id, criterion, verdict: 'agree', actor: 'alice' }, { store: t.store });
    }
    expect(reviewQueue('ws_a', { store: t.store }).map((i) => i.targetId)).not.toContain(v1.id);
    t.store.findings.update(v1.id, { lifecycle: 'replaced' });
    const v2 = t.fact('ws_a', 'Acme Pro costs $12', { lineageId: v1.id, version: 2, replacesId: v1.id, criteria: { relevance: 4, reliability: 4, novelty: 3 } });
    const queue = reviewQueue('ws_a', { store: t.store });
    expect(queue.map((i) => i.targetId)).toContain(v2.id);
    expect(queue.find((i) => i.targetId === v2.id)!.unrated.sort()).toEqual(['novelty', 'relevance', 'reliability']);
    expect(queue.map((i) => i.targetId)).not.toContain(v1.id);
  });
});
