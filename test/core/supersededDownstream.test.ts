import { afterEach, describe, expect, it } from 'vitest';
import { diffRuns } from '../../src/core/scheduler/diff.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { reviewQueue } from '../../src/core/scoring/reviewQueue.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Finding } from '../../src/core/types.js';
import { researchSetup } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return t;
}

const finding = (store: Store, runId: string, claim: string, status: Finding['status']): Finding =>
  store.findings.insert({
    id: newId('fnd'), workspaceId: 'ws_a', runId, taskId: 'tsk_1', subject: 'Acme', claim, criteria: { relevance: 3 }, evidence: [],
    status, createdAt: 'now',
  });

describe('superseded outputs downstream', () => {
  it('diffRuns ignores superseded findings', () => {
    const t = setup();
    finding(t.store, 'rrun_prev', 'Acme Pro costs $20 per seat', 'verified');
    finding(t.store, 'rrun_next', 'Acme Pro costs $20 per seat', 'verified');
    finding(t.store, 'rrun_next', 'Acme Pro costs $10 per seat', 'superseded');
    finding(t.store, 'rrun_prev', 'Globex is gone', 'superseded');
    const d = diffRuns('rrun_prev', 'rrun_next', { store: t.store });
    expect(d.newFindings).toEqual([]);
    expect(d.removedSubjects).toEqual([]);
  });

  it('reviewQueue skips superseded findings, recommendations and personas', () => {
    const t = setup();
    const live = finding(t.store, 'r', 'live', 'verified');
    const old = finding(t.store, 'r', 'old', 'superseded');
    t.store.recommendations.insert({
      id: 'rec_sup', workspaceId: 'ws_a', title: 'old rec', summary: 's', criteria: { upside: 4 }, findingIds: [], personaFeedback: [],
      priority: 2, createdAt: 'now', status: 'superseded',
    });
    t.store.personas.insert({
      id: 'per_sup', workspaceId: 'ws_a', slug: 'sam', segment: 'SMB', agentMdPath: 'x.md', version: 1, status: 'superseded',
      profile: { goals: { value: 'v', confidence: 0.5, evidence: [] } },
    });
    const ids = reviewQueue('ws_a', { store: t.store }).map((i) => i.targetId);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain('rec_sup');
    expect(ids).not.toContain('per_sup');
  });

  it('training export skips decisions whose subject is superseded', () => {
    const t = setup();
    const live = finding(t.store, 'r', 'live', 'verified');
    const old = finding(t.store, 'r', 'old', 'superseded');
    for (const f of [live, old]) {
      t.store.decisions.insert({
        id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'arun_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
        kind: 'score', payload: { tool: 'save_finding', findingId: f.id, criteria: f.criteria }, refs: [f.id], promptVersion: 'v', createdAt: 'now',
      });
    }
    const lines = exportTrainingData('ws_a', { store: t.store }).trim().split('\n').map((l) => JSON.parse(l) as { decision: { payload: { findingId: string } } });
    expect(lines.map((l) => l.decision.payload.findingId)).toEqual([live.id]);
  });
});
