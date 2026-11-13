import { priorRunLines } from '../harness/priorAttempt.js';
import type { Store } from '../store/db.js';
import type { Task, UserRequest } from '../types.js';

/**
 * Escalation re-run context (WP-D). Kept free of research imports so `reviewLoop` can include it in
 * every worker prompt without an import cycle.
 */

/** `user_requests.kind` of escalation questions. */
export const ESCALATION_KIND = 'escalation' satisfies UserRequest['kind'];

/** Harness Decision event recorded (on the escalation run) when an answered escalation re-runs its task. */
export const ESCALATION_RERUN_EVENT = 'escalation_rerun';

export type EscalationRerunPayload = {
  tool: 'harness';
  event: typeof ESCALATION_RERUN_EVENT;
  previousStatus: Task['status'];
  previousRound: number;
  lastReview?: { score: number; issues: Array<{ id: string; class: string; description: string }> };
  failureReasons?: string[];
  lastWorkerRunId?: string;
  requestIds: string[];
};

/** Escalation questions of a task (own workspace), oldest first. */
export function escalationRequests(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): UserRequest[] {
  return store.userRequests
    .list({ taskId: task.id, kind: ESCALATION_KIND })
    .filter((r) => r.workspaceId === task.workspaceId);
}

/** The latest re-run marker of a task, if it was ever re-run after an escalation. */
export function latestRerun(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): EscalationRerunPayload | undefined {
  let latest: EscalationRerunPayload | undefined;
  for (const run of store.agentRuns.list({ taskId: task.id, role: 'escalation' })) {
    for (const d of store.decisions.list({ agentRunId: run.id })) {
      const p = d.payload as Partial<EscalationRerunPayload> | null;
      if (p?.tool === 'harness' && p.event === ESCALATION_RERUN_EVENT && d.workspaceId === task.workspaceId) {
        latest = p as EscalationRerunPayload;
      }
    }
  }
  return latest;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** "question → answer" line of an answered escalation question. */
export function answerLine(r: UserRequest): string {
  const answer = r.status === 'denied' ? 'dismissed by the user (no answer)' : clip(r.response ?? '(answered)', 400);
  return `- Q: ${clip(r.details, 300)}\n  A: ${answer}`;
}

/**
 * Worker prompt section for a task re-run after an answered escalation: how the previous attempt
 * ended (status, last review issues, failures), what that attempt's run did (prior-attempt
 * summary) and the user's answers. Empty string unless the task was re-run after an escalation.
 */
export function escalationRerunSection(store: Store, task: Task): string {
  const rerun = latestRerun(store, task);
  if (!rerun) return '';
  const answered = escalationRequests(store, task).filter((r) => r.status !== 'pending');
  const parts = [
    `## Previous attempt and the user's answers (escalation)\nYour previous attempt at this task ended ${rerun.previousStatus} in review round ${rerun.previousRound}.`,
  ];
  if (rerun.lastReview) {
    const issues = rerun.lastReview.issues.slice(0, 8).map((i) => `- ${i.id} (${i.class}): ${clip(i.description, 300)}`);
    parts.push(`Last review (score ${rerun.lastReview.score}):\n${issues.join('\n') || '- (no issues listed)'}`);
  }
  if (rerun.failureReasons?.length) parts.push(`Failures:\n${rerun.failureReasons.slice(-4).map((r) => `- ${clip(r, 300)}`).join('\n')}`);
  if (rerun.lastWorkerRunId) {
    const lines = priorRunLines(store, rerun.lastWorkerRunId);
    if (lines.length) parts.push(`What the previous attempt did:\n${lines.join('\n')}`);
  }
  if (answered.length) parts.push(`The user answered these questions about it:\n${answered.map(answerLine).join('\n')}`);
  parts.push('Redo the task following these answers; they override your earlier assumptions. Do not ask the same questions again.');
  return parts.join('\n\n');
}
