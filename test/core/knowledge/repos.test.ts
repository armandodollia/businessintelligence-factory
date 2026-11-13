import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import type {
  ArtifactCapture, ArtifactText, Entity, EntityMergeSuggestion, FactObservation, Relation, RetrievalEvent, TextChunk,
} from '../../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

function store(): Store {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'bif-ksrepo-')), 'bif.db'));
  opened.push(s);
  return s;
}

describe('knowledge repositories (KS-0)', () => {
  it('are memoized per connection', () => {
    const s = store();
    expect(knowledgeRepos(s)).toBe(knowledgeRepos(s));
  });

  it('roundtrip every keyed table', () => {
    const s = store();
    const k = knowledgeRepos(s);
    const capture: ArtifactCapture = {
      id: 'cap_1', artifactId: 'art_1', workspaceId: 'ws_a', agentRunId: 'arun_1', taskId: 'tsk_1', runId: 'rrun_1',
      sourceUrl: 'https://x.test/a', urlKey: 'https://x.test/a', title: 'A', flow: 'signup', step: 1, note: 'n',
      description: 'Signup form with email field', entityId: 'ent_1', capturedAt: T0,
    };
    const text: ArtifactText = {
      artifactId: 'art_1', workspaceId: 'ws_a', status: 'ok', extractor: 'html@1', charCount: 10, tokenEstimate: 3,
      contentSha256: 'ab', extractedAt: T0,
    };
    const chunk: TextChunk = {
      id: 'chk_1', artifactId: 'art_1', workspaceId: 'ws_a', seq: 0, headingPath: 'H', locator: 'page 1', text: 't',
      charStart: 0, charEnd: 1, tokenEstimate: 1, uploadDerived: false,
    };
    const obs: FactObservation = {
      id: 'fob_1', workspaceId: 'ws_a', lineageId: 'fnd_1', findingId: 'fnd_1', kind: 'confirm', taskId: 'tsk_1',
      evidence: ['art_1'], status: 'pending', createdAt: T0,
    };
    const entity: Entity = {
      id: 'ent_1', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'competitor', name: 'Globex', nameKey: 'globex',
      aliases: ['Globex Inc'], createdAt: T0, updatedAt: T0,
    };
    const relation: Relation = {
      id: 'rel_1', rootWorkspaceId: 'ws_a', fromEntityId: 'ent_1', type: 'competes_with', toEntityId: 'ent_2',
      sourceKind: 'competitor', sourceId: 'cmp_1', createdAt: T0,
    };
    const sugg: EntityMergeSuggestion = {
      id: 'ems_1', rootWorkspaceId: 'ws_a', entityId: 'ent_1', candidateId: 'ent_2', score: 0.8, status: 'open', createdAt: T0,
    };
    const ret: RetrievalEvent = {
      id: 'ret_1', workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', agentRunId: 'arun_1', role: 'worker', provider: 'claude',
      model: 'sonnet', promptVersion: 'v1', tool: 'search', query: 'pricing', scope: 'node',
      resultIds: [{ id: 'fnd_1', kind: 'fact' }], resultCount: 1, tokensReturned: 40, truncated: false, relaxed: true,
      latencyMs: 3, uploadDerived: false, createdAt: T0,
    };
    k.artifactCaptures.insert(capture);
    k.artifactTexts.insert(text);
    k.chunks.insert(chunk);
    k.factObservations.insert(obs);
    k.entities.insert(entity);
    k.relations.insert(relation);
    k.entityMergeSuggestions.insert(sugg);
    k.retrievalEvents.insert(ret);
    expect(k.artifactCaptures.get('cap_1')).toEqual(capture);
    expect(k.artifactTexts.get('art_1')).toEqual(text);
    expect(k.chunks.get('chk_1')).toEqual(chunk);
    expect(k.factObservations.get('fob_1')).toEqual(obs);
    expect(k.entities.get('ent_1')).toEqual(entity);
    expect(k.relations.get('rel_1')).toEqual(relation);
    expect(k.entityMergeSuggestions.get('ems_1')).toEqual(sugg);
    expect(k.retrievalEvents.get('ret_1')).toEqual(ret);
    expect(k.factObservations.update('fob_1', { status: 'applied', appliedAt: T0 })).toMatchObject({ status: 'applied', appliedAt: T0 });
    expect(() => k.retrievalEvents.update('ret_1', { query: 'x' })).toThrow(/append-only/);
  });

  it('link repositories: insert, insertIgnore, list and delete by filter', () => {
    const s = store();
    const k = knowledgeRepos(s);
    k.findingEvidence.insert({ findingId: 'fnd_1', seq: 0, artifactId: 'art_1', quote: 'q', charStart: 0, charEnd: 1 });
    k.findingEvidence.insert({ findingId: 'fnd_1', seq: 1, artifactId: 'art_2' });
    expect(() => k.findingEvidence.insert({ findingId: 'fnd_1', seq: 1, artifactId: 'art_3' })).toThrow(/UNIQUE/);
    expect(k.findingEvidence.list({ findingId: 'fnd_1' }).map((e) => e.artifactId)).toEqual(['art_1', 'art_2']);
    expect(k.itemScopes.insertIgnore({ itemKind: 'fact', itemId: 'fnd_1', workspaceId: 'ws_a', source: 'agent' })).toBe(true);
    expect(k.itemScopes.insertIgnore({ itemKind: 'fact', itemId: 'fnd_1', workspaceId: 'ws_a', source: 'user' })).toBe(false);
    expect(k.itemScopes.list({ itemId: 'fnd_1' })).toEqual([{ itemKind: 'fact', itemId: 'fnd_1', workspaceId: 'ws_a', source: 'agent' }]);
    expect(k.itemScopes.delete({ itemKind: 'fact', itemId: 'fnd_1' })).toBe(1);
    expect(() => k.itemScopes.delete({})).toThrow(/needs a filter/);
    k.retrievalUses.insert({ retrievalEventId: 'ret_1', itemId: 'fnd_1', usedByKind: 'finding', usedById: 'fnd_2', createdAt: T0 });
    expect(k.retrievalUses.list({ retrievalEventId: 'ret_1' })).toHaveLength(1);
  });
});
