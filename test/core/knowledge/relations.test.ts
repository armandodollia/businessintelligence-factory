import { afterEach, describe, expect, it } from 'vitest';
import { companyEntity, resolveEntity } from '../../../src/core/knowledge/entities.js';
import { RELATION_TYPES, addRelation, neighbours } from '../../../src/core/knowledge/relations.js';
import { KnowledgeNotFoundError, scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { art, competitor, fact, ks3Store, symptom } from './ks3fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** Tree A with a small graph: Globex —offers→ Widget (fnd_w), Widget —has_flow→ Signup (art_f), Globex —competes_with→ Acme (cmp_g). */
function graph() {
  const s = ks3Store(opened);
  const sc = scopeFor(s, 'ws_a');
  const globex = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
  const widget = resolveEntity(s, sc, { kind: 'product', name: 'Widget' });
  const signup = resolveEntity(s, sc, { kind: 'flow', name: 'Signup' });
  const acme = companyEntity(s, sc);
  fact(s, 'fnd_w', 'ws_a', { entityId: globex.id });
  art(s, 'art_f', 'ws_a');
  competitor(s, 'cmp_g', 'ws_a', 'Globex', { entityId: globex.id });
  addRelation(s, sc, { from: globex.id, type: 'offers', to: widget.id, sourceKind: 'fact', sourceId: 'fnd_w' });
  addRelation(s, sc, { from: widget.id, type: 'has_flow', to: signup.id, sourceKind: 'artifact', sourceId: 'art_f' });
  addRelation(s, sc, { from: globex.id, type: 'competes_with', to: acme.id, sourceKind: 'competitor', sourceId: 'cmp_g' });
  return { s, sc, globex, widget, signup, acme };
}

const triples = (edges: Array<{ fromEntityId: string; type: string; toEntityId: string; depth: number }>) =>
  edges.map((e) => [e.fromEntityId, e.type, e.toEntityId, e.depth]);

describe('addRelation', () => {
  it('lists every relation type and is idempotent', () => {
    expect([...RELATION_TYPES].sort()).toEqual(
      ['addresses', 'causes', 'competes_with', 'experiences', 'has_flow', 'offers', 'part_of', 'targets'],
    );
    const { s, sc, globex, widget } = graph();
    const again = addRelation(s, sc, { from: globex.id, type: 'offers', to: widget.id, sourceKind: 'fact', sourceId: 'fnd_w' });
    expect(knowledgeRepos(s).relations.list({ fromEntityId: globex.id, type: 'offers' })).toEqual([again]);
    // Another source asserting the same edge is a second row (each edge names its record).
    fact(s, 'fnd_w2', 'ws_a');
    addRelation(s, sc, { from: globex.id, type: 'offers', to: widget.id, sourceKind: 'fact', sourceId: 'fnd_w2' });
    expect(knowledgeRepos(s).relations.list({ fromEntityId: globex.id, type: 'offers' })).toHaveLength(2);
  });

  it('rejects other trees’ entities and records as not found, self-loops and unknown types', () => {
    const { s, sc, globex, widget } = graph();
    const foreign = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'product', name: 'Widget' });
    fact(s, 'fnd_b', 'ws_b');
    expect(() => addRelation(s, sc, { from: globex.id, type: 'offers', to: foreign.id, sourceKind: 'fact', sourceId: 'fnd_w' })).toThrow(
      new KnowledgeNotFoundError('entity', foreign.id),
    );
    expect(() => addRelation(s, sc, { from: globex.id, type: 'offers', to: widget.id, sourceKind: 'fact', sourceId: 'fnd_b' })).toThrow(
      new KnowledgeNotFoundError('fact', 'fnd_b'),
    );
    expect(() => addRelation(s, sc, { from: globex.id, type: 'offers', to: widget.id, sourceKind: 'fact', sourceId: 'fnd_zz' })).toThrow(
      new KnowledgeNotFoundError('fact', 'fnd_zz'),
    );
    expect(() => addRelation(s, sc, { from: globex.id, type: 'offers', to: globex.id, sourceKind: 'fact', sourceId: 'fnd_w' })).toThrow(/two different/);
    expect(() => addRelation(s, sc, { from: globex.id, type: 'likes' as never, to: widget.id, sourceKind: 'fact', sourceId: 'fnd_w' })).toThrow(
      /unknown relation type/,
    );
  });
});

