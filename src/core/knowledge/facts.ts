/**
 * Living facts (design §7.2, build plan KS-2). A fact is a finding with a stable identity across
 * runs (`lineage_id`) and versions. Runs make observations about facts — `create`, `confirm`,
 * `replace`, `retract` (`fact_observations`) — that stay `pending` until the task ends; then
 * `applyObservations` (called inside `applyTaskStatus`, same transaction) applies or rejects them.
 * Nothing is ever deleted: a replaced or retracted version keeps its row as history.
 *
 * This module holds the store-level rules: claim similarity and duplicate candidates, freshness,
 * lineage heads, applying observations (with lineage conflicts and WP-C outcomes), and the human
 * fact actions (scope change, retract, accept an unverified replacement), which write WP-A feedback
 * events. The agent tools live in `factTools.ts`, the reviewer context in `factReview.ts`.
 */
import type { BifConfig, EntityKind } from '../config/schema.js';
import { recordFeedback } from '../feedback/events.js';
import { outputSaveDecision, recordOutcome } from '../learning/outcomes.js';
import type { DecisionOutcome } from '../learning/types.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { FactLifecycle, FactObservation, Finding, ObservationKind, Task } from '../types.js';
import { knowledgeSettings, type KnowledgeSettings } from './config.js';
import { entityNameKey } from './entityKeys.js';
import { normalizeText } from './extract/normalize.js';
import { KnowledgeNotFoundError, notFound, scopeFor, setItemScopes, type KnowledgeScope } from './scope.js';
import { sameTree } from '../workspace/tree.js'; // KS-6

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// scope

/**
 * The caller's knowledge scope; a workspace without a row (tests, legacy callers) is a tree of one
 * node, so nothing outside it is ever reachable.
 */
export function factScope(store: Store, workspaceId: string): KnowledgeScope {
  try {
    return scopeFor(store, workspaceId);
  } catch (err) {
    if (!(err instanceof KnowledgeNotFoundError)) throw err;
    return { workspaceId, rootId: workspaceId, treeIds: [workspaceId], nodeIds: [workspaceId], ancestorIds: [] };
  }
}

// ---------------------------------------------------------------------------
// claims and duplicate candidates (design §7.2 "Duplicate handshake")

/** Claim text for exact comparison: §8.2 normalization, NFKC, lower case, whitespace collapsed, no trailing punctuation. */
export function normalizeClaim(claim: string): string {
  return normalizeText(claim)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:,]+$/u, '')
    .trim();
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Distinct word tokens (letters / digits runs) of the normalized claim. */
export function claimTokens(claim: string): Set<string> {
  return new Set(normalizeClaim(claim).match(TOKEN) ?? []);
}

/**
 * Similarity used against `knowledge.dedupe.similarityFloor`: Jaccard overlap of the token sets of
 * the two normalized claims, |A ∩ B| / |A ∪ B|, in 0–1 (1 = same words). bm25 is unbounded and
 * corpus-dependent, so it only selects the FTS candidates this measure is computed on.
 */
