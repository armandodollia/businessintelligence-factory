/**
 * KS-6: flag-versus-expansion agreement (design §12 "Upload stickiness", §18 "Provenance"). The export's
 * reference expansion is the authority; the materialized `upload_derived` flags must agree with it:
 * - everything the expansion links to an upload carries the flag (expansion ⇒ flag), and
 * - the default export leaves out a judgment of an item exactly when the item is flagged (artifacts,
 *   findings) or resolves as derived (records): flag ⇔ exclusion,
 * over every evidence shape (direct evidence, quoted evidence, text duplicates, observations, lineage,
 * records citing derived items) and in both orders (an artifact classified as an upload late).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { itemIsUploadDerived } from '../../../src/core/knowledge/provenance.js';
import { evidenceIncludesUpload, exportTrainingData, internalUploadIds } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Decision, Finding } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('upload flag and export expansion agree (KS-6, design §18 "Provenance")', () => {
  it('over every evidence shape, including a late upload classification', async () => {
    const t = ks4(opened);
    const { store } = t;
    const up = uploadInternal('ws_a', { name: 'kpis.txt', bytes: new TextEncoder().encode('Internal KPIs: churn is 14 percent this quarter.'), mime: 'text/plain' }, t);
    await ingestorFor(t).idle();
    const pub = await t.page('ws_a', 'Public pricing page: Pro is 49 dollars.');
    // Same text as the upload, other bytes: a text duplicate of an upload.
    const dupe = await t.page('ws_a', 'Internal KPIs: churn is 14 percent this quarter.\n');
    expect(knowledgeRepos(store).artifactTexts.get(dupe.id)!.duplicateOf).toBe(up.id);
    const late = await t.page('ws_c', 'A deck the user later says is internal.');

    const fact = (claim: string, evidence: string[], extra: Partial<Finding> = {}) => t.fact('ws_a', claim, { evidence, ...extra });
    const clean = fact('Pro is 49 dollars', [pub.id]);
    const direct = fact('Churn is 14 percent', [up.id]);
    const viaDuplicate = fact('Churn is high', [dupe.id]);
    const viaObservation = fact('Acme sells three plans', [pub.id]);
    knowledgeRepos(store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_a', lineageId: viaObservation.id, findingId: viaObservation.id, kind: 'confirm', taskId: 'tsk_o',
      evidence: [up.id], status: 'rejected', createdAt: T0,
    });
    const v2 = fact('Churn is 15 percent', [pub.id], { lineageId: direct.id, version: 2, replacesId: direct.id });
    const quoted = fact('Churn rose', [pub.id]);
    knowledgeRepos(store).findingEvidence.insert({ findingId: quoted.id, seq: 0, artifactId: up.id, quote: 'churn is 14 percent' });
    const lateFact = fact('The deck says Acme plans a Pro+ tier', [late.id]);
    const comp = store.competitors.insert({
      id: newId('cmp'), workspaceId: 'ws_a', name: 'Globex', threat: 3, directness: 'direct', comparison: {}, evidence: [direct.id], createdAt: T0, updatedAt: T0,
    } as never);
    const rec = store.recommendations.insert({
      id: newId('rec'), workspaceId: 'ws_a', title: 'r', summary: 's', criteria: {}, findingIds: [viaObservation.id], personaFeedback: [], priority: 1, createdAt: T0,
    });
    const cleanRec = store.recommendations.insert({
      id: newId('rec'), workspaceId: 'ws_a', title: 'r2', summary: 's', criteria: {}, findingIds: [clean.id], personaFeedback: [], priority: 1, createdAt: T0,
    });

    // The user classifies `late` as an internal upload after the fact was saved.
    store.profiles.insert({ workspaceId: 'ws_c', data: { uploads: [late.id] } });

    const decisionOn = (id: string): Decision =>
      store.decisions.insert({
        id: newId('dec'), workspaceId: 'ws_a', agentRunId: newId('arun'), role: 'worker', model: { provider: 'claude', model: 'sonnet' },
        kind: 'decision', payload: { tool: 'log_decision', what: 'judgment' }, refs: [id], promptVersion: 'pv', createdAt: T0,
      });
    const findings = store.findings.list();
    const artifacts = store.artifacts.list();
    const records = [comp.id, rec.id, cleanRec.id];
    const judged = new Map([...findings.map((f) => f.id), ...artifacts.map((a) => a.id), ...records].map((id) => [id, decisionOn(id)]));
    const exported = exportTrainingData('ws_a', { store });

    const uploads = internalUploadIds(store);
    for (const a of artifacts) {
      const flag = store.artifacts.get(a.id)!.uploadDerived === true;
      if (uploads.has(a.id)) expect(flag, `expansion ⇒ flag: ${a.id}`).toBe(true);
      expect(!exported.includes(judged.get(a.id)!.id), `flag ⇔ exclusion: artifact ${a.id}`).toBe(flag);
    }
    for (const f of findings) {
      const flag = store.findings.get(f.id)!.uploadDerived === true;
      if (evidenceIncludesUpload(store, f.id, uploads)) expect(flag, `expansion ⇒ flag: ${f.claim}`).toBe(true);
      expect(!exported.includes(judged.get(f.id)!.id), `flag ⇔ exclusion: ${f.claim}`).toBe(flag);
    }
    for (const id of records) {
      expect(!exported.includes(judged.get(id)!.id), `resolved flag ⇔ exclusion: ${id}`).toBe(itemIsUploadDerived(store, id));
    }

    // The expected classification, so the loops above cannot pass vacuously.
    const flagged = (f: Finding) => store.findings.get(f.id)!.uploadDerived;
    expect([direct, viaDuplicate, viaObservation, v2, quoted, lateFact].map(flagged)).toEqual([true, true, true, true, true, true]);
    expect(flagged(clean)).toBe(false);
    expect([comp.id, rec.id, cleanRec.id].map((id) => itemIsUploadDerived(store, id))).toEqual([true, true, false]);
    expect(store.artifacts.get(late.id)!.uploadDerived).toBe(true);
    expect(store.artifacts.get(pub.id)!.uploadDerived).toBe(false);
  });
});
