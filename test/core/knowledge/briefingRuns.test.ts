/**
 * KS-5 briefings in real runs (fake adapter, real supervisor): every prompt section that carries store
 * text is a prompt read logged BEFORE the run starts with the run's prompt hash; `propose_tasks` takes
 * `recheck_fact_ids`; reviewer / escalation outputs are fenced briefings; and the design §18 "Recurring"
 * scenario: two scheduled runs → the second confirms, replaces and retracts, and "what changed" comes
 * from fact lineage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { escalationPromptWithReads } from '../../../src/core/escalation/escalation.js';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { runPipeline, startPhase } from '../../../src/core/research/orchestrator.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';
import { addTask, researchSetup, review } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { extraHandlers: () => researchToolHandlers() });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '2026-11-01T00:00:00.000Z' });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: '2026-11-01T00:00:00.000Z' });
  return t;
}
type Env = ReturnType<typeof setup>;

const fact = (env: Env, workspaceId: string, claim: string, evidence: string[] = []) =>
  env.store.findings.insert({
    id: newId('fnd'), workspaceId, runId: 'rrun_seed', taskId: 'tsk_seed', subject: 'Acme', claim, criteria: {}, evidence,
    status: 'verified', createdAt: new Date().toISOString(), lastConfirmedAt: new Date().toISOString(),
  });

const task = (type = 'news_scan', extra: Record<string, unknown> = {}) => ({
  type, brief: `do ${type}`, subject: 'Acme', needs_browser: false, acceptance_criteria: ['criterion'], ...extra,
});

const rows = (env: Env, agentRunId: string) => knowledgeRepos(env.store).retrievalEvents.list({ agentRunId });

describe('briefings are prompt reads, logged before the run starts', () => {
  it('orchestrator: the briefing row exists while the agent runs, lists the facts shown, carries the run prompt hash; upload exposure follows', async () => {
    const env = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('Renewals fell 12% in Q3'), mime: 'text/csv' }, env);
    await ingestorFor(env).idle();
    const pub = fact(env, 'ws_a', 'PUBLIC_FACT Acme sells three plans');
    const fromUpload = fact(env, 'ws_a', 'UPLOAD_FACT renewals fell 12% in Q3', [up.id]);
    expect(env.store.findings.get(fromUpload.id)!.uploadDerived).toBe(true);
    let during = -1;
    env.state.pick = (r): FakeScript | undefined =>
      r.kind === 'orchestrate'
        ? async () => {
            const run = env.store.agentRuns.list({ role: 'orchestrator' }).find((x) => x.status === 'running')!;
            during = rows(env, run.id).length;
          }
        : undefined;
    await startPhase('ws_a', 'deep_dives', env.deps);
    const orch = env.store.agentRuns.list({ role: 'orchestrator' })[0]!;
    expect(during).toBe(1);
    const [row] = rows(env, orch.id);
    expect(row).toMatchObject({ tool: 'prompt_context', role: 'orchestrator', promptVersion: orch.promptVersion, uploadDerived: true, scope: 'node' });
    expect(row!.resultIds.map((x) => x.id)).toEqual(expect.arrayContaining([pub.id, fromUpload.id]));
    expect(row!.tokensReturned).toBeGreaterThan(0);
    const prompt = env.requests.find((r) => r.kind === 'orchestrate')!.prompt;
    expect(prompt).toContain('PUBLIC_FACT');
    expect(prompt).toContain('UPLOAD_FACT renewals fell 12% in Q3 (confirmed');
    expect(prompt).toContain('[upload]');
    expect(runIsUploadExposed(env.store, orch.id)).toBe(true);
    expect(promptStoreGaps(env.store)).toEqual([]);
  });
});

// Design-thread ruling on §12 (after KS-5): prompts list uploads as metadata (id, type, size, date),
// never their titles. Listing them is not a read; opening one is.
describe('uploads in prompts are metadata only', () => {
  async function orchestratorRun(open: boolean) {
    const env = setup();
    const up = uploadInternal('ws_a', { name: 'secret-board-plan.csv', bytes: new TextEncoder().encode('Renewals fell 12% in Q3'), mime: 'text/csv' }, env);
    await ingestorFor(env).idle();
    env.state.pick = (r): FakeScript | undefined =>
      r.kind === 'orchestrate' && r.round === 1
        ? async (tools) => {
            if (open) await tools.call('read_artifact', { artifact_id: up.id, mode: 'text' });
          }
        : undefined;
    await startPhase('ws_a', 'deep_dives', env.deps);
    const run = env.store.agentRuns.list({ role: 'orchestrator' })[0]!;
    return { env, up, run, prompt: env.requests.find((r) => r.kind === 'orchestrate')!.prompt };
  }

  it('an orchestrator run that opens nothing is not upload-exposed; the prompt has no title', async () => {
    const { env, up, run, prompt } = await orchestratorRun(false);
    expect(prompt).toContain(`- ${up.id} (spreadsheet, 23 B, uploaded ${up.capturedAt.slice(0, 10)})`);
    expect(prompt).toContain('Use `expand` or `read_artifact` with an upload id');
    expect(prompt).not.toContain('secret-board-plan');
    expect(prompt).not.toContain('Renewals fell');
    expect(rows(env, run.id).every((r) => !r.uploadDerived && !r.resultIds.some((x) => x.id === up.id))).toBe(true);
    expect(runIsUploadExposed(env.store, run.id)).toBe(false);
  });

  it('opening the upload with read_artifact makes the run upload-exposed', async () => {
    const { env, run } = await orchestratorRun(true);
    expect(rows(env, run.id).some((r) => r.tool === 'read_artifact' && r.uploadDerived)).toBe(true);
    expect(runIsUploadExposed(env.store, run.id)).toBe(true);
  });
});

describe('propose_tasks recheck_fact_ids', () => {
  it('validated in the tree, stored on the proposal, shown to the worker with claims, and logged on its run', async () => {
    const env = setup();
    const mine = fact(env, 'ws_a', 'RECHECK_CLAIM Acme Pro costs $10');
    const theirs = fact(env, 'ws_b', 'OTHER_TREE_CLAIM');
    const results: unknown[] = [];
    env.state.pick = (r): FakeScript | undefined => {
      if (r.kind === 'orchestrate') {
        return r.round === 1
          ? async (tools) => {
              results.push(await tools.call('propose_tasks', { tasks: [task('news_scan', { recheck_fact_ids: [mine.id] }), task('public_filings', { recheck_fact_ids: [theirs.id] })] }));
            }
          : async () => {};
      }
      if (r.kind === 'work') return async (tools) => void (await tools.call('submit_result', { summary: 'checked' }));
      return review(9);
    };
    const rr = await startPhase('ws_a', 'deep_dives', env.deps);
    expect(results[0]).toMatchObject({
      accepted: [{ index: 0, recheckFactIds: [mine.id] }],
      rejected: [{ index: 1, reason: `recheck_fact_ids: finding '${theirs.id}' not found` }],
    });
    const work = env.requests.find((r) => r.kind === 'work')!;
    expect(work.prompt).toMatch(new RegExp(`Re-check:\\n- \\[${mine.id}\\] RECHECK_CLAIM Acme Pro costs \\$10`));
    expect(work.prompt).not.toContain('OTHER_TREE_CLAIM');
    const worker = env.store.agentRuns.list({ taskId: env.store.tasks.list({ runId: rr.id })[0]!.id }).find((x) => x.role === 'worker')!;
    const read = rows(env, worker.id).find((x) => x.tool === 'prompt_context')!;
    expect(read.resultIds.map((x) => x.id)).toContain(mine.id);
    expect(read.promptVersion).toBe(worker.promptVersion);
  });
});

describe('review and escalation outputs are fenced briefings and reads', () => {
  it('the reviewer is shown the task outputs fenced, and the read lists them', async () => {
    const env = setup();
    let t: Task | undefined;
    env.state.pick = (r): FakeScript =>
      r.kind === 'work'
        ? async (tools) => {
            const a = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'Pro costs $10' })) as { artifactId: string };
            await tools.call('save_finding', { claim: 'OUTPUT_CLAIM Pro costs $10', subject: 'Acme', evidence: [a.artifactId], relation: 'new' });
            await tools.call('submit_result', { summary: 'done' });
          }
        : review(9);
    t = addTask(env.store);
    await runTaskWithReview(t, env.deps);
    const finding = env.store.findings.list({ taskId: t.id })[0]!;
    const reviewReq = env.requests.find((r) => r.kind === 'review')!;
    expect(reviewReq.prompt).toMatch(/## Submitted outputs\n[^\n]*untrusted[^\n]*\n<<<EVIDENCE outputs\n### Findings saved by this task\n- \[fnd_\w+\] Acme: OUTPUT_CLAIM/);
    const reviewer = env.store.agentRuns.list({ taskId: t.id }).find((x) => x.role === 'reviewer')!;
    const outputsRow = rows(env, reviewer.id).find((x) => x.query.startsWith('review outputs'))!;
    expect(outputsRow.resultIds.map((x) => x.id)).toContain(finding.id);

    const esc = escalationPromptWithReads(env.store, { ...env.store.tasks.get(t.id)!, status: 'unverified' }, 3, env.config);
    expect(esc.prompt).toContain('<<<EVIDENCE outputs');
    expect(esc.reads.flatMap((r) => r.results.map((x) => x.id))).toContain(finding.id);
  });
});

// ---------------------------------------------------------------------------
// design §18 "Recurring"

/** save_artifact + the capture row of this task (task-scoped evidence for confirm / retract). */
async function capture(env: Env, tools: ToolClient, req: AgentRequest, content: string): Promise<string> {
  const { artifactId } = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content })) as { artifactId: string };
  const caps = knowledgeRepos(env.store).artifactCaptures.list({ artifactId });
  if (!caps.some((c) => c.taskId === req.task!.id)) {
    knowledgeRepos(env.store).artifactCaptures.insert({ id: newId('cap'), artifactId, workspaceId: req.workspaceId, taskId: req.task!.id, capturedAt: new Date().toISOString() });
  }
  return artifactId;
}

