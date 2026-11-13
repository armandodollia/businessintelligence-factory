import { afterEach, describe, expect, it } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { FeedbackActionError, mergeEntitiesAsUser, renameEntityAsUser } from '../../../src/core/feedback/actions.js';
import { companyEntity, entityNames, listMergeSuggestions, mergeEntities, renameEntity, resolveEntity, resolveEntityDetailed } from '../../../src/core/knowledge/entities.js';
import { entityIsUploadOnly, entityReferences, itemIsUploadDerived, mergeSuggestionIsUploadOnly } from '../../../src/core/knowledge/provenance.js';
import { addRelation } from '../../../src/core/knowledge/relations.js';
import { recordRetrieval, runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { art, competitor, fact, hypothesis, ks3Store, persona, symptom } from './ks3fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** Tree A with an upload (art_up) and a public page (art_pub). */
function setup() {
  const s = ks3Store(opened);
  art(s, 'art_up', 'ws_a', 'upload');
  art(s, 'art_pub', 'ws_a');
  return { s, sc: scopeFor(s, 'ws_a') };
}

describe('entityIsUploadOnly (ruling 5: resolved at check time, no stored flag)', () => {
  it('upload-only while every referencing record is upload-derived; one usable public record attests it', () => {
    const { s, sc } = setup();
    const e = resolveEntity(s, sc, { kind: 'competitor', name: 'Hidden Co' });
    expect(entityIsUploadOnly(s, e.id)).toBe(false); // no references: the name did not come from an upload
    fact(s, 'fnd_up', 'ws_a', { entityId: e.id, evidence: ['art_up'] });
    expect(entityIsUploadOnly(s, e.id)).toBe(true);
    // A public but not (yet) usable reference does not attest it.
    fact(s, 'fnd_pub', 'ws_a', { entityId: e.id, evidence: ['art_pub'], status: 'pending' });
    expect(entityIsUploadOnly(s, e.id)).toBe(true);
    s.findings.update('fnd_pub', { status: 'verified' });
    expect(entityIsUploadOnly(s, e.id)).toBe(false);
    // Usability is re-checked each time: the public fact replaced → upload-only again.
    s.findings.update('fnd_pub', { lifecycle: 'replaced' });
    expect(entityIsUploadOnly(s, e.id)).toBe(true);
    expect(entityReferences(s, e.id).map((r) => [r.kind, r.id, r.derived, r.usable])).toEqual([
      ['fact', 'fnd_up', true, true],
      ['fact', 'fnd_pub', false, false],
    ]);
  });

  it('covers typed records, captures and edge sources', () => {
    const { s, sc } = setup();
    const kinds = ['competitor', 'persona', 'symptom', 'cause', 'product', 'flow'] as const;
    const [c, p, sy, h, cap, rel] = kinds.map((k) => resolveEntity(s, sc, { kind: k, name: `Name ${k}` }));
    competitor(s, 'cmp_1', 'ws_a', 'x', { evidence: ['art_up'], entityId: c!.id });
    persona(s, 'per_1', 'ws_a', 'x', { evidence: ['art_up'] });
    s.personas.update('per_1', { entityId: p!.id });
    symptom(s, 'sym_1', 'ws_a', 'x', { evidence: ['art_up'] });
    s.symptoms.update('sym_1', { entityId: sy!.id });
    fact(s, 'fnd_up', 'ws_a', { evidence: ['art_up'] });
    hypothesis(s, 'hyp_1', 'ws_a', 'sym_1', 'x', { evidence: ['fnd_up'] });
    s.symptomHypotheses.update('hyp_1', { entityId: h!.id });
    knowledgeRepos(s).artifactCaptures.insert({ id: 'cap_1', artifactId: 'art_up', workspaceId: 'ws_a', entityId: cap!.id, capturedAt: 'now' });
    // `rel` is named only by an edge whose source is the upload-derived fact.
    addRelation(s, sc, { from: c!.id, type: 'offers', to: rel!.id, sourceKind: 'fact', sourceId: 'fnd_up' });
    for (const e of [c, p, sy, h, cap, rel]) expect(entityIsUploadOnly(s, e!.id), e!.kind).toBe(true);
    // A public capture of the same entity attests it (captures are not reviewed).
    knowledgeRepos(s).artifactCaptures.insert({ id: 'cap_2', artifactId: 'art_pub', workspaceId: 'ws_a', entityId: cap!.id, capturedAt: 'now' });
    expect(entityIsUploadOnly(s, cap!.id)).toBe(false);
  });

  it('follows late classification: an artifact listed as an upload later flags the entity name', () => {
    const { s, sc } = setup();
    const e = resolveEntity(s, sc, { kind: 'competitor', name: 'Late Co' });
    competitor(s, 'cmp_l', 'ws_a', 'Late Co', { evidence: ['art_pub'], entityId: e.id });
    expect(entityIsUploadOnly(s, e.id)).toBe(false);
    s.profiles.insert({ workspaceId: 'ws_a', data: { uploads: ['art_pub'] } });
    expect(entityIsUploadOnly(s, e.id)).toBe(true);
  });

  it('never flags a node’s company entity (scope names are user-entered)', () => {
    const { s, sc } = setup();
    const acme = companyEntity(s, sc);
    fact(s, 'fnd_up', 'ws_a', { entityId: acme.id, evidence: ['art_up'] });
    expect(entityIsUploadOnly(s, acme.id)).toBe(false);
    const other = resolveEntity(s, sc, { kind: 'company', name: 'Partner Ltd' });
    fact(s, 'fnd_up2', 'ws_a', { entityId: other.id, evidence: ['art_up'] });
    expect(entityIsUploadOnly(s, other.id)).toBe(true);
  });

  it('routes entity and suggestion ids through itemIsUploadDerived and runIsUploadExposed', () => {
    const { s, sc } = setup();
    const hidden = resolveEntity(s, sc, { kind: 'competitor', name: 'Hidden Co' });
    fact(s, 'fnd_up', 'ws_a', { entityId: hidden.id, evidence: ['art_up'] });
    const pub = resolveEntity(s, sc, { kind: 'competitor', name: 'Zenith Labs' });
    fact(s, 'fnd_pub', 'ws_a', { entityId: pub.id, evidence: ['art_pub'] });
    expect(itemIsUploadDerived(s, hidden.id)).toBe(true);
    expect(itemIsUploadDerived(s, pub.id)).toBe(false);
    const ctx = { workspaceId: 'ws_a', role: 'worker' as const };
    const entry = (id: string) => ({ tool: 'get_card' as const, query: id, scope: 'node', results: [{ id, kind: 'entity' }], tokensReturned: 5, latencyMs: 1, uploadDerived: false });
    recordRetrieval({ store: s }, { ...ctx, agentRunId: 'arun_pub' }, entry(pub.id));
    recordRetrieval({ store: s }, { ...ctx, agentRunId: 'arun_hidden' }, entry(hidden.id));
    expect(runIsUploadExposed(s, 'arun_pub')).toBe(false);
    expect(runIsUploadExposed(s, 'arun_hidden')).toBe(true);
    // Merge suggestions follow the same rule.
    const near = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Hidden Corp' });
    const pubNear = resolveEntityDetailed(s, sc, { kind: 'competitor', name: 'Zenith Lab' });
    fact(s, 'fnd_pub2', 'ws_a', { entityId: near.entity.id, evidence: ['art_pub'] });
    fact(s, 'fnd_pub3', 'ws_a', { entityId: pubNear.entity.id, evidence: ['art_pub'] });
    const [hiddenPair] = near.suggestions;
    const [publicPair] = pubNear.suggestions;
    expect(hiddenPair!.candidateId).toBe(hidden.id);
    expect(mergeSuggestionIsUploadOnly(s, hiddenPair!.id)).toBe(true);
    expect(itemIsUploadDerived(s, hiddenPair!.id)).toBe(true);
    expect(mergeSuggestionIsUploadOnly(s, publicPair!.id)).toBe(false);
    expect(Object.fromEntries(listMergeSuggestions(s, sc).map((x) => [x.id, x.uploadOnly]))).toEqual({
      [hiddenPair!.id]: true, [publicPair!.id]: false,
    });
    expect(itemIsUploadDerived(s, 'ent_unknown')).toBe(false);
  });
});

describe('upload-only names on merge and rename', () => {
  it('an alias taken from an upload-only entity keeps that status', () => {
    const { s, sc } = setup();
    const pub = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    fact(s, 'fnd_pub', 'ws_a', { entityId: pub.id, evidence: ['art_pub'] });
    const hidden = resolveEntity(s, sc, { kind: 'competitor', name: 'Project Falcon' });
    fact(s, 'fnd_up', 'ws_a', { entityId: hidden.id, evidence: ['art_up'] });
    const r = mergeEntities(s, pub.id, hidden.id, 'u');
    expect(r.aliasUploadOnly).toBe(true);
    expect(r.swappedNames).toBe(false);
    expect(r.uploadRefs).toEqual(['fnd_up']);
    // Not in the public aliases (nor in the survivor's FTS row); still resolvable; flagged as an alias.
    expect(r.survivor.aliases).toEqual([]);
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'project falcon' }).id).toBe(pub.id);
    expect(entityIsUploadOnly(s, hidden.id)).toBe(true);
    expect(entityIsUploadOnly(s, pub.id)).toBe(false); // the survivor's own name stays public
    expect(entityNames(s, sc, pub.id)).toMatchObject({
      uploadOnly: false,
      aliases: [{ name: 'Project Falcon', uploadOnly: true, entityId: hidden.id }],
    });
    // Status is kept even after the upload-derived fact becomes unusable or a public record names the survivor.
    fact(s, 'fnd_pub2', 'ws_a', { entityId: pub.id, evidence: ['art_pub'] });
    expect(entityIsUploadOnly(s, hidden.id)).toBe(true);
    // The survivor merged further: the alias row keeps its status (its own merge target decides).
    const top = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex Group' });
    fact(s, 'fnd_top', 'ws_a', { entityId: top.id, evidence: ['art_pub'] });
    const r2 = mergeEntities(s, top.id, pub.id, 'u');
    expect(r2.survivor.aliases).toEqual(['Globex']);
    expect(entityIsUploadOnly(s, hidden.id)).toBe(true);
    expect(entityIsUploadOnly(s, pub.id)).toBe(false);
    expect(entityNames(s, sc, top.id).aliases).toEqual([
      { name: 'Globex', uploadOnly: false },
      { name: 'Project Falcon', uploadOnly: true, entityId: hidden.id },
    ]);
  });

  it('a public alias stays public; a public entity merged into an upload-only one swaps names', () => {
    const { s, sc } = setup();
    const hidden = resolveEntity(s, sc, { kind: 'competitor', name: 'Project Falcon' });
    fact(s, 'fnd_up', 'ws_a', { entityId: hidden.id, evidence: ['art_up'] });
    const pub = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    fact(s, 'fnd_pub', 'ws_a', { entityId: pub.id, evidence: ['art_pub'] });
    const r = mergeEntities(s, hidden.id, pub.id, 'u');
    expect(r.swappedNames).toBe(true);
    expect(r.aliasUploadOnly).toBe(false);
    // The survivor keeps its id but shows the public name; the upload-only name is the alias.
    expect(r.survivor).toMatchObject({ id: hidden.id, name: 'Globex', nameKey: 'globex', aliases: [] });
    expect(r.loser).toMatchObject({ id: pub.id, name: 'Project Falcon', mergedIntoId: hidden.id });
    expect(entityIsUploadOnly(s, hidden.id)).toBe(false);
    expect(entityIsUploadOnly(s, pub.id)).toBe(true);
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'project falcon' }).id).toBe(hidden.id);
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'globex' }).id).toBe(hidden.id);

    // Both public: the loser's name joins the public aliases.
    const a = resolveEntity(s, sc, { kind: 'topic', name: 'Pricing' });
    const b = resolveEntity(s, sc, { kind: 'topic', name: 'Plans' });
    fact(s, 'fnd_a', 'ws_a', { entityId: a.id, evidence: ['art_pub'] });
    fact(s, 'fnd_b', 'ws_a', { entityId: b.id, evidence: ['art_pub'] });
    const r3 = mergeEntities(s, a.id, b.id, 'u');
    expect(r3.survivor.aliases).toEqual(['Plans']);
    expect(entityIsUploadOnly(s, b.id)).toBe(false);
  });

  it('rename keeps an upload-only previous name out of the public aliases', () => {
    const { s, sc } = setup();
    const hidden = resolveEntity(s, sc, { kind: 'competitor', name: 'Project Falcon' });
    fact(s, 'fnd_up', 'ws_a', { entityId: hidden.id, evidence: ['art_up'] });
    const r = renameEntity(s, hidden.id, 'Competitor X');
    expect(r.aliasUploadOnly).toBe(true);
    expect(r.entity).toMatchObject({ name: 'Competitor X', aliases: [] });
    expect(resolveEntity(s, sc, { kind: 'competitor', name: 'Project Falcon' }).id).toBe(hidden.id);
    expect(entityNames(s, sc, hidden.id).aliases).toEqual([
      { name: 'Project Falcon', uploadOnly: true, entityId: expect.stringMatching(/^ent_/) },
    ]);
    // Still upload-only as a whole (every reference is upload-derived).
    expect(entityIsUploadOnly(s, hidden.id)).toBe(true);
  });
});

