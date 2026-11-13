import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { learningRepos } from '../../src/core/learning/store.js';
import {
  issueRecurrence,
  issueSimilarity,
  listReviewIssues,
  maxReasserts,
  reviewIssueHistory,
} from '../../src/core/learning/reviewIssues.js';
import type { AgentRequest } from '../../src/core/research/deps.js';
import { MALFORMED_REVIEW_ISSUE, runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { decisionReviewQueue } from '../../src/core/scoring/decisionQueue.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import type { Store } from '../../src/core/store/db.js';
import { addTask, researchSetup, review, revise, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Issue = { id?: string; class: string; description: string };
const reviewWith =
  (score: number, issues: Issue[]): FakeScript =>
  async (t) => {
    await t.call('submit_review', { score, issues, summary: `score ${score}` });
  };

/** Revision answering each listed issue id with the action chosen per id (default fix). */
const reviseBy =
  (actions: Record<string, 'fix' | 'pushback'> = {}) =>
  (req: AgentRequest): FakeScript =>
  async (t) => {
    for (const m of req.prompt.matchAll(/^- \[(\w+)\]/gm)) {
      const action = actions[m[1]!] ?? 'fix';
      await t.call('respond_to_review', { issue_id: m[1], action, reason: `${action}: REASON_${m[1]}` });
    }
    const keep = [...req.prompt.matchAll(/^- (?:finding|recommendation|persona|competitor|hypothesis) (\w+):/gm)].map((m) => m[1]);
    await t.call('submit_result', { summary: 'revised', keep });
  };

const rows = (store: Store, taskId: string) => learningRepos(store).reviewIssues.list({ taskId });
const outcomes = (store: Store) => learningRepos(store).decisionOutcomes.list();

describe('review-issue history', () => {
  it('keeps every round (append-only) with stable ids for repeated issues; tasks.review_issues keeps the latest round', async () => {
    const s = researchSetup(opened, {
      pick: (r) =>
        r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(7, [{ class: 'substantive', description: 'Coverage is thin' }]) : revise('fix')(r),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    const history = rows(s.store, task.id);
    expect(history.map((r) => [r.round, r.issueId, r.class, r.status])).toEqual([
      [1, 'I1', 'substantive', 'fixed'],
      [2, 'I1', 'substantive', 'fixed'],
      [3, 'I1', 'substantive', 'open'],
    ]);
    expect(history[0]!.resolvedAt).toBeTruthy();
    expect(history[2]!.resolvedAt).toBeUndefined();
    expect(history[0]!.responseReason).toMatch(/fix because/);
    expect(new Set(history.map((r) => r.reviewerRunId)).size).toBe(3);
    expect(history.every((r) => r.reviewDecisionId && s.store.decisions.get(r.reviewDecisionId)?.kind === 'review')).toBe(true);
    expect(history.every((r) => r.workerRunId && r.workerPromptVersion)).toBe(true);
    expect(s.store.tasks.get(task.id)!.reviewIssues).toEqual([{ id: 'I1', class: 'substantive', description: 'Coverage is thin' }]);
  });

  it('a new issue that reuses an earlier raw id gets a fresh stable id (shown to the worker)', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return reviseBy()(r);
        reviews++;
        if (reviews === 1) return reviewWith(5, [{ class: 'blocking', description: 'Price for Acme Pro is not sourced' }]);
        if (reviews === 2) return reviewWith(5, [{ class: 'nit', description: 'Headline uses passive voice' }]);
        return reviewWith(9, []);
      },
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    expect(rows(s.store, task.id).map((r) => [r.round, r.rawIssueId, r.issueId])).toEqual([
      [1, 'I1', 'I1'],
      [2, 'I1', 'I2'],
    ]);
    const secondRevise = s.requests.filter((r) => r.kind === 'revise')[1]!;
    expect(secondRevise.prompt).toContain('[I2] (nit) Headline uses passive voice');
  });

  it('a malformed review is recorded as synthetic and does not settle disputes', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return reviseBy({ I1: 'pushback' })(r);
        reviews++;
        if (reviews === 1) return reviewWith(6, [{ class: 'nit', description: 'comma splice in summary' }]);
        if (reviews === 2) return async () => {}; // no submit_review
        return reviewWith(9, []);
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const h = rows(s.store, task.id);
    const synthetic = h.find((r) => r.synthetic)!;
    expect(synthetic).toMatchObject({ round: 2, text: MALFORMED_REVIEW_ISSUE, class: 'blocking' });
    // Round-1 nit: pushed back in round 2, untouched by the malformed review, withdrawn by round 3.
    expect(h.find((r) => r.round === 1)!.status).toBe('withdrawn');
    // The synthetic issue is not a reviewer judgment: no dispute outcome for it.
    expect(outcomes(s.store).filter((o) => o.source === 'dispute')).toHaveLength(1);
  });
});

describe('review disputes', () => {
  it('next reviewer sees the pushback; dropping the issue → withdrawn + reviewer false positive', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return reviseBy({ I1: 'pushback' })(r);
        reviews++;
        return reviews === 1 ? reviewWith(6, [{ class: 'nit', description: 'comma splice in summary' }]) : reviewWith(8, []);
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const prompts = s.requests.filter((r) => r.kind === 'review').map((r) => r.prompt);
    expect(prompts[0]).not.toMatch(/Disputed issues/);
    expect(prompts[1]).toMatch(/Disputed issues/);
    expect(prompts[1]).toContain('[I1] (nit) comma splice in summary');
    expect(prompts[1]).toContain('REASON_I1');
    expect(prompts[1]).not.toContain('respond_to_review');
    const [r1] = rows(s.store, task.id);
    expect(r1).toMatchObject({ status: 'withdrawn', responseReason: 'pushback: REASON_I1' });
    const fp = outcomes(s.store).filter((o) => o.source === 'dispute');
    expect(fp).toHaveLength(1);
    expect(fp[0]).toMatchObject({ outcome: 'withdrawn_after_pushback', label: 'reviewer-false-positive', role: 'reviewer', decisionId: r1!.reviewDecisionId });
  });

  it('reasserted (same id) → upheld; later fixed → worker miss on the pushback decision', async () => {
    let reviews = 0;
    let revises = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return reviseBy(++revises === 1 ? { I1: 'pushback' } : {})(r);
        reviews++;
        if (reviews === 1) return reviewWith(5, [{ class: 'substantive', description: 'No date on the pricing source' }]);
        if (reviews === 2) return reviewWith(6, [{ id: 'I1', class: 'substantive', description: 'Pushback rejected: the source still has no date' }]);
        return reviewWith(9, []);
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    expect(rows(s.store, task.id).map((r) => [r.round, r.issueId, r.status])).toEqual([
      [1, 'I1', 'upheld'],
      [2, 'I1', 'fixed'],
    ]);
    // Cap (default 1) reached: the worker is told to fix it.
    const secondRevise = s.requests.filter((r) => r.kind === 'revise')[1]!;
    expect(secondRevise.prompt).toMatch(/I1: the reviewer reasserted this issue after your pushback \(1×; limit reached\)/);
    const miss = outcomes(s.store).filter((o) => o.label === 'worker-miss');
    expect(miss).toHaveLength(1);
    const pushback = s.store.decisions.get(miss[0]!.decisionId!)!;
    expect(pushback.kind).toBe('pushback');
    expect(miss[0]).toMatchObject({ outcome: 'fixed_after_upheld', source: 'dispute', role: 'worker', taskId: task.id });
  });

  it('a reasserted issue is matched by text when the reviewer does not reuse the id', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return reviseBy({ I1: 'pushback', I2: 'pushback' })(r);
        reviews++;
        if (reviews === 1) return reviewWith(5, [{ class: 'substantive', description: 'The Acme pricing claim cites no dated source' }]);
        if (reviews === 2) return reviewWith(5, [{ id: 'X9', class: 'substantive', description: 'the Acme pricing claim cites no dated source.' }]);
        return reviewWith(9, []);
      },
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    expect(rows(s.store, task.id).map((r) => [r.round, r.rawIssueId, r.issueId, r.status])).toEqual([
      [1, 'I1', 'I1', 'upheld'],
      [2, 'X9', 'I1', 'withdrawn'],
    ]);
  });

  it('after the reassert cap the dispute is no longer put to the reviewer; maxReasserts is configurable', async () => {
    const run = async (cap?: number) => {
      let reviews = 0;
      const s = researchSetup(opened, {
        config: (c) => {
          if (cap !== undefined) (c.loop as { maxReasserts?: number }).maxReasserts = cap;
          c.loop.maxRounds = 4;
        },
        pick: (r) => {
          if (r.kind === 'work') return submitWork();
          if (r.kind === 'revise') return reviseBy({ I1: 'pushback' })(r);
          reviews++;
          if (reviews <= 2) return reviewWith(5, [{ id: 'I1', class: 'substantive', description: 'No date on the pricing source' }]);
          return reviewWith(9, []);
        },
      });
      await runTaskWithReview(addTask(s.store), s.deps);
      return s.requests.filter((r) => r.kind === 'review').map((r) => /Disputed issues/.test(r.prompt));
    };
    // Round 2 shows the dispute; round 3 (already reasserted once) only with a cap of 2.
    expect(await run()).toEqual([false, true, false]);
    expect(await run(2)).toEqual([false, true, true]);
    expect(maxReasserts(undefined)).toBe(1);
  });
});