export function claimSimilarity(a: string, b: string): number {
  const x = claimTokens(a);
  const y = claimTokens(b);
  if (!x.size || !y.size) return normalizeClaim(a) === normalizeClaim(b) && x.size === y.size ? 1 : 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

export type FactCandidate = {
  id: string;
  lineageId: string;
  version: number;
  workspaceId: string;
  subject: string;
  claim: string;
  status: Finding['status'];
  lastConfirmedAt?: string;
  uploadDerived: boolean;
  /** `claimSimilarity` with the claim being saved. */
  similarity: number;
};

export type CandidateQuery = {
  claim: string;
  subject: string;
  /**
   * Resolved entity of the claim being saved (KS-3); `null` = an entity no stored fact has yet (it
   * would be created on save), so only facts without an entity can match, by subject key. Without
   * it, sameness falls back to the subject key.
   */
  entityId?: string | null;
  /** The saving task: its own outputs are never candidates. */
  excludeTaskId?: string;
};

/** FTS rows looked at before the similarity floor; the floor and `candidateLimit` decide what is returned. */
export const CANDIDATE_POOL = 50;
const MAX_QUERY_TOKENS = 32;

/**
 * Likely matches of a claim among the CURRENT facts of the caller's tree (design §7.2): FTS5 on
 * `findings_fts.claim` (bm25 order, tokens quoted and OR-ed) restricted to `scope.treeIds`, lifecycle
 * `current`, not superseded / failed, same entity (entity ids when both sides have one, else the
 * subject's name key). `exact` is a fact whose normalized claim equals this one; `candidates` are the
 * others with `claimSimilarity ≥ similarityFloor`, best first, at most `candidateLimit`.
 */
export function findCandidates(
  store: Store,
  scope: KnowledgeScope,
  q: CandidateQuery,
  dedupe: KnowledgeSettings['dedupe'] = knowledgeSettings({}).dedupe,
): { exact?: FactCandidate; candidates: FactCandidate[] } {
  const tokens = [...claimTokens(q.claim)].slice(0, MAX_QUERY_TOKENS);
  if (!tokens.length) return { candidates: [] };
  const match = `claim : (${tokens.map((t) => `"${t}"`).join(' OR ')})`;
  const rows = store.db
    .prepare(
      `SELECT f.id AS id FROM findings_fts JOIN findings f ON f.rowid = findings_fts.rowid
       WHERE findings_fts MATCH ? AND f.lifecycle = 'current' AND f.status NOT IN ('superseded', 'failed')
         AND f.workspace_id IN (SELECT value FROM json_each(?))
       ORDER BY bm25(findings_fts, 0.0, 1.0), f.rowid LIMIT ?`,
    )
    .all(match, JSON.stringify(scope.treeIds), CANDIDATE_POOL) as Array<{ id: string }>;
  const subjectKey = entityNameKey(q.subject);
  const normalized = normalizeClaim(q.claim);
  let exact: FactCandidate | undefined;
  const scored: FactCandidate[] = [];
  for (const { id } of rows) {
    const f = store.findings.get(id);
    if (!f || (q.excludeTaskId !== undefined && f.taskId === q.excludeTaskId)) continue;
    const sameEntity = q.entityId !== undefined && f.entityId !== undefined ? f.entityId === q.entityId : entityNameKey(f.subject) === subjectKey;
    if (!sameEntity) continue;
    const c = toCandidate(f, claimSimilarity(q.claim, f.claim));
    if (normalizeClaim(f.claim) === normalized) exact ??= c;
    else if (c.similarity >= dedupe.similarityFloor) scored.push(c);
  }
  // Stable: equal similarity keeps the bm25 order.
  const candidates = scored.sort((a, b) => b.similarity - a.similarity).slice(0, dedupe.candidateLimit);
  return exact ? { exact, candidates } : { candidates };
}

function toCandidate(f: Finding, similarity: number): FactCandidate {
  const c: FactCandidate = {
    id: f.id,
    lineageId: f.lineageId ?? f.id,
    version: f.version ?? 1,
    workspaceId: f.workspaceId,
    subject: f.subject,
    claim: f.claim,
    status: f.status,
    uploadDerived: f.uploadDerived === true,
    similarity: Math.round(similarity * 1000) / 1000,
  };
  if (f.lastConfirmedAt) c.lastConfirmedAt = f.lastConfirmedAt;
  return c;
}

// ---------------------------------------------------------------------------
// freshness (computed, never stored)

export type Freshness = {
  /** `last_confirmed_at`, else first seen, else created. */
  since: string;
  ageDays: number;
  ttlDays: number;
  /** `now − since > ttl` (strictly). */
  stale: boolean;
};

type FreshFact = Pick<Finding, 'createdAt' | 'lastConfirmedAt' | 'firstSeenAt' | 'ttlDays'>;

/** TTL of a fact: its own `ttl_days`, else config by entity kind, else `freshness.defaultDays`. */
export function factTtlDays(fact: Pick<Finding, 'ttlDays'>, config: Pick<BifConfig, 'knowledge'>, entityKind?: EntityKind): number {
  const f = knowledgeSettings(config).freshness;
  return fact.ttlDays ?? (entityKind ? f.byEntityKind[entityKind] : undefined) ?? f.defaultDays;
}

export function freshness(fact: FreshFact, config: Pick<BifConfig, 'knowledge'>, now: Date = new Date(), entityKind?: EntityKind): Freshness {
  const since = fact.lastConfirmedAt ?? fact.firstSeenAt ?? fact.createdAt;
  const ms = now.getTime() - Date.parse(since);
  const ttlDays = factTtlDays(fact, config, entityKind);
  return { since, ageDays: Math.max(0, Math.floor(ms / DAY_MS)), ttlDays, stale: ms > ttlDays * DAY_MS };
}

/** The fact's entity kind (for its TTL), when it has an entity. */
export function factEntityKind(store: Store, fact: Pick<Finding, 'entityId'>): EntityKind | undefined {
  return fact.entityId ? knowledgeRepos(store).entities.get(fact.entityId)?.kind : undefined;
}

/** `freshness` with the fact's entity kind looked up. */
export function factFreshness(store: Store, fact: Finding, config: Pick<BifConfig, 'knowledge'>, now: Date = new Date()): Freshness {
  return freshness(fact, config, now, factEntityKind(store, fact));
}

/**
 * WP-C `stale` outcome (design §13): written the first time a current fact is observed past its
 * TTL. Idempotent per (fact version, `last_confirmed_at`): `sourceKey` is the freshness base, so a
 * later confirmation followed by a new lapse records a new one. KS-4 (`list_changes`) and KS-5
 * (briefing) call it when they observe a stale fact; nothing in KS-2 observes freshness lazily.
 */
export function recordStaleOutcome(store: Store, config: Pick<BifConfig, 'knowledge'>, fact: Finding, now: Date = new Date()): DecisionOutcome | undefined {
  if ((fact.lifecycle ?? 'current') !== 'current') return undefined;
  const fresh = factFreshness(store, fact, config, now);
  if (!fresh.stale) return undefined;
  return lineageOutcome(store, fact, 'stale', 'stale', 'fact_lineage', fresh.since, { ageDays: fresh.ageDays, ttlDays: fresh.ttlDays });
}

// ---------------------------------------------------------------------------
// lineage

/** Versions of a lineage, oldest first. */
export function lineageVersions(store: Store, lineageId: string): Finding[] {
  return store.findings.list({ lineageId }).sort((a, b) => (a.version ?? 1) - (b.version ?? 1));
}

/** The current version of a lineage (highest version if several), excluding `exceptId`. */
export function lineageHead(store: Store, lineageId: string, exceptId?: string): Finding | undefined {
  return store.findings
    .list({ lineageId, lifecycle: 'current' })
    .filter((f) => f.id !== exceptId)
    .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0];
}

