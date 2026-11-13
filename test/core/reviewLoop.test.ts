import { afterEach, describe, expect, it } from 'vitest';
import { loadPrompt, promptVersion } from '../../src/core/prompts/index.js';
import { MALFORMED_REVIEW_ISSUE, runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { addTask, researchSetup, review, revise, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('loadPrompt', () => {
  it('returns text and an 8-char sha256 version', () => {
    const p = loadPrompt('reviewer');
    expect(p.text).toMatch(/submit_review/);
    expect(p.version).toBe(promptVersion(p.text));
    expect(p.version).toMatch(/^[0-9a-f]{8}$/);
  });

  it('prompts instruct nit/scope pushback and no failing for nits', () => {
    expect(loadPrompt('revise').text).toMatch(/push back[^\n]*`nit`[^\n]*`scope_expansion`/i);
    expect(loadPrompt('reviewer').text).toMatch(/do not fail work for nits or for not doing out-of-scope work/i);
  });
});

describe('runTaskWithReview', () => {
  it('passes in round 1 at score 8', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(8) : undefined),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    expect(out.result).toMatchObject({ summary: 'Acme raised prices' });
    expect(s.requests.map((r) => r.kind)).toEqual(['work', 'review']);
    const findings = s.store.findings.list({ taskId: task.id });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe('verified');
    // Reviewer runs on a different provider than the worker when one is enabled.
    const reviewerRun = s.store.agentRuns.list({ role: 'reviewer' })[0]!;
    expect(reviewerRun.model.provider).toBe('codex');
  });

  it('score 7,7,7 → unverified after 3 rounds', async () => {
    const s = researchSetup(opened, {
      pick: (r) =>
        r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(7, [{ class: 'substantive', description: 'thin' }]) : revise('fix')(r),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 3 });
    expect(s.requests.map((r) => r.kind)).toEqual(['work', 'review', 'revise', 'review', 'revise', 'review']);
    expect(s.store.findings.list({ taskId: task.id }).every((f) => f.status === 'unverified')).toBe(true);
    // Every round spawned a NEW reviewer run.
    expect(new Set(s.store.agentRuns.list({ role: 'reviewer' }).map((r) => r.id)).size).toBe(3);
  });

  it('perTaskType maxRounds=1 honored', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.perTaskType.news_scan = { maxRounds: 1 }),
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(7) : revise()(r)),
    });
    const out = await runTaskWithReview(addTask(s.store), s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 1 });
    expect(s.requests.map((r) => r.kind)).toEqual(['work', 'review']);
  });

  it('perTaskType passThreshold honored', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.perTaskType.news_scan = { passThreshold: 6 }),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(6)),
    });
    expect((await runTaskWithReview(addTask(s.store), s.deps)).status).toBe('verified');
  });

  it('reviewer prompt minimal', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') {
          return async (t) => {
            await t.call('log_decision', { what: 'WORKER_SECRET_REASONING', why: 'transcript text', confidence: 0.5 });
            await submitWork({ summary: 'DELIVERABLE_V1' })(t);
          };
        }
        if (r.kind === 'review') {
          reviews++;
          return review(reviews === 1 ? 3 : 9, [{ class: 'blocking', description: 'ROUND1_ISSUE_TEXT' }]);
        }
        return async (t) => {
          await t.call('log_decision', { what: 'REVISION_SECRET', why: 'w', confidence: 0.5 });
          await revise('fix', { summary: 'DELIVERABLE_V2' })(r)(t);
        };
      },
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const reviewerPrompts = s.requests.filter((r) => r.kind === 'review').map((r) => r.prompt);
    expect(reviewerPrompts).toHaveLength(2);
    const artifactId = s.store.findings.list({ taskId: task.id })[0]!.evidence[0]!;
    for (const p of reviewerPrompts) {
      expect(p).toContain(task.brief);
      expect(p).toContain('at least one dated article');
      expect(p).toContain(artifactId);
      expect(p).not.toContain('WORKER_SECRET_REASONING');
      expect(p).not.toContain('REVISION_SECRET');
      expect(p).not.toContain('ROUND1_ISSUE_TEXT');
      expect(p).not.toContain('respond_to_review');
    }
    expect(reviewerPrompts[0]).toContain('DELIVERABLE_V1');
    expect(reviewerPrompts[1]).toContain('DELIVERABLE_V2');
    expect(reviewerPrompts[1]).not.toContain('DELIVERABLE_V1');
    // The worker's revision prompt does carry the issues.
    const revisePrompt = s.requests.find((r) => r.kind === 'revise')!.prompt;
    expect(revisePrompt).toContain('[I1] (blocking) ROUND1_ISSUE_TEXT');
    // Reviewer system prompt is the reviewer prompt, not the worker's.
    expect(s.requests.find((r) => r.kind === 'review')!.systemPrompt).toContain('adversarial reviewer');
  });

  it('malformed review counts as fail', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return revise('fix')(r);
        reviews++;
        if (reviews === 1) return async () => {}; // no submit_review at all
        if (reviews === 2) {
          return async (t) => {
            // score out of range is rejected by the harness; the reviewer gives up
            await t.call('submit_review', { score: 11, issues: [] }).catch(() => {});
          };
        }
        return review(9);
      },
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 3 });
    const revisePrompts = s.requests.filter((r) => r.kind === 'revise').map((r) => r.prompt);
    expect(revisePrompts).toHaveLength(2);
    for (const p of revisePrompts) expect(p).toContain(`[I1] (blocking) ${MALFORMED_REVIEW_ISSUE}`);
    const synthetic = s.store.decisions
      .list({ kind: 'review' })
      .filter((d) => (d.payload as { event?: string }).event === 'synthetic_review');
    expect(synthetic).toHaveLength(2);
    expect(synthetic[0]!.payload).toMatchObject({ tool: 'harness', score: 0 });
  });

  it('malformed review in the last round is never a pass', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : async () => {}),
    });
    expect((await runTaskWithReview(addTask(s.store), s.deps)).status).toBe('unverified');
  });

  it('pushbacks logged as Decision kind pushback', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return revise('pushback')(r);
        reviews++;
        return reviews === 1 ? review(6, [{ class: 'nit', description: 'comma splice' }]) : review(8);
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const pushbacks = s.store.decisions.list({ kind: 'pushback' });
    expect(pushbacks).toHaveLength(1);
    expect(pushbacks[0]!.payload).toMatchObject({ tool: 'respond_to_review', issueId: 'I1', action: 'pushback' });
    expect(pushbacks[0]!.refs).toContain(task.id);
  });

  it('failed worker run is retried once with a new run; the failed run is kept', async () => {
    let works = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'review') return review(9);
        works++;
        return works === 1
          ? async () => {
              throw new Error('CLI exited 1');
            }
          : submitWork();
      },
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('verified');
    const runs = s.store.agentRuns.list({ taskId: task.id, role: 'worker' });
    expect(runs.map((r) => r.status)).toEqual(['failed', 'done']);
    const failed = s.store.decisions
      .list({ agentRunId: runs[0]!.id })
      .find((d) => (d.payload as { event?: string }).event === 'worker_run_failed');
    expect(failed?.payload).toMatchObject({ attempt: 1, willRetry: true });
    expect((failed?.payload as { reason: string }).reason).toMatch(/CLI exited 1/);
  });

  it('second worker failure marks the task failed', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? async () => {} /* ends without submit_result */ : review(9)),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('failed');
    expect(s.store.agentRuns.list({ taskId: task.id, role: 'worker' })).toHaveLength(2);
    expect(s.requests.filter((r) => r.kind === 'review')).toHaveLength(0);
  });

  it('idle-killed worker run counts as a failure and is retried', async () => {
    let works = 0;
    const s = researchSetup(opened, {
      config: (c) => (c.limits.idleTimeoutMs = 100),
      pick: (r) => {
        if (r.kind === 'review') return review(9);
        works++;
        return works === 1 ? () => new Promise<void>(() => {}) : submitWork();
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const runs = s.store.agentRuns.list({ taskId: task.id, role: 'worker' });
    expect(runs[0]).toMatchObject({ status: 'failed' });
  });

  it('synthesis tasks run as synthesizer', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? submitWork() : review(9)),
    });
    const task = addTask(s.store, { type: 'synthesize_recommendations', phase: 'synthesis' });
    await runTaskWithReview(task, s.deps);
    expect(s.requests[0]!.role).toBe('synthesizer');
  });
});

describe('finding idempotency (rate-limit retries replay tool calls)', () => {
  it('saving the same claim twice on a task yields one finding with merged evidence', async () => {
    const s = researchSetup(opened, {
      pick: (r) =>
        r.kind === 'work'
          ? async (t) => {
              const a = (await t.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'one' })) as { artifactId: string };
              const b = (await t.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'two' })) as { artifactId: string };
              const f1 = (await t.call('save_finding', { claim: 'Same claim', subject: 'Acme', evidence: [a.artifactId] })) as { findingId: string };
              const f2 = (await t.call('save_finding', { claim: 'Same claim', subject: 'Acme', evidence: [b.artifactId] })) as { findingId: string };
              if (f1.findingId !== f2.findingId) throw new Error('duplicate finding');
              await t.call('submit_result', { ok: true });
            }
          : review(9),
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const findings = s.store.findings.list({ taskId: task.id });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toHaveLength(2);
  });
});
