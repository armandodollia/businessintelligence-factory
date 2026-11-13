import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { explainUploadDerived } from '../../../src/core/knowledge/uploadCause.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Decision } from '../../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ks2-export-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  const pub = artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'public pricing page' });
  const upload = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('secret kpis'), mime: 'text/csv' }, { store, artifacts });
  return { store, artifacts, pub, upload };
}

function decision(store: Store, payload: Record<string, unknown>, refs: string[]): Decision {
  return store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: newId('arun'), role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    kind: 'score', payload, refs, promptVersion: 'pv', createdAt: T0,
  });
}

/** A public-evidence fact whose only upload link is a confirmation observation (task later failed). */
function observationFlaggedFact(t: ReturnType<typeof setup>) {
  const { store, pub, upload } = t;
  const fact = store.findings.insert({
    id: newId('fnd'), workspaceId: 'ws_a', runId: 'run_1', taskId: 'tsk_1', subject: 'Acme', claim: 'Acme charges $10',
    criteria: {}, evidence: [pub.id], status: 'verified', createdAt: T0,
  });
  const save = decision(store, { tool: 'save_finding', findingId: fact.id, criteria: {} }, [fact.id, pub.id]);
  expect(store.findings.get(fact.id)!.uploadDerived).toBe(false);
  const obs = knowledgeRepos(store).factObservations.insert({
    id: newId('obs'), workspaceId: 'ws_a', lineageId: fact.id, findingId: fact.id, kind: 'confirm', taskId: 'tsk_2',
    evidence: [upload.id], status: 'rejected', createdAt: T0,
  });
  return { fact: store.findings.get(fact.id)!, save, obs };
}

describe('export read path (KS-2 ruling: materialized flags + itemIsUploadDerived)', () => {
  it('excludes a fact flagged only through an observation, and a record that cites it', () => {
    const t = setup();
    const { fact, save, obs } = observationFlaggedFact(t);
    expect(fact.uploadDerived).toBe(true);
    expect(fact.uploadCause).toBe(`observation:${obs.id}`);
    const rec = t.store.recommendations.insert({
      id: newId('rec'), workspaceId: 'ws_a', title: 'Raise prices', summary: 's', criteria: {}, findingIds: [fact.id],
      personaFeedback: [], priority: 1, createdAt: T0, status: 'verified',
    });
    // The recommendation's decision names only the recommendation: the link is resolved through it.
    const recDecision = decision(t.store, { tool: 'save_recommendation', recommendationId: rec.id }, [rec.id]);
    const unrelated = decision(t.store, { tool: 'log_decision', what: 'w' }, [t.pub.id]);

    const out = exportTrainingData('ws_a', { store: t.store });
    expect(out).not.toContain(save.id);
    expect(out).not.toContain(recDecision.id);
    expect(out).toContain(unrelated.id);

    const all = exportTrainingData('ws_a', { store: t.store }, true);
    expect(all).toContain(save.id);
    expect(all).toContain(recDecision.id);
  });

  it('excludes a finding by its stored flag even when its evidence no longer names the upload', () => {
    const t = setup();
    const f = t.store.findings.insert({
      id: newId('fnd'), workspaceId: 'ws_a', runId: 'run_1', taskId: 'tsk_1', subject: 'Acme', claim: 'c',
      criteria: {}, evidence: [t.upload.id], status: 'verified', createdAt: T0,
    });
    t.store.findings.update(f.id, { evidence: [t.pub.id] }); // sticky: the flag stays
    const d = decision(t.store, { tool: 'save_finding', findingId: f.id }, [f.id]);
    expect(exportTrainingData('ws_a', { store: t.store })).not.toContain(d.id);
  });
});

describe('explainUploadDerived (KS-2 ruling: why a flag was set)', () => {
  it('follows the recorded cause from a fact through its observation to the upload', () => {
    const t = setup();
    const { fact, obs } = observationFlaggedFact(t);
    const why = explainUploadDerived(t.store, fact.id)!;
    expect(why.chain.map((s) => s.id)).toEqual([fact.id, obs.id, t.upload.id]);
    expect(why.chain[0]).toMatchObject({ kind: 'finding', cause: `observation:${obs.id}` });
    expect(why.chain.at(-1)).toMatchObject({ kind: 'artifact', cause: 'kind:upload' });
    expect(why.text).toContain(obs.id);
    expect(why.text).toContain(t.upload.id);
  });

  it('explains a record without a flag through the derived item it cites, and lineage versions', () => {
    const t = setup();
    const { fact, obs } = observationFlaggedFact(t);
    const rec = t.store.recommendations.insert({
      id: newId('rec'), workspaceId: 'ws_a', title: 'r', summary: 's', criteria: {}, findingIds: [fact.id], personaFeedback: [], priority: 1, createdAt: T0,
    });
    expect(explainUploadDerived(t.store, rec.id)!.chain.map((s) => s.id)).toEqual([rec.id, fact.id, obs.id, t.upload.id]);
    const v2 = t.store.findings.insert({
      id: newId('fnd'), workspaceId: 'ws_a', runId: 'run_2', taskId: 'tsk_3', subject: 'Acme', claim: 'Acme charges $12',
      criteria: {}, evidence: [t.pub.id], status: 'pending', createdAt: T0, lineageId: fact.lineageId!, version: 2, replacesId: fact.id,
    });
    const why = explainUploadDerived(t.store, v2.id)!;
    expect(why.chain[0]).toMatchObject({ id: v2.id, cause: `lineage:${fact.id}` });
    expect(why.chain.map((s) => s.id)).toContain(t.upload.id);
  });

  it('returns undefined for an item that is not upload-derived', () => {
    const t = setup();
    expect(explainUploadDerived(t.store, t.pub.id)).toBeUndefined();
    expect(explainUploadDerived(t.store, 'fnd_unknown')).toBeUndefined();
  });

  it('explains a text duplicate of an upload', () => {
    const t = setup();
    knowledgeRepos(t.store).artifactTexts.update(t.pub.id, { duplicateOf: t.upload.id });
    const why = explainUploadDerived(t.store, t.pub.id)!;
    expect(why.chain.map((s) => s.id)).toEqual([t.pub.id, t.upload.id]);
    expect(why.chain[0]!.cause).toBe(`duplicate_of:${t.upload.id}`);
  });
});
