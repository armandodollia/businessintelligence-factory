import type { BifConfig } from '../config/schema.js';
import type { ReviewIssue } from '../harness/tools/handlers.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { AgentRun, Role, Task, TaskType } from '../types.js';
import { recordOutcome } from './outcomes.js';
import { learningRepos } from './store.js';
import type { IssueRecurrence, ReviewIssueRecord, ReviewIssueStatus } from './types.js';
import { isAuditRun } from './runTags.js'; // learning loop WP-F

/**
 * Review-issue history and review disputes (learning loop WP-C, migration 16).
 *
 * Every review round appends one `review_issues` row per issue (never overwritten; `tasks.review_issues`
 * still holds the latest round for the revise step). Issue ids are stable across rounds: an issue the
 * reviewer repeats keeps its id — matched by the reviewer reusing the id of a disputed issue it was
 * shown, or by near-identical text. The worker's answers move a row to `fixed` / `pushed_back`.
 *
 * Disputes: the next reviewer sees the issues the worker pushed back on (issue + the worker's reason)
 * and either accepts (drops the issue → `withdrawn`, a reviewer false-positive outcome) or reasserts
 * it (repeats it → `upheld`). An issue is put to the reviewer as a dispute only while it has been
 * reasserted fewer than `loop.maxReasserts` times (default 1); once the cap is reached, the revise
 * prompt tells the worker to fix it, and a fix of an upheld issue records a worker-miss outcome.
 */

/** Default for `loop.maxReasserts`. */
export const DEFAULT_MAX_REASSERTS = 1;

/** How many times the reviewer may reassert a pushed-back issue before the dispute is closed. */
export function maxReasserts(config: Pick<BifConfig, 'loop'> | undefined): number {
  const v = (config?.loop as { maxReasserts?: number } | undefined)?.maxReasserts;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_MAX_REASSERTS;
}

const WORKER_ROLES: readonly Role[] = ['worker', 'synthesizer'];

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}$€£%]+/gu) ?? []);
}

/** Jaccard similarity of the word sets of two issue texts (0–1; case and punctuation ignored). */
export function issueSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Text similarity at which a new issue is taken to repeat an earlier one. */
const REPEAT_SIMILARITY = 0.6;
/** Looser bar when the reviewer reused the id of a disputed issue it was shown (or the class matches). */
const REASSERT_SIMILARITY = 0.25;

function taskRows(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): ReviewIssueRecord[] {
  return learningRepos(store).reviewIssues.list({ taskId: task.id }).filter((r) => r.workspaceId === task.workspaceId);
}

/** Rows of one round: those of its latest reviewer run (a review repeated after a restart replaces the earlier one). */
function latestRoundRows(rows: ReviewIssueRecord[], round: number): ReviewIssueRecord[] {
  const inRound = rows.filter((r) => r.round === round);
  const last = inRound.at(-1)?.reviewerRunId;
  return inRound.filter((r) => r.reviewerRunId === last);
}

const upheldCount = (rows: ReviewIssueRecord[], issueId: string) =>
  rows.filter((r) => r.issueId === issueId && r.status === 'upheld').length;

const runsOf = (store: Store, task: Pick<Task, 'id' | 'workspaceId'>, roles: readonly Role[]): AgentRun[] =>
  store.agentRuns
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && roles.includes(r.role) && !isAuditRun(store, r.id)); // WP-F: audits excluded

/** Pushed-back issues the reviewer of `round` must rule on (still under the reassert cap). */
export function openDisputes(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, round: number, cap: number): ReviewIssueRecord[] {
  const rows = taskRows(store, task);
  const rounds = [...new Set(rows.filter((r) => r.round < round).map((r) => r.round))];
  return rounds
    .flatMap((n) => latestRoundRows(rows, n))
    .filter((r) => r.status === 'pushed_back' && !r.synthetic && upheldCount(rows, r.issueId) < cap);
}

/**
 * Reviewer prompt section for the issues the worker pushed back on (empty when there are none):
 * only the issue and the worker's reason — no transcript, no other review content.
 */