/** Next version number of a lineage (max + 1, so two pending replacements never share one). */
export function nextVersion(store: Store, lineageId: string): number {
  return Math.max(0, ...store.findings.list({ lineageId }).map((f) => f.version ?? 1)) + 1;
}

/** Usable fact (design §7.2): lifecycle `current` and verified or included by the user, never superseded. */
export function isFactUsable(f: Pick<Finding, 'lifecycle' | 'status' | 'includeInSynthesis'>): boolean {
  if ((f.lifecycle ?? 'current') !== 'current' || f.status === 'superseded') return false;
  return f.includeInSynthesis ?? f.status === 'verified';
}

// ---------------------------------------------------------------------------
// observations

export type NewObservation = {
  workspaceId: string;
  finding: Pick<Finding, 'id' | 'lineageId'>;
  kind: ObservationKind;
  priorFindingId?: string;
  task?: Pick<Task, 'id' | 'runId' | 'round'>;
  agentRunId?: string;
  evidence?: string[];
  reason?: string;
  status?: FactObservation['status'];
  appliedAt?: string;
};

/** Appends an observation (the migration-18 trigger flags the fact when its evidence is upload-derived). */
export function addObservation(store: Store, o: NewObservation): FactObservation {
  const row: FactObservation = {
    id: newId('obs'),
    workspaceId: o.workspaceId,
    lineageId: o.finding.lineageId ?? o.finding.id,
    findingId: o.finding.id,
    kind: o.kind,
    evidence: [...new Set(o.evidence ?? [])],
    status: o.status ?? 'pending',
    createdAt: new Date().toISOString(),
  };
  if (o.priorFindingId !== undefined) row.priorFindingId = o.priorFindingId;
  if (o.task) {
    row.taskId = o.task.id;
    row.runId = o.task.runId;
    row.taskRound = o.task.round;
  }
  if (o.agentRunId !== undefined) row.agentRunId = o.agentRunId;
  if (o.reason !== undefined) row.reason = o.reason;
  if (o.appliedAt !== undefined) row.appliedAt = o.appliedAt;
  return knowledgeRepos(store).factObservations.insert(row);
}