describe('review-issue queries (lessons input)', () => {
  it('history per stable id, filters, and class recurrence across tasks', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) =>
        r.kind === 'work'
          ? submitWork()
          : reviewWith(5, [
              { class: 'substantive', description: 'thin sourcing' },
              { class: 'nit', description: 'typo' },
            ]),
    });
    const tasks = [addTask(s.store), addTask(s.store), addTask(s.store, { type: 'public_filings' })];
    for (const t of tasks) await runTaskWithReview(t, s.deps);
    const history = reviewIssueHistory(s.store, tasks[0]!.id);
    expect(history.map((h) => [h.issueId, h.rounds.length, h.status])).toEqual([
      ['I1', 1, 'open'],
      ['I2', 1, 'open'],
    ]);
    expect(listReviewIssues(s.store, { workspaceIds: ['ws_a'], class: 'nit' })).toHaveLength(3);
    const rec = issueRecurrence(s.store, ['ws_a']);
    expect(rec.find((r) => r.taskType === 'news_scan' && r.class === 'substantive')).toMatchObject({ role: 'worker', issues: 2, taskIds: [tasks[0]!.id, tasks[1]!.id] });
    expect(rec.find((r) => r.taskType === 'public_filings' && r.class === 'nit')?.taskIds).toEqual([tasks[2]!.id]);
    expect(issueRecurrence(s.store, ['ws_other'])).toEqual([]);
  });

  it('issueSimilarity: same words → 1, unrelated → low', () => {
    expect(issueSimilarity('No date on the source.', 'no date on the SOURCE')).toBe(1);
    expect(issueSimilarity('No date on the source', 'Headline uses passive voice')).toBeLessThan(0.2);
  });
});

