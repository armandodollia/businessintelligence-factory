/**
 * Opus findings 1 and 3 (final gate) with the design-thread precisions (binding):
 * - `replaces` is a citation edge, forward only: a later version inherits exposed-output status from the
 *   version it replaces, to any depth; an earlier version never inherits from a later one.
 * - A confirm or retract by an exposed task does not taint the fact it targets. The observation is that
 *   task's output: judgments that reference it are excluded, and so is its export line.
 * - Fact-observation lines follow the task rule (`taskCitesExposedOutput`) like decisions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Role, Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Line = { type: string; decision?: { id: string }; observation?: { id: string } };

async function world() {
  const t = ks4(opened);
  uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential board memo: churn rose to 14 percent.'), mime: 'text/plain' }, t);
  await ingestorFor(t).idle();
  const task = (): Task =>
    t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
  const run = (role: Role = 'worker'): RunContext => {
    const tk = task();
    const c = t.ctx('ws_a', role, { taskId: tk.id });
    t.store.agentRuns.insert({ id: c.agentRunId, workspaceId: 'ws_a', role, model: c.model, token: c.agentRunId, status: 'done', startedAt: T0, promptVersion: 'pv', taskId: tk.id });
    return c;
  };
  const exposed = async (): Promise<RunContext> => {
    const c = run();
    await t.call(c, 'search', { query: 'churn', kinds: ['passage'] });
    return c;
  };
  /** A page this run's task captured (evidence for its saves, confirmations and retractions). */
  const page = async (c: RunContext, content: string) => (await t.call<{ artifactId: string }>(c, 'save_artifact', { kind: 'text', mime: 'text/plain', content })).artifactId;
  const save = async (c: RunContext, claim: string, relation: unknown = 'new') => {
    const a = await page(c, `${claim}.`);
    const r = await t.call<{ findingId: string }>(c, 'save_finding', { claim, subject: 'Acme', evidence: [a], relation });
    t.store.findings.update(r.findingId, { status: 'verified' });
    // As when the task is verified: the replacement becomes current, the replaced version `replaced`.
    const replaces = (relation as { replaces?: string }).replaces;
    if (replaces) {
      t.store.findings.update(replaces, { lifecycle: 'replaced' });
      t.store.findings.update(r.findingId, { lifecycle: 'current' });
    }
    return r.findingId;
  };
  const judge = async (refs: string[]) => {
    const c = run();
    await t.call(c, 'log_decision', { what: 'Build on it', why: 'cited', confidence: 0.6, refs });
    return t.store.decisions.list({ agentRunId: c.agentRunId }).map((d) => d.id);
  };
  const lines = (includeUploads = false) => exportTrainingData('ws_a', { store: t.store }, includeUploads).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
  const decisions = (includeUploads = false) => lines(includeUploads).filter((l) => l.type === 'decision').map((l) => l.decision!.id);
  const observations = (includeUploads = false) => lines(includeUploads).filter((l) => l.type === 'fact_observation').map((l) => l.observation!.id);
  const decisionsOf = (c: RunContext) => t.store.decisions.list({ agentRunId: c.agentRunId }).map((d) => d.id);
  return { t, run, exposed, page, save, judge, decisions, observations, decisionsOf };
}

describe('export exposure follows a fact lineage forward only (Opus 1)', () => {
  it("Opus's chain: exposed T1 saves F; T3 saves F2 replacing F; T4's judgment citing F2 is excluded", async () => {
    const w = await world();
    const t1 = await w.exposed();
    const f = await w.save(t1, 'Acme Pro costs 49 dollars per seat');
    const t3 = w.run();
    const f2 = await w.save(t3, 'Acme Pro costs 59 dollars per seat', { replaces: f });
    const t4 = await w.judge([f2]);
    const out = w.decisions();
    for (const d of [...t4, ...w.decisionsOf(t3)]) expect(out).not.toContain(d);
    expect(w.decisions(true)).toEqual(expect.arrayContaining(t4));
  });

  it('forward to any depth: F → F2 → F3; a judgment citing F3 is excluded', async () => {
    const w = await world();
    const f = await w.save(await w.exposed(), 'Acme Pro costs 49 dollars per seat');
    const f2 = await w.save(w.run(), 'Acme Pro costs 59 dollars per seat', { replaces: f });
    const t5 = w.run();
    const f3 = await w.save(t5, 'Acme Pro costs 69 dollars per seat', { replaces: f2 });
    const judged = await w.judge([f3]);
    const out = w.decisions();
    for (const d of [...judged, ...w.decisionsOf(t5)]) expect(out).not.toContain(d);
  });

  it('never backward: the version an exposed task replaced, and judgments citing it, stay exported', async () => {
    const w = await world();
    const t0 = w.run();
    const f0 = await w.save(t0, 'Acme Pro costs 39 dollars per seat');
    await w.save(await w.exposed(), 'Acme Pro costs 49 dollars per seat', { replaces: f0 });
    const judged = await w.judge([f0]);
    const out = w.decisions();
    expect(out).toEqual(expect.arrayContaining([...judged, ...w.decisionsOf(t0)]));
  });
});

describe('a confirm or retract by an exposed task does not taint its target (design-thread precision)', () => {
  for (const kind of ['confirm', 'retract'] as const) {
    it(`${kind}: the target fact stays exported; judgments referencing the observation, and its line, are excluded`, async () => {
      const w = await world();
      const t8 = w.run();
      const g = await w.save(t8, 'Acme offers a free tier');
      const t7 = await w.exposed();
      const a = await w.page(t7, 'Acme pricing page, checked again.');
      if (kind === 'confirm') await w.t.call(t7, 'confirm_finding', { finding_id: g, evidence: [a] });
      else await w.t.call(t7, 'retract_finding', { finding_id: g, reason: 'gone', evidence: [a] });
      const obs = knowledgeRepos(w.t.store).factObservations.list({ findingId: g }).find((o) => o.kind === kind)!;
      expect(obs).toBeDefined();
      const onFact = await w.judge([g]);
      const onObservation = await w.judge([obs.id]);
      const out = w.decisions();
      expect(out).toEqual(expect.arrayContaining([...onFact, ...w.decisionsOf(t8)]));
      for (const d of onObservation) expect(out).not.toContain(d);
      expect(w.observations()).not.toContain(obs.id);
      expect(w.observations(true)).toContain(obs.id);
    });
  }
});
