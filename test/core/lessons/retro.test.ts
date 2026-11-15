import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptLessonProposalAsUser } from '../../../src/core/feedback/actions.js';
import { listFeedback, recordFeedback } from '../../../src/core/feedback/events.js';
import { ROLE_TOOLS } from '../../../src/core/harness/tools/registry.js';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { recordRetrieval, runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { lessonRepos } from '../../../src/core/learning/lessons/store.js';
import { LessonPrivacy } from '../../../src/core/learning/lessons/privacy.js';
import { retroBudget, retroDigest, retroJobSource, runRetro } from '../../../src/core/learning/lessons/retro.js';
import { calibrationAppendix } from '../../../src/core/prompts/index.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import { workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import { startScheduler } from '../../../src/core/scheduler/scheduler.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { lessonsHarness, lessonsSetup } from './fixture.js';

// User persona learning (user persona design §8): a test makes it throw to check the retro is unchanged.
const userLearning = vi.hoisted(() => ({ fail: false }));
vi.mock('../../../src/core/userPersona/learn.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/userPersona/learn.js')>();
  return {
    ...original,
    runUserPersonaLearning: (...args: Parameters<typeof original.runUserPersonaLearning>) =>
      userLearning.fail ? Promise.reject(new Error('user persona learning broke')) : original.runUserPersonaLearning(...args),
  };
});

const opened: Store[] = [];
afterEach(() => {
  userLearning.fail = false;
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

/** A verified persona in tree A with `n` disagreeing profile ratings, each on its own field (qualifies for learning). */
function qualifyingPersona(t: T, n = 6) {
  const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.7, evidence: [] }]));
  const p = t.store.personas.insert({
    id: 'per_smb', workspaceId: t.a.id, slug: 'smb', segment: 'smb segment', profile, version: 1, status: 'verified', agentMdPath: join(t.dir, 'smb.md'),
  });
  for (const criterion of PERSONA_FIELDS.slice(0, n)) {
    t.at();
    rateCriterion({ workspaceId: t.a.id, targetType: 'persona', targetId: p.id, criterion, verdict: 'disagree', userValue: 0.2 }, t);
  }
  return p;
}
const isLearning = (req: AgentRequest) => req.prompt.startsWith('# Persona learning');
/** Persona learning answer: one add on the first three reactions shown, or none. */
const learn = (req: AgentRequest, propose = true) => async (tc: { call(name: string, input: unknown): Promise<unknown> }) => {
  const ids = [...req.prompt.matchAll(/^- (\S+) disagree\b/gm)].map((m) => m[1]!).slice(0, 3);
  await tc.call('submit_persona_learning', {
    persona_id: 'per_smb', assumption: 'Overrates its confidence.',
    proposals: propose ? [{ action: 'add', text: 'You are less sure of your profile than you think.', why: 'w', evidence: ids }] : [],
  });
};
const PERSONA_COUNTS = ['personasEvaluated', 'personasQualified', 'personaLearningRuns', 'personaProposals'];

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
    expect(ROLE_TOOLS.retro).toEqual(['log_decision', 'submit_retro', 'submit_persona_learning']);
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

