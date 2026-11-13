import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Finding, SymptomHypothesis } from '../types.js';
import { isOutputUsable } from '../research/outputs.js';
import { sameTree } from '../workspace/tree.js';

/**
 * `save_hypothesis` (worker, `symptom_hypotheses` tasks; spec §8 drill-down): persists a hypothesis
 * about the cause of one of this workspace's interview symptoms, citing findings and/or artifacts
 * of the same business tree, and logs a `score` Decision. Idempotent per (task, symptom,
 * hypothesis text).
 */
export const saveHypothesisHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'save_hypothesis'>;
  const { store, artifacts, events } = deps;
  const symptom = store.symptoms.get(input.symptom_id);
  if (!symptom || symptom.workspaceId !== ctx.workspaceId) {
    return { ok: false, error: `symptom '${input.symptom_id}' not found in this workspace` };
  }
  const isFinding = (id: string) => {
    const f = store.findings.get(id);
    return !!f && sameTree(store, ctx.workspaceId, f.workspaceId);
  };
  const missing = artifacts.exists(ctx.workspaceId, input.evidence.filter((id) => !isFinding(id)));
  if (missing.length) return { ok: false, error: `evidence must be finding or artifact ids of this business tree; unknown: ${missing.join(', ')}` };

  const key = titleKey(input.hypothesis);
  const replay = findReplay(store, ctx, 'save_hypothesis', 'task', (p) => {
    const prior = store.symptomHypotheses.get(String(p.hypothesisId));
    return !!prior && prior.symptomId === symptom.id && titleKey(prior.hypothesis) === key;
  });
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const evidence = [...new Set(input.evidence)];
  const prior = replay ? store.symptomHypotheses.get((replay.payload as { hypothesisId: string }).hypothesisId) : undefined;
  if (prior) {
    // Re-submitted: current for this task's round (superseded tracking, migration 13).
    // Without an owning task nothing will review it: `unverified`, no round.
    const tracking =
      task && task.workspaceId === ctx.workspaceId
        ? { taskId: task.id, taskRound: task.round, status: 'pending' as const }
        : { taskId: undefined, taskRound: undefined, status: 'unverified' as const };
    const sameEvidence = JSON.stringify([...prior.evidence].sort()) === JSON.stringify([...evidence].sort());
    if (prior.confidence === input.confidence && sameEvidence) {
      store.symptomHypotheses.update(prior.id, tracking);
      return { ok: true, data: { hypothesisId: prior.id, duplicate: true } };
    }
    // A correction (e.g. after review): persist the new confidence / evidence and log it as a revision.
    const revision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'score',
      payload: {
        tool: 'save_hypothesis', hypothesisId: prior.id, symptomId: symptom.id, hypothesis: prior.hypothesis, confidence: input.confidence,
        revision: true, previous: { confidence: prior.confidence, evidence: prior.evidence },
      },
      refs: [...new Set([prior.id, symptom.id, ...evidence])],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    store.transaction(() => {
      store.symptomHypotheses.update(prior.id, { confidence: input.confidence, evidence, ...tracking });
      store.decisions.insert(revision);
    });
    events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: revision });
    return { ok: true, data: { hypothesisId: prior.id, revised: true } };
  }

  const hypothesis: SymptomHypothesis = {
    id: newId('hyp'),
    workspaceId: ctx.workspaceId,
    symptomId: symptom.id,
    hypothesis: input.hypothesis.trim(),
    confidence: input.confidence,
    evidence,
    createdAt: new Date().toISOString(),
    status: 'unverified', // pending once an owning task is set below
  };
  if (task && task.workspaceId === ctx.workspaceId) {
    hypothesis.taskId = task.id;
    hypothesis.taskRound = task.round;
    hypothesis.status = 'pending';
  }
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind: 'score',
    payload: { tool: 'save_hypothesis', hypothesisId: hypothesis.id, symptomId: symptom.id, hypothesis: hypothesis.hypothesis, confidence: input.confidence },
    refs: [...new Set([hypothesis.id, symptom.id, ...hypothesis.evidence])],
    promptVersion: ctx.promptVersion,
    createdAt: hypothesis.createdAt,
  };
  store.transaction(() => {
    store.symptomHypotheses.insert(hypothesis);
    store.decisions.insert(decision);
  });
  events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
  return { ok: true, data: { hypothesisId: hypothesis.id } };
};

export type DrillDownItem = {
  hypothesis: SymptomHypothesis;
  /** Verified findings cited by the hypothesis. */
  verifiedFindings: Finding[];
};

/**
 * Drill-down context per symptom of a workspace: its usable hypotheses (verified, or included by the
 * user; never superseded), highest confidence first, each with the verified findings it cites.
 * Symptoms without usable hypotheses are omitted.
 */
export function drillDown(store: Store, workspaceId: string): Map<string, DrillDownItem[]> {
  const out = new Map<string, DrillDownItem[]>();
  for (const h of store.symptomHypotheses.list({ workspaceId }).filter(isOutputUsable)) {
    const verifiedFindings = h.evidence.flatMap((id) => {
      const f = store.findings.get(id);
      return f && f.status === 'verified' && sameTree(store, workspaceId, f.workspaceId) ? [f] : [];
    });
    const list = out.get(h.symptomId) ?? [];
    list.push({ hypothesis: h, verifiedFindings });
    out.set(h.symptomId, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.hypothesis.confidence - a.hypothesis.confidence);
  return out;
}
