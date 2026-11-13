import type { Store } from '../store/db.js';
import type { Criteria, Decision } from '../types.js';
import { CRITERIA } from './criteria.js';
import { decisionTags } from '../learning/runTags.js'; // learning loop WP-F
import type { ReviewQueueItem } from './reviewQueue.js';

const DECISION_KEYS = CRITERIA.decision.map((c) => c.key);

/** Agent value of the `pushback` criterion on a pushback decision (learning loop WP-C). */
export const PUSHBACK_AGENT_VALUE = 1;

/** Display title of a decision for rating lists. */
export function decisionTitle(d: Decision): string {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  if (typeof p.what === 'string' && p.what) return p.what;
  if (p.tool === 'submit_review') return `Review score (${d.role})`;
  if (d.kind === 'pushback') return `Pushback on ${String(p.issueId ?? '?')}: ${String(p.reason ?? '')}`; // learning loop WP-C
  return String(p.tool ?? d.kind);
}

/**
 * Ratable agent values carried by a decision: `confidence` (log_decision) and `score`
 * (submit_review), numeric only, and `pushback` (1) on worker pushbacks. Empty for user / scheduler
 * decisions.
 */
export function decisionCriteria(d: Decision): Criteria {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const out: Criteria = {};
  for (const k of DECISION_KEYS) if (typeof p[k] === 'number') out[k] = p[k] as number;
  // learning loop WP-C: a worker pushback is ratable (agent value 1: "the issue needs no change").
  if (d.kind === 'pushback') out.pushback = PUSHBACK_AGENT_VALUE;
  return out;
}

/** Review-queue items for agent decisions with unrated ratable values (target type `decision`). */
export function decisionReviewQueue(workspaceId: string, deps: { store: Store }): ReviewQueueItem[] {
  const { store } = deps;
  const rated = new Set(
    store.ratings.list({ workspaceId, targetType: 'decision' }).map((r) => `${r.targetId}|${r.criterion}`),
  );
  const out: ReviewQueueItem[] = [];
  for (const d of store.decisions.list({ workspaceId })) {
    const criteria = decisionCriteria(d);
    const unrated = Object.keys(criteria).filter((k) => !rated.has(`${d.id}|${k}`));
    if (!unrated.length) continue;
    // Learning loop WP-F: experiment / audit judgments stay ratable (arm comparison) but say what they are.
    const tags = decisionTags(store, d.id);
    const prefix = tags.auditId ? '[audit] ' : tags.experimentId ? `[experiment arm ${tags.arm ?? '?'}] ` : '';
    out.push({ targetType: 'decision', targetId: d.id, title: `${prefix}${decisionTitle(d)}`, criteria, unrated });
  }
  return out;
}
