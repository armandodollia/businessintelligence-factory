/**
 * Stakeholder personas, final whole-branch review fixes: research withheld from its first run, model
 * choice for offline work (reads and learning of own stakeholders; own-stakeholder research itself may
 * use the web since the user's ruling of 2026-11-15), `save_stakeholder` only in stakeholder tasks, the
 * feature switch, offline reads and learning of own stakeholders, own-stakeholder research internal in
 * the export, label hygiene and the caps.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configWarnings, reviewerFor } from '../../../src/core/config/load.js';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { canRunOffline, offlineModel } from '../../../src/core/harness/offline.js';
import type { RunOptions } from '../../../src/core/harness/supervisor.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { auditModelFor } from '../../../src/core/learning/reviewerAudit.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { personaLearningToolHandlers, runPersonaLearning } from '../../../src/core/personas/learn.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import { stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import { ensureQuestions } from '../../../src/core/stakeholders/questions.js';
import { runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { addNote } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import { withholding } from '../../../src/core/stakeholders/withheld.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, Task, TaskType } from '../../../src/core/types.js';
import { addTask, researchSetup, review, type SetupOptions } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-15T10:00:00.000Z';
const CLAUDE_SONNET = { provider: 'claude' as const, model: 'sonnet' };
const CODEX = { provider: 'codex' as const, model: 'gpt-6.1-sol' };

/** The default config with Claude (and OpenCode) disabled: no enabled provider can run offline. */
const codexOnly = (c: BifConfig) => {
  c.providers.claude = { ...c.providers.claude, enabled: false };
  c.providers.opencode = { ...c.providers.opencode, enabled: false };
};

function setup(opts: SetupOptions = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'bif-stk-final-'));
  const s = researchSetup(opened, {
    dir,
    extraHandlers: () => ({
      ...researchToolHandlers(), ...stakeholderToolHandlers({ dataDir: dir }), ...personaLearningToolHandlers(),
      submit_stakeholder_read: submitStakeholderReadHandler,
    }),
    ...opts,
  });
  s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW, scope: { level: 'company', name: 'Acme', description: 'payments' } });
  return s;
}

const profile = (evidence: string[]) => Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.6, evidence }]));
const saveInput = (evidence: string[], extra: Record<string, unknown> = {}) => ({
  label: 'Chief financial officer', stakeholder_type: 'leader', subject: 'own', relation: 'approves pricing changes', profile: profile(evidence), ...extra,
});
const ctxOf = (task: Task | undefined, extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: CLAUDE_SONNET, promptVersion: 'pv',
  ...(task ? { taskId: task.id } : {}), ...extra,
});
const stakeholderTask = (s: ReturnType<typeof setup>, type: TaskType = 'own_stakeholders', extra: Partial<Task> = {}) =>
  addTask(s.store, { phase: 'stakeholders', type, brief: `do ${type}`, subject: undefined, ...extra });

/** Options of every supervisor run (fake scripts: the adapter is not reached, the options are). */
function spyRuns(s: ReturnType<typeof setup>) {
  const runs: RunOptions[] = [];
  const original = s.supervisor.run.bind(s.supervisor);
  vi.spyOn(s.supervisor, 'run').mockImplementation((o: RunOptions) => {
    runs.push(o);
    return original(o);
  });
  return runs;
}
const harnessEvents = (s: ReturnType<typeof setup>, event: string) =>
  s.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { tool?: string; event?: string }).tool === 'harness' && (d.payload as { event?: string }).event === event);

// ---------------------------------------------------------------------------------------------------
// item 1