describe('withheld own-stakeholder research in lessons (stakeholder design §7)', () => {
  it('review issues of a withheld task are counted but never quoted; quoted again once no stakeholder is hidden', () => {
    const t = lessonsSetup(opened);
    const own = t.task(t.a.id, { type: 'own_stakeholders' });
    t.issue(own, 'substantive', 'WITHHELD-QUOTE the CFO only approves quick payback');
    const plain = t.task(t.a.id);
    t.issue(plain, 'substantive', 'the market size has no date');
    const cfo = t.store.personas.insert({
      id: 'per_cfo', workspaceId: t.a.id, slug: 'stk-cfo', segment: 'Chief financial officer', profile: {}, version: 1, status: 'verified',
      agentMdPath: join(t.dir, 'cfo.md'), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: 'r', disclosure: 'hidden',
    });
    const window = () => ({ since: '2000-01-01T00:00:00Z', until: nowAfter(t).toISOString() });

    const privacy = new LessonPrivacy(t.store);
    expect(privacy.blocked(own.task.id)).toBe(true);
    expect(privacy.blocked(own.worker.id)).toBe(true);
    expect(privacy.blocked(own.reviewer.id)).toBe(true);
    expect(privacy.blocked(plain.task.id)).toBe(false);

    const hidden = retroDigest({ store: t.store, config: t.config }, t.a.id, window());
    expect(hidden.briefing.section).not.toContain('WITHHELD-QUOTE');
    expect(hidden.briefing.section).toContain(own.task.id.slice(0, 8)); // counted, named by id
    expect(hidden.briefing.section).toContain('the market size has no date');

    t.store.personas.update(cfo.id, { disclosure: 'open' });
    expect(new LessonPrivacy(t.store).blocked(own.task.id)).toBe(false);
    expect(retroDigest({ store: t.store, config: t.config }, t.a.id, window()).briefing.section).toContain('WITHHELD-QUOTE');
  });
});

describe('persona learning in the retro', () => {
  it('runs after the lessons engine and stores its four counts in the retro digest', async () => {
    const t = lessonsSetup(opened);
    history(t);
    qualifyingPersona(t);
    const h = harness(t, (req) =>
      req.kind !== 'retro' ? undefined : isLearning(req) ? learn(req) : async (tc) => void (await tc.call('submit_retro', { summary: 'ok', proposals: [] })),
    );
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    expect(retro).toMatchObject({ status: 'done', summary: 'ok' });
    expect(retro.digest).toMatchObject({ personasEvaluated: 1, personasQualified: 1, personaLearningRuns: 1, personaProposals: 1 });
    expect(lessonRepos(t.store).retros.get(retro.id)!.digest).toMatchObject({ personaLearningRuns: 1 });
    expect(personaLearningRepos(t.store).runs.list({ retroId: retro.id })).toEqual([expect.objectContaining({ status: 'proposed', personaId: 'per_smb' })]);
    expect(h.requests.map((r) => isLearning(r))).toEqual([true, false]);
  });

  it('stores the counts for a skipped retro too', async () => {
    const t = lessonsSetup(opened);
    qualifyingPersona(t); // reactions older than the retro window: the period itself is empty
    const h = harness(t, (req) => (isLearning(req) ? learn(req, false) : undefined));
    const now = new Date(Date.parse(t.at()) + 10 * 86_400_000);
    const retro = (await runRetro(h.deps, t.a.id, { now }))!;
    expect(retro.status).toBe('skipped');
    expect(retro.digest).toMatchObject({ personasEvaluated: 1, personasQualified: 1, personaLearningRuns: 1, personaProposals: 0 });
    expect(h.requests.filter((r) => !isLearning(r))).toEqual([]);
  });

  it('a throw inside persona learning leaves the retro result unchanged', async () => {
    const t = lessonsSetup(opened);
    history(t);
    qualifyingPersona(t);
    t.store.db.exec('DROP TABLE persona_learning_runs');
    const h = harness(t, (req) => (isLearning(req) ? learn(req) : async (tc) => void (await tc.call('submit_retro', { summary: 'ok', proposals: [] }))));
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    expect(retro).toMatchObject({ status: 'done', summary: 'ok' });
    for (const k of PERSONA_COUNTS) expect(retro.digest).not.toHaveProperty(k);
    expect(retro.digest).toHaveProperty('tasks', 3);
    expect(h.requests.filter((r) => isLearning(r))).toEqual([]);
  });
});

