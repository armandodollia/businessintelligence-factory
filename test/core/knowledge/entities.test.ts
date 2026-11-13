import { afterEach, describe, expect, it } from 'vitest';
import { SUBJECT_ENTITY_KINDS } from '../../../src/core/knowledge/backfill.js';
import {
  EntityConflictError,
  SUBJECT_KINDS,
  companyEntity,
  entityNameSimilarity,
  getEntity,
  listMergeSuggestions,
  mergeEntities,
  rejectMergeSuggestion,
  renameEntity,
  resolveEntity,
  resolveEntityDetailed,
  subjectEntity,
} from '../../../src/core/knowledge/entities.js';
import { addRelation } from '../../../src/core/knowledge/relations.js';
import { KnowledgeNotFoundError, scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { art, competitor, fact, hypothesis, ks3Store, persona, symptom } from './ks3fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const errorOf = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
};

describe('resolveEntity (design §7.4)', () => {
  it('same name in two trees → two entities; same tree resolves by key (case / whitespace)', () => {
    const s = ks3Store(opened);
    const a = resolveEntity(s, scopeFor(s, 'ws_c'), { kind: 'competitor', name: 'Globex' });
    const b = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'competitor', name: 'Globex' });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ rootWorkspaceId: 'ws_a', workspaceId: 'ws_c', name: 'Globex', nameKey: 'globex' });
    expect(b.rootWorkspaceId).toBe('ws_b');
    expect(resolveEntity(s, scopeFor(s, 'ws_d'), { kind: 'competitor', name: '  GLOBEX ' }).id).toBe(a.id);
    // Same name, other kind: a different entity.
    expect(resolveEntity(s, scopeFor(s, 'ws_a'), { kind: 'topic', name: 'Globex' }).id).not.toBe(a.id);
  });

  it('records the creating run and caps long names', () => {
    const s = ks3Store(opened);
    const e = resolveEntity(s, scopeFor(s, 'ws_a'), { kind: 'cause', name: `x${'y'.repeat(400)}` }, { agentRunId: 'arun_1' });
    expect(e.createdByRun).toBe('arun_1');
    expect(e.name.length).toBe(200);
    expect(() => resolveEntity(s, scopeFor(s, 'ws_a'), { kind: 'topic', name: '   ' })).toThrow(/empty/);
    expect(() => resolveEntity(s, scopeFor(s, 'ws_a'), { kind: 'planet' as never, name: 'x' })).toThrow(/unknown entity kind/);
  });

  it('matches aliases, and a merged id resolves to its survivor', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const acme = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex Corp' });
    knowledgeRepos(s).entities.update(acme.id, { aliases: ['Globex Corporation'] });
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'globex corporation' }).id).toBe(acme.id);
    const loser = resolveEntity(s, sc, { kind: 'competitor', name: 'GX' });
    mergeEntities(s, acme.id, loser.id, 'u');
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'gx' }).id).toBe(acme.id);
    expect(resolveEntity(s, sc, { id: loser.id }).id).toBe(acme.id);
  });

  it('an id of another tree is indistinguishable from an unknown id', () => {
    const s = ks3Store(opened);
    const other = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'topic', name: 'Secret topic' });
    const sc = scopeFor(s, 'ws_a');
    const foreign = errorOf(() => resolveEntity(s, sc, { id: other.id }));
    const unknown = errorOf(() => resolveEntity(s, sc, { id: 'ent_nope' }));
    expect(foreign).toBeInstanceOf(KnowledgeNotFoundError);
    expect(unknown).toBeInstanceOf(KnowledgeNotFoundError);
    expect(foreign.message).toBe(`entity '${other.id}' not found`);
    expect(unknown.message).toBe(`entity 'ent_nope' not found`);
    expect(foreign.message).not.toContain('Secret');
    expect(() => getEntity(s, sc, other.id)).toThrow(KnowledgeNotFoundError);
  });
});

