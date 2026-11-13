/**
 * Human-action outcomes (learning loop integration of WP-A and WP-C): the ONE place user actions
 * become decision outcomes. Every human action on agent output is a WP-A feedback event
 * (`recordFeedback`); this `onFeedback` listener, registered at boot (`createRuntime`), turns the
 * relevant ones into outcomes through `recordOutcome`:
 * - `include_override` on a finding / recommendation / persona / competitor / hypothesis →
 *   `recordOverrideOutcome` (`user-rejected`, `weak-review`, `confirmed`);
 * - `proposal_reject` → `recordUnitProposalRejected` (`user-rejected`).
 * The core primitives (`setIncludeInSynthesis`, `setOutputInclude`, `rejectUnitProposal`) write no
 * outcome, so an action never writes one twice. Listeners run inside the action's transaction.
 */
import { onFeedback, type FeedbackEvent } from '../feedback/events.js';
import type { Store } from '../store/db.js';
import { recordOverrideOutcome, recordUnitProposalRejected, type OutputKind } from './outcomes.js';
import type { DecisionOutcome } from './types.js';

const OUTPUT_KINDS: ReadonlySet<string> = new Set<OutputKind>(['finding', 'recommendation', 'persona', 'competitor', 'hypothesis']);

/** The outcomes a feedback event implies (written through `recordOutcome`); [] for other kinds. */
export function outcomesFromFeedback(store: Store, event: FeedbackEvent): DecisionOutcome[] {
  const after = (event.afterJson ?? {}) as Record<string, unknown>;
  if (event.kind === 'include_override' && OUTPUT_KINDS.has(event.targetType)) {
    const include = after.include === true ? true : after.include === false ? false : null;
    return recordOverrideOutcome(store, {
      targetType: event.targetType as OutputKind,
      targetId: event.targetId,
      include,
      actor: event.actor,
      feedbackEventId: event.id,
      ...(event.reason ? { reason: event.reason } : {}),
    });
  }
  if (event.kind === 'proposal_reject') {
    const proposal = store.unitProposals.get(event.targetId);
    if (!proposal) return [];
    const o = recordUnitProposalRejected(store, proposal, event.reason ?? '', event.actor, event.id);
    return o ? [o] : [];
  }
  return [];
}

let off: (() => void) | undefined;
let holders = 0;

/**
 * Registers the feedback → outcome listener (one listener per process however often it is called,
 * so no action writes its outcome twice). Returns a release function; the listener is removed when
 * every registration was released (tests). Boot keeps it for the process lifetime.
 */
export function registerFeedbackOutcomes(): () => void {
  holders++;
  off ??= onFeedback((store, event) => {
    outcomesFromFeedback(store, event);
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) {
      off?.();
      off = undefined;
    }
  };
}

/** Whether the listener is registered (boot wiring check). */
export function feedbackOutcomesRegistered(): boolean {
  return off !== undefined;
}