export function reviewerDisputeSection(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, round: number, cap: number): string {
  const disputes = openDisputes(store, task, round, cap);
  if (!disputes.length) return '';
  return [
    '## Disputed issues from the previous review',
    'The worker pushed back on these issues instead of changing the deliverable. For each one: if the',
    "worker's reason holds, leave the issue out of your review. Otherwise reassert it: list it again with",
    'the same `id` and say why the reason does not hold.',
    ...disputes.map((d) => `- [${d.issueId}] (${d.class}) ${d.text}\n  Worker's reason: ${d.responseReason ?? '(none given)'}`),
  ].join('\n');
}

/** Revise prompt section on issues the reviewer reasserted after a pushback (empty when none). */
export function workerDisputeSection(
  store: Store,
  task: Pick<Task, 'id' | 'workspaceId'>,
  issues: Array<Pick<ReviewIssue, 'id'>>,
  cap: number,
): string {
  const rows = taskRows(store, task);
  const lines = issues.flatMap((i) => {
    const n = upheldCount(rows, i.id);
    if (!n) return [];
    return n >= cap
      ? [`- ${i.id}: the reviewer reasserted this issue after your pushback (${n}×; limit reached). Fix it — another pushback will not be put to the reviewer.`]
      : [`- ${i.id}: the reviewer reasserted this issue after your pushback (${n}×). Fix it, or push back once more only with new evidence.`];
  });
  return lines.length ? `## Reasserted issues\n${lines.join('\n')}` : '';
}

/**
 * Appends one review round to the history and returns its issues with stable ids (to hand to the
 * revise step). Idempotent per reviewer run. A valid review also settles the open disputes: each
 * pushed-back issue it repeats is `upheld`, each it drops is `withdrawn` (reviewer false positive).
 * Without a reviewer run (nothing to attach the history to) the issues are returned unchanged.
 */
