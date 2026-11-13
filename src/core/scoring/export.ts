import { artifactIdsIn } from '../harness/tools/handlers.js';
import type { Store } from '../store/db.js';
import type { Decision, Rating } from '../types.js';

/** Payload keys naming a decision's primary subject, in precedence order. */
const PRIMARY_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId', 'competitorId'] as const;

/** The primary subject id a (non-persona_feedback) decision judges, if its payload names one. */
function primarySubject(d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  for (const k of PRIMARY_KEYS) if (typeof p[k] === 'string') return p[k] as string;
  return undefined;
}

/**
 * Rating target id (`<recId>:<personaId>`) of a persona_feedback decision, from the persona stamped
 * on it by the panel (`payload.personaId`). Undefined for unstamped (legacy) decisions, which then
 * get no persona_feedback ratings rather than a guessed persona's.
 */
function feedbackTargetId(d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const input = p.input as Record<string, unknown> | undefined;
  const recId = input?.recommendation_id;
  return typeof recId === 'string' && typeof p.personaId === 'string' ? `${recId}:${p.personaId}` : undefined;
}

/**
 * Ids of internal uploads, across ALL workspaces (uploads of ancestors / siblings may be cited by a
 * node): every artifact of kind `upload`, plus every id listed in any `profile.uploads` (covers an
 * upload whose bytes sha-deduped onto an artifact saved earlier under another kind).
 */
function uploadIds(store: Store): Set<string> {
  const ids = new Set<string>(store.artifacts.list({ kind: 'upload' }).map((a) => a.id));
  for (const p of store.profiles.list()) {
    const u = p.data.uploads;
    if (Array.isArray(u)) for (const id of u) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/** Evidence artifacts an item cites: finding / symptom evidence, persona field evidence, and a
 * recommendation's findings' evidence. Empty for anything else. */
function evidenceOf(store: Store, id: string): string[] {
  const f = store.findings.get(id);
  if (f) return f.evidence;
  const s = store.symptoms.get(id);
  if (s) return s.evidence;
  const p = store.personas.get(id);
  if (p) return Object.values(p.profile ?? {}).flatMap((x) => x.evidence ?? []);
  const r = store.recommendations.get(id);
  if (r) return r.findingIds.flatMap((fid) => store.findings.get(fid)?.evidence ?? []);
  const c = store.competitors.get(id);
  if (c) return c.evidence;
  const h = store.symptomHypotheses.get(id);
  if (h) return h.evidence.flatMap((e) => store.findings.get(e)?.evidence ?? [e]);
  return [];
}

/**
 * Everything a task's outputs rest on: its findings' evidence, artifact ids cited in its
 * deliverable (`result`) or brief. Empty for a non-task id.
 */
function taskEvidence(store: Store, id: string): string[] {
  const task = store.tasks.get(id);
  if (!task) return [];
  const out = new Set<string>(artifactIdsIn(task.result));
  for (const a of artifactIdsIn(task.brief)) out.add(a);
  for (const f of store.findings.list({ taskId: task.id })) for (const e of f.evidence) out.add(e);
  return [...out];
}

const ITEM_ID = /\b(?:art|fnd|sym|rec|per|tsk|cmp|hyp)_[0-9A-Z]{26}\b/g;

/**
 * A decision's provenance: its refs and every item id in its payload (artifact / finding /
 * task ids an agent wrote, recorded `provenance`), expanded by the evidence the referenced items
 * cite (finding / symptom / persona evidence; recommendation → its findings → their evidence) and
 * by task outputs (a referenced task, and the task of the decision's own run: its findings,
 * deliverable and brief). So a decision whose result was derived from an internal upload counts as
 * upload-linked even when the upload id appears only in the task's outputs.
 */
function expandedRefs(store: Store, d: Decision): string[] {
  const out = new Set(d.refs);
  const subject = primarySubject(d);
  if (subject) out.add(subject);
  for (const m of JSON.stringify(d.payload ?? null).matchAll(ITEM_ID)) out.add(m[0]);
  const runTask = store.agentRuns.get(d.agentRunId)?.taskId;
  if (runTask) out.add(runTask);
  for (const id of [...out]) {
    for (const e of evidenceOf(store, id)) out.add(e);
    for (const e of taskEvidence(store, id)) out.add(e);
  }
  return [...out];
}

/**
 * For each primary subject, its judgments (decisions naming it) in log order; a rating of the
 * subject joins the judgment that was current when the rating was made — the latest one created at
 * or before the rating (the first one when the rating predates them all). So after a revision
 * (e.g. a recommendation re-scored), later ratings join the new judgment, earlier ones the old.
 */
function judgmentFor(judgments: Map<string, Decision[]>, r: Rating): Decision | undefined {
  const list = judgments.get(r.targetId);
  if (!list?.length) return undefined;
  let pick = list[0]!;
  for (const d of list) if (d.createdAt <= r.createdAt) pick = d;
  return pick;
}

/**
 * Training export: one JSON line per decision in the workspace (`{decision, ratings}`), joined with
 * the user's ratings:
 * - every decision joins ratings of itself (targetType `decision`);
 * - a persona_feedback decision joins only the persona_feedback ratings of exactly its
 *   `<recId>:<personaId>`;
 * - a decision with a primary subject (`findingId` / `symptomId` / `recommendationId` /
 *   `personaId` in its payload) joins that subject's ratings made while it was the latest judgment
 *   of the subject (`judgmentFor`);
 * - any other decision joins ratings of its refs.
 * Decisions referencing an internal upload — directly or via the evidence of a referenced item
 * (`expandedRefs`) — are excluded unless `includeUploads`.
 */
export function exportTrainingData(workspaceId: string, deps: { store: Store }, includeUploads = false): string {
  const { store } = deps;
  const ratings = store.ratings.list({ workspaceId });
  const decisions = store.decisions.list({ workspaceId });
  const uploads = includeUploads ? undefined : uploadIds(store);

  const judgments = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.kind === 'persona_feedback') continue;
    const s = primarySubject(d);
    if (s) judgments.set(s, [...(judgments.get(s) ?? []), d]);
  }

  const lines: string[] = [];
  for (const decision of decisions) {
    if (uploads && expandedRefs(store, decision).some((id) => uploads.has(id))) continue;
    const self = (r: Rating) => r.targetType === 'decision' && r.targetId === decision.id;
    let joined: Rating[];
    if (decision.kind === 'persona_feedback') {
      const target = feedbackTargetId(decision);
      joined = ratings.filter((r) => self(r) || (r.targetType === 'persona_feedback' && r.targetId === target));
    } else {
      const subject = primarySubject(decision);
      const refs = new Set(decision.refs);
      joined = ratings.filter((r) => {
        if (self(r)) return true;
        if (r.targetType === 'persona_feedback' || r.targetType === 'decision') return false;
        if (subject) return r.targetId === subject && judgmentFor(judgments, r)?.id === decision.id;
        return refs.has(r.targetId);
      });
    }
    lines.push(JSON.stringify({ decision, ratings: joined }));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