describe('neighbours', () => {
  it('1 hop and 2 hops, either direction, ordered by depth then type', () => {
    const { s, sc, globex, widget, signup, acme } = graph();
    expect(triples(neighbours(s, sc, globex.id, { depth: 1, usableOnly: true }))).toEqual([
      [globex.id, 'competes_with', acme.id, 1],
      [globex.id, 'offers', widget.id, 1],
    ]);
    expect(triples(neighbours(s, sc, globex.id, { depth: 2, usableOnly: true }))).toEqual([
      [globex.id, 'competes_with', acme.id, 1],
      [globex.id, 'offers', widget.id, 1],
      [widget.id, 'has_flow', signup.id, 2],
    ]);
    expect(triples(neighbours(s, sc, signup.id, { depth: 2, usableOnly: true }))).toEqual([
      [widget.id, 'has_flow', signup.id, 1],
      [globex.id, 'offers', widget.id, 2],
    ]);
    expect(triples(neighbours(s, sc, globex.id, { depth: 2, usableOnly: true, types: ['offers'] }))).toEqual([
      [globex.id, 'offers', widget.id, 1],
    ]);
  });

  it('an edge is live only while its source record is usable (join, no stored flag)', () => {
    const { s, sc, globex, widget, signup } = graph();
    // The fact is replaced by a later version: the edge disappears, and so does the hop through it.
    s.findings.update('fnd_w', { lifecycle: 'replaced' });
    expect(triples(neighbours(s, sc, globex.id, { depth: 2, usableOnly: true })).map((t) => t[1])).toEqual(['competes_with']);
    const all = neighbours(s, sc, globex.id, { depth: 1, usableOnly: false });
    expect(all.find((e) => e.type === 'offers')).toMatchObject({ usable: false, toEntityId: widget.id });
    // Back to current but unverified: still not usable; the user's include override makes it usable.
    s.findings.update('fnd_w', { lifecycle: 'current', status: 'unverified' });
    expect(neighbours(s, sc, globex.id, { depth: 1, usableOnly: true }).map((e) => e.type)).toEqual(['competes_with']);
    s.findings.update('fnd_w', { includeInSynthesis: true });
    expect(neighbours(s, sc, signup.id, { depth: 2, usableOnly: true }).map((e) => e.type)).toEqual(['has_flow', 'offers']);
    // A superseded competitor's edge is gone even with an override.
    s.competitors.update('cmp_g', { status: 'superseded', includeOverride: true });
    expect(neighbours(s, sc, globex.id, { depth: 1, usableOnly: true }).map((e) => e.type)).toEqual(['offers']);
  });

  it('node scope sees only edges whose source is visible from the node; tree scope sees all', () => {
    const { s, globex } = graph();
    const scD = scopeFor(s, 'ws_d');
    const scC = scopeFor(s, 'ws_c');
    const sym = resolveEntity(s, scC, { kind: 'pain_point', name: 'Slow payouts' });
    fact(s, 'fnd_c', 'ws_c');
    addRelation(s, scC, { from: globex.id, type: 'targets', to: sym.id, sourceKind: 'fact', sourceId: 'fnd_c' });
    symptom(s, 'sym_x', 'ws_c', 'Slow payouts');
    // From sibling ws_d: ws_c's fact is not visible by default (design §7.1, option A).
    expect(neighbours(s, scD, globex.id, { depth: 1, usableOnly: true }).map((e) => e.type)).toEqual(['competes_with', 'offers']);
    expect(neighbours(s, scD, globex.id, { depth: 1, usableOnly: true, mode: 'tree' }).map((e) => e.type)).toEqual([
      'competes_with', 'offers', 'targets',
    ]);
    expect(neighbours(s, scC, globex.id, { depth: 1, usableOnly: true }).map((e) => e.type)).toEqual(['competes_with', 'offers', 'targets']);
  });

  it('rejects an entity of another tree as not found', () => {
    const { s, sc } = graph();
    const x = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'topic', name: 'X' });
    expect(() => neighbours(s, sc, x.id, { depth: 1, usableOnly: false })).toThrow(new KnowledgeNotFoundError('entity', x.id));
    expect(() => neighbours(s, sc, 'ent_unknown', { depth: 1, usableOnly: false })).toThrow(new KnowledgeNotFoundError('entity', 'ent_unknown'));
  });
});
