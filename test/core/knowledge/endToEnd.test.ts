/**
 * KS-8 end-to-end (fake adapter, real supervisor, real scheduler, real tool handlers):
 * interview → upload → first scheduled run (deep dives + synthesis) → the user excludes a fact → second
 * scheduled run confirms / replaces / retracts → "what changed" → synthesis sees only current usable
 * facts → export respects upload exposure (the per-task bound and the citation chain) → every prompt
 * read is logged before its run starts → each outcome label once → lesson signals → metrics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setIncludeOverride } from '../../../src/core/feedback/actions.js';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { interviewToolHandlers, sendInterviewMessage, type InterviewerFake } from '../../../src/core/interview/interview.js';
import { synthesisBriefing } from '../../../src/core/knowledge/briefing.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { knowledgeMetrics } from '../../../src/core/knowledge/metrics.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { collectLessonSignals } from '../../../src/core/learning/lessons/signals.js';
import { registerFeedbackOutcomes } from '../../../src/core/learning/feedbackOutcomes.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import type { DecisionOutcome } from '../../../src/core/learning/types.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { startScheduler } from '../../../src/core/scheduler/scheduler.js';
import { recordWhatChanged } from '../../../src/core/scheduler/whatChanged.js';
import { exportTrainingData, exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import { scoringToolHandlers } from '../../../src/core/scoring/priority.js';
import type { Store } from '../../../src/core/store/db.js';
import { attachEventRecorders } from '../../../src/core/telemetry/recorders.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { AgentRun, Decision, Finding, Role } from '../../../src/core/types.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';
import { researchSetup, review, revise } from '../helpers/research.js';

const opened: Store[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const s of opened.splice(0)) s.close();
});

const DAY = 86_400_000;
const C = {
  price: 'Acme Pro plan costs $10 per month',
  free: 'Acme offers a free tier',
  plans: 'Acme sells three plans',
  staff: 'Acme employs about 50 people',
  four: 'Acme sells four plans',
  filings: 'Acme publishes churn figures in its annual report',
};
const UPLOAD_TEXT = 'Confidential board memo: churn rose to 14 percent.';

type PromptCheck = { kind: AgentRequest['kind'] | 'interview'; role: Role; runId: string; expected: number; logged: number; versionOk: boolean };

describe('KS-8 end to end: interview → research → scheduled re-run → what changed → synthesis → export', () => {
  it('keeps living facts, logs every prompt read before its run, and keeps upload-exposed work out of the export', async () => {
    const env = researchSetup(opened, {
      extraHandlers: () => ({ ...researchToolHandlers(), ...interviewToolHandlers(), ...scoringToolHandlers() }), // as src/api/main.ts
      config: (c) => {
        c.lessons = { ...(c.lessons ?? {}), retro: { enabled: false } }; // only the research schedule runs
      },
    });
    const { store } = env;
    // Boot wiring, as src/api/main.ts: human actions → outcomes; bus events persisted.
    cleanups.push(registerFeedbackOutcomes());
    const recorders = attachEventRecorders({ store, events: env.events, config: env.config });
    cleanups.push(() => recorders.stop());
    const ws = createWorkspace(store, { name: 'Acme', sector: 'saas' });
    const knowledge = knowledgeRepos(store);
    const fact = (claim: string): Finding => store.findings.list({ claim })[0]!;

    // --- prompt reads are logged before each run starts --------------------------------------------
    const checks: PromptCheck[] = [];
    const runningRun = (role: Role, taskId?: string): AgentRun =>
      store.agentRuns
        .list({ workspaceId: ws.id })
        .filter((r) => r.status === 'running' && r.role === role && (taskId ? r.taskId === taskId : !r.taskId))
        .at(-1)!;
    const promptRows = (agentRunId: string) => knowledge.retrievalEvents.list({ agentRunId }).filter((e) => e.tool === 'prompt_context');
    const checkReads = (kind: PromptCheck['kind'], role: Role, expected: number, taskId?: string) => {
      const run = runningRun(role, taskId);
      const rows = promptRows(run.id);
      checks.push({ kind, role, runId: run.id, expected, logged: rows.length, versionOk: rows.every((e) => e.promptVersion === run.promptVersion) });
    };
    const interviewer = (body: InterviewerFake): InterviewerFake => async (tools) => {
      checkReads('interview', 'interviewer', -1); // the interviewer's reads are not on a request; checked below
      return body(tools);
    };

    // --- 1. interview -------------------------------------------------------------------------------
    await sendInterviewMessage(ws.id, 'We run Acme, a SaaS company. Enterprise renewals are down this year.', {
      ...env,
      fake: interviewer(async (tools) => {
        await tools.call('update_profile', { patch: { basics: { sector: 'saas', geography: 'EU' }, revenue_model: 'subscriptions' } });
        await tools.call('save_symptom', { kind: 'symptom', title: 'enterprise renewals down', detail: 'Renewal rate fell this year', criteria: { severity: 4, trend: '↓', causeConfidence: 40 } });
        return 'What changed in your pricing this year?';
      }),
    });
    const symptom = store.symptoms.list({ workspaceId: ws.id })[0]!;
    expect(symptom.title).toBe('enterprise renewals down');
    const up = uploadInternal(ws.id, { name: 'board.txt', bytes: new TextEncoder().encode(UPLOAD_TEXT), mime: 'text/plain' }, env);
    await ingestorFor(env).idle();

    // --- the fake agents ------------------------------------------------------------------------------
    let runNo = 1;
    const orchestratorPrompts: Array<{ run: number; phase: string; prompt: string }> = [];
    const synthPrompts: string[] = [];
    const rejectedCitations: string[] = [];
    async function capture(tools: ToolClient, req: AgentRequest, content: string): Promise<string> {
      const { artifactId } = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content })) as { artifactId: string };
      if (!knowledge.artifactCaptures.list({ artifactId }).some((c) => c.taskId === req.task!.id)) {
        knowledge.artifactCaptures.insert({ id: newId('cap'), artifactId, workspaceId: req.workspaceId, taskId: req.task!.id, capturedAt: new Date().toISOString() });
      }
      return artifactId;
    }
    const taskInput = (type: string, brief: string, extra: Record<string, unknown> = {}) => ({
      type, brief, subject: 'Acme', needs_browser: false, acceptance_criteria: ['cites a saved page'], ...extra,
    });
    let filingsReviews = 0;

    const script = (r: AgentRequest): FakeScript | undefined => {
      if (r.kind === 'orchestrate') {
        const phase = store.researchRuns.get(r.researchRunId!)!.phase;
        orchestratorPrompts.push({ run: runNo, phase, prompt: r.prompt });
        if (r.round > 1) return async () => {};
        if (phase === 'synthesis') {
          return async (tools) => void (await tools.call('propose_tasks', { tasks: [taskInput('synthesize_recommendations', `recommendations, run ${runNo}`)] }));
        }
        if (runNo === 1) {
          return async (tools) =>
            void (await tools.call('propose_tasks', {
              tasks: [taskInput('news_scan', 'pricing page and plans'), taskInput('public_filings', 'churn disclosures')],
            }));
        }
        const ids = [C.price, C.free, C.plans].map((c) => fact(c).id);
        return async (tools) => void (await tools.call('propose_tasks', { tasks: [taskInput('news_scan', 're-check pricing', { recheck_fact_ids: ids })] }));
      }
      if (r.kind === 'review') {
        // The filings task fails its first review once (a review issue → a lesson signal).
        if (r.task!.type === 'public_filings' && filingsReviews++ === 0) return review(3, [{ class: 'substantive', description: 'say which filing' }]);
        return review(9);
      }
      if (r.kind === 'revise') return revise('fix')(r);
      if (r.kind !== 'work') return undefined;
      const t = r.task!;
      if (t.type === 'synthesize_recommendations') {
        synthPrompts.push(r.prompt);
        return async (tools) => {
          if (runNo === 1) {
            await tools.call('save_recommendation', { title: 'Publish the price', summary: 'Keep the $10 Pro price visible', finding_ids: [fact(C.price).id] });
          } else {
            // Citing a retracted, a replaced or a user-excluded fact is refused.
            for (const c of [C.free, C.plans, C.staff]) {
              try {
                await tools.call('save_recommendation', { title: 'x', summary: 'x', finding_ids: [fact(c).id] });
              } catch (e) {
                rejectedCitations.push(String((e as Error).message));
              }
            }
            await tools.call('save_recommendation', { title: 'Explain churn', summary: 'Use the churn disclosure', finding_ids: [fact(C.filings).id, fact(C.four).id] });
          }
          await tools.call('submit_result', { summary: `synthesis ${runNo}` });
        };
      }
      if (t.type === 'public_filings') {
        // Reads the upload (this task becomes upload-exposed), saves a public finding.
        return async (tools) => {
          await tools.call('read_artifact', { artifact_id: up.id, mode: 'text' });
          const a = await capture(tools, r, 'Acme annual report: churn figures are published every year.');
          await tools.call('save_finding', { claim: C.filings, subject: 'Acme', evidence: [a], relation: 'new' });
          await tools.call('submit_result', { summary: 'filings' });
        };
      }
      if (runNo === 1) {
        return async (tools) => {
          const a = await capture(tools, r, 'Pricing: Pro $10 per month. Free tier available. Three plans. About 50 employees.');
          for (const claim of [C.price, C.free, C.plans, C.staff]) await tools.call('save_finding', { claim, subject: 'Acme', evidence: [a], relation: 'new' });
          await tools.call('submit_result', { summary: 'pricing v1' });
        };
      }
      return async (tools) => {
        const a = await capture(tools, r, 'Pricing: Pro $10 per month. No free tier. Four plans.');
        await tools.call('confirm_finding', { finding_id: fact(C.price).id, evidence: [a] });
        await tools.call('save_finding', { claim: C.four, subject: 'Acme', evidence: [a], relation: { replaces: fact(C.plans).id } });
        await tools.call('retract_finding', { finding_id: fact(C.free).id, reason: 'free tier removed', evidence: [a] });
        await tools.call('submit_result', { summary: 'pricing v2' });
      };
    };
    env.state.pick = (r) => {
      const s = script(r);
      if (!s) return undefined;
      return async (tools) => {
        checkReads(r.kind, r.role, r.promptReads?.length ?? 0, r.task?.id);
        await s(tools);
      };
    };

    // --- 2. two scheduled runs through the real scheduler ----------------------------------------------
    let clock = Date.now();
    store.schedules.insert({
      id: 'sch_1', workspaceId: ws.id, name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives', 'synthesis'], enabled: true,
      activatedAt: new Date(clock - 8 * DAY).toISOString(),
    });
    const scheduler = startScheduler({ ...env.deps, intervalMs: 3_600_000 }, () => clock);
    await scheduler.idle();
    const runs1 = store.researchRuns.list({ workspaceId: ws.id });
    expect(runs1.map((x) => [x.phase, x.status, x.scheduleId])).toEqual([['deep_dives', 'done', 'sch_1'], ['synthesis', 'done', 'sch_1']]);
    expect(store.tasks.list({ workspaceId: ws.id }).map((x) => x.status)).toEqual(['verified', 'verified', 'verified']);

    // The user excludes the head-count fact from synthesis (a human signal on the worker's output).
    setIncludeOverride(store, 'finding', fact(C.staff).id, false, { actor: 'local-user', reason: 'not relevant' });

    runNo = 2;
    clock += 8 * DAY;
    await scheduler.tick();
    await scheduler.idle();
    scheduler.stop();
    const all = store.researchRuns.list({ workspaceId: ws.id });
    expect(all).toHaveLength(4);
    const runs2 = all.slice(2);
    expect(runs2.every((x) => x.status === 'done' && x.scheduleId === 'sch_1')).toBe(true);

    // A follow-up interview turn (its drill-down now carries usable facts).
    await sendInterviewMessage(ws.id, 'What did you find?', { ...env, fake: interviewer(async () => 'Prices held; the free tier is gone.') });

    // --- 3. living facts: confirm / replace / retract, nothing deleted -----------------------------------
    const [price, free, plans, staff, four, filings] = [C.price, C.free, C.plans, C.staff, C.four, C.filings].map(fact);
    expect(store.findings.list({ workspaceId: ws.id })).toHaveLength(6);
    expect(price).toMatchObject({ lifecycle: 'current', confirmCount: 1, status: 'verified' });
    expect(free!.lifecycle).toBe('retracted');
    expect(plans!.lifecycle).toBe('replaced');
    expect(four).toMatchObject({ lifecycle: 'current', replacesId: plans!.id, status: 'verified' });
    expect(staff).toMatchObject({ lifecycle: 'current', includeInSynthesis: false });
    // The second deep-dive orchestrator saw the first run's changes; its worker the claims to re-check.
    const orch2 = orchestratorPrompts.find((p) => p.run === 2 && p.phase === 'deep_dives')!.prompt;
    expect(orch2).toContain('Changes since the last run');
    expect(orch2).toContain(`[${price!.id}]`);

    // --- 4. what changed, from fact lineage -------------------------------------------------------------
    const whatChanged = store.decisions
      .list({ workspaceId: ws.id })
      .filter((d) => (d.payload as { event?: string }).event === 'what_changed');
    const deepDive = whatChanged.find((d) => (d.payload as { phase?: string }).phase === 'deep_dives')!;
    expect(deepDive.payload).toMatchObject({
      prevRunId: runs1[0]!.id, nextRunId: runs2[0]!.id, newFindings: [],
      replaced: [{ from: plans!.id, to: four!.id }], retracted: [free!.id], confirmed: 1,
    });
    expect(whatChanged.map((d) => (d.payload as { phase: string }).phase).sort()).toEqual(['deep_dives', 'synthesis']);

    // --- 5. synthesis uses only current, usable facts -----------------------------------------------------
    const synth2 = synthPrompts[1]!;
    for (const f of [price!, four!, filings!]) expect(synth2).toContain(`[${f.id}]`);
    for (const f of [free!, plans!, staff!]) expect(synth2).not.toContain(f.id);
    expect(synth2).not.toContain(C.free);
    expect(synth2).not.toContain(C.plans);
    expect(synth2).toContain(symptom.id); // interview symptoms reach synthesis
    expect(rejectedCitations).toHaveLength(3);
    for (const m of rejectedCitations) expect(m).toMatch(/not verified/);
    const recs = store.recommendations.list({ workspaceId: ws.id });
    expect(recs.map((r) => r.findingIds)).toEqual([[price!.id], [filings!.id, four!.id]]);

    // --- 6. every prompt read was logged before its run started -------------------------------------------
    const fromRequests = checks.filter((c) => c.kind !== 'interview');
    expect(fromRequests.length).toBeGreaterThanOrEqual(16);
    for (const c of fromRequests) {
      expect({ ...c, logged: c.logged }).toEqual({ ...c, logged: c.expected });
      expect(c.versionOk).toBe(true);
    }
    // Every orchestrator, worker, synthesizer and reviewer run of a briefed step had at least one row.
    for (const kind of ['orchestrate', 'review'] as const) {
      expect(fromRequests.filter((c) => c.kind === kind).every((c) => c.logged > 0)).toBe(true);
    }
    expect(fromRequests.filter((c) => c.role === 'synthesizer').every((c) => c.logged > 0)).toBe(true);
    const recheckWorker = fromRequests.find((c) => c.role === 'worker' && store.agentRuns.get(c.runId)!.taskId === store.tasks.list({ runId: runs2[0]!.id })[0]!.id)!;
    expect(recheckWorker.logged).toBeGreaterThan(0);
    // The follow-up interview turn: its drill-down rows were there before the agent ran.
    const interviews = checks.filter((c) => c.kind === 'interview');
    expect(interviews).toHaveLength(2);
    expect(interviews[1]!.logged).toBeGreaterThan(0);
    expect(interviews[1]!.versionOk).toBe(true);
    expect(promptStoreGaps(store)).toEqual([]);

    // --- 7. export respects upload exposure: per-task bound and citation chain ------------------------------
    const tasks1 = store.tasks.list({ runId: runs1[0]!.id });
    const pricingTask = tasks1.find((x) => x.type === 'news_scan')!;
    const filingsTask = tasks1.find((x) => x.type === 'public_filings')!;
    const synthTask1 = store.tasks.list({ runId: runs1[1]!.id })[0]!;
    const synthTask2 = store.tasks.list({ runId: runs2[1]!.id })[0]!;
    const runsOf = (taskId: string) => store.agentRuns.list({ taskId });
    const decisionsOf = (taskId: string): Decision[] => runsOf(taskId).flatMap((r) => store.decisions.list({ agentRunId: r.id }));
    const filingsWorker = runsOf(filingsTask.id).find((r) => r.role === 'worker')!;
    expect(runIsUploadExposed(store, filingsWorker.id)).toBe(true);
    // Same research run, other task: not exposed (the bound is the task).
    expect(runsOf(pricingTask.id).some((r) => runIsUploadExposed(store, r.id))).toBe(false);
    // Shown the exposed task's finding in a briefing: not exposed either.
    expect(runsOf(synthTask2.id).some((r) => runIsUploadExposed(store, r.id))).toBe(false);

    type Line = { type: string; decision?: Decision };
    const exported = (includeUploads = false) =>
      exportTrainingData(ws.id, { store }, includeUploads)
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Line)
        .filter((l) => l.type === 'decision')
        .map((l) => l.decision!.id);
    const out = exported();
    const jsonl = exportTrainingData(ws.id, { store });
    expect(jsonl).not.toContain('churn rose to 14 percent');
    for (const d of decisionsOf(filingsTask.id)) expect(out).not.toContain(d.id); // exposed run and its task
    for (const d of decisionsOf(synthTask2.id)) expect(out).not.toContain(d.id); // cites an output of that task
    for (const taskId of [pricingTask.id, synthTask1.id]) {
      const ds = decisionsOf(taskId);
      expect(ds.length).toBeGreaterThan(0);
      expect(out).toEqual(expect.arrayContaining(ds.map((d) => d.id))); // the bound: nothing further
    }
    expect(exported(true)).toEqual(expect.arrayContaining([...decisionsOf(filingsTask.id), ...decisionsOf(synthTask2.id)].map((d) => d.id)));
    const { summary } = exportTrainingDataWithSummary(ws.id, { store });
    const byCause = Object.fromEntries(summary.excludedJudgments.byCause.map((c) => [c.cause, c.count]));
    expect(byCause.exposed_run).toBeGreaterThan(0);
    expect(byCause.exposed_task).toBeGreaterThan(0);
    expect(byCause.exposed_output).toBeGreaterThan(0);

    // --- 8. every outcome label once ----------------------------------------------------------------------
    const key = (o: DecisionOutcome) => `${o.subjectId ?? o.decisionId}|${o.targetId ?? ''}|${o.outcome}|${o.label}|${o.source}|${o.sourceKey ?? ''}`;
    const snapshot = () => listOutcomes(store, { includeExperiments: true }).map(key).sort();
    const first = snapshot();
    expect(new Set(first).size).toBe(first.length);
    const lineage = listOutcomes(store).filter((o) => o.source === 'fact_lineage').map((o) => `${o.subjectId}|${o.label}`);
    expect(lineage.filter((x) => x === `${price!.id}|confirmed`)).toHaveLength(1);
    expect(lineage.filter((x) => x === `${plans!.id}|changed`)).toHaveLength(1);
    expect(lineage.filter((x) => x === `${free!.id}|retracted`)).toHaveLength(1);
    const labelsOf = (id: string) => listOutcomes(store).filter((o) => o.subjectId === id || o.targetId === id).map((o) => o.label);
    expect(labelsOf(staff!.id).filter((l) => l === 'user-rejected')).toHaveLength(1); // the user's exclusion
    // Each finished task's review verdict once.
    for (const t of store.tasks.list({ workspaceId: ws.id })) {
      expect(listOutcomes(store, { taskId: t.id }).filter((o) => o.source === 'review_loop')).toHaveLength(1);
    }
    // Replays add nothing: the what-changed step again, and another briefing over the same store.
    recordWhatChanged({ store, config: env.config }, 'sch_1', runs2);
    synthesisBriefing({ store, config: env.config, now: new Date() }, { workspaceId: ws.id, role: 'synthesizer' });
    expect(snapshot()).toEqual(first);

    // --- 9. lesson signals are collected ----------------------------------------------------------------------
    const signals = collectLessonSignals(store, ws.id, {}, env.config).map((s) => `${s.role}|${s.category}|${s.unit}`);
    expect(signals).toEqual(expect.arrayContaining([
      `worker|review:substantive:public_filings|${filingsTask.id}`,
      `worker|feedback:exclude:finding|${pricingTask.id}`,
      `worker|outcome:user-rejected|${pricingTask.id}`,
    ]));

    // --- 10. metrics report sensible numbers ---------------------------------------------------------------
    const m = knowledgeMetrics(store, { workspaceId: ws.id, config: env.config, dataDir: env.dir });
    expect(m.store.facts).toEqual({ candidate: 0, current: 4, replaced: 1, retracted: 1, total: 6 });
    expect(m.store.observations).toBeGreaterThanOrEqual(3);
    expect(m.store.artifacts).toBeGreaterThanOrEqual(4); // 3 pages + the upload
    expect(m.store.chunks).toBeGreaterThan(0);
    expect(m.store.fileBytes).toBeGreaterThan(0);
    expect(m.freshness).toMatchObject({ currentFacts: 4, stale: 0, staleShare: 0 });
    const r = m.retrieval;
    expect(r.retrievals).toBe(knowledge.retrievalEvents.list({}).filter((e) => e.role !== 'user').length);
    expect(r.runs).toBeGreaterThan(0);
    expect(r.withUse).toBeGreaterThan(0); // the re-check worker confirmed a fact its briefing showed
    expect(r.hitRate).toBeGreaterThan(0);
    expect(r.hitRate).toBeLessThanOrEqual(1);
    expect(r.retrievedTokens).toBeGreaterThan(0);
    expect(r.usedTokens).toBeGreaterThan(0);
    expect(r.usedTokens).toBeLessThanOrEqual(r.retrievedTokens);
    expect(r.byTool.find((x) => x.tool === 'prompt_context')!.retrievals).toBeGreaterThan(0);
  });
});
