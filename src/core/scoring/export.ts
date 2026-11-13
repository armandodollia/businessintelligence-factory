import { artifactIdsIn } from '../harness/tools/handlers.js';
import { taskOutputEvidence } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import type { Decision, InterviewTurn, Rating, UserRequest } from '../types.js';
// Learning loop WP-A: human feedback lines (request answers, interview turns, feedback events).
import { listFeedback, type FeedbackEvent } from '../feedback/events.js';
import { descendants, rootOf } from '../workspace/tree.js';
import { itemIsUploadDerived } from '../knowledge/provenance.js'; // KS-2

/** Payload keys naming a decision's primary subject, in precedence order. */
const PRIMARY_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId', 'competitorId'] as const;

/** The primary subject id a (non-persona_feedback) decision judges, if its payload names one. */
function primarySubject(d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  for (const k of PRIMARY_KEYS) if (typeof p[k] === 'string') return p[k] as string;
  return undefined;
}

/** Whether `id` is a task output superseded in a later review round. */
function isSuperseded(store: Store, id: string | undefined): boolean {
  if (!id) return false;
  const item =
    store.findings.get(id) ?? store.recommendations.get(id) ?? store.personas.get(id) ?? store.competitors.get(id) ??
    store.symptomHypotheses.get(id);
  return item?.status === 'superseded';
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
  for (const e of taskOutputEvidence(store, task)) out.add(e);
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
function expandedRefs(store: Store, d: Decision, taskEvidenceOf: (id: string) => string[] = (id) => taskEvidence(store, id)): string[] {
  const out = new Set(d.refs);
  const subject = primarySubject(d);
  if (subject) out.add(subject);
  for (const m of JSON.stringify(d.payload ?? null).matchAll(ITEM_ID)) out.add(m[0]);
  const runTask = store.agentRuns.get(d.agentRunId)?.taskId;
  if (runTask) out.add(runTask);
  for (const id of [...out]) {
    for (const e of evidenceOf(store, id)) out.add(e);
    for (const e of taskEvidenceOf(id)) out.add(e);
  }
  return [...out];
}

/**
 * A reuse record (`payload.reused: true`, e.g. an unchanged re-save of another task's competitor):
 * not a judgment. It only ties the reusing run to the item for provenance filtering, so it is never
 * the item's judgment for ratings and is not exported as a line of its own.
 */
function isReuseRecord(d: Decision): boolean {
  return (d.payload as { reused?: unknown } | null)?.reused === true;
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
 * (`expandedRefs`) — are excluded unless `includeUploads`. Decisions whose primary subject was
 * superseded (replaced in a later review round) are excluded. Reuse records (`isReuseRecord`) are
 * neither judgments nor lines: they only feed provenance filtering (via the task's decisions).
 */
export function exportTrainingData(workspaceId: string, deps: { store: Store }, includeUploads = false): string {
  const { store } = deps;
  const ratings = store.ratings.list({ workspaceId });
  const decisions = store.decisions.list({ workspaceId });
  const uploads = includeUploads ? undefined : uploadExclusionSet(store); // KS-2: + materialized / resolved flags

  const judgments = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.kind === 'persona_feedback' || isReuseRecord(d)) continue;
    const s = primarySubject(d);
    if (s) judgments.set(s, [...(judgments.get(s) ?? []), d]);
  }

  // Per-task evidence is the same for every decision of the task's runs: compute it once.
  const taskEvidenceCache = new Map<string, string[]>();
  const taskEvidenceOf = (id: string): string[] => {
    let ev = taskEvidenceCache.get(id);
    if (!ev) {
      ev = taskEvidence(store, id);
      taskEvidenceCache.set(id, ev);
    }
    return ev;
  };

  const lines: string[] = [];
  for (const decision of decisions) {
    if (isReuseRecord(decision)) continue;
    if (uploads && expandedRefs(store, decision, taskEvidenceOf).some((id) => uploads.has(id))) continue;
    if (uploads && citedDecisionsLinkUpload(store, decision, uploads, taskEvidenceOf)) continue; // WP-A
    if (isSuperseded(store, primarySubject(decision))) continue;
    // save_hypothesis decisions name their symptom as primary subject; the hypothesis itself decides.
    const hypothesisId = (decision.payload as { hypothesisId?: unknown } | null)?.hypothesisId;
    if (typeof hypothesisId === 'string' && isSuperseded(store, hypothesisId)) continue;
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
    const status = finalReviewStatus(store, decision);
    lines.push(JSON.stringify({ type: 'decision', decision, ratings: joined, ...(status ? { finalReviewStatus: status } : {}) }));
  }
  lines.push(...humanFeedbackLines(store, workspaceId, uploads, taskEvidenceOf));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Learning loop WP-A: human feedback in the export

const DECISION_ID = /\bdec_[0-9A-Z]{26}\b/g;

/**
 * Whether a Decision cited by id in `d` (e.g. the `sources` of an applied prompt patch, a feedback
 * event's rated decision) rests on an internal upload (`expandedRefs` of the cited decision).
 */
function citedDecisionsLinkUpload(store: Store, d: Decision, uploads: Set<string>, taskEvidenceOf: (id: string) => string[]): boolean {
  for (const m of JSON.stringify([d.refs, d.payload ?? null]).matchAll(DECISION_ID)) {
    const cited = m[0] === d.id ? undefined : store.decisions.get(m[0]);
    if (cited && expandedRefs(store, cited, taskEvidenceOf).some((id) => uploads.has(id))) return true;
  }
  return false;
}

const TERMINAL = new Set(['verified', 'unverified', 'failed', 'superseded']);

/** Final review status of the output a decision judges, else of its run's task (terminal statuses only). */
function finalReviewStatus(store: Store, d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const subject = typeof p.hypothesisId === 'string' ? p.hypothesisId : primarySubject(d);
  return outputStatus(store, subject) ?? taskStatus(store, store.agentRuns.get(d.agentRunId)?.taskId);
}

function outputStatus(store: Store, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const item =
    store.findings.get(id) ?? store.recommendations.get(id) ?? store.personas.get(id) ?? store.competitors.get(id) ??
    store.symptomHypotheses.get(id);
  return item?.status && TERMINAL.has(item.status) ? item.status : undefined;
}

function taskStatus(store: Store, taskId: string | undefined): string | undefined {
  const status = taskId ? store.tasks.get(taskId)?.status : undefined;
  return status && TERMINAL.has(status) ? status : undefined;
}

/** A Decision-shaped view of a human record, so the decision provenance rules (`expandedRefs`) apply to it. */
function pseudoDecision(workspaceId: string, agentRunId: string | undefined, refs: string[], payload: unknown): Decision {
  return {
    id: 'pseudo', workspaceId, agentRunId: agentRunId ?? '', role: 'orchestrator', model: { provider: 'claude', model: 'none' },
    kind: 'decision', payload, refs, promptVersion: 'n/a', createdAt: '',
  };
}

/**
 * Earliest time an internal upload of the workspace's business tree was stored, if any. The
 * interviewer is told about uploads and may read them (reads are not logged), so its turns from then
 * on are treated as upload-derived.
 */
function firstUploadAt(store: Store, workspaceId: string, uploads: Set<string>): string | undefined {
  const root = store.workspaces.get(workspaceId) ? rootOf(store, workspaceId) : workspaceId;
  const tree = new Set([root, ...descendants(store, root).map((w) => w.id), workspaceId]);
  let first: string | undefined;
  for (const id of uploads) {
    const a = store.artifacts.get(id);
    if (a && tree.has(a.workspaceId) && (first === undefined || a.capturedAt < first)) first = a.capturedAt;
  }
  return first;
}

/**
 * Human feedback lines of the export (after the decision lines):
 * - `{type: 'request_answer', request}`: answered user requests (who, when, response);
 * - `{type: 'interview_turn', turn}`: the interview transcript, each turn linked to its interviewer
 *   run (`turn.agentRunId`);
 * - `{type: 'feedback_event', feedbackEvent, finalReviewStatus?}`: every feedback event, with the
 *   final review status of the output it acted on.
 * Upload provenance (unless `includeUploads`, i.e. `uploads` undefined): a request is left out when
 * its text, task or run rests on an upload; a turn when its text cites an upload, its run's
 * decisions rest on one, or (agent turns) an upload of the tree existed when it was written; a
 * feedback event when its before/after/reason, its target (evidence, task) or its agent run rests on
 * one — including decisions it cites (e.g. a prompt patch's rated sources).
 */
function humanFeedbackLines(
  store: Store,
  workspaceId: string,
  uploads: Set<string> | undefined,
  taskEvidenceOf: (id: string) => string[],
): string[] {
  const linked = (d: Decision) =>
    !!uploads && (expandedRefs(store, d, taskEvidenceOf).some((id) => uploads.has(id)) || citedDecisionsLinkUpload(store, d, uploads, taskEvidenceOf));
  const lines: string[] = [];

  for (const request of store.userRequests.list({ workspaceId })) {
    if (request.status === 'pending') continue;
    const d = pseudoDecision(workspaceId, request.agentRunId, request.taskId ? [request.taskId] : [], requestText(request));
    if (linked(d)) continue;
    lines.push(JSON.stringify({ type: 'request_answer', request }));
  }

  const runLinked = new Map<string, boolean>();
  const runRestsOnUpload = (runId: string) => {
    let v = runLinked.get(runId);
    if (v === undefined) {
      v = store.decisions.list({ agentRunId: runId }).some(linked);
      runLinked.set(runId, v);
    }
    return v;
  };
  const uploadSince = uploads ? firstUploadAt(store, workspaceId, uploads) : undefined;
  for (const turn of store.interview.list({ workspaceId })) {
    if (uploads && turnRestsOnUpload(turn, uploadSince, runRestsOnUpload, linked, workspaceId)) continue;
    lines.push(JSON.stringify({ type: 'interview_turn', turn }));
  }

  for (const e of listFeedback(store, { workspaceId })) {
    if (linked(feedbackPseudoDecision(store, e))) continue;
    const status = outputStatus(store, e.targetId);
    lines.push(JSON.stringify({ type: 'feedback_event', feedbackEvent: e, ...(status ? { finalReviewStatus: status } : {}) }));
  }
  return lines;
}

const requestText = (r: UserRequest) => ({ site: r.site ?? null, details: r.details, response: r.response ?? null });

function turnRestsOnUpload(
  turn: InterviewTurn,
  uploadSince: string | undefined,
  runRestsOnUpload: (runId: string) => boolean,
  linked: (d: Decision) => boolean,
  workspaceId: string,
): boolean {
  if (linked(pseudoDecision(workspaceId, undefined, [], { text: turn.text }))) return true;
  if (turn.role !== 'agent') return false;
  if (uploadSince !== undefined && turn.createdAt >= uploadSince) return true;
  return !!turn.agentRunId && runRestsOnUpload(turn.agentRunId);
}

function feedbackPseudoDecision(store: Store, e: FeedbackEvent): Decision {
  const refs = [e.targetId];
  if (e.targetType === 'user_request') {
    const taskId = store.userRequests.get(e.targetId)?.taskId;
    if (taskId) refs.push(taskId);
  }
  return pseudoDecision(e.workspaceId, e.agentRunId, refs, { before: e.beforeJson ?? null, after: e.afterJson ?? null, reason: e.reason ?? null });
}

// ---------------------------------------------------------------------------
// Knowledge store KS-0: the export's upload expansion is the authority for the materialized
// `upload_derived` flags (design §12). The backfill and tests use these so flag and expansion agree.

/** Ids of internal uploads, across all workspaces (same set the export excludes by). */
export function internalUploadIds(store: Store): Set<string> {
  return uploadIds(store);
}

/** Whether the evidence of item `id`, as the export expands it (`evidenceOf`), includes an internal upload. */
export function evidenceIncludesUpload(store: Store, id: string, uploads: Set<string> = uploadIds(store)): boolean {
  return evidenceOf(store, id).some((e) => uploads.has(e));
}
// --- end knowledge store KS-0 ---------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Knowledge store KS-2: the export read path also honours the materialized `upload_derived` flags
// (design §12; KS-2 ruling). The reference expansion above only sees artifact ids an item's own
// evidence names, so a fact flagged through a confirmation / replacement / retraction observation,
// a later lineage version, a text duplicate of an upload, or a record citing any of these, would
// pass it. Every id the expansion reaches is therefore ALSO checked with `itemIsUploadDerived`
// (stored flags of artifacts, chunks and findings; records resolved through what they cite).
// `explainUploadDerived` (knowledge/uploadCause.ts) explains such an exclusion.

/** The upload ids, plus every id that is upload-derived now (`has` only; iteration = the uploads). */
class UploadExclusionSet extends Set<string> {
  private readonly memo = new Map<string, boolean>();
  constructor(
    private readonly store: Store,
    uploads: Set<string>,
  ) {
    super(uploads);
  }
  override has(id: string): boolean {
    if (super.has(id)) return true;
    // Set's constructor calls `add` before the memo exists; `has` is only called afterwards.
    let v = this.memo.get(id);
    if (v === undefined) {
      v = itemIsUploadDerived(this.store, id);
      this.memo.set(id, v);
    }
    return v;
  }
}

/** What the export excludes by (unless `includeUploads`): internal uploads and anything upload-derived. */
export function uploadExclusionSet(store: Store): Set<string> {
  return new UploadExclusionSet(store, uploadIds(store));
}
// --- end knowledge store KS-2 ---------------------------------------------------------------------