export type TaskOutcomeStatus = 'verified' | 'unverified' | 'failed';

const OUTPUT_ID = /\b(?:fnd|rec|per|cmp|hyp|flw)_[0-9A-Z]{26}\b/g;

/**
 * Applies the task's pending observations at task end (design §7.2), inside `applyTaskStatus`'s
 * transaction and after its outputs got their final status:
 * - not re-submitted in the final round → `superseded` (create / replace: their fact is superseded;
 *   confirm / retract: saved in an earlier round than the final submitted one and the fact is not
 *   cited by id in the deliverable);
 * - task unverified / failed → `rejected` (prior facts untouched; a replacing fact stays `candidate`);
 * - task verified → `applied`: confirm sets `last_confirmed_at` and increments `confirm_count`;
 *   replace sets the head `replaced` and the new version `current`; retract sets `retracted`. When
 *   the named version is no longer the lineage head, replace / retract apply onto the head and flag
 *   `lineage_conflict`; a confirmation of a non-head version flags the head and confirms nothing.
 * Lineage events write WP-C outcomes (`confirmed`, `changed` on the replaced version, `retracted`),
 * keyed by the observation id. Idempotent: only `pending` rows are touched.
 */
export function applyObservations(
  store: Store,
  task: Pick<Task, 'id' | 'workspaceId' | 'result' | 'submittedRound'>,
  outcome: TaskOutcomeStatus,
  opts: { cited?: Set<string>; now?: Date } = {},
): FactObservation[] {
  const repo = knowledgeRepos(store).factObservations;
  const pending = repo.list({ taskId: task.id, status: 'pending' }).filter((o) => o.workspaceId === task.workspaceId);
  if (!pending.length) return [];
  const now = (opts.now ?? new Date()).toISOString();
  const cited = opts.cited ?? new Set(task.result === undefined ? [] : (JSON.stringify(task.result).match(OUTPUT_ID) ?? []));
  const rounds = pending.map((o) => o.taskRound).filter((r): r is number => typeof r === 'number');
  const submitted = task.submittedRound ?? (rounds.length ? Math.max(...rounds) : undefined);
  const out: FactObservation[] = [];
  for (const o of pending) {
    const fact = store.findings.get(o.findingId);
    const superseded =
      o.kind === 'create' || o.kind === 'replace'
        ? !fact || fact.status === 'superseded'
        : o.taskRound !== undefined && o.taskRound !== submitted && !cited.has(o.findingId);
    if (superseded) {
      out.push(repo.update(o.id, { status: 'superseded' }));
    } else if (outcome !== 'verified') {
      out.push(repo.update(o.id, { status: 'rejected' }));
    } else {
      applyOne(store, o, true);
      out.push(repo.update(o.id, { status: 'applied', appliedAt: now }));
    }
  }
  return out;
}