export function recordReviewRound(
  store: Store,
  config: Pick<BifConfig, 'loop'> | undefined,
  taskId: string,
  round: number,
  review: { valid: boolean; issues: ReviewIssue[] },
): ReviewIssue[] {
  const task = store.tasks.get(taskId);
  if (!task) return review.issues;
  const reviewer = runsOf(store, task, ['reviewer']).at(-1);
  if (!reviewer) return review.issues;
  const repo = learningRepos(store).reviewIssues;
  const toIssue = (r: ReviewIssueRecord): ReviewIssue => ({
    id: r.issueId, class: r.class, description: r.text, ...(r.evidence.length ? { evidence: r.evidence } : {}),
  });
  const mine = repo.list({ reviewerRunId: reviewer.id }).filter((r) => r.taskId === task.id);
  if (mine.length) return mine.map(toIssue);

  return store.transaction(() => {
    const rows = taskRows(store, task);
    const prior = rows.filter((r) => r.round < round);
    // Latest row per stable id among earlier rounds (candidates for a repeat).
    const latest = new Map<string, ReviewIssueRecord>();
    for (const r of prior) latest.set(r.issueId, r);
    const shown = new Set(openDisputes(store, task, round, maxReasserts(config)).map((d) => d.issueId));
    const used = new Set(prior.map((r) => r.issueId));
    const taken = new Set<string>();
    const reviewDecision = store.decisions.list({ agentRunId: reviewer.id }).filter((d) => d.kind === 'review').at(-1);
    const worker = runsOf(store, task, WORKER_ROLES).filter((r) => r.status === 'done' && r.startedAt <= reviewer.startedAt).at(-1);
    const now = new Date().toISOString();
    let n = 0;
    const freshId = () => {
      let id: string;
      do id = `I${++n}`;
      while (used.has(id) || taken.has(id));
      return id;
    };

    const out: ReviewIssue[] = [];
    for (const issue of review.issues) {
      const synthetic = !review.valid;
      let stable: string | undefined;
      const explicit = latest.get(issue.id);
      if (
        !synthetic && explicit && shown.has(issue.id) && !taken.has(issue.id) &&
        (explicit.class === issue.class || issueSimilarity(explicit.text, issue.description) >= REASSERT_SIMILARITY)
      ) {
        stable = issue.id;
      } else {
        let best = 0;
        for (const [id, r] of latest) {
          if (taken.has(id) || r.synthetic !== synthetic) continue;
          const sim = issueSimilarity(r.text, issue.description);
          if (sim >= REPEAT_SIMILARITY && sim > best) {
            best = sim;
            stable = id;
          }
        }
      }
      stable ??= used.has(issue.id) || taken.has(issue.id) ? freshId() : issue.id;
      taken.add(stable);
      const row: ReviewIssueRecord = {
        id: newId('rvi'), workspaceId: task.workspaceId, taskId: task.id, round, issueId: stable, rawIssueId: issue.id,
        class: issue.class, text: issue.description, evidence: issue.evidence ?? [], status: 'open', synthetic,
        reviewerRunId: reviewer.id, createdAt: now,
      };
      if (reviewDecision) row.reviewDecisionId = reviewDecision.id;
      if (worker) {
        row.workerRunId = worker.id;
        if (worker.promptVersion) row.workerPromptVersion = worker.promptVersion;
      }
      repo.insert(row);
      out.push({ ...issue, id: stable });
    }

    if (review.valid) {
      const repeated = new Set(out.map((i) => i.id));
      const rounds = [...new Set(prior.map((r) => r.round))];
      for (const r of rounds.flatMap((x) => latestRoundRows(rows, x))) {
        if (r.status !== 'pushed_back' || r.synthetic) continue;
        if (repeated.has(r.issueId)) {
          repo.update(r.id, { status: 'upheld', resolvedAt: now });
          continue;
        }
        repo.update(r.id, { status: 'withdrawn', resolvedAt: now });
        if (r.reviewDecisionId) {
          recordOutcome(store, {
            decisionId: r.reviewDecisionId, outcome: 'withdrawn_after_pushback', label: 'reviewer-false-positive', source: 'dispute',
            evidence: { issueId: r.issueId, round: r.round, class: r.class, text: r.text, pushback: r.responseReason ?? null, settledInRound: round },
            taskId: task.id, targetType: 'review_issue', targetId: `${task.id}:${r.issueId}:${r.round}`,
          });
        }
      }
    }
    return out;
  });
}

/**
 * Records the worker's answers (`respond_to_review`) of the revise run of `round` on the issues of
 * the previous round: `fix` → `fixed`, `pushback` → `pushed_back` (with the reason). Fixing an issue
 * the reviewer had upheld after a pushback records a worker-miss outcome on that pushback. Only
 * `open` rows change, so a repeated call is a no-op.
 */