describe('merge suggestions (near-matches never block)', () => {
  it('creates the entity and suggests the trigram near-match in the same tree and kind only', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const acme = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    resolveEntity(s, sc, { kind: 'topic', name: 'Globex Corp' }); // other kind
    resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'competitor', name: 'Globex Corp' }); // other tree
    resolveEntity(s, sc, { kind: 'competitor', name: 'Initech' }); // unrelated
    const r = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Globex Corp' });
    expect(r.created).toBe(true);
    expect(r.entity.id).not.toBe(acme.id);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ rootWorkspaceId: 'ws_a', entityId: r.entity.id, candidateId: acme.id, status: 'open' });
    expect(r.suggestions[0]!.score).toBeGreaterThanOrEqual(0.5);
    expect(listMergeSuggestions(s, sc).map((x) => x.id)).toEqual([r.suggestions[0]!.id]);
    // The other tree's own suggestion is not visible from tree A, and vice versa.
    expect(listMergeSuggestions(s, scopeFor(s, 'ws_b'))).toEqual([]);
  });

  it('scores with a bounded measure and does not suggest a pair twice', () => {
    expect(entityNameSimilarity('Acme', 'Acme Inc')).toBeCloseTo(0.667, 2);
    expect(entityNameSimilarity('Acme', 'Acne')).toBeLessThan(0.5);
    expect(entityNameSimilarity('Same', ' same ')).toBe(1);
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    resolveEntity(s, sc, { kind: 'competitor', name: 'Acne' }); // below the floor
    const a = resolveEntity(s, sc, { kind: 'competitor', name: 'Acme Inc' });
    const b = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Acme' });
    expect(b.suggestions.map((x) => x.candidateId)).toEqual([a.id]);
    // Rejected: the pair is never suggested again, even when a third near-match appears.
    rejectMergeSuggestion(s, sc, b.suggestions[0]!.id, 'u');
    expect(() => rejectMergeSuggestion(s, sc, b.suggestions[0]!.id, 'u')).toThrow(EntityConflictError);
    expect(() => rejectMergeSuggestion(s, scopeFor(s, 'ws_b'), b.suggestions[0]!.id, 'u')).toThrow(KnowledgeNotFoundError);
    const c = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Acme Inc.' });
    expect(c.suggestions.map((x) => x.candidateId).sort()).toEqual([a.id, b.entity.id].sort());
    expect(knowledgeRepos(s).entityMergeSuggestions.list({ entityId: b.entity.id, candidateId: a.id })).toHaveLength(1);
  });

  it('names under three characters get no suggestions; FTS syntax in names is inert', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    resolveEntity(s, sc, { kind: 'topic', name: 'AI' });
    expect(resolveEntityDetailed(s, sc, { kind: 'topic', name: 'A' }).suggestions).toEqual([]);
    resolveEntity(s, sc, { kind: 'topic', name: 'Pricing "pages" OR x*' });
    expect(() => resolveEntityDetailed(s, sc, { kind: 'topic', name: 'Pricing "page" NEAR( x' })).not.toThrow();
  });
});

describe('subject rule and company entities', () => {
  it('uses the backfill’s kind order', () => {
    expect(SUBJECT_KINDS).toEqual(SUBJECT_ENTITY_KINDS);
  });

  it('competitor / persona / company entity first, then a node’s scope name, else a topic', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_c');
    const globex = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    expect(subjectEntity(s, sc, 'globex').entity.id).toBe(globex.id);
    // A node's scope name: that node's company entity, created on first use with home = that node.
    const parent = subjectEntity(s, sc, 'ACME').entity;
    expect(parent).toMatchObject({ kind: 'company', name: 'Acme', workspaceId: 'ws_a' });
    expect(companyEntity(s, scopeFor(s, 'ws_a')).id).toBe(parent.id);
    const own = companyEntity(s, sc);
    expect(own).toMatchObject({ kind: 'company', name: 'Acme Payments', workspaceId: 'ws_c' });
    expect(subjectEntity(s, sc, 'acme payments').entity.id).toBe(own.id);
    const topic = subjectEntity(s, sc, 'Pricing pages');
    expect(topic.entity).toMatchObject({ kind: 'topic', name: 'Pricing pages' });
    expect(topic.created).toBe(true);
    // Another tree's scope name is not a company of this tree.
    expect(subjectEntity(s, sc, 'Beta').entity.kind).toBe('topic');
    expect(() => companyEntity(s, sc, 'ws_b')).toThrow(KnowledgeNotFoundError);
  });
});