/** What applying one observation changed: the version it replaced or retracted, if any. */
type Applied = { replaced?: Finding; retracted?: Finding; confirmed?: Finding; conflict: boolean };

function applyOne(store: Store, o: FactObservation, outcomes: boolean): Applied {
  const findings = store.findings;
  const f = findings.get(o.findingId);
  if (!f) return { conflict: false };
  const lineageId = f.lineageId ?? f.id;
  switch (o.kind) {
    case 'create': {
      if (!f.lastConfirmedAt) findings.update(f.id, { lastConfirmedAt: f.createdAt });
      return { conflict: false };
    }
    case 'confirm': {
      if ((f.lifecycle ?? 'current') !== 'current') {
        const head = lineageHead(store, lineageId);
        if (head) findings.update(head.id, { lineageConflict: true });
        return { conflict: true };
      }
      const at = f.lastConfirmedAt && f.lastConfirmedAt > o.createdAt ? f.lastConfirmedAt : o.createdAt;
      const confirmed = findings.update(f.id, { lastConfirmedAt: at, confirmCount: (f.confirmCount ?? 0) + 1 });
      if (outcomes) lineageOutcome(store, confirmed, 'confirmed', 'confirmed', 'fact_lineage', o.id, observationEvidence(o));
      return { confirmed, conflict: false };
    }
    case 'replace': {
      const head = lineageHead(store, lineageId, f.id);
      const conflict = head === undefined || head.id !== o.priorFindingId;
      let replaced: Finding | undefined;
      if (head) {
        replaced = findings.update(head.id, { lifecycle: 'replaced' });
        if (outcomes) lineageOutcome(store, replaced, 'changed', 'changed', 'fact_lineage', o.id, { ...observationEvidence(o), newVersionId: f.id });
      }
      const patch: Partial<Finding> = { lifecycle: 'current', lastConfirmedAt: f.lastConfirmedAt ?? f.createdAt };
      if (conflict) {
        patch.lineageConflict = true;
        const others = store.findings.list({ lineageId }).filter((x) => x.id !== f.id);
        const top = Math.max(0, ...others.map((x) => x.version ?? 1));
        if ((f.version ?? 1) <= top) patch.version = top + 1;
      }
      findings.update(f.id, patch);
      if (patch.version !== undefined) propagateLineageFlag(store, f.id);
      return { ...(replaced ? { replaced } : {}), conflict };
    }
    case 'retract': {
      const current = (f.lifecycle ?? 'current') === 'current';
      const target = current ? f : lineageHead(store, lineageId);
      if (!target) return { conflict: !current };
      const retracted = findings.update(target.id, { lifecycle: 'retracted', ...(current ? {} : { lineageConflict: true }) });
      if (outcomes) lineageOutcome(store, retracted, 'retracted', 'retracted', 'fact_lineage', o.id, { ...observationEvidence(o), ...(o.reason ? { reason: o.reason } : {}) });
      return { retracted, conflict: !current };
    }
  }
}

/** Upload stickiness after a version renumber (the insert trigger only saw versions below the old number). */
function propagateLineageFlag(store: Store, findingId: string): void {
  store.db
    .prepare(
      `UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
         SELECT 'lineage:' || p.id FROM findings p
         WHERE p.lineage_id = findings.lineage_id AND p.version < findings.version AND p.upload_derived = 1 ORDER BY p.version LIMIT 1))
       WHERE id = ? AND upload_derived = 0 AND EXISTS (
         SELECT 1 FROM findings p WHERE p.lineage_id = findings.lineage_id AND p.version < findings.version AND p.upload_derived = 1)`,
    )
    .run(findingId);
}

const observationEvidence = (o: FactObservation): Record<string, unknown> => ({
  observationId: o.id,
  lineageId: o.lineageId,
  kind: o.kind,
  evidence: o.evidence,
  ...(o.taskId ? { observingTaskId: o.taskId } : {}),
  ...(o.agentRunId ? { observingAgentRunId: o.agentRunId } : {}),
});