describe('user persona learning in the retro', () => {
  /** `n` include overrides by the user on `n` different findings of tree A (open, non-neutral interactions). */
  const userActions = (t: T, n: number) => {
    for (let i = 0; i < n; i++) {
      t.at();
      recordFeedback(t.store, { workspaceId: t.a.id, kind: 'include_override', targetType: 'finding', targetId: `fnd_u${i}`, afterJson: { include: false } });
    }
  };
  const isUserLearning = (req: AgentRequest) => req.prompt.startsWith('# User persona learning');
  /** The user learning run proposes one add on the first three actions shown. */
  const learnUser = (req: AgentRequest) => async (tc: { call(name: string, input: unknown): Promise<unknown> }) => {
    const ids = [...req.prompt.matchAll(/^- (\S+) reject —/gm)].map((m) => m[1]!).slice(0, 3);
    await tc.call('submit_persona_learning', {
      persona_id: /persona_id `(\w+)`/.exec(req.prompt)![1], assumption: 'Excludes much.',
      proposals: [{ action: 'add', field: 'quality_bar', text: 'Excludes findings without a dated source.', why: 'w', evidence: ids }],
    });
  };
  const USER_COUNTS = ['userInteractions', 'userLearningRuns', 'userProposals'];

  it('runs after persona learning and stores its three counts in the retro digest', async () => {
    const t = lessonsSetup(opened);
    history(t);
    qualifyingPersona(t);
    userActions(t, 12);
    const h = harness(t, (req) =>
      req.kind !== 'retro'
        ? undefined
        : isUserLearning(req)
          ? learnUser(req)
          : isLearning(req)
            ? learn(req)
            : async (tc) => void (await tc.call('submit_retro', { summary: 'ok', proposals: [] })),
    );
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    expect(retro).toMatchObject({ status: 'done', summary: 'ok' });
    // 12 overrides, the history's override and the 6 persona ratings: 19 open actions.
    expect(retro.digest).toMatchObject({ userInteractions: 19, userLearningRuns: 1, userProposals: 1, personaLearningRuns: 1 });
    expect(lessonRepos(t.store).retros.get(retro.id)!.digest).toMatchObject({ userLearningRuns: 1, userProposals: 1 });
    expect(h.requests.map((r) => (isUserLearning(r) ? 'user' : isLearning(r) ? 'persona' : 'retro'))).toEqual(['persona', 'user', 'retro']);
  });

  it('stores the counts for a skipped retro too', async () => {
    const t = lessonsSetup(opened);
    userActions(t, 12);
    const h = harness(t, (req) => (isUserLearning(req) ? learnUser(req) : undefined));
    const now = new Date(Date.parse(t.at()) + 10 * 86_400_000);
    const retro = (await runRetro(h.deps, t.a.id, { now }))!;
    expect(retro.status).toBe('skipped');
    expect(retro.digest).toMatchObject({ userInteractions: 12, userLearningRuns: 1, userProposals: 1 });
  });

  it('a throw inside user persona learning leaves the retro result unchanged', async () => {
    const t = lessonsSetup(opened);
    history(t);
    qualifyingPersona(t);
    userActions(t, 12);
    userLearning.fail = true;
    const h = harness(t, (req) =>
      req.kind !== 'retro' ? undefined : isLearning(req) ? learn(req) : async (tc) => void (await tc.call('submit_retro', { summary: 'ok', proposals: [] })),
    );
    const retro = (await runRetro(h.deps, t.a.id, { now: nowAfter(t) }))!;
    expect(retro).toMatchObject({ status: 'done', summary: 'ok' });
    for (const k of USER_COUNTS) expect(retro.digest).not.toHaveProperty(k);
    expect(retro.digest).toMatchObject({ tasks: 3, personaLearningRuns: 1, personaProposals: 1 });
    expect(h.requests.filter((r) => isUserLearning(r))).toEqual([]);
  });
});

describe('retro scheduling (existing scheduler, built-in job source)', () => {
  it('runs each tree once per cron occurrence and never twice for one occurrence', async () => {
    const t = lessonsSetup(opened, (c) => (c.lessons = { retro: { cron: '* * * * *' } }));
    const h = harness(t, () => undefined);
    let clock = Date.now();
    const sched = startScheduler({ ...h.deps, intervalMs: 3_600_000 }, () => clock);
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
    expect(retroJobSource(h.deps).list()).toEqual([]);
  });
});
