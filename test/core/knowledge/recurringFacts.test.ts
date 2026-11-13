import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';
import { addTask, researchSetup, review, revise } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return t;
}
type Env = ReturnType<typeof setup>;

/** save_artifact + the capture row KS-1 writes for it (task-scoped evidence for confirm / retract). */
async function capture(env: Env, tools: ToolClient, task: Task, content: string): Promise<string> {
  const { artifactId } = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content })) as { artifactId: string };
  knowledgeRepos(env.store).artifactCaptures.insert({ id: newId('cap'), artifactId, workspaceId: task.workspaceId, taskId: task.id, capturedAt: new Date().toISOString() });
  return artifactId;
}

async function run(env: Env, runId: string, work: (tools: ToolClient, task: Task) => Promise<void>): Promise<{ task: Task; prompts: AgentRequest[] }> {
  const task = addTask(env.store, { runId });
  const prompts: AgentRequest[] = [];
  env.state.pick = (r): FakeScript => {
    prompts.push(r);
    return r.kind === 'work'
      ? async (tools) => {
          await work(tools, task);
          await tools.call('submit_result', { summary: 'done' });
        }
      : review(9);
  };
  return { task: await runTaskWithReview(task, env.deps), prompts };
}

describe('recurring runs keep living facts (design §18 "Recurring"; KS-2 ruling 8)', () => {
  it('a second run confirms, replaces and retracts instead of adding duplicates; nothing is deleted', async () => {
    const env = setup();
    await run(env, 'rrun_1', async (tools, task) => {
      const a = await capture(env, tools, task, 'Pricing: Pro $10 per month. Free tier available. Three plans.');
      for (const claim of ['Acme Pro plan costs $10 per month', 'Acme offers a free tier', 'Acme sells three plans']) {
        await tools.call('save_finding', { claim, subject: 'Acme', evidence: [a] });
      }
    });
    const [price, free, plans] = ['Acme Pro plan costs $10 per month', 'Acme offers a free tier', 'Acme sells three plans'].map(
      (claim) => env.store.findings.list({ claim })[0]!,
    );
    expect([price, free, plans].map((f) => [f!.status, f!.lifecycle])).toEqual([['verified', 'current'], ['verified', 'current'], ['verified', 'current']]);

    const second = await run(env, 'rrun_2', async (tools, task) => {
      const a = await capture(env, tools, task, 'Pricing: Pro $10 per month. No free tier. Four plans: the Pro plan sells four tiers.');
      expect(await tools.call('save_finding', { claim: 'Acme Pro plan costs $10 per month', subject: 'Acme', evidence: [a] })).toMatchObject({ autoConfirmed: true });
      // Similar claim: the handshake returns the old fact instead of saving.
      const hs = (await tools.call('save_finding', { claim: 'Acme sells four plans', subject: 'Acme', evidence: [a] })) as { saved: boolean; candidates: Array<{ id: string }> };
      expect(hs.saved).toBe(false);
      await tools.call('save_finding', {
        claim: 'Acme sells four plans', subject: 'Acme', evidence: [a], relation: { replaces: hs.candidates[0]!.id },
        evidence_refs: [{ artifact_id: a, quote: 'Four plans' }],
      });
      await tools.call('retract_finding', { finding_id: free!.id, reason: 'free tier removed', evidence: [a] });
    });
    expect(second.task.status).toBe('verified');

    // No duplicates: one new row (the replacing version); every old row kept.
    expect(env.store.findings.list()).toHaveLength(4);
    expect(env.store.findings.get(price!.id)).toMatchObject({ lifecycle: 'current', confirmCount: 1 });
    expect(env.store.findings.get(free!.id)!.lifecycle).toBe('retracted');
    expect(env.store.findings.get(plans!.id)!.lifecycle).toBe('replaced');
    const v2 = env.store.findings.list({ claim: 'Acme sells four plans' })[0]!;
    expect(v2).toMatchObject({ lifecycle: 'current', status: 'verified', lineageId: plans!.id, version: 2 });
    const obs = knowledgeRepos(env.store).factObservations.list({ taskId: second.task.id });
    expect(obs.map((o) => [o.kind, o.status])).toEqual([['confirm', 'applied'], ['replace', 'applied'], ['retract', 'applied']]);
    const labels = listOutcomes(env.store).filter((o) => o.subjectType === 'fact_version').map((o) => [o.subjectId, o.label]);
    expect(labels).toEqual(expect.arrayContaining([[price!.id, 'confirmed'], [plans!.id, 'changed'], [free!.id, 'retracted']]));

    // The reviewer saw the prior claim, the retraction and the quote — and that read is logged.
    const reviewReq = second.prompts.find((p) => p.kind === 'review')!;
    expect(reviewReq.prompt).toContain(`REPLACES [${plans!.id}]`);
    expect(reviewReq.prompt).toContain('Prior claim: "Acme sells three plans"');
    expect(reviewReq.prompt).toContain(`RETRACTS [${free!.id}]`);
    expect(reviewReq.prompt).toContain('<<<EVIDENCE');
    const reviewerRun = env.store.agentRuns.list({ taskId: second.task.id }).find((r) => r.role === 'reviewer')!;
    const [ev] = knowledgeRepos(env.store).retrievalEvents.list({ agentRunId: reviewerRun.id });
    expect(ev).toMatchObject({ tool: 'prompt_context', role: 'reviewer', taskId: second.task.id });
    expect(ev!.resultIds.map((r) => r.id)).toEqual(expect.arrayContaining([plans!.id, price!.id, free!.id]));
  });

  it('a reviewer shown an upload-derived prior claim is upload-exposed and its review is not exported', async () => {
    const env = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('secret: 3 plans'), mime: 'text/csv' }, env);
    await run(env, 'rrun_1', async (tools) => {
      await tools.call('save_finding', { claim: 'Acme sells three plans', subject: 'Acme', evidence: [up.id] });
    });
    const plans = env.store.findings.list({ claim: 'Acme sells three plans' })[0]!;
    expect(plans.uploadDerived).toBe(true);
    const second = await run(env, 'rrun_2', async (tools, task) => {
      const a = await capture(env, tools, task, 'Four plans on the public pricing page.');
      await tools.call('save_finding', { claim: 'Acme sells four plans', subject: 'Acme', evidence: [a], relation: { replaces: plans.id } });
    });
    const reviewerRun = env.store.agentRuns.list({ taskId: second.task.id }).find((r) => r.role === 'reviewer')!;
    expect(runIsUploadExposed(env.store, reviewerRun.id)).toBe(true);
    // The new version is upload-derived by lineage, so its save and the review are excluded by default.
    const v2 = env.store.findings.list({ claim: 'Acme sells four plans' })[0]!;
    expect(v2.uploadCause).toBe(`lineage:${plans.id}`);
    const save = env.store.decisions.list().find((d) => (d.payload as { findingId?: string }).findingId === v2.id)!;
    expect(exportTrainingData('ws_a', { store: env.store })).not.toContain(save.id);
  });

  it('a confirmation not re-submitted in the final round is superseded; one cited by the deliverable is applied', async () => {
    const env = setup();
    await run(env, 'rrun_1', async (tools, task) => {
      const a = await capture(env, tools, task, 'Three plans.');
      await tools.call('save_finding', { claim: 'Acme sells three plans', subject: 'Acme', evidence: [a] });
    });
    const fact = env.store.findings.list({ claim: 'Acme sells three plans' })[0]!;
    const twoRounds = async (cite: boolean) => {
      const task = addTask(env.store, { runId: `rrun_${cite}` });
      let reviews = 0;
      const prompts: AgentRequest[] = [];
      env.state.pick = (r): FakeScript => {
        prompts.push(r);
        if (r.kind === 'review') return review(reviews++ === 0 ? 2 : 9, reviews === 1 ? [{ class: 'nit', description: 'tidy' }] : []);
        if (r.kind === 'work') {
          return async (tools) => {
            const a = await capture(env, tools, task, 'Still three plans.');
            await tools.call('confirm_finding', { finding_id: fact.id, evidence: [a] });
            await tools.call('submit_result', { summary: 'r1' });
          };
        }
        return cite ? revise('fix', { summary: `still true: ${fact.id}` })(r) : revise('fix')(r);
      };
      await runTaskWithReview(task, env.deps);
      const revisePrompt = prompts.find((p) => p.kind === 'revise')!.prompt;
      expect(revisePrompt).toContain(`- confirmation of finding ${fact.id}`);
      return knowledgeRepos(env.store).factObservations.list({ taskId: task.id })[0]!.status;
    };
    expect(await twoRounds(false)).toBe('superseded');
    expect(env.store.findings.get(fact.id)!.confirmCount).toBe(0);
    expect(await twoRounds(true)).toBe('applied');
    expect(env.store.findings.get(fact.id)!.confirmCount).toBe(1);
  });
});
