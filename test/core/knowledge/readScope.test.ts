/**
 * KS-4 read tools: design §18 "Isolation" and "Scope" — two trees with overlapping names and text;
 * a three-level tree with node / tree scope, applies_to, ancestor inheritance, sibling exclusion,
 * ordering, and out-of-tree ids indistinguishable from unknown ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { scopeFor, setItemScopes } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Hits = { hits: Array<{ kind: string; id: string; source?: string; title?: string; snippet?: string }> };

async function world() {
  const t = ks4(opened);
  const own = t.fact('ws_c', 'Widget pricing is 10 dollars at Payments');
  const child = t.fact('ws_g', 'Widget pricing is 12 dollars for Cards');
  const parent = t.fact('ws_a', 'Widget pricing is 9 dollars company wide');
  const sibling = t.fact('ws_d', 'Widget pricing is 11 dollars in Labs');
  const other = t.fact('ws_b', 'Widget pricing is 99 dollars at Beta');
  const pageA = await t.page('ws_c', 'Widget pricing page: the Pro plan costs 10 dollars.', { title: 'Widget pricing' });
  const pageB = await t.page('ws_b', 'Widget pricing page: the Pro plan costs 99 dollars.', { title: 'Widget pricing' });
  const entA = resolveEntity(t.store, scopeFor(t.store, 'ws_c'), { kind: 'competitor', name: 'Widget Corp' });
  const entB = resolveEntity(t.store, scopeFor(t.store, 'ws_b'), { kind: 'competitor', name: 'Widget Corp' });
  t.store.findings.update(own.id, { entityId: entA.id });
  t.store.findings.update(other.id, { entityId: entB.id });
  return { t, own, child, parent, sibling, other, pageA, pageB, entA, entB };
}

describe('scope (design §7.1)', () => {
  it('node scope = own node, descendants and ancestors, ordered in that order; siblings only with scope tree', async () => {
    const w = await world();
    const c = w.t.ctx('ws_c');
    const node = await w.t.call<Hits>(c, 'search', { query: 'widget pricing', kinds: ['fact'] });
    expect(node.hits.map((h) => h.id)).toEqual([w.own.id, w.child.id, w.parent.id]);
    expect(node.hits.map((h) => h.source)).toEqual([undefined, 'ws_g', 'ws_a']);
    const tree = await w.t.call<Hits>(c, 'search', { query: 'widget pricing', kinds: ['fact'], scope: 'tree' });
    expect(tree.hits.map((h) => h.id)).toEqual([w.own.id, w.child.id, w.parent.id, w.sibling.id]);
    expect(tree.hits.at(-1)!.source).toBe('ws_d');
  });

  it('workspace_id narrows to another node of the tree (its own view); another tree is "not found"', async () => {
    const w = await world();
    const c = w.t.ctx('ws_c');
    const labs = await w.t.call<Hits>(c, 'search', { query: 'widget pricing', kinds: ['fact'], workspace_id: 'ws_d' });
    expect(labs.hits.map((h) => h.id)).toEqual([w.sibling.id, w.parent.id]);
    const r = await w.t.handle(c, 'search', { query: 'widget', workspace_id: 'ws_b' });
    const u = await w.t.handle(c, 'search', { query: 'widget', workspace_id: 'ws_nope' });
    expect(r).toEqual({ ok: false, error: "workspace 'ws_b' not found" });
    expect(u).toEqual({ ok: false, error: "workspace 'ws_nope' not found" });
  });

  it('applies_to labels make an item visible where it applies, not where it was saved', async () => {
    const w = await world();
    const f = w.t.fact('ws_d', 'Widget pricing applies to Payments too');
    setItemScopes(w.t.store, 'fact', f.id, ['ws_c'], 'agent');
    const fromC = await w.t.call<Hits>(w.t.ctx('ws_c'), 'search', { query: 'applies payments', kinds: ['fact'] });
    expect(fromC.hits.map((h) => h.id)).toEqual([f.id]);
    expect(fromC.hits[0]!.source).toBe('ws_d'); // the home node is shown
    const fromD = await w.t.call<Hits>(w.t.ctx('ws_d'), 'search', { query: 'applies payments', kinds: ['fact'] });
    expect(fromD.hits).toEqual([]);
  });

  it('a grandchild inherits from its ancestors but never sees its parent\'s sibling', async () => {
    const w = await world();
    const g = await w.t.call<Hits>(w.t.ctx('ws_g'), 'search', { query: 'widget pricing', kinds: ['fact'] });
    expect(g.hits.map((h) => h.id)).toEqual([w.child.id, w.own.id, w.parent.id]);
  });
});

describe('isolation (design §12, §18)', () => {
  it('no read tool returns anything of another tree, and its ids answer exactly like unknown ids', async () => {
    const w = await world();
    const c = w.t.ctx('ws_c');
    const seen: string[] = [];
    const json = (x: unknown) => seen.push(JSON.stringify(x));
    json(await w.t.call(c, 'search', { query: 'widget pricing pro plan dollars', scope: 'tree' }));
    json(await w.t.call(c, 'search', { query: 'widget corp', kinds: ['entity'], scope: 'tree' }));
    json(await w.t.call(c, 'search', { query: 'beta', scope: 'tree' }));
    json(await w.t.call(c, 'get_card', { entity_id: w.entA.id }));
    json(await w.t.call(c, 'get_card', { workspace_id: 'ws_a' }));
    json(await w.t.call(c, 'read_workspace', { workspace_id: 'ws_a' }));
    json(await w.t.call(c, 'list_changes', { scope: 'tree', since: '2000-01-01' }));
    json(await w.t.call(c, 'expand', { id: w.pageA.id }));
    json(await w.t.call(c, 'read_artifact', { artifact_id: w.pageA.id, mode: 'text' }));
    for (const s of seen) {
      for (const leak of [w.other.id, w.pageB.id, w.entB.id, 'ws_b', '99 dollars', 'Beta']) expect(s).not.toContain(leak);
    }
    // Other-tree ids: same text as an unknown id, for every tool that takes an id.
    const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['expand', { id: w.other.id }, { id: 'fnd_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['expand', { id: w.pageB.id }, { id: 'art_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['expand', { id: w.entB.id }, { id: 'ent_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['read_artifact', { artifact_id: w.pageB.id }, { artifact_id: 'art_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['get_card', { entity_id: w.entB.id }, { entity_id: 'ent_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['search', { query: 'x', entity_id: w.entB.id }, { query: 'x', entity_id: 'ent_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['list_changes', { entity_id: w.entB.id }, { entity_id: 'ent_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
    ];
    for (const [tool, foreign, unknown] of pairs) {
      const a = await w.t.handle(c, tool as never, foreign);
      const b = await w.t.handle(c, tool as never, unknown);
      expect(a.ok, tool).toBe(false);
      expect(b.ok, tool).toBe(false);
      const id = (o: Record<string, unknown>) => String(Object.values(o).at(-1));
      expect((a as { error: string }).error.replace(id(foreign), 'ID'), tool).toBe((b as { error: string }).error.replace(id(unknown), 'ID'));
    }
    // An out-of-tree attempt is a blocked attempt on the bus; an unknown id is not.
    const blocked = w.t.seen.filter((e) => e.type === 'policy_blocked');
    expect(blocked.map((e) => (e as { itemId: string }).itemId)).toEqual([w.other.id, w.pageB.id, w.entB.id, w.pageB.id, w.entB.id, w.entB.id, w.entB.id]);
    expect(blocked.every((e) => (e as { reason: string }).reason === 'out_of_tree')).toBe(true);
  });

  it('reads by id accept any node of the tree (the id is the explicit request) and label the source', async () => {
    const w = await world();
    const e = await w.t.call<{ id: string; source?: string; items: unknown[] }>(w.t.ctx('ws_c'), 'expand', { id: w.sibling.id });
    expect(e).toMatchObject({ id: w.sibling.id, source: 'ws_d' });
    expect(e.items[0]).toEqual({ type: 'claim', text: 'Widget pricing is 11 dollars in Labs' });
  });
});
