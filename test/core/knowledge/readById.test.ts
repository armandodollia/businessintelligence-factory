/**
 * KS-4 gate, design ruling on reads by id (§7.1): a read BY ID (`expand`, `read_artifact`, `get_card`,
 * `read_workspace` with `workspace_id`) returns the named item of any node of the tree, labelled with its
 * source node; everything listed AROUND it (card facts and relations, an entity's neighbours, a node
 * card's entity index) still follows node scope unless `scope: "tree"` is passed. The sibling rule
 * lives in one function, `allowByIdSiblingRead`.
 *
 * Fixture: ws_a "Acme" → ws_c "Acme Payments" and ws_d "Acme Labs" (here: Lending).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { allowByIdSiblingRead } from '../../../src/core/knowledge/readCommon.js';
import { addRelation } from '../../../src/core/knowledge/relations.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function world() {
  const t = ks4(opened);
  const sc = scopeFor(t.store, 'ws_a');
  const globex = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Globex' }, { workspaceId: 'ws_a' });
  const payments = t.fact('ws_c', 'Globex undercuts Payments on card fees', { entityId: globex.id });
  const lending = t.fact('ws_d', 'Globex offers loans to Lending customers', { entityId: globex.id });
  const loans = resolveEntity(t.store, sc, { kind: 'product', name: 'Globex Loans' }, { workspaceId: 'ws_d' });
  addRelation(t.store, sc, { from: globex.id, type: 'offers', to: loans.id, sourceKind: 'fact', sourceId: lending.id });
  return { t, globex, payments, lending, loans };
}

type Card = { lines: string[]; node?: { id: string }; source?: string };

describe('reads by id vs. what is listed around the item', () => {
  it('from Payments, get_card(entity) leaves Lending\'s facts out without scope "tree"; expand(<Lending fact>) works', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const card = await w.t.call<Card>(c, 'get_card', { entity_id: w.globex.id });
    const text = card.lines.join('\n');
    expect(text).toContain(w.payments.id);
    expect(text).not.toContain(w.lending.id);
    expect(text).not.toContain('Globex Loans'); // its relation is asserted by the Lending fact
    const tree = await w.t.call<Card>(c, 'get_card', { entity_id: w.globex.id, scope: 'tree' });
    expect(tree.lines.join('\n')).toContain(w.lending.id);
    expect(tree.lines.join('\n')).toContain('Globex Loans');
    const ex = await w.t.call<{ id: string; source: string; claim: string }>(c, 'expand', { id: w.lending.id });
    expect(ex).toMatchObject({ id: w.lending.id, source: 'ws_d', claim: 'Globex offers loans to Lending customers' });
  });

  it('expand of an entity lists neighbours in node scope unless scope "tree"', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const node = await w.t.call<{ items: Array<{ text: string }> }>(c, 'expand', { id: w.globex.id });
    expect(JSON.stringify(node.items)).not.toContain('Globex Loans');
    const tree = await w.t.call<{ items: Array<{ text: string }> }>(c, 'expand', { id: w.globex.id, scope: 'tree' });
    expect(JSON.stringify(tree.items)).toContain('Globex Loans');
  });

  it('the node card of the caller\'s own node indexes only entities with facts in its scope; a sibling card is the sibling\'s own, labelled', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const own = await w.t.call<Card>(c, 'get_card', { workspace_id: 'ws_c' });
    expect(own.lines.join('\n')).toMatch(/entity Globex .*1 current fact/);
    const sib = await w.t.call<Card>(c, 'read_workspace', { workspace_id: 'ws_d' });
    expect(sib.node!.id).toBe('ws_d');
    expect(sib.source).toBe('ws_d');
    expect(sib.lines.join('\n')).toMatch(/counts: facts 1 current/);
    expect(own.source).toBeUndefined();
  });

  it('an entity homed in a sibling and referenced only there is still readable by id (labelled)', async () => {
    const w = world();
    const r = await w.t.call<{ entity: { id: string; home: string } }>(w.t.ctx('ws_c'), 'get_card', { entity_id: w.loans.id });
    expect(r.entity).toMatchObject({ id: w.loans.id, home: 'ws_d' });
  });

  it('entity search applies the same node visibility (a sibling-only entity needs scope "tree")', async () => {
    const w = world();
    const c = w.t.ctx('ws_c');
    const node = await w.t.call<{ hits: Array<{ id: string }> }>(c, 'search', { query: 'loans', kinds: ['entity'] });
    expect(node.hits.map((h) => h.id)).not.toContain(w.loans.id);
    const tree = await w.t.call<{ hits: Array<{ id: string }> }>(c, 'search', { query: 'loans', kinds: ['entity'], scope: 'tree' });
    expect(tree.hits.map((h) => h.id)).toContain(w.loans.id);
  });

  it('the sibling rule is one switch: allowByIdSiblingRead (ruling: allowed in node scope too)', () => {
    const w = world();
    expect(allowByIdSiblingRead(scopeFor(w.t.store, 'ws_c'), 'node')).toBe(true);
    expect(allowByIdSiblingRead(scopeFor(w.t.store, 'ws_c'), 'tree')).toBe(true);
  });
});