describe('pushback is ratable', () => {
  it('pushback decisions appear in the decision queue with criterion `pushback` and can be rated', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork();
        if (r.kind === 'revise') return revise('pushback')(r);
        reviews++;
        return reviews === 1 ? review(6, [{ class: 'nit', description: 'comma splice' }]) : review(8);
      },
    });
    await runTaskWithReview(addTask(s.store), s.deps);
    const pushback = s.store.decisions.list({ kind: 'pushback' })[0]!;
    const item = decisionReviewQueue('ws_a', { store: s.store }).find((i) => i.targetId === pushback.id)!;
    expect(item).toMatchObject({ targetType: 'decision', criteria: { pushback: 1 }, unrated: ['pushback'] });
    expect(item.title).toMatch(/^Pushback on I1/);
    const rating = rateCriterion(
      { workspaceId: 'ws_a', targetType: 'decision', targetId: pushback.id, criterion: 'pushback', verdict: 'disagree', userValue: 0, reason: 'should have fixed' },
      { store: s.store },
    );
    expect(rating).toMatchObject({ agentValue: 1, userValue: 0 });
    expect(decisionReviewQueue('ws_a', { store: s.store }).some((i) => i.targetId === pushback.id)).toBe(false);
    expect(() =>
      rateCriterion({ workspaceId: 'ws_a', targetType: 'decision', targetId: pushback.id, criterion: 'pushback', verdict: 'disagree', userValue: 3 }, { store: s.store }),
    ).toThrow(/fraction 0–1/);
  });
});