/**
 * One WP-C outcome on a fact version (subject `fact_version`), on the decision that saved it when
 * there is one. `sourceKey`: the observation id (confirmed / changed / retracted), the freshness
 * base (`stale`).
 */
function lineageOutcome(
  store: Store,
  subject: Finding,
  outcome: string,
  label: DecisionOutcome['label'],
  source: DecisionOutcome['source'],
  sourceKey: string,
  evidence: Record<string, unknown>,
  actor?: string,
): DecisionOutcome | undefined {
  const save = outputSaveDecision(store, 'finding', subject.id);
  return recordOutcome(store, {
    ...(save ? { decisionId: save.id } : {}),
    subjectType: 'fact_version',
    subjectId: subject.id,
    workspaceId: subject.workspaceId,
    outcome,
    label,
    source,
    sourceKey,
    evidence,
    ...(actor ? { actor } : {}),
    ...(!save && subject.taskId ? { taskId: subject.taskId } : {}),
    targetType: 'finding',
    targetId: subject.id,
  });
}

// ---------------------------------------------------------------------------
// human fact actions (design §13, §17): WP-A feedback events; outcomes come from the feedback
// listener (`factOutcomesFromFeedback`, called by `learning/feedbackOutcomes.ts`).

/** User-facing error of a fact action (the API maps `status`). */
export class FactActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'FactActionError';
  }
}

export type FactActor = { actor?: string; reason?: string };

function getFact(store: Store, id: string): Finding {
  const f = store.findings.get(id);
  if (!f) throw notFound('finding', id);
  return f;
}

/**
 * Applies an unverified replacement because the user included it (design §7.2: include override
 * true on a `candidate` whose replace observation was rejected). Writes a `fact_replacement_accept`
 * feedback event. Returns the new current version, or `undefined` when there is nothing to apply
 * (not a candidate, superseded, or its task has not ended).
 */