describe('own-stakeholder research is withheld from its first run', () => {
  it('a running own_stakeholders task (no stakeholder saved yet) is withheld with its runs; once finished, only a hidden stakeholder keeps it so', () => {
    const s = setup();
    s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'stakeholders', status: 'running', startedAt: NOW });
    const task = stakeholderTask(s, 'own_stakeholders', { status: 'running' });
    const run = s.store.agentRuns.insert({
      id: 'arun_w', workspaceId: 'ws_a', taskId: task.id, role: 'worker', model: CLAUDE_SONNET, token: 'tok_w', status: 'running', startedAt: NOW,
      promptVersion: 'pv', taskType: 'own_stakeholders',
    });
    const other = stakeholderTask(s, 'competitor_stakeholders', { status: 'running' });
    expect(withholding(s.store).nodeHasHidden('ws_a')).toBe(false);
    for (const status of ['queued', 'running', 'reviewing', 'waiting_user'] as const) {
      const t = s.store.tasks.update(task.id, { status });
      const w = withholding(s.store);
      expect(w.task(t), status).toBe(true);
      expect(w.run(run.id), status).toBe(true);
      expect(w.servedBusEvent({ type: 'run_event', workspaceId: 'ws_a', agentRunId: run.id, event: { t: 'message', text: 'SECRET' } }), status).toBeUndefined();
    }
    expect(withholding(s.store).task(other)).toBe(false);
    for (const status of ['verified', 'unverified', 'failed'] as const) {
      expect(withholding(s.store).task(s.store.tasks.update(task.id, { status })), status).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// item 2

describe('model choice for offline work, and own-stakeholder research on the usual models', () => {
  it('canRunOffline / offlineModel follow the adapters: Codex cannot, Claude and OpenCode can', () => {
    const cfg = structuredClone(defaultConfig);
    expect(canRunOffline(cfg, 'claude')).toBe(true);
    expect(canRunOffline(cfg, 'codex')).toBe(false);
    expect(canRunOffline(cfg, 'opencode')).toBe(false); // disabled by default
    expect(offlineModel(cfg, { provider: 'claude', model: 'haiku' })).toEqual({ provider: 'claude', model: 'haiku' });
    expect(offlineModel(cfg, CODEX)).toEqual({ provider: 'claude', model: 'opus' });
    // only Claude disabled: the first model of OpenCode, which can run offline
    cfg.providers.opencode = { enabled: true, command: 'opencode', models: ['big-pickle'] };
    cfg.providers.claude = { ...cfg.providers.claude, enabled: false };
    expect(offlineModel(cfg, CODEX)).toEqual({ provider: 'opencode', model: 'big-pickle' });
    codexOnly(cfg);
    expect(offlineModel(cfg, CODEX)).toBeUndefined();
  });

  it('default config: own-stakeholder research runs on the usual models, not offline; its reviewer may be on Codex', async () => {
    const s = setup({ pick: (r) => (r.kind === 'review' ? review(9) : async (t) => void (await t.call('submit_result', { summary: 'x' }))) });
    const runs = spyRuns(s);
    const done = await runTaskWithReview(stakeholderTask(s), s.deps);
    const reviewers = runs.filter((o) => o.ctx.role === 'reviewer');
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.ctx.model).toEqual(reviewerFor(CLAUDE_SONNET, s.config));
    expect(reviewers[0]!.ctx.model).toEqual(CODEX);
    expect(runs.map((o) => o.offline)).toEqual([undefined, undefined]);
    expect(done.status).toBe('verified');
  });

  it('the reviewer audit of an own_stakeholders review picks its auditor like any other', () => {
    const cfg = structuredClone(defaultConfig);
    const original = { provider: 'claude' as const, model: 'opus' };
    expect(auditModelFor(original, CLAUDE_SONNET, cfg)).toEqual(CODEX);
  });

  const propose = (s: ReturnType<typeof setup>, tasks: unknown[]) => {
    const results: unknown[] = [];
    s.state.pick = (r) => {
      if (r.kind === 'orchestrate') return r.round === 1 ? async (t) => void results.push(await t.call('propose_tasks', { tasks })) : async () => undefined;
      if (r.kind === 'work') return async (t) => void (await t.call('submit_result', { summary: 'x' }));
      return review(9);
    };
    return results;
  };
  const own = (extra: Record<string, unknown> = {}) => ({ type: 'own_stakeholders', brief: 'who matters', needs_browser: false, acceptance_criteria: ['c'], ...extra });

  it('a Codex worker for an own_stakeholders task is kept, and the task is created when no provider can run offline', async () => {
    const s = setup();
    const results = propose(s, [own({ model: CODEX })]);
    const rr = await startPhase('ws_a', 'stakeholders', s.deps);
    expect(s.store.tasks.list({ runId: rr.id })[0]!.model).toEqual(CODEX);
    expect(results[0]).toMatchObject({ accepted: [{ type: 'own_stakeholders', model: CODEX }] });
    expect((results[0] as { accepted: Array<Record<string, unknown>> }).accepted[0]).not.toHaveProperty('offlineSwapFrom');

    const u = setup({ config: (c) => {
      codexOnly(c);
      for (const role of ['orchestrator', 'interviewer', 'reviewer', 'synthesizer', 'persona'] as const) c.roles[role] = CODEX;
      c.roles.workers = { default: CODEX };
    } });
    const accepted = propose(u, [own()]);
    const rr2 = await startPhase('ws_a', 'stakeholders', u.deps);
    expect(u.store.tasks.list({ runId: rr2.id }).map((t) => [t.type, t.model])).toEqual([['own_stakeholders', CODEX]]);
    expect(accepted[0]).toMatchObject({ rejected: [] });
    expect(harnessEvents(u, 'offline_model_unavailable')).toEqual([]);
  });

  it('config warnings: stakeholders on and no enabled provider can run offline (reads by own stakeholders and their learning are skipped)', () => {
    const cfg = structuredClone(defaultConfig);
    expect(configWarnings(cfg)).toEqual([]);
    codexOnly(cfg);
    expect(configWarnings(cfg)).toEqual([expect.stringContaining('stakeholders')]);
    expect(configWarnings(cfg)[0]).toMatch(/reads by own stakeholders/);
    expect(configWarnings(cfg)[0]).not.toMatch(/research/);
    cfg.stakeholders = { enabled: false };
    expect(configWarnings(cfg)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// item 3

describe('save_stakeholder only in stakeholder tasks', () => {
  it('a run of another task type, or of no task, is refused with the reason', async () => {
    const s = setup();
    const art = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'leadership page' }).id;
    for (const type of ['own_company_audit', 'public_filings', 'news_scan'] as const) {
      const r = await s.handle(ctxOf(addTask(s.store, { type })), 'save_stakeholder', saveInput([art]));
      expect(r, type).toMatchObject({ ok: false, error: expect.stringContaining(`not available in a ${type} task`) });
    }
    expect(await s.handle(ctxOf(undefined), 'save_stakeholder', saveInput([art]))).toMatchObject({ ok: false, error: expect.stringContaining('only in') });
    expect(s.store.personas.list({ workspaceId: 'ws_a' })).toEqual([]);
    expect((await s.handle(ctxOf(stakeholderTask(s)), 'save_stakeholder', saveInput([art]))).ok).toBe(true);
  });

  it('the company-audit and filings notes ask only to capture the public pages', () => {
    for (const type of ['own_company_audit', 'public_filings'] as const) {
      const prompt = workerSystemPrompt(defaultConfig, 'worker', false, type);
      const note = prompt.split('\n').find((l) => l.startsWith('For this task:'))!;
      expect(note).toMatch(/capture the public leadership, ownership and investor pages/);
      expect(note).not.toMatch(/save_stakeholder|save (the |each )?stakeholder/i);
      expect(note).toMatch(/not here/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// item 4

describe('stakeholders.enabled: false', () => {
  it('skips the stakeholders phase: no orchestrator, no tasks, no question round; recorded as a harness Decision', async () => {
    const s = setup({ config: (c) => (c.stakeholders = { enabled: false }) });
    s.store.personas.insert({
      id: 'per_cfo', workspaceId: 'ws_a', slug: 'stk-cfo', segment: 'CFO', profile: {}, agentMdPath: '/tmp/x.md', version: 1, kind: 'stakeholder',
      stakeholderType: 'leader', subjectKind: 'own', disclosure: 'hidden', status: 'verified',
    });
    const rr = await startPhase('ws_a', 'stakeholders', s.deps);
    expect(rr.status).toBe('done');
    expect(s.requests).toEqual([]);
    expect(s.store.tasks.list({ runId: rr.id })).toEqual([]);
    expect(stakeholderRepos(s.store).questions.list({ workspaceId: 'ws_a' })).toEqual([]);
    expect(harnessEvents(s, 'phase_skipped').map((d) => d.payload)).toEqual([
      expect.objectContaining({ researchRunId: rr.id, phase: 'stakeholders', reason: expect.stringContaining('stakeholders.enabled') }),
    ]);
    // switched back on, the same phase plans as usual
    s.config.stakeholders = { enabled: true };
    s.state.pick = (r) => (r.kind === 'orchestrate' ? async () => undefined : undefined);
    await startPhase('ws_a', 'stakeholders', s.deps);
    expect(s.requests.map((r) => r.kind)).toEqual(['orchestrate']);
    expect(stakeholderRepos(s.store).questions.list({ workspaceId: 'ws_a' }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// item 5

const stakeholder = (s: ReturnType<typeof setup>, slug: string, extra: Partial<Persona> = {}): Persona => {
  const p = s.store.personas.insert({
    id: newId('per'), workspaceId: 'ws_a', slug, segment: slug, version: 1, status: 'verified', agentMdPath: join(s.dir, 'personas', `${slug}.md`),
    profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${slug}`, confidence: 0.6, evidence: [] }])),
    kind: 'stakeholder', stakeholderType: 'leader', subjectKind: slug.startsWith('stk-rival-') ? 'competitor' : 'own',
    ...(slug.startsWith('stk-rival-') ? { subjectId: 'cmp_rival' } : {}), relation: 'approves budgets', disclosure: 'open', ...extra,
  });
  writeAgentMd(s.store, p);
  return p;
};

describe('own stakeholders read and learn offline', () => {
  const readScript = (req: AgentRequest): FakeScript => async (t) => {
    const rec = /^Recommendation id: (\S+)$/m.exec(req.prompt)![1]!;
    const own = !/^name: stk-rival-/m.test(req.systemPrompt);
    await t.call('submit_stakeholder_read', {
      recommendation_id: rec, stance: own ? 'approve' : 'watch', conditions: [], concerns: [], reasoning: 'r', would_change_mind: 'w',
    });
  };
  const seed = (s: ReturnType<typeof setup>) => {
    stakeholder(s, 'stk-cfo');
    stakeholder(s, 'stk-rival-ceo');
    s.store.recommendations.insert({
      id: 'rec_1', workspaceId: 'ws_a', title: 'Raise prices', summary: 's', criteria: {}, findingIds: [], priority: 3, personaFeedback: [], createdAt: NOW, status: 'verified',
    });
  };

  it('an own stakeholder\'s read runs offline on the persona model, swapped for one that can; a competitor\'s as before', async () => {
    const s = setup({ config: (c) => (c.roles.persona = CODEX), pick: (r) => (r.role === 'persona' ? readScript(r) : undefined) });
    seed(s);
    const runs = spyRuns(s);
    expect(await runStakeholderReads('ws_a', s.deps)).toMatchObject({ reads: 2, missing: [] });
    const bySlug = (slug: string) => runs.find((o) => o.systemPrompt.includes(`name: ${slug}`))!;
    expect(bySlug('stk-cfo')).toMatchObject({ offline: true, ctx: { model: { provider: 'claude' } } });
    expect(bySlug('stk-rival-ceo').offline).toBeUndefined();
    expect(bySlug('stk-rival-ceo').ctx.model).toEqual(CODEX);
  });

  it('with no provider that can run offline, an own stakeholder\'s reads are skipped with one harness Decision', async () => {
    const s = setup({ config: (c) => {
      codexOnly(c);
      c.roles.persona = CODEX;
    }, pick: (r) => (r.role === 'persona' ? readScript(r) : undefined) });
    seed(s);
    stakeholder(s, 'stk-ops');
    const runs = spyRuns(s);
    const report = await runStakeholderReads('ws_a', s.deps);
    expect(report.reads).toBe(1);
    expect(runs.map((o) => o.offline)).toEqual([undefined]);
    const why = harnessEvents(s, 'stakeholder_reads_offline_unavailable');
    expect(why).toHaveLength(1);
    expect((why[0]!.payload as { personaIds: string[] }).personaIds).toHaveLength(2);
  });

  const learn = (personaId: string): FakeScript => async (t) => {
    await t.call('submit_persona_learning', { persona_id: personaId, assumption: 'a', proposals: [] });
  };
  const learningSetup = (configure: (c: BifConfig) => void) => {
    const s = setup({ config: configure });
    s.state.pick = (r) => (r.role === 'retro' ? learn(/persona_id `(\w+)`/.exec(r.prompt)![1]!) : undefined);
    const cfo = stakeholder(s, 'stk-cfo');
    const rival = stakeholder(s, 'stk-rival-ceo');
    for (const p of [cfo, rival]) addNote(s.store, 'tester', 'ws_a', { personaId: p.id, text: 'She only signs off on things that pay back within a year.' });
    return { s, cfo, rival };
  };

  it('a learning run for an own stakeholder runs offline on the learning model, swapped for one that can; a competitor\'s as before', async () => {
    const { s, cfo, rival } = learningSetup((c) => (c.personaLearning = { model: CODEX }));
    const runs = spyRuns(s);
    await runPersonaLearning(s.deps, 'ws_a');
    const of = (id: string) => runs.find((o) => o.prompt.includes(`persona_id \`${id}\``))!;
    expect(of(cfo.id)).toMatchObject({ offline: true, ctx: { model: { provider: 'claude' } } });
    expect(of(rival.id).offline).toBeUndefined();
    expect(of(rival.id).ctx.model).toEqual(CODEX);
  });

  it('with no provider that can run offline, an own stakeholder\'s learning run is skipped with one harness Decision', async () => {
    const { s, cfo, rival } = learningSetup((c) => {
      codexOnly(c);
      c.personaLearning = { model: CODEX };
    });
    const runs = spyRuns(s);
    await runPersonaLearning(s.deps, 'ws_a');
    expect(runs.map((o) => o.prompt.includes(`persona_id \`${rival.id}\``))).toEqual([true]);
    const why = harnessEvents(s, 'persona_learning_offline_unavailable');
    expect(why).toHaveLength(1);
    expect(why[0]!.payload).toMatchObject({ personaIds: [cfo.id] });
  });
});

// ---------------------------------------------------------------------------------------------------
// item 6

describe('the export counts own-stakeholder research as internal', () => {
  it('every Decision of an own_stakeholders task and feedback on its runs is left out by default and included with the switch', () => {
    const s = setup();
    s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'stakeholders', status: 'done', startedAt: NOW });
    const own = stakeholderTask(s, 'own_stakeholders', { status: 'verified', runId: 'rrun_1' });
    const news = addTask(s.store, { status: 'verified', runId: 'rrun_1' });
    const run = (id: string, task: Task, role: 'worker' | 'reviewer') =>
      s.store.agentRuns.insert({
        id, workspaceId: 'ws_a', taskId: task.id, role, model: CLAUDE_SONNET, token: `tok_${id}`, status: 'done', startedAt: NOW, endedAt: NOW,
        promptVersion: 'pv', taskType: task.type,
      });
    const decision = (agentRunId: string, role: 'worker' | 'reviewer', kind: 'decision' | 'review', payload: Record<string, unknown>, refs: string[] = []) =>
      s.store.decisions.insert({ id: newId('dec'), workspaceId: 'ws_a', agentRunId, role, model: CLAUDE_SONNET, kind, payload, refs, promptVersion: 'pv', createdAt: NOW });
    run('arun_w', own, 'worker');
    run('arun_r', own, 'reviewer');
    run('arun_n', news, 'worker');
    const internal = [
      decision('arun_w', 'worker', 'decision', { tool: 'log_decision', what: 'the CFO decides' }),
      decision('arun_r', 'reviewer', 'review', { tool: 'submit_review', score: 9, issues: [] }, [own.id]),
      decision('arun_w', 'worker', 'decision', { tool: 'harness', event: 'worker_run_failed' }, [own.id]),
    ];
    const kept = decision('arun_n', 'worker', 'decision', { tool: 'log_decision', what: 'news' });
    const fb = recordFeedback(s.store, { workspaceId: 'ws_a', kind: 'include_override', targetType: 'persona', targetId: 'per_saved_by_own_research', afterJson: { include: true }, agentRunId: 'arun_w' });

    const parse = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; decision?: { id: string }; feedbackEvent?: { id: string } });
    const out = exportTrainingDataWithSummary('ws_a', { store: s.store });
    const ids = parse(out.jsonl).map((l) => l.decision?.id ?? l.feedbackEvent?.id);
    for (const d of internal) expect(ids).not.toContain(d.id);
    expect(ids).not.toContain(fb.id);
    expect(ids).toContain(kept.id);
    expect(out.summary.excludedJudgments.byCause.find((c) => c.cause === 'internal')!.count).toBe(internal.length);
    expect(out.summary.excludedOtherLines.byCause.find((c) => c.cause === 'internal')!.count).toBeGreaterThanOrEqual(1);

    const all = parse(exportTrainingDataWithSummary('ws_a', { store: s.store }, true).jsonl).map((l) => l.decision?.id ?? l.feedbackEvent?.id);
    for (const d of internal) expect(all).toContain(d.id);
    expect(all).toContain(fb.id);
  });
});

// ---------------------------------------------------------------------------------------------------
// items 7 and 8

describe('save_stakeholder label hygiene and caps', () => {
  it('a label with a newline or tabs is stored on one line, so it cannot add a heading to agent.md or a line to a question', async () => {
    const s = setup();
    const art = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'org chart' }).id;
    const r = await s.handle(ctxOf(stakeholderTask(s)), 'save_stakeholder', saveInput([art], {
      label: '  Chief\tfinancial\n# Injected heading\r\n officer ', relation: 'approves\n\n## Rules\nbudgets',
    }));
    expect(r.ok).toBe(true);
    const p = s.store.personas.list({ workspaceId: 'ws_a' })[0]!;
    expect(p.segment).toBe('Chief financial # Injected heading officer');
    expect(p.relation).toBe('approves ## Rules budgets');
    const md = readFileSync(p.agentMdPath, 'utf8');
    expect(md).not.toMatch(/^# Injected heading/m);
    expect(md).not.toMatch(/^## Rules/m);
    const questions = ensureQuestions(s.store, 'ws_a').filter((q) => q.personaId === p.id);
    expect(questions.length).toBe(4);
    for (const q of questions) expect(q.text).not.toMatch(/\n/);
  });

  it('a label over 80 characters is refused', async () => {
    const s = setup();
    const art = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'org chart' }).id;
    const r = await s.handle(ctxOf(stakeholderTask(s)), 'save_stakeholder', saveInput([art], { label: 'x'.repeat(81) }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('label') });
    expect((await s.handle(ctxOf(stakeholderTask(s)), 'save_stakeholder', saveInput([art], { label: 'x'.repeat(80) }))).ok).toBe(true);
  });

  it('the own cap counts only stakeholders that are not failed and not superseded', async () => {
    const s = setup({ config: (c) => (c.stakeholders = { maxOwn: 1 }) });
    const art = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'org chart' }).id;
    stakeholder(s, 'stk-old-cfo', { status: 'failed', disclosure: 'hidden' });
    stakeholder(s, 'stk-older-cfo', { status: 'superseded', disclosure: 'hidden' });
    const task = stakeholderTask(s);
    expect((await s.handle(ctxOf(task), 'save_stakeholder', saveInput([art]))).ok).toBe(true);
    expect(await s.handle(ctxOf(task), 'save_stakeholder', saveInput([art], { label: 'Board' }))).toMatchObject({ ok: false, error: expect.stringContaining('at most 1') });
  });
});