describe('human entity actions (feedback events, ruling 3)', () => {
  it('merge and rename record entity_merge / entity_rename with the actor, in the same transaction', () => {
    const { s, sc } = setup();
    const a = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' }, { workspaceId: 'ws_c' });
    const b = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex Corp' });
    fact(s, 'fnd_a', 'ws_c', { entityId: a.id, evidence: ['art_pub'] });
    const r = mergeEntitiesAsUser(s, a.id, b.id, { actor: 'alice', reason: 'same company', workspaceId: 'ws_a' });
    expect(r.survivor.aliases).toEqual(['Globex Corp']);
    const merges = listFeedback(s, { kind: 'entity_merge' });
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      workspaceId: 'ws_c', actor: 'alice', targetType: 'entity', targetId: a.id, reason: 'same company',
      beforeJson: { survivor: { id: a.id, name: 'Globex' }, loser: { id: b.id, name: 'Globex Corp' } },
      afterJson: { survivor: { name: 'Globex', aliases: ['Globex Corp'] }, mergedIntoId: a.id, aliasUploadOnly: false },
    });
    renameEntityAsUser(s, a.id, 'Globex Inc', { actor: 'alice' });
    expect(listFeedback(s, { kind: 'entity_rename' })[0]).toMatchObject({
      actor: 'alice', targetType: 'entity', targetId: a.id, beforeJson: { name: 'Globex' }, afterJson: { name: 'Globex Inc' },
    });
  });

  it('maps not found (other trees included) to 404 and conflicts to 409, recording nothing', () => {
    const { s, sc } = setup();
    const a = resolveEntity(s, sc, { kind: 'topic', name: 'One' });
    const x = resolveEntity(s, scopeFor(s, 'ws_b'), { kind: 'topic', name: 'Other tree' });
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as FeedbackActionError;
      }
      throw new Error('no throw');
    };
    const foreign = err(() => mergeEntitiesAsUser(s, a.id, x.id, { workspaceId: 'ws_a' }));
    const unknown = err(() => mergeEntitiesAsUser(s, a.id, 'ent_nope', { workspaceId: 'ws_a' }));
    expect(foreign).toBeInstanceOf(FeedbackActionError);
    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    expect(foreign.message).toBe(`entity '${x.id}' not found`);
    expect(err(() => renameEntityAsUser(s, x.id, 'y', { workspaceId: 'ws_a' })).status).toBe(404);
    expect(err(() => mergeEntitiesAsUser(s, a.id, a.id, {})).status).toBe(409);
    expect(err(() => renameEntityAsUser(s, a.id, '  ', {})).status).toBe(400);
    expect(listFeedback(s, {})).toEqual([]);
  });

  it('the export leaves out a merge event that names an upload-only entity', () => {
    const { s, sc } = setup();
    const pub = resolveEntity(s, sc, { kind: 'competitor', name: 'Globex' });
    fact(s, 'fnd_pub', 'ws_a', { entityId: pub.id, evidence: ['art_pub'] });
    const hidden = resolveEntity(s, sc, { kind: 'competitor', name: 'Project Falcon' });
    // Export ids are matched by format (ULIDs), so this record gets a real id.
    fact(s, newId('fnd'), 'ws_a', { entityId: hidden.id, evidence: ['art_up'] });
    const other = resolveEntity(s, sc, { kind: 'topic', name: 'Plans' });
    const other2 = resolveEntity(s, sc, { kind: 'topic', name: 'Pricing' });
    mergeEntitiesAsUser(s, pub.id, hidden.id, { actor: 'alice' });
    mergeEntitiesAsUser(s, other2.id, other.id, { actor: 'alice' });
    const events = (includeUploads: boolean) =>
      exportTrainingData('ws_a', { store: s }, includeUploads)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type?: string; feedbackEvent?: { kind: string; targetId: string } })
        .filter((l) => l.type === 'feedback_event')
        .map((l) => l.feedbackEvent!.targetId);
    expect(events(false)).toEqual([other2.id]);
    expect(events(true)).toEqual([pub.id, other2.id]);
  });
});