export function applyReplacementByUser(store: Store, findingId: string, opts: FactActor = {}): Finding | undefined {
  return store.transaction(() => {
    const n = getFact(store, findingId);
    if (n.lifecycle !== 'candidate' || n.status === 'superseded') return undefined;
    const repo = knowledgeRepos(store).factObservations;
    const o = repo.list({ findingId: n.id, kind: 'replace', status: 'rejected' }).at(-1);
    if (!o) return undefined;
    const applied = applyOne(store, o, false);
    repo.update(o.id, { status: 'applied', appliedAt: new Date().toISOString() });
    recordFeedback(store, {
      workspaceId: n.workspaceId,
      ...(opts.actor ? { actor: opts.actor } : {}),
      kind: 'fact_replacement_accept',
      targetType: 'finding',
      targetId: n.id,
      beforeJson: { lifecycle: 'candidate', status: n.status, replacesId: n.replacesId ?? null },
      afterJson: { lifecycle: 'current', observationId: o.id, replacedId: applied.replaced?.id ?? null, conflict: applied.conflict },
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return store.findings.get(n.id);
  });
}

/**
 * The user retracts a current fact: an applied `retract` observation without a task, and a `fact_retract` event.
 * KS-6: `duplicateOf` (another fact of the same tree, another lineage) retracts it as a duplicate of that
 * fact — v1's form of merging two facts; recorded in the event (`afterJson.duplicateOf`), which writes a
 * `duplicate-saved` outcome when the agent had answered a duplicate handshake with `new`.
 */
export function retractFactByUser(store: Store, findingId: string, opts: FactActor & { duplicateOf?: string } = {}): Finding {
  return store.transaction(() => {
    const f = getFact(store, findingId);
    const lifecycle = f.lifecycle ?? 'current';
    if (lifecycle !== 'current') throw new FactActionError(`finding '${f.id}' is ${lifecycle}; only a current fact can be retracted`, 409);
    // --- KS-6: retract as a duplicate of another fact of the same tree ---
    if (opts.duplicateOf !== undefined) {
      const other = store.findings.get(opts.duplicateOf);
      if (!other || !sameTree(store, f.workspaceId, other.workspaceId)) throw notFound('finding', opts.duplicateOf);
      if ((other.lineageId ?? other.id) === (f.lineageId ?? f.id)) throw new FactActionError('a fact cannot duplicate its own lineage', 400);
    }
    // --- end KS-6 ---
    const now = new Date().toISOString();
    const o = addObservation(store, {
      workspaceId: f.workspaceId, finding: f, kind: 'retract', status: 'applied', appliedAt: now,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    const retracted = store.findings.update(f.id, { lifecycle: 'retracted' });
    recordFeedback(store, {
      workspaceId: f.workspaceId,
      ...(opts.actor ? { actor: opts.actor } : {}),
      kind: 'fact_retract',
      targetType: 'finding',
      targetId: f.id,
      beforeJson: { lifecycle },
      afterJson: { lifecycle: 'retracted', observationId: o.id, ...(opts.duplicateOf !== undefined ? { duplicateOf: opts.duplicateOf } : {}) },
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return retracted;
  });
}

/** The user relabels the nodes a fact applies to (source `user`) and a `fact_scope_change` event. */
export function setFactScopes(store: Store, findingId: string, workspaceIds: string[], opts: FactActor = {}): string[] {
  return store.transaction(() => {
    const f = getFact(store, findingId);
    const repo = knowledgeRepos(store).itemScopes;
    const before = repo.list({ itemKind: 'fact', itemId: f.id }).map((r) => r.workspaceId);
    setItemScopes(store, 'fact', f.id, workspaceIds, 'user');
    const after = repo.list({ itemKind: 'fact', itemId: f.id }).map((r) => r.workspaceId);
    if (JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())) {
      recordFeedback(store, {
        workspaceId: f.workspaceId,
        ...(opts.actor ? { actor: opts.actor } : {}),
        kind: 'fact_scope_change',
        targetType: 'finding',
        targetId: f.id,
        beforeJson: { scopes: before },
        afterJson: { scopes: after },
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
    }
    return after;
  });
}

/**
 * WP-C outcomes of the human fact actions, for the feedback listener: `fact_retract` →
 * `retracted` / `user-rejected` on the retracted version; `fact_replacement_accept` → `changed` on
 * the version it replaced. Keyed by the observation id, so a replay writes nothing twice.
 */
export function factOutcomesFromFeedback(
  store: Store,
  event: { kind: string; targetId: string; actor: string; id: string; reason?: string; afterJson?: unknown },
): DecisionOutcome[] {
  const after = (event.afterJson ?? {}) as { observationId?: unknown; replacedId?: unknown };
  const obsId = typeof after.observationId === 'string' ? after.observationId : undefined;
  if (!obsId) return [];
  const evidence = { observationId: obsId, feedbackEventId: event.id, ...(event.reason ? { reason: event.reason } : {}) };
  if (event.kind === 'fact_retract') {
    const f = store.findings.get(event.targetId);
    const o = f && lineageOutcome(store, f, 'retracted', 'user-rejected', 'user_reject', obsId, evidence, event.actor);
    return o ? [o] : [];
  }
  if (event.kind === 'fact_replacement_accept' && typeof after.replacedId === 'string') {
    const prior = store.findings.get(after.replacedId);
    const o = prior && lineageOutcome(store, prior, 'changed', 'changed', 'user_override', obsId, { ...evidence, newVersionId: event.targetId }, event.actor);
    return o ? [o] : [];
  }
  return [];
}

/** Lifecycle labels for prompts and the UI. */
export const LIFECYCLE_LABEL: Record<FactLifecycle, string> = {
  candidate: 'unverified update',
  current: 'current',
  replaced: 'replaced',
  retracted: 'retracted',
};
