import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptLessonProposalAsUser } from '../../../src/core/feedback/actions.js';
import { listFeedback, recordFeedback } from '../../../src/core/feedback/events.js';
import { ROLE_TOOLS } from '../../../src/core/harness/tools/registry.js';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { recordRetrieval, runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { lessonRepos } from '../../../src/core/learning/lessons/store.js';
import { retroBudget, retroDigest, retroJobs, runRetro } from '../../../src/core/learning/lessons/retro.js';
import { calibrationAppendix } from '../../../src/core/prompts/index.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import { workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import { startScheduler } from '../../../src/core/scheduler/scheduler.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { lessonsHarness, lessonsSetup } from './fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

type T = ReturnType<typeof lessonsSetup>;

const harness = lessonsHarness;

/** Three tasks with substantive issues in tree A; the first task's worker read an upload. */
function history(t: T) {
  t.store.identities.insert({ id: newId('idn'), workspaceId: t.a.id, site: 'acme.com', name: 'Test', email: 'qa@x.test', password: 'hunter2-SECRETPW', createdAt: t.at() });
  const xs = [t.task(t.a.id), t.task(t.aChild.id), t.task(t.a.id)];
  t.issue(xs[0]!, 'substantive', 'UPLOAD-ONLY board numbers were quoted without a source');
  t.issue(xs[1]!, 'substantive', `login hunter2-SECRETPW was pasted; ${'long text '.repeat(40)}`);
  t.issue(xs[2]!, 'substantive', 'the market size has no date');
  recordRetrieval({ store: t.store }, { workspaceId: t.a.id, agentRunId: xs[0]!.worker.id, taskId: xs[0]!.task.id, role: 'worker' }, {
    tool: 'read_artifact', query: 'x', scope: 'node', results: [{ id: 'art_upload', kind: 'artifact' }], tokensReturned: 10, latencyMs: 1, uploadDerived: true,
  });
  recordFeedback(t.store, { workspaceId: t.a.id, kind: 'include_override', targetType: 'finding', targetId: 'fnd_1', afterJson: { include: false }, agentRunId: xs[2]!.worker.id, promptVersion: xs[2]!.worker.promptVersion! });
  return xs;
}

const nowAfter = (t: T) => new Date(Date.parse(t.at()) + 1);

describe('weekly retro', () => {
  it('digest: fixed budget, redacted then cut, fenced, no upload-derived text; logged as a read before the run starts', async () => {
    const t = lessonsSetup(opened);
    const xs = history(t);
    let readsAtStart = -1;
    let prompt = '';
    const h = harness(t, (req) =>
      req.kind === 'retro'
        ? async (tc) => {
            readsAtStart = knowledgeRepos(t.store).retrievalEvents.list({ role: 'retro' }).length;
            prompt = req.prompt;
            const id = /\[(tsk_[A-Z0-9]+)/.exec(req.prompt)![1]!;
            await tc.call('submit_retro', {
              summary: 'Substantive issues recur in news scans.',
              proposals: [
                { kind: 'prompt_edit', role: 'worker', text: 'Date every market figure you report.', why: 'issues lack dates', evidence: [id] },
                { kind: 'calibration_edit', role: 'reviewer', text: 'A missing date on a figure is a substantive issue.', why: 'consistency', evidence: [id] },
              ],
            });
          }
        : undefined,
    );
    const retro = (await runRetro(h.deps, t.aChild.id, { now: nowAfter(t) }))!;
    expect(retro).toMatchObject({ rootWorkspaceId: t.a.id, status: 'done', triggeredBy: 'user', summary: 'Substantive issues recur in news scans.' });
    expect(h.requests.map((r) => r.role)).toEqual(['retro']);
    expect(readsAtStart).toBe(1); // the digest read existed before the agent made any call
    const [read] = knowledgeRepos(t.store).retrievalEvents.list({ role: 'retro' });
    expect(read).toMatchObject({ tool: 'prompt_context', agentRunId: retro.agentRunId, rootWorkspaceId: t.a.id, uploadDerived: false });
    expect(runIsUploadExposed(t.store, retro.agentRunId!)).toBe(false);

    expect(prompt).toContain('<<<EVIDENCE retro');
    expect(prompt).not.toContain('UPLOAD-ONLY'); // exposed task: id only
    expect(prompt).not.toContain('hunter2-SECRETPW'); // redacted before the cut
    expect(prompt).toContain('the market size has no date'); // a quotable example
    expect(prompt).toContain(xs[0]!.task.id.slice(0, 8)); // ids are there
    const section = /## Digest of the period[\s\S]*?(?=\n\n## What to do)/.exec(prompt)![0];
    expect(estimateTokens(section)).toBeLessThanOrEqual(4000);
    for (const l of section.split('\n')) expect(l.length).toBeLessThanOrEqual(400);

    const proposals = lessonRepos(t.store).proposals.list({ retroId: retro.id });
    expect(proposals.map((p) => [p.action, p.role, p.status, p.source])).toEqual([
      ['prompt_edit', 'worker', 'pending', 'retro'],
      ['calibration_edit', 'reviewer', 'pending', 'retro'],
    ]);
    // The lessons engine ran first: its add proposal is pending too.
    expect(lessonRepos(t.store).proposals.list({ rootWorkspaceId: t.a.id, source: 'engine' })).toHaveLength(1);
    // Retro role sees only its own tools; the run's prompt resolves in the prompt store.
    expect(ROLE_TOOLS.retro).toEqual(['log_decision', 'submit_retro']);
    expect(promptStoreGaps(t.store)).toEqual([]);
  });

  it('retro proposals change nothing until accepted: a prompt edit becomes a marked rule, a calibration edit goes through calibration history', async () => {
    const t = lessonsSetup(opened, (c) => (c.user = { id: 'carol' }));
    history(t);
    const h = harness(t, (req) =>
      req.kind === 'retro'
        ? async (tc) => {
            const id = /\[(tsk_[A-Z0-9]+)/.exec(req.prompt)![1]!;
            await tc.call('submit_retro', {
              summary: 's',
              proposals: [
                { kind: 'prompt_edit', role: 'worker', text: 'Date every market figure you report.', why: 'w', evidence: [id] },
                { kind: 'calibration_edit', role: 'reviewer', text: 'A missing date on a figure is a substantive issue.', why: 'w', evidence: [id] },
              ],
            });
          }
        : undefined,
    );
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    const [edit, cal] = lessonRepos(t.store).proposals.list({ retroId: retro.id });
    const scope = calibrationScope(t.store, t.dir, t.a.id);
    expect(workerSystemPrompt(t.config, 'worker', false, 'news_scan', scope)).not.toContain('Date every market figure');
    expect(calibrationAppendix('reviewer', scope)).toBe('');

    const r1 = acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, edit!.id);
    expect(workerSystemPrompt(t.config, 'worker', false, 'news_scan', scope)).toContain(`[${r1.rule!.marker}.v1] Date every market figure you report.`);
    expect(r1.rule).toMatchObject({ source: 'retro', category: `retro:${edit!.id}`, actor: 'carol' });

    const r2 = acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, cal!.id);
    expect(calibrationAppendix('reviewer', scope)).toContain('A missing date on a figure is a substantive issue.');
    expect(r2.rule).toBeUndefined();
    expect(listFeedback(t.store, { kind: 'prompt_patch_apply' })).toEqual([expect.objectContaining({ actor: 'carol', targetId: 'reviewer' })]);
    expect(listFeedback(t.store, { kind: 'lesson_accept' }).map((e) => e.targetId)).toEqual([edit!.id, cal!.id]);
    expect(promptStoreGaps(t.store)).toEqual([]);
  });

  it('submit_retro accepts only evidence ids shown in the digest and at most maxProposals', async () => {
    const t = lessonsSetup(opened, (c) => (c.lessons = { retro: { maxProposals: 1 } }));
    history(t);
    const other = t.task(t.b.id);
    const errors: unknown[] = [];
    const h = harness(t, (req) =>
      req.kind === 'retro'
        ? async (tc) => {
            const id = /\[(tsk_[A-Z0-9]+)/.exec(req.prompt)![1]!;
            const p = (evidence: string[]) => ({ kind: 'prompt_edit', role: 'worker', text: 'x rule', why: 'w', evidence });
            for (const input of [
              { summary: 's', proposals: [p([other.task.id])] },
              { summary: 's', proposals: [p([id]), p([id])] },
            ]) {
              try {
                await tc.call('submit_retro', input);
              } catch (e) {
                errors.push((e as Error).message);
              }
            }
            await tc.call('submit_retro', { summary: 'ok', proposals: [p([id])] });
          }
        : undefined,
    );
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    expect(errors.join('\n')).toMatch(/not shown in the digest/);
    expect(errors.join('\n')).toMatch(/at most 1 proposal/);
    expect(retro).toMatchObject({ status: 'done', summary: 'ok' });
    expect(retro.proposalIds).toHaveLength(1);
  });

  it('a configured retro budget bounds the digest; what is cut is counted (degrade ladder)', () => {
    const t = lessonsSetup(opened, (c) => (c.knowledge = { budgets: { roles: { retro: { briefing: 150 } } } }));
    history(t);
    expect(retroBudget(t.config)).toBe(150);
    expect(retroBudget(structuredClone(t.config), 'claude')).toBe(150);
    const d = retroDigest({ store: t.store, config: t.config }, t.a.id, { since: '2000-01-01T00:00:00Z', until: nowAfter(t).toISOString() });
    expect(d.briefing.tokens).toBeLessThanOrEqual(150);
    expect(d.briefing.truncated).toBe(true);
    expect(d.briefing.section).toMatch(/left out/);
    t.config.knowledge = {};
    expect(retroBudget(t.config)).toBe(4000);
  });

  it('skips the agent when nothing happened in the period, and is per tree', async () => {
    const t = lessonsSetup(opened);
    history(t);
    const h = harness(t, () => async () => undefined);
    const b = (await runRetro(h.deps, t.b.id, { now: nowAfter(t) }))!;
    expect(b).toMatchObject({ rootWorkspaceId: t.b.id, status: 'skipped' });
    expect(h.requests).toEqual([]);
    const digest = retroDigest({ store: t.store, config: t.config }, t.b.id, { since: '2000-01-01T00:00:00Z', until: nowAfter(t).toISOString() });
    expect(digest.active).toBe(false);
    expect(digest.briefing.section).not.toMatch(/tsk_/);
  });
});

describe('retro scheduling (existing scheduler, system jobs)', () => {
  it('runs each tree once per cron occurrence and never twice for one occurrence', async () => {
    const t = lessonsSetup(opened, (c) => (c.lessons = { retro: { cron: '* * * * *' } }));
    const h = harness(t, () => undefined);
    let clock = Date.now();
    const sched = startScheduler({ ...h.deps, intervalMs: 3_600_000, systemJobs: () => retroJobs(h.deps) }, () => clock);
    try {
      await sched.idle();
      expect(lessonRepos(t.store).retros.list()).toHaveLength(0); // first occurrence is after the start
      clock += 61_000;
      await sched.tick();
      await sched.idle();
      await sched.tick();
      await sched.idle();
      const roots = lessonRepos(t.store).retros.list().map((r) => r.rootWorkspaceId).sort();
      expect(roots).toEqual([t.a.id, t.b.id].sort()); // one per tree (the child is not a tree)
      expect(lessonRepos(t.store).retros.list().every((r) => r.status === 'skipped' && r.triggeredBy === 'schedule')).toBe(true);
      clock += 61_000;
      await sched.tick();
      await sched.idle();
      expect(lessonRepos(t.store).retros.list()).toHaveLength(4);
    } finally {
      sched.stop();
    }
    t.config.lessons = { retro: { enabled: false } };
    expect(retroJobs(h.deps)).toEqual([]);
  });
});