export function recordRevisionResponses(store: Store, taskId: string, round: number): void {
  const task = store.tasks.get(taskId);
  if (!task) return;
  const worker = runsOf(store, task, WORKER_ROLES).filter((r) => r.status === 'done').at(-1);
  if (!worker) return;
  const rows = taskRows(store, task);
  const prevRound = Math.max(0, ...rows.filter((r) => r.round < round).map((r) => r.round));
  const target = latestRoundRows(rows, prevRound);
  if (!target.length) return;
  const responses = new Map<string, { action: string; reason: string; decisionId: string }>();
  for (const d of store.decisions.list({ agentRunId: worker.id })) {
    const p = d.payload as { tool?: string; issueId?: string; action?: string; reason?: string } | null;
    if (p?.tool === 'respond_to_review' && p.issueId) {
      responses.set(p.issueId, { action: p.action ?? 'fix', reason: p.reason ?? '', decisionId: d.id });
    }
  }
  const repo = learningRepos(store).reviewIssues;
  const now = new Date().toISOString();
  store.transaction(() => {
    for (const r of target) {
      const res = responses.get(r.issueId);
      if (!res || r.status !== 'open') continue;
      const status: ReviewIssueStatus = res.action === 'pushback' ? 'pushed_back' : 'fixed';
      repo.update(r.id, { status, responseReason: res.reason, responseDecisionId: res.decisionId, resolvedAt: now });
      if (status !== 'fixed') continue;
      const upheld = rows.filter((x) => x.issueId === r.issueId && x.round < r.round && x.status === 'upheld' && x.responseDecisionId);
      for (const u of upheld) {
        recordOutcome(store, {
          decisionId: u.responseDecisionId!, outcome: 'fixed_after_upheld', label: 'worker-miss', source: 'dispute',
          evidence: { issueId: r.issueId, class: r.class, text: r.text, pushedBackInRound: u.round, fixedInRound: round, fix: res.reason },
          taskId: task.id, targetType: 'review_issue', targetId: `${task.id}:${r.issueId}:${u.round}`,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// queries (lessons engine input)

export type ReviewIssueFilter = {
  workspaceIds?: string[];
  taskId?: string;
  status?: ReviewIssueStatus;
  class?: ReviewIssueRecord['class'];
  /** Include harness-made rows of malformed reviews (default false). */
  includeSynthetic?: boolean;
  /** ISO time; only rows created at or after it. */
  since?: string;
};

/** Review-issue rows in insertion order (per workspace list; never across business trees unless asked). */
export function listReviewIssues(store: Store, filter: ReviewIssueFilter = {}): ReviewIssueRecord[] {
  const repo = learningRepos(store).reviewIssues;
  const base = {
    ...(filter.taskId ? { taskId: filter.taskId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.class ? { class: filter.class } : {}),
  };
  const rows = filter.workspaceIds ? filter.workspaceIds.flatMap((workspaceId) => repo.list({ ...base, workspaceId })) : repo.list(base);
  return rows
    .filter((r) => filter.includeSynthetic || !r.synthetic)
    .filter((r) => (filter.since ? r.createdAt >= filter.since : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type IssueThread = {
  issueId: string;
  class: ReviewIssueRecord['class'];
  /** Status of its latest row. */
  status: ReviewIssueStatus;
  rounds: ReviewIssueRecord[];
};

/** A task's issues grouped by stable id (rounds in order), synthetic rows included. */
export function reviewIssueHistory(store: Store, taskId: string): IssueThread[] {
  const threads = new Map<string, IssueThread>();
  for (const r of learningRepos(store).reviewIssues.list({ taskId })) {
    const t = threads.get(r.issueId) ?? { issueId: r.issueId, class: r.class, status: r.status, rounds: [] };
    t.rounds.push(r);
    t.class = r.class;
    t.status = r.status;
    threads.set(r.issueId, t);
  }
  return [...threads.values()];
}

/**
 * How often each issue class recurs per executing role + task type (optionally per worker prompt
 * version) over the given workspaces (one business tree): distinct tasks and issue rows. Synthetic
 * rows are left out. Input for lessons ("a class recurring in ≥ 3 tasks").
 */
export function issueRecurrence(
  store: Store,
  workspaceIds: string[],
  opts: { byPromptVersion?: boolean; since?: string } = {},
): IssueRecurrence[] {
  const groups = new Map<string, IssueRecurrence>();
  const taskCache = new Map<string, Task | undefined>();
  for (const r of listReviewIssues(store, { workspaceIds, ...(opts.since ? { since: opts.since } : {}) })) {
    if (!taskCache.has(r.taskId)) taskCache.set(r.taskId, store.tasks.get(r.taskId));
    const task = taskCache.get(r.taskId);
    if (!task) continue;
    // Same rule as `roleForTask` (research/reviewLoop.ts, which imports this module).
    const role: Role = task.type === 'synthesize_recommendations' ? 'synthesizer' : 'worker';
    const taskType: TaskType = task.type;
    const pv = opts.byPromptVersion ? r.workerPromptVersion : undefined;
    const key = `${role}\u0000${taskType}\u0000${pv ?? ''}\u0000${r.class}`;
    let g = groups.get(key);
    if (!g) {
      g = { role, taskType, class: r.class, taskIds: [], issues: 0 };
      if (pv) g.promptVersion = pv;
      groups.set(key, g);
    }
    g.issues++;
    if (!g.taskIds.includes(r.taskId)) g.taskIds.push(r.taskId);
  }
  return [...groups.values()];
}