describe('mergeEntities', () => {
  it('re-points facts, typed records, captures and relations, keeps the alias, accepts the suggestion', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const survivor = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    const loserRes = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Globex Corp' });
    const loser = loserRes.entity;
    const other = resolveEntity(s, sc, { kind: 'product', name: 'Widget' });
    const company = companyEntity(s, sc);
    fact(s, 'fnd_1', 'ws_a', { entityId: loser.id });
    fact(s, 'fnd_2', 'ws_c', { entityId: survivor.id });
    competitor(s, 'cmp_1', 'ws_c', 'Globex Corp', { entityId: loser.id });
    persona(s, 'per_1', 'ws_a', 'x');
    s.personas.update('per_1', { entityId: loser.id });
    symptom(s, 'sym_1', 'ws_a', 'Churn');
    s.symptoms.update('sym_1', { entityId: loser.id });
    hypothesis(s, 'hyp_1', 'ws_a', 'sym_1', 'Because');
    s.symptomHypotheses.update('hyp_1', { entityId: loser.id });
    art(s, 'art_1', 'ws_a');
    knowledgeRepos(s).artifactCaptures.insert({ id: 'cap_x', artifactId: 'art_1', workspaceId: 'ws_a', entityId: loser.id, capturedAt: 'now' });
    addRelation(s, sc, { from: loser.id, type: 'offers', to: other.id, sourceKind: 'fact', sourceId: 'fnd_1' });
    addRelation(s, sc, { from: survivor.id, type: 'offers', to: other.id, sourceKind: 'fact', sourceId: 'fnd_1' }); // duplicate after merge
    addRelation(s, sc, { from: loser.id, type: 'competes_with', to: company.id, sourceKind: 'competitor', sourceId: 'cmp_1' });
    addRelation(s, sc, { from: loser.id, type: 'part_of', to: survivor.id, sourceKind: 'fact', sourceId: 'fnd_1' }); // self-loop after merge

    const r = mergeEntities(s, survivor.id, loser.id, 'alice');
    expect(r.repointed).toMatchObject({ findings: 1, competitors: 1, personas: 1, symptoms: 1, symptom_hypotheses: 1, artifact_captures: 1 });
    expect(s.findings.get('fnd_1')!.entityId).toBe(survivor.id);
    expect(s.competitors.get('cmp_1')!.entityId).toBe(survivor.id);
    expect(s.personas.get('per_1')!.entityId).toBe(survivor.id);
    expect(s.symptoms.get('sym_1')!.entityId).toBe(survivor.id);
    expect(s.symptomHypotheses.get('hyp_1')!.entityId).toBe(survivor.id);
    expect(knowledgeRepos(s).artifactCaptures.get('cap_x')!.entityId).toBe(survivor.id);
    const rels = knowledgeRepos(s).relations.list({ rootWorkspaceId: 'ws_a' });
    expect(rels.map((x) => [x.fromEntityId, x.type, x.toEntityId]).sort()).toEqual(
      [[survivor.id, 'competes_with', company.id], [survivor.id, 'offers', other.id]].sort(),
    );
    expect(r.survivor.aliases).toEqual(['Globex Corp']);
    expect(r.loser.mergedIntoId).toBe(survivor.id);
    expect(r.aliasUploadOnly).toBe(false);
    expect(knowledgeRepos(s).entityMergeSuggestions.get(loserRes.suggestions[0]!.id)).toMatchObject({ status: 'accepted', actor: 'alice' });
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'globex corp' }).id).toBe(survivor.id);
  });

  it('re-points the loser’s other open suggestions and closes those that collapse', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const a = resolveEntity(s, sc, { kind: 'topic', name: 'Pricing page' });
    const b = resolveEntityDetailed(s, sc, { kind: 'topic', name: 'Pricing pages' }); // b ~ a
    const c = resolveEntityDetailed(s, sc, { kind: 'topic', name: 'Pricing pagez' }); // c ~ a, c ~ b
    const pairs = () =>
      knowledgeRepos(s).entityMergeSuggestions.list({ rootWorkspaceId: 'ws_a' }).map((x) => [x.entityId, x.candidateId, x.status]);
    expect(pairs()).toHaveLength(3);
    mergeEntities(s, a.id, b.entity.id, 'u');
    const after = pairs();
    expect(after).toContainEqual([b.entity.id, a.id, 'accepted']);
    // c~b becomes c~a, which already exists: closed.
    expect(after.filter((p) => p[2] === 'open')).toEqual([[c.entity.id, a.id, 'open']]);
  });

  it('refuses other trees (as not found), self-merges and already merged entities', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const a = resolveEntity(s, sc, { kind: 'topic', name: 'One' });
    const b = resolveEntity(s, sc, { kind: 'topic', name: 'Two' });
    const x = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'topic', name: 'Three' });
    expect(errorOf(() => mergeEntities(s, a.id, x.id, 'u')).message).toBe(`entity '${x.id}' not found`);
    expect(errorOf(() => mergeEntities(s, x.id, a.id, 'u', { scope: sc })).message).toBe(`entity '${x.id}' not found`);
    expect(() => mergeEntities(s, a.id, a.id, 'u')).toThrow(EntityConflictError);
    mergeEntities(s, a.id, b.id, 'u');
    expect(() => mergeEntities(s, a.id, b.id, 'u')).toThrow(/already merged/);
    expect(() => mergeEntities(s, b.id, a.id, 'u')).toThrow(/already merged/);
    expect(knowledgeRepos(s).entities.get(x.id)!.mergedIntoId).toBeUndefined();
  });

  it('allows a cross-kind merge (topic into competitor)', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const c = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    const t = resolveEntity(s, sc, { kind: 'topic', name: 'Globex' });
    fact(s, 'fnd_1', 'ws_a', { entityId: t.id });
    const r = mergeEntities(s, c.id, t.id, 'u');
    expect(r.survivor.aliases).toEqual([]); // same key: nothing to add
    expect(resolveEntity(s, sc, { kind: 'topic', name: 'globex' }).id).toBe(c.id);
    expect(s.findings.get('fnd_1')!.entityId).toBe(c.id);
  });
});

