import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Finding, SymptomHypothesis } from '../types.js';
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
  if (replay) return { ok: true, data: { hypothesisId: (replay.payload as { hypothesisId: string }).hypothesisId, duplicate: true } };

  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const hypothesis: SymptomHypothesis = {
    id: newId('hyp'),
    workspaceId: ctx.workspaceId,
    symptomId: symptom.id,
    hypothesis: input.hypothesis.trim(),
    confidence: input.confidence,
    evidence: [...new Set(input.evidence)],
    createdAt: new Date().toISOString(),
  };
  if (task && task.workspaceId === ctx.workspaceId) hypothesis.taskId = task.id;
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
 * Drill-down context per symptom of a workspace: its hypotheses (highest confidence first), each
 * with the verified findings it cites. Symptoms without hypotheses are omitted.
 */
export function drillDown(store: Store, workspaceId: string): Map<string, DrillDownItem[]> {
  const out = new Map<string, DrillDownItem[]>();
  for (const h of store.symptomHypotheses.list({ workspaceId })) {
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
