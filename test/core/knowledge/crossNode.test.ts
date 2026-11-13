/**
 * KS-7 additions to the KS-4 read tools (user decisions, design §3):
 * - relation endpoints in `expand` of a fact carry their source node (gate nit);
 * - causal edges (`causes`, `addresses`) around a symptom or cause entity are listed tree-wide in node
 *   scope too, labelled with their source node; every other relation type keeps the node boundary;
 * - a node-scoped `search` says how many more matches exist elsewhere in the business (counts only).
 *
 * Fixture: ws_a "Acme" → ws_c "Acme Payments" (here: Product) and ws_d "Acme Labs" (here: HR).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { addRelation } from '../../../src/core/knowledge/relations.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { orchestratorBriefing } from '../../../src/core/knowledge/briefing.js';
import { crossNodeCausalEdges } from '../../../src/core/knowledge/readCommon.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function world() {
  const t = ks4(opened);
  const sc = scopeFor(t.store, 'ws_a');
  const symptom = resolveEntity(t.store, sc, { kind: 'symptom', name: 'Checkout abandonment' }, { workspaceId: 'ws_c' });
  const cause = resolveEntity(t.store, sc, { kind: 'cause', name: 'Slow HR approvals' }, { workspaceId: 'ws_d' });
  const topic = resolveEntity(t.store, sc, { kind: 'topic', name: 'Hiring freeze' }, { workspaceId: 'ws_d' });
  const fix = resolveEntity(t.store, sc, { kind: 'feature', name: 'Instant approval flow' }, { workspaceId: 'ws_d' });
  t.fact('ws_c', 'Checkout abandonment rose to 30 percent', { entityId: symptom.id });
  const hrCause = t.fact('ws_d', 'HR approvals take three weeks', { entityId: cause.id });
  const hrTopic = t.fact('ws_d', 'A hiring freeze slows HR', { entityId: topic.id });
  const hrFix = t.fact('ws_d', 'Instant approvals would remove the wait', { entityId: fix.id });
  const causes = addRelation(t.store, sc, { from: cause.id, type: 'causes', to: symptom.id, sourceKind: 'fact', sourceId: hrCause.id });
  const addresses = addRelation(t.store, sc, { from: fix.id, type: 'addresses', to: symptom.id, sourceKind: 'fact', sourceId: hrFix.id });
  // Non-causal edges asserted in HR stay behind the node boundary.
  addRelation(t.store, sc, { from: symptom.id, type: 'part_of', to: topic.id, sourceKind: 'fact', sourceId: hrTopic.id });
  addRelation(t.store, sc, { from: cause.id, type: 'part_of', to: topic.id, sourceKind: 'fact', sourceId: hrTopic.id });
  return { t, symptom, cause, topic, fix, causes, addresses, hrCause };
}

type Card = { lines: string[] };
type Expanded = { items: Array<Record<string, unknown>> };

describe('relation endpoints carry their source node (expand of a fact)', () => {
  it('labels both ends with their home node under scope "tree"', async () => {
    const t = ks4(opened);
    const sc = scopeFor(t.store, 'ws_a');
    const globex = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Globex' }, { workspaceId: 'ws_a' });
    const lending = t.fact('ws_d', 'Globex offers loans to Lending customers', { entityId: globex.id });
    const loans = resolveEntity(t.store, sc, { kind: 'product', name: 'Globex Loans' }, { workspaceId: 'ws_d' });
    addRelation(t.store, sc, { from: globex.id, type: 'offers', to: loans.id, sourceKind: 'fact', sourceId: lending.id });
    const own = resolveEntity(t.store, sc, { kind: 'product', name: 'Payments Wallet' }, { workspaceId: 'ws_c' });
    addRelation(t.store, sc, { from: globex.id, type: 'competes_with', to: own.id, sourceKind: 'fact', sourceId: lending.id });
    const ex = await t.call<Expanded>(t.ctx('ws_c'), 'expand', { id: lending.id, scope: 'tree' });
    const rels = ex.items.filter((i) => i.type === 'relation');
    expect(rels.find((r) => r.relation === 'offers')).toMatchObject({
      from: { id: globex.id, source: 'ws_a' },
      to: { id: loans.id, source: 'ws_d' },
    });
    // The caller's own node is not labelled.
    const cw = rels.find((r) => r.relation === 'competes_with') as { to: Record<string, unknown> };
    expect(cw.to.id).toBe(own.id);
    expect(cw.to.source).toBeUndefined();
  });
});

describe('causal edges cross nodes by default', () => {
  it("a Product symptom's card shows the HR cause and fix, labelled; a non-causal HR relation stays hidden", async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const card = await w.t.call<Card>(c, 'get_card', { entity_id: w.symptom.id });
    const text = card.lines.join('\n');
    expect(text).toMatch(/← causes Slow HR approvals \[ent_[^\]]+\] \(source ws_d\)/);
    expect(text).toMatch(/← addresses Instant approval flow \[ent_[^\]]+\] \(source ws_d\)/);
    expect(text).not.toContain('Hiring freeze');
    // Tree scope still shows everything.
    const tree = await w.t.call<Card>(c, 'get_card', { entity_id: w.symptom.id, scope: 'tree' });
    expect(tree.lines.join('\n')).toContain('Hiring freeze');
    // The shown causal edges are logged: their entities, the edge and the record asserting it.
    const row = w.t.rows(c.agentRunId).at(-2)!;
    const ids = row.resultIds.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([w.cause.id, w.fix.id, w.causes.id, w.addresses.id, w.hrCause.id]));
    expect(ids).not.toContain(w.topic.id);
  });

  it('expand on the cause entity from Product lists the symptom it causes, not its HR-only relations', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const ex = await w.t.call<Expanded>(c, 'expand', { id: w.cause.id });
    const text = JSON.stringify(ex.items);
    expect(text).toMatch(/causes → Checkout abandonment \[ent_[^\]]+\] \(source ws_d\)/);
    expect(text).not.toContain('Hiring freeze');
  });

  it('expand on the symptom entity lists the cause too', async () => {
    const w = world();
    const ex = await w.t.call<Expanded>(w.t.ctx('ws_c'), 'expand', { id: w.symptom.id });
    expect(JSON.stringify(ex.items)).toContain('Slow HR approvals');
  });

  it('other entity kinds keep the node boundary for causal types too', async () => {
    const w = world();
    const sc = scopeFor(w.t.store, 'ws_a');
    const topicFact = w.t.fact('ws_d', 'Freeze addresses budget', { entityId: w.topic.id });
    const budget = resolveEntity(w.t.store, sc, { kind: 'topic', name: 'Budget overrun' }, { workspaceId: 'ws_c' });
    addRelation(w.t.store, sc, { from: w.topic.id, type: 'addresses', to: budget.id, sourceKind: 'fact', sourceId: topicFact.id });
    const card = await w.t.call<Card>(w.t.ctx('ws_c'), 'get_card', { entity_id: budget.id });
    expect(card.lines.join('\n')).not.toContain('Hiring freeze');
  });
});

describe('search: "elsewhere in the business" count', () => {
  it('a node-scoped search says how many more matches exist outside node scope, per kind, counts only', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const r = await w.t.call<{ hits: Array<{ id: string }>; notes?: string[] }>(c, 'search', { query: 'approvals', kinds: ['fact', 'entity'] });
    expect(r.hits).toEqual([]);
    const note = (r.notes ?? []).find((n) => n.includes('elsewhere'));
    expect(note).toBeDefined();
    expect(note).toMatch(/fact 2\b/);
    expect(note).toMatch(/entity 1\b/);
    expect(note).toContain('scope "tree"');
    expect(note).not.toMatch(/fnd_|ent_|approval/i);
    // The retrieval row is unchanged: it lists only what was shown.
    expect(w.t.rows(c.agentRunId).at(-1)!.resultIds).toEqual([]);
    const tree = await w.t.call<{ hits: Array<{ id: string }>; notes?: string[] }>(c, 'search', { query: 'approvals', kinds: ['fact', 'entity'], scope: 'tree' });
    expect(tree.hits.length).toBe(3);
    expect((tree.notes ?? []).some((n) => n.includes('elsewhere'))).toBe(false);
  });

  it('prints nothing when there is nothing elsewhere', async () => {
    const w = world();
    const r = await w.t.call<{ notes?: string[] }>(w.t.ctx('ws_a'), 'search', { query: 'approvals' });
    expect((r.notes ?? []).some((n) => n.includes('elsewhere'))).toBe(false);
    const own = await w.t.call<{ hits: unknown[]; notes?: string[] }>(w.t.ctx('ws_c'), 'search', { query: 'Checkout', kinds: ['fact'] });
    expect(own.hits.length).toBe(1);
    expect((own.notes ?? []).some((n) => n.includes('elsewhere'))).toBe(false);
  });

  it('the line fits within the response budget', async () => {
    const w = world();
    for (let i = 0; i < 12; i++) w.t.fact('ws_c', `HR note number ${i} about payments approvals and their long waiting times in the queue`);
    const c = w.t.ctx('ws_c');
    const r = await w.t.call<{ tokens: number; hits: unknown[]; notes?: string[] }>(c, 'search', { query: 'approvals', max_tokens: 300 });
    expect(r.tokens).toBeLessThanOrEqual(300);
    expect(r.hits.length).toBeGreaterThan(0);
    // The first page carries the line when it fits beside the hits; later pages do not repeat it.
    expect((r.notes ?? []).some((n) => n.includes('elsewhere'))).toBe(true);
  });
});

describe('integration: KS-5 briefings and KS-7 cards share one causal-edge rule', () => {
  it('the company briefing lists exactly the causal edges a symptom / cause card lists tree-wide, with the same logging', async () => {
    const w = world();
    const sc = scopeFor(w.t.store, 'ws_a');
    // A causal type between two non-causal kinds across nodes: no card shows it in node scope, so no briefing may either.
    const topicFact = w.t.fact('ws_d', 'Freeze addresses budget', { entityId: w.topic.id });
    const budget = resolveEntity(w.t.store, sc, { kind: 'topic', name: 'Budget overrun' }, { workspaceId: 'ws_c' });
    const nonCausal = addRelation(w.t.store, sc, { from: w.topic.id, type: 'addresses', to: budget.id, sourceKind: 'fact', sourceId: topicFact.id });
    const edges = crossNodeCausalEdges(w.t.store, sc);
    expect(edges.map((e) => e.relation.id)).toEqual([w.causes.id, w.addresses.id]);
    expect(edges.map((e) => e.relation.id)).not.toContain(nonCausal.id);

    const env = { store: w.t.store, config: w.t.config, now: new Date() };
    const b = orchestratorBriefing(env, { workspaceId: 'ws_a', phase: 'deep_dives' });
    // KS-5 label kept: endpoints, type, source node and the asserting record.
    expect(b.section).toContain(`Slow HR approvals [${w.cause.id}] causes Checkout abandonment [${w.symptom.id}] (source ws_d: fact ${w.hrCause.id})`);
    expect(b.section).not.toMatch(/Hiring freeze \[ent_[^\]]+\] addresses Budget overrun/);
    // Logging: both ends, the edge and the record asserting it (as the card logs them).
    const ids = b.results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([w.cause.id, w.symptom.id, w.causes.id, w.hrCause.id, w.addresses.id]));
    expect(ids).not.toContain(nonCausal.id);

    // Every edge in the briefing is listed on the symptom's node-scoped card from the symptom's own node.
    const card = await w.t.call<Card>(w.t.ctx('ws_c'), 'get_card', { entity_id: w.symptom.id });
    const text = card.lines.join('\n');
    for (const e of edges) {
      const other = e.to.id === w.symptom.id ? e.from : e.to;
      expect(text).toContain(`${other.name} [${other.id}] (source ${e.sourceWorkspaceId})`);
    }
  });
});