describe('recurring scheduled runs (design §18 "Recurring")', () => {
  it('the second scheduled run is planned as re-checks, confirms / replaces / retracts, and "what changed" comes from lineage', async () => {
    const env = setup();
    env.store.schedules.insert({ id: 'sch_1', workspaceId: 'ws_a', name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives'], enabled: true });
    const CLAIMS = ['Acme Pro plan costs $10 per month', 'Acme offers a free tier', 'Acme sells three plans'];
    let run = 1;
    const orchestratorPrompts: string[] = [];
    const workPrompts: string[] = [];
    env.state.pick = (r): FakeScript | undefined => {
      if (r.kind === 'orchestrate') {
        orchestratorPrompts.push(r.prompt);
        if (r.round > 1) return async () => {};
        if (run === 1) return async (tools) => void (await tools.call('propose_tasks', { tasks: [task('news_scan')] }));
        // Run 2: plan "confirm these" from the briefing (the fact ids it lists).
        const ids = CLAIMS.map((c) => env.store.findings.list({ claim: c })[0]!.id);
        for (const id of ids) expect(r.prompt).toContain(`[${id}]`);
        return async (tools) => void (await tools.call('propose_tasks', { tasks: [task('news_scan', { brief: 're-check pricing', recheck_fact_ids: ids })] }));
      }
      if (r.kind === 'work') {
        workPrompts.push(r.prompt);
        return run === 1
          ? async (tools) => {
              const a = await capture(env, tools, r, 'Pricing: Pro $10 per month. Free tier available. Three plans.');
              for (const claim of CLAIMS) await tools.call('save_finding', { claim, subject: 'Acme', evidence: [a], relation: 'new' });
              await tools.call('submit_result', { summary: 'v1' });
            }
          : async (tools) => {
              const [price, free, plans] = CLAIMS.map((c) => env.store.findings.list({ claim: c })[0]!);
              const a = await capture(env, tools, r, 'Pricing: Pro $10 per month. No free tier. Four plans.');
              await tools.call('confirm_finding', { finding_id: price!.id, evidence: [a] });
              await tools.call('save_finding', { claim: 'Acme sells four plans', subject: 'Acme', evidence: [a], relation: { replaces: plans!.id } });
              await tools.call('retract_finding', { finding_id: free!.id, reason: 'free tier removed', evidence: [a] });
              await tools.call('submit_result', { summary: 'v2' });
            };
      }
      return review(9);
    };
    const [rr1] = await runPipeline('ws_a', ['deep_dives'], env.deps, { scheduleId: 'sch_1' });
    expect(rr1!.status).toBe('done');
    run = 2;
    const [rr2] = await runPipeline('ws_a', ['deep_dives'], env.deps, { scheduleId: 'sch_1' });
    expect(rr2!.status).toBe('done');

    const [price, free, plans] = CLAIMS.map((c) => env.store.findings.list({ claim: c })[0]!);
    const four = env.store.findings.list({ claim: 'Acme sells four plans' })[0]!;
    // The second orchestrator saw the changes of the first run; its worker the claims to re-check.
    const orch2 = orchestratorPrompts.find((p, i) => i > 0 && p.includes('Changes since the last run'))!;
    expect(orch2).toContain(`- new [${price!.id}] Acme Pro plan costs $10 per month`);
    expect(workPrompts[1]).toMatch(new RegExp(`Re-check:\\n- \\[${price!.id}\\] Acme Pro plan costs \\$10 per month`));

    // Living facts: one new row (the replacing version), nothing deleted, nothing duplicated.
    expect(env.store.findings.list({ workspaceId: 'ws_a' })).toHaveLength(4);
    expect(env.store.findings.get(price!.id)).toMatchObject({ lifecycle: 'current', confirmCount: 1 });
    expect(env.store.findings.get(free!.id)!.lifecycle).toBe('retracted');
    expect(env.store.findings.get(plans!.id)!.lifecycle).toBe('replaced');
    expect(four).toMatchObject({ lifecycle: 'current', replacesId: plans!.id });

    // "What changed" from fact lineage (backward compatible payload + replaced / retracted / confirmed).
    const wc = env.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string }).event === 'what_changed');
    expect(wc).toHaveLength(1);
    expect(wc[0]!.payload).toMatchObject({
      prevRunId: rr1!.id, nextRunId: rr2!.id, newFindings: [], removedSubjects: [], changedArtifacts: [],
      replaced: [{ from: plans!.id, to: four.id }], retracted: [free!.id], confirmed: 1,
    });
    expect(wc[0]!.refs).toEqual(expect.arrayContaining([four.id, free!.id]));
    // The text-diff hook no longer calls a confirmed / replaced / retracted fact "contradicted".
    expect(listOutcomes(env.store).filter((o) => o.outcome === 'contradicted')).toEqual([]);
    expect(promptStoreGaps(env.store)).toEqual([]);
  });
});