describe('renameEntity', () => {
  it('keeps the previous name as an alias; refuses a name another entity holds', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const e = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    resolveEntity(s, sc, { kind: 'competitor', name: 'Initech' });
    const r = renameEntity(s, e.id, 'Globex Inc');
    expect(r.entity).toMatchObject({ name: 'Globex Inc', nameKey: 'globex inc', aliases: ['Globex'] });
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'globex' }).id).toBe(e.id);
    expect(() => renameEntity(s, e.id, 'initech')).toThrow(EntityConflictError);
    expect(renameEntity(s, e.id, 'GLOBEX inc').entity.name).toBe('GLOBEX inc'); // display-only change
    // Back to the alias: the alias becomes the name again.
    expect(renameEntity(s, e.id, 'Globex').entity).toMatchObject({ name: 'Globex', aliases: ['GLOBEX inc'] });
    const other = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'topic', name: 'Other' });
    expect(errorOf(() => renameEntity(s, other.id, 'x', { scope: sc })).message).toBe(`entity '${other.id}' not found`);
  });

  it('renaming to a merged row’s name swaps with that row', () => {
    const s = ks3Store(opened);
    const sc = scopeFor(s, 'ws_a');
    const a = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    const b = resolveEntity(s, sc, { kind: 'competitor', name: 'GX' });
    mergeEntities(s, a.id, b.id, 'u');
    const r = renameEntity(s, a.id, 'gx');
    expect(r.entity).toMatchObject({ name: 'gx', nameKey: 'gx' });
    expect(r.entity.aliases).toEqual(['Globex']);
    expect(knowledgeRepos(s).entities.get(b.id)).toMatchObject({ name: 'Globex', nameKey: 'globex', mergedIntoId: a.id });
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' }).id).toBe(a.id);
  });
});
