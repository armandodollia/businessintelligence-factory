/**
 * Human actions with feedback provenance (learning loop WP-A). Each function performs one user
 * action on agent output and, in the same transaction, records who did it, when, why and what
 * changed (`recordFeedback`), plus — where the action is a learning signal — a rating-equivalent
 * row for calibration (`signals.ts`). The API calls these with `actor = actorOf(config)`.
 */
import type { BifConfig } from '../config/schema.js';
import type { EventBus } from '../events.js';
import { answerEscalation } from '../escalation/escalation.js';
import { setIncludeInSynthesis } from '../evidence/synthesis.js';
import { resolveUserRequest } from '../harness/tools/handlers.js';
import { PROTECTED_PROFILE_KEYS, mergePatch } from '../interview/interview.js';
import { calibrationAppendix, loadPrompt, promptVersion, withCalibration, type CalibrationScope } from '../prompts/index.js';
import { recordPromptVersion } from '../prompts/store.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../research/systemPrompts.js';
import { setOutputInclude } from '../research/outputs.js';
import { calibrationScope, proposePromptPatch, type PromptPatch } from '../scoring/calibration.js';
import { applyPromptPatchVersioned, revertCalibration, setCalibrationDecision } from '../scoring/calibrationHistory.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { usageRepos } from '../store/usageRepos.js';
import { recordSystemDecision } from '../systemDecision.js';
import type {
  CalibrationVersion,
  Competitor,
  EntityMergeSuggestion,
  Decision,
  Finding,
  OutputStatus,
  Persona,
  Profile,
  Rating,
  Recommendation,
  Role,
  SymptomHypothesis,
  UnitProposal,
  UnitProposalSnapshot,
  UserRequest,
  Workspace,
} from '../types.js';
import { acceptUnitProposal, rejectUnitProposal, type UnitProposalEdits } from '../workspace/businessMap.js';
// knowledge store KS-3
import { entityNameKey } from '../knowledge/entityKeys.js';
import {
  EntityConflictError, cleanEntityName, mergeEntities, rejectMergeSuggestion, renameEntity, type MergeResult, type RenameResult,
} from '../knowledge/entities.js';
import { KnowledgeNotFoundError, inTree, scopeFor } from '../knowledge/scope.js';
import { knowledgeRepos } from '../store/repos.js';
import { DEFAULT_ACTOR, recordFeedback, type FeedbackEvent } from './events.js';
import { FactActionError, applyReplacementByUser, retractFactByUser, setFactScopes } from '../knowledge/facts.js'; // KS-2, KS-7
import { pruneArtifacts, type ArtifactFiles, type PruneResult } from '../knowledge/gc.js'; // KS-7
import { mergeSuggestionIsUploadOnly } from '../knowledge/provenance.js'; // KS-7
import { mergeDuplicateSaves } from '../knowledge/outcomes.js'; // KS-6
import { targetProvenance } from './provenance.js';
import { UNIT_PROPOSAL_CRITERION } from './signals.js';

/** User-facing validation error of a feedback action (the API maps it to 400). */
export class FeedbackActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'FeedbackActionError';
  }
}

export type ActorOpts = { actor?: string; reason?: string };
const actor = (o: ActorOpts) => o.actor?.trim() || DEFAULT_ACTOR;

// ---------------------------------------------------------------------------
// include overrides

export type IncludeTarget = 'finding' | 'recommendation' | 'persona' | 'competitor' | 'hypothesis';
type IncludeItem = Finding | Recommendation | Persona | Competitor | SymptomHypothesis;

function includeItem(store: Store, kind: IncludeTarget, id: string): { item: IncludeItem; include: boolean | undefined; status: OutputStatus | undefined } | undefined {
  switch (kind) {
    case 'finding': {
      const f = store.findings.get(id);
      return f && { item: f, include: f.includeInSynthesis, status: f.status };
    }
    case 'recommendation': {
      const r = store.recommendations.get(id);
      return r && { item: r, include: r.includeOverride, status: r.status };
    }
    case 'persona': {
      const p = store.personas.get(id);
      return p && { item: p, include: p.includeOverride, status: p.status };
    }
    case 'competitor': {
      const c = store.competitors.get(id);
      return c && { item: c, include: c.includeOverride, status: c.status };
    }
    case 'hypothesis': {
      const h = store.symptomHypotheses.get(id);
      return h && { item: h, include: h.includeOverride, status: h.status };
    }
  }
}

/**
 * Sets (or with `null` resets) the user's include override on an agent output — findings
 * (`includeInSynthesis`), recommendations, personas, competitors, symptom hypotheses — and records an
 * `include_override` feedback event (`before`: previous override + review status; `after`: the new
 * override). Unchanged overrides record nothing. Throws `FeedbackActionError` (404) when unknown.
 */
export function setIncludeOverride(store: Store, kind: IncludeTarget, id: string, include: boolean | null, opts: ActorOpts = {}): IncludeItem {
  return store.transaction(() => {
    const cur = includeItem(store, kind, id);
    if (!cur) throw new FeedbackActionError(`${kind} '${id}' not found`, 404);
    let next: IncludeItem;
    if (kind === 'finding') next = setIncludeInSynthesis(store, id, include);
    else if (kind === 'hypothesis') next = store.symptomHypotheses.update(id, { includeOverride: include ?? undefined });
    else next = setOutputInclude(store, kind, id, include);
    if ((cur.include ?? null) !== include) {
      recordFeedback(store, {
        workspaceId: cur.item.workspaceId,
        actor: actor(opts),
        kind: 'include_override',
        targetType: kind,
        targetId: id,
        beforeJson: { include: cur.include ?? null, status: cur.status ?? null },
        afterJson: { include },
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
    }
    // Knowledge store KS-2 (design §7.2): including an unverified update of a fact applies it.
    if (kind === 'finding' && include === true) {
      const applied = applyReplacementByUser(store, id, { actor: actor(opts), ...(opts.reason ? { reason: opts.reason } : {}) });
      if (applied) next = applied;
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// unit proposals

const snapshot = (p: UnitProposal): UnitProposalSnapshot => ({
  name: p.name,
  description: p.description,
  level: p.level,
  audiences: p.audiences,
  evidence: p.evidence,
  reasoning: p.reasoning,
});

/** Human-readable edit diff, e.g. `name: "Dev" → "Dev Platform"`. */
function diffText(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return Object.keys(after)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`)
    .join('; ');
}

export type UnitProposalDecision =
  | { action: 'accept'; edits?: UnitProposalEdits; reason?: string }
  | { action: 'reject'; reason?: string };

export type UnitProposalOutcome = { proposal: UnitProposal; workspace?: Workspace; rating: Rating; feedback: FeedbackEvent };

/**
 * Accepts (optionally with edits) or rejects a unit proposal with full provenance: `decidedAt`,
 * `actor`, `decisionReason`; on accept-with-edit the agent's proposal is kept verbatim in
 * `originalPayload`. Every decision is a calibration signal on the proposing Decision (criterion
 * `unit_proposal`): `accepted` (agree), `edited` (disagree; reason = the edit diff) or `rejected`
 * (disagree). Records a `proposal_accept` / `proposal_edit` / `proposal_reject` feedback event.
 */
export function decideUnitProposal(store: Store, id: string, decision: UnitProposalDecision, opts: { actor?: string } = {}): UnitProposalOutcome {
  const who = actor(opts);
  return store.transaction(() => {
    const p = store.unitProposals.get(id);
    if (!p) throw new FeedbackActionError(`unit proposal '${id}' not found`, 404);
    if (p.status !== 'proposed') throw new FeedbackActionError(`unit proposal '${id}' is already ${p.status}`, 409);
    const original = snapshot(p);
    const reason = decision.reason?.trim() || undefined;
    const now = new Date().toISOString();
    const prov = targetProvenance(store, p.workspaceId, 'unit_proposal', id);
    const provFields = {
      ...(prov.agentRunId ? { agentRunId: prov.agentRunId } : {}),
      ...(prov.promptVersion ? { promptVersion: prov.promptVersion } : {}),
    };

    let workspace: Workspace | undefined;
    let rating: Rating;
    let kind: FeedbackEvent['kind'];
    if (decision.action === 'reject') {
      rating = rejectUnitProposal(store, id, reason ?? '').rating;
      rating = store.ratings.update(rating.id, { actor: who, ...provFields });
      kind = 'proposal_reject';
    } else {
      const edits = Object.fromEntries(Object.entries(decision.edits ?? {}).filter(([, v]) => v !== undefined)) as UnitProposalEdits;
      const editable = { name: p.name, description: p.description, level: p.level, audiences: p.audiences };
      const diff = diffText(editable, { ...editable, ...edits });
      workspace = acceptUnitProposal(store, id, edits);
      kind = diff ? 'proposal_edit' : 'proposal_accept';
      const row: Rating = {
        id: newId('rat'),
        workspaceId: p.workspaceId,
        targetType: 'decision',
        targetId: p.decisionId ?? p.id,
        criterion: UNIT_PROPOSAL_CRITERION,
        agentValue: 'proposed',
        verdict: diff ? 'disagree' : 'agree',
        createdAt: now,
        actor: who,
        ...provFields,
      };
      if (diff) {
        row.userValue = 'edited';
        row.reason = reason ? `${reason} (edited: ${diff})` : `edited: ${diff}`;
      } else if (reason) {
        row.reason = reason;
      }
      rating = store.ratings.insert(row);
    }
    const patch: Partial<UnitProposal> = { decidedAt: now, actor: who };
    if (reason) patch.decisionReason = reason;
    if (kind === 'proposal_edit') patch.originalPayload = original;
    const proposal = store.unitProposals.update(id, patch);
    const feedback = recordFeedback(store, {
      workspaceId: p.workspaceId,
      actor: who,
      createdAt: now,
      kind,
      targetType: 'unit_proposal',
      targetId: id,
      beforeJson: original,
      afterJson: { status: proposal.status, ...snapshot(proposal), ...(proposal.childWorkspaceId ? { childWorkspaceId: proposal.childWorkspaceId } : {}) },
      ...(reason ? { reason } : {}),
      ...provFields,
    });
    return { proposal, ...(workspace ? { workspace } : {}), rating, feedback };
  });
}

// ---------------------------------------------------------------------------
// user requests

/**
 * Answers (resolves or denies) an agent's user request with provenance (`resolvedAt`, `actor`) and a
 * `request_answer` feedback event (agent run = the requesting run). See `resolveUserRequest`.
 */
export function answerUserRequest(
  deps: { store: Store; events: EventBus },
  id: string,
  status: 'resolved' | 'denied',
  response: string | undefined,
  opts: { actor?: string } = {},
): UserRequest {
  return answerWithProvenance(deps.store, id, opts, () => {
    resolveUserRequest(deps, id, status, response);
    return { status, ...(response !== undefined ? { response } : {}) };
  });
}

/**
 * The user's answer to an escalation question (WP-D `answerEscalation`: option index + optional
 * note) with the same provenance as any request answer: `resolvedAt`, `actor` and a
 * `request_answer` feedback event (`afterJson.choice` = the chosen option). `EscalationError`s
 * propagate (the API maps them).
 */
export function answerEscalationAsUser(
  deps: { store: Store; events: EventBus },
  id: string,
  input: { choice: number; note?: string },
  opts: { actor?: string } = {},
): UserRequest {
  return answerWithProvenance(deps.store, id, opts, () => {
    const answered = answerEscalation(deps, id, input);
    return { status: 'resolved', ...(answered.response !== undefined ? { response: answered.response } : {}), choice: input.choice };
  });
}

/** Runs `answer` on a pending user request and records who answered, when, and the feedback event. */
function answerWithProvenance(store: Store, id: string, opts: { actor?: string }, answer: () => Record<string, unknown>): UserRequest {
  const who = actor(opts);
  return store.transaction(() => {
    const before = store.userRequests.get(id);
    if (!before) throw new FeedbackActionError(`user request '${id}' not found`, 404);
    if (before.status !== 'pending') throw new FeedbackActionError(`user request '${id}' is already ${before.status}`, 409);
    const after = answer();
    const resolvedAt = new Date().toISOString();
    const updated = store.userRequests.update(id, { resolvedAt, actor: who });
    recordFeedback(store, {
      workspaceId: updated.workspaceId,
      actor: who,
      createdAt: resolvedAt,
      kind: 'request_answer',
      targetType: 'user_request',
      targetId: id,
      beforeJson: { status: before.status, kind: before.kind, ...(before.site ? { site: before.site } : {}), details: before.details },
      afterJson: after,
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// symptom hypotheses

export type HypothesisCorrection = { hypothesis?: string; confidence?: number };

/**
 * The user's correction of a symptom hypothesis (text and/or confidence 0–100), distinct from agent
 * revisions (which are `save_hypothesis` Decisions): updates the hypothesis and records a
 * `hypothesis_correction` feedback event with the agent's judgment (run + prompt version).
 */
export function correctHypothesis(store: Store, id: string, input: HypothesisCorrection, opts: ActorOpts = {}): SymptomHypothesis {
  return store.transaction(() => {
    const h = store.symptomHypotheses.get(id);
    if (!h) throw new FeedbackActionError(`hypothesis '${id}' not found`, 404);
    const patch: Partial<SymptomHypothesis> = {};
    if (input.hypothesis !== undefined) {
      const text = input.hypothesis.trim();
      if (!text) throw new FeedbackActionError('hypothesis must not be empty');
      if (text !== h.hypothesis) patch.hypothesis = text;
    }
    if (input.confidence !== undefined) {
      if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) {
        throw new FeedbackActionError('confidence must be a number 0–100 (percent)');
      }
      if (input.confidence !== h.confidence) patch.confidence = input.confidence;
    }
    if (!Object.keys(patch).length) throw new FeedbackActionError('nothing to correct: give a new hypothesis text or confidence');
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, h[k as keyof SymptomHypothesis]]));
    const updated = store.symptomHypotheses.update(id, patch);
    recordFeedback(store, {
      workspaceId: h.workspaceId,
      actor: actor(opts),
      kind: 'hypothesis_correction',
      targetType: 'hypothesis',
      targetId: id,
      beforeJson: { symptomId: h.symptomId, ...before },
      afterJson: patch,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// profile

/**
 * The user's direct edit of a workspace profile (RFC 7386 merge patch; app-managed keys such as
 * `uploads` cannot be changed). Records a `profile_edit` feedback event with the changed keys only
 * (before → after). Throws when nothing would change.
 */
export function editProfile(store: Store, workspaceId: string, patch: Record<string, unknown>, opts: ActorOpts = {}): Profile {
  return store.transaction(() => {
    if (!store.workspaces.get(workspaceId)) throw new FeedbackActionError(`workspace '${workspaceId}' not found`, 404);
    const clean = { ...patch };
    for (const k of PROTECTED_PROFILE_KEYS) {
      if (Object.hasOwn(clean, k)) throw new FeedbackActionError(`profile.${k} is managed by the app`);
    }
    const existing = store.profiles.get(workspaceId);
    const prev = existing?.data ?? {};
    const next = mergePatch(prev, clean) as Record<string, unknown>;
    const changed = Object.keys(clean).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    if (!changed.length) throw new FeedbackActionError('the patch does not change the profile');
    const profile = existing ? store.profiles.update(workspaceId, { data: next }) : store.profiles.insert({ workspaceId, data: next });
    const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k] ?? null]));
    recordFeedback(store, {
      workspaceId,
      actor: actor(opts),
      kind: 'profile_edit',
      targetType: 'profile',
      targetId: workspaceId,
      beforeJson: pick(prev),
      afterJson: pick(next),
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return profile;
  });
}

// ---------------------------------------------------------------------------
// weights

/** Records a `weights_change` feedback event (priority weights / persona weight before → after). */
export function recordWeightsChange(
  store: Store,
  workspaceId: string,
  before: BifConfig['scoring'],
  after: BifConfig['scoring'],
  opts: ActorOpts & { source?: string; decisionId?: string } = {},
): FeedbackEvent {
  return recordFeedback(store, {
    workspaceId,
    actor: actor(opts),
    kind: 'weights_change',
    targetType: 'scoring_weights',
    targetId: 'scoring',
    beforeJson: before,
    afterJson: { ...after, ...(opts.source ? { source: opts.source } : {}), ...(opts.decisionId ? { decisionId: opts.decisionId } : {}) },
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// prompt patches

/**
 * Canonical current prompt text of a role in a business tree: the text its runs record for the base
 * prompt (worker / synthesizer: worker prompt without task-type extras or browser note; reviewer:
 * reviewer prompt + policy; orchestrator / interviewer: their prompt; persona: the persona
 * calibration appendix, since persona prompts are per persona). Changes when a patch is applied.
 */
export function rolePromptText(config: BifConfig, role: Role, scope: CalibrationScope): string {
  switch (role) {
    case 'worker':
    case 'synthesizer':
      return workerSystemPrompt(config, role, false, undefined, scope);
    case 'reviewer':
      return reviewerSystemPrompt(config, scope);
    case 'persona':
      return withCalibration('', 'persona', scope);
    default:
      return loadPrompt(role, scope).text;
  }
}

/** Canonical current prompt version of a role in a business tree (hash of `rolePromptText`). */
export function rolePromptVersion(config: BifConfig, role: Role, scope: CalibrationScope): string {
  return promptVersion(rolePromptText(config, role, scope));
}

/**
 * `rolePromptVersion` that also stores the text in the prompt store (WP-B `recordPromptVersion`), so
 * the hash a decision / feedback event is tagged with always resolves to its text.
 */
export function recordRolePromptVersion(store: Store, config: BifConfig, role: Role, scope: CalibrationScope): string {
  return recordPromptVersion(store, role, rolePromptText(config, role, scope));
}

export type AppliedPatch = {
  path: string;
  decisionId: string;
  /** The `calibration_versions` row this approval created (WP-B history). */
  versionId: string;
  promptVersion: string;
  previousPromptVersion: string;
  feedback: FeedbackEvent;
};

/**
 * User approval of a (possibly edited) prompt calibration patch — THE apply path (learning loop
 * WP-A + WP-B): merges it into the role's calibration appendix of the workspace's business tree and
 * keeps the history (`applyPromptPatchVersioned` → a `calibration_versions` row), logs an
 * `apply_prompt_patch` Decision by the real actor (`agentRunId` = actor id) at the role's new
 * prompt version (linked from the version row), and records a `prompt_patch_apply` feedback event
 * (before: previous version + appendix; after: new version + patch + decision + version ids).
 * `sources` = the rated items behind the role's current proposal, so exports can apply
 * upload-provenance filtering to the patch.
 */
export function applyPromptPatchAsUser(
  deps: { store: Store; events?: EventBus; config: BifConfig },
  workspaceId: string,
  patch: Pick<PromptPatch, 'role' | 'patchText' | 'examples'>,
  opts: ActorOpts = {},
): AppliedPatch {
  const { store, config } = deps;
  const who = actor(opts);
  const scope = calibrationScope(store, config.dataDir, workspaceId);
  const previousPromptVersion = recordRolePromptVersion(store, config, patch.role, scope);
  const previousAppendix = calibrationAppendix(patch.role, scope);
  const sources = proposePromptPatch(workspaceId, patch.role, { store }).sources ?? [];
  return store.transaction(() => {
    const { path, version: cal } = applyPromptPatchVersioned(
      store,
      { role: patch.role, patchText: patch.patchText, examples: patch.examples },
      scope,
      who,
    );
    const version = recordRolePromptVersion(store, config, patch.role, scope);
    const decision: Decision = recordSystemDecision(
      { store, ...(deps.events ? { events: deps.events } : {}) },
      {
        workspaceId,
        actor: 'user',
        actorId: who,
        promptVersion: version,
        payload: { tool: 'apply_prompt_patch', role: patch.role, patchText: patch.patchText, path, previousPromptVersion, sources, versionId: cal.id },
      },
    );
    setCalibrationDecision(store, cal.id, decision.id);
    const feedback = recordFeedback(store, {
      workspaceId,
      actor: who,
      kind: 'prompt_patch_apply',
      targetType: 'prompt',
      targetId: patch.role,
      beforeJson: { promptVersion: previousPromptVersion, appendix: previousAppendix },
      afterJson: { promptVersion: version, patchText: patch.patchText, path, decisionId: decision.id, versionId: cal.id, sources },
      promptVersion: version,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return { path, decisionId: decision.id, versionId: cal.id, promptVersion: version, previousPromptVersion, feedback };
  });
}

export type RevertedPatch = {
  path: string;
  decisionId: string;
  version: CalibrationVersion;
  promptVersion: string;
  previousPromptVersion: string;
  feedback: FeedbackEvent;
};

/**
 * User action: restores calibration version `versionId` of the workspace's business tree
 * (`revertCalibration`, recorded as a new `revert` version), logs a `revert_calibration` Decision by
 * the real actor at the role's restored prompt version and a `prompt_patch_revert` feedback event.
 * Throws `FeedbackActionError` (404) for an unknown version or one of another tree.
 */
export function revertCalibrationAsUser(
  deps: { store: Store; events?: EventBus; config: BifConfig },
  workspaceId: string,
  versionId: string,
  opts: ActorOpts = {},
): RevertedPatch {
  const { store, config } = deps;
  const who = actor(opts);
  const scope = calibrationScope(store, config.dataDir, workspaceId);
  return store.transaction(() => {
    let result: ReturnType<typeof revertCalibration>;
    let previousPromptVersion: string;
    try {
      const target = usageRepos(store).calibrationVersions.get(versionId);
      previousPromptVersion = target ? recordRolePromptVersion(store, config, target.role, scope) : '';
      result = revertCalibration(store, scope, versionId, who);
    } catch (e) {
      throw new FeedbackActionError((e as Error).message, 404);
    }
    const role = result.version.role;
    const version = recordRolePromptVersion(store, config, role, scope);
    const decision = recordSystemDecision(
      { store, ...(deps.events ? { events: deps.events } : {}) },
      {
        workspaceId,
        actor: 'user',
        actorId: who,
        promptVersion: version,
        payload: { tool: 'revert_calibration', role, versionId, newVersionId: result.version.id, path: result.path, previousPromptVersion },
      },
    );
    const cal = setCalibrationDecision(store, result.version.id, decision.id);
    const feedback = recordFeedback(store, {
      workspaceId,
      actor: who,
      kind: 'prompt_patch_revert',
      targetType: 'prompt',
      targetId: role,
      beforeJson: { promptVersion: previousPromptVersion },
      afterJson: { promptVersion: version, revertedTo: versionId, path: result.path, decisionId: decision.id, versionId: cal.id },
      promptVersion: version,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return { path: result.path, decisionId: decision.id, version: cal, promptVersion: version, previousPromptVersion, feedback };
  });
}

// ---------------------------------------------------------------------------
// Knowledge store KS-3: entity merge / rename as human actions (design §7.4, §13; wave-1 hook 2).
// Same transaction as the change; the actor comes from the caller (`actorOf(config)` in the API).

export type EntityActionOpts = ActorOpts & {
  /** The caller's node: ids outside its tree are "not found" (design §12). */
  workspaceId?: string;
};

/** Runs an entity action, mapping knowledge errors to `FeedbackActionError` (404 not found, 409 conflict). */
function entityAction<R>(fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KnowledgeNotFoundError) throw new FeedbackActionError(e.message, 404);
    if (e instanceof EntityConflictError) throw new FeedbackActionError(e.message, 409);
    throw e;
  }
}

const entitySnapshot = (e: { id: string; kind: string; name: string; aliases: string[] }) => ({
  id: e.id, kind: e.kind, name: e.name, aliases: e.aliases,
});

/**
 * Merges entity `loserId` into `survivorId` (`mergeEntities`) and records an `entity_merge` feedback
 * event on the survivor (before: both entities; after: the survivor's names). When an upload-only
 * name is involved, `beforeJson.uploadRefs` lists the upload-derived records behind it, so the
 * export's provenance expansion leaves the event out by default.
 */
export function mergeEntitiesAsUser(store: Store, survivorId: string, loserId: string, opts: EntityActionOpts = {}): MergeResult {
  return entityAction(() =>
    store.transaction(() => {
      const repo = knowledgeRepos(store).entities;
      const before = { survivor: repo.get(survivorId), loser: repo.get(loserId) };
      const scope = opts.workspaceId !== undefined ? scopeFor(store, opts.workspaceId) : undefined;
      // KS-6: handshake answers the merge reveals as duplicate saves (computed before facts are re-pointed).
      const duplicateSaved = before.survivor && before.loser ? mergeDuplicateSaves(store, survivorId, loserId) : [];
      const result = mergeEntities(store, survivorId, loserId, actor(opts), scope ? { scope } : {});
      recordFeedback(store, {
        workspaceId: result.survivor.workspaceId,
        actor: actor(opts),
        kind: 'entity_merge',
        targetType: 'entity',
        targetId: result.survivor.id,
        beforeJson: {
          survivor: entitySnapshot(before.survivor!),
          loser: entitySnapshot(before.loser!),
          ...(result.uploadRefs.length ? { uploadRefs: result.uploadRefs } : {}),
        },
        afterJson: {
          survivor: { name: result.survivor.name, aliases: result.survivor.aliases },
          mergedIntoId: result.survivor.id,
          aliasUploadOnly: result.aliasUploadOnly,
          swappedNames: result.swappedNames,
          ...(duplicateSaved.length ? { duplicateSaved } : {}), // KS-6
        },
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      return result;
    }),
  );
}

/** Renames an entity (`renameEntity`) and records an `entity_rename` feedback event (same upload rule as merges). */
export function renameEntityAsUser(store: Store, entityId: string, name: string, opts: EntityActionOpts = {}): RenameResult {
  if (!entityNameKey(cleanEntityName(name))) throw new FeedbackActionError('name is empty', 400);
  return entityAction(() =>
    store.transaction(() => {
      const scope = opts.workspaceId !== undefined ? scopeFor(store, opts.workspaceId) : undefined;
      const result = renameEntity(store, entityId, name, scope ? { scope } : {});
      const prior = { name: result.previousName };
      recordFeedback(store, {
        workspaceId: result.entity.workspaceId,
        actor: actor(opts),
        kind: 'entity_rename',
        targetType: 'entity',
        targetId: result.entity.id,
        beforeJson: { ...prior, ...(result.uploadRefs.length ? { uploadRefs: result.uploadRefs } : {}) },
        afterJson: { name: result.entity.name, aliases: result.entity.aliases, aliasUploadOnly: result.aliasUploadOnly },
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      return result;
    }),
  );
}
// --- end knowledge store KS-3 ----------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Knowledge store KS-7: the human actions of the Knowledge view (design §13, §14, §17). Every one
// runs through here with the actor from the caller (`actorOf(config)` in the API, never a request
// body). With `workspaceId` (the caller's node) any id outside its business tree answers exactly
// like an unknown id (404, design §12).

export type KnowledgeActionOpts = ActorOpts & {
  /** The caller's node: ids outside its tree are "not found". */
  workspaceId?: string;
};

/** Runs a fact action, mapping knowledge errors to `FeedbackActionError` (404 / the fact error's status). */
function factAction<R>(fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KnowledgeNotFoundError) throw new FeedbackActionError(e.message, 404);
    if (e instanceof FactActionError) throw new FeedbackActionError(e.message, e.status);
    throw e;
  }
}

/** The fact `id`, if it is in the caller's tree (else the same 404 as an unknown id). */
function callerFact(store: Store, id: string, opts: KnowledgeActionOpts): Finding {
  const f = store.findings.get(id);
  const scope = opts.workspaceId !== undefined ? factAction(() => scopeFor(store, opts.workspaceId!)) : undefined;
  if (!f || (scope && !inTree(scope, f.workspaceId))) throw new FeedbackActionError(`finding '${id}' not found`, 404);
  return f;
}

const factOpts = (opts: KnowledgeActionOpts) => ({ actor: actor(opts), ...(opts.reason ? { reason: opts.reason } : {}) });

/** The user retracts a current fact (`retractFactByUser`: a `fact_retract` event). 409 when not current. */
export function retractFactAsUser(store: Store, findingId: string, opts: KnowledgeActionOpts = {}): Finding {
  callerFact(store, findingId, opts);
  return factAction(() => retractFactByUser(store, findingId, factOpts(opts)));
}

/** The user relabels the nodes a fact applies to (`setFactScopes`: a `fact_scope_change` event). Nodes outside the fact's tree: 404. */
export function setFactScopesAsUser(store: Store, findingId: string, workspaceIds: string[], opts: KnowledgeActionOpts = {}): string[] {
  if (!workspaceIds.length) throw new FeedbackActionError('give at least one node the fact applies to', 400);
  callerFact(store, findingId, opts);
  return factAction(() => setFactScopes(store, findingId, workspaceIds, factOpts(opts)));
}

/**
 * The user applies an unverified replacement (design §7.2): the include override set to true on a
 * `candidate` whose replace observation was rejected (`setIncludeOverride` → `applyReplacementByUser`,
 * `include_override` + `fact_replacement_accept` events). 409 when there is nothing to apply.
 */
export function acceptReplacementAsUser(store: Store, findingId: string, opts: KnowledgeActionOpts = {}): Finding {
  const f = callerFact(store, findingId, opts);
  const pending = knowledgeRepos(store).factObservations.list({ findingId: f.id, kind: 'replace', status: 'rejected' }).length > 0;
  if (f.lifecycle !== 'candidate' || f.status === 'superseded' || !pending) {
    throw new FeedbackActionError(`finding '${f.id}' is not an unverified update that can be applied`, 409);
  }
  return factAction(() => setIncludeOverride(store, 'finding', f.id, true, factOpts(opts))) as Finding;
}

/** An open merge suggestion of the caller's tree (else 404 / 409). */
function callerSuggestion(store: Store, id: string, opts: KnowledgeActionOpts) {
  const s = knowledgeRepos(store).entityMergeSuggestions.get(id);
  const scope = opts.workspaceId !== undefined ? factAction(() => scopeFor(store, opts.workspaceId!)) : undefined;
  if (!s || (scope && s.rootWorkspaceId !== scope.rootId)) throw new FeedbackActionError(`merge suggestion '${id}' not found`, 404);
  if (s.status !== 'open') throw new FeedbackActionError(`merge suggestion '${id}' is already ${s.status}`, 409);
  return s;
}

/**
 * Accepts a merge suggestion: merges the two entities (`mergeEntitiesAsUser`, an `entity_merge`
 * event). The survivor defaults to the earlier entity (`candidateId`); `survivorId` may pick the other.
 */
export function acceptMergeSuggestionAsUser(
  store: Store,
  suggestionId: string,
  opts: KnowledgeActionOpts & { survivorId?: string } = {},
): MergeResult {
  const s = callerSuggestion(store, suggestionId, opts);
  const survivor = opts.survivorId ?? s.candidateId;
  if (survivor !== s.candidateId && survivor !== s.entityId) throw new FeedbackActionError('survivorId must be one of the two suggested entities', 400);
  const loser = survivor === s.candidateId ? s.entityId : s.candidateId;
  return mergeEntitiesAsUser(store, survivor, loser, opts);
}

/**
 * Rejects a merge suggestion (the row records actor and time) and, in the same transaction, an
 * `entity_merge_reject` feedback event on the suggested entity (before: the pair; after: the status).
 * An upload-only name involved lists the suggestion in `beforeJson.uploadRefs` (export leaves it out).
 */
export function rejectMergeSuggestionAsUser(store: Store, suggestionId: string, opts: KnowledgeActionOpts = {}): EntityMergeSuggestion {
  const s = callerSuggestion(store, suggestionId, opts);
  return entityAction(() =>
    store.transaction(() => {
      const repo = knowledgeRepos(store).entities;
      const entity = repo.get(s.entityId);
      const candidate = repo.get(s.candidateId);
      const rejected = rejectMergeSuggestion(store, scopeFor(store, s.rootWorkspaceId), s.id, actor(opts));
      const uploadOnly = mergeSuggestionIsUploadOnly(store, s.id);
      recordFeedback(store, {
        workspaceId: entity?.workspaceId ?? s.rootWorkspaceId,
        actor: actor(opts),
        kind: 'entity_merge_reject',
        targetType: 'entity',
        targetId: s.entityId,
        beforeJson: {
          suggestionId: s.id, score: s.score,
          ...(entity ? { entity: entitySnapshot(entity) } : {}),
          ...(candidate ? { candidate: entitySnapshot(candidate) } : {}),
          ...(uploadOnly ? { uploadRefs: [s.id] } : {}),
        },
        afterJson: { status: rejected.status, suggestionId: s.id },
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      return rejected;
    }),
  );
}

export type PruneDeps = { store: Store; files: ArtifactFiles; config: Pick<BifConfig, 'knowledge'>; events?: EventBus };

/**
 * The user prunes stored files (design §14; `pruneArtifacts`, all or nothing): in the same transaction
 * a system decision (tool `artifact_prune`, refs = the artifacts) and one `artifact_prune` feedback
 * event per artifact (before: path, sha256, bytes, last capture; after: the decision). Ids outside
 * the caller's tree are refused like unknown ones. Throws `PruneError` (400 / 409 with `refused`) or
 * `FeedbackActionError` (404 unknown caller node).
 */
export function pruneArtifactsAsUser(
  deps: PruneDeps,
  workspaceId: string,
  artifactIds: string[],
  opts: ActorOpts & { minAgeDays?: number; now?: Date } = {},
): PruneResult & { decisionId: string; feedback: FeedbackEvent[] } {
  const { store } = deps;
  const scope = factAction(() => scopeFor(store, workspaceId));
  let decisionId = '';
  const feedback: FeedbackEvent[] = [];
  const result = pruneArtifacts(
    store, deps.files, deps.config, artifactIds,
    { treeIds: scope.treeIds, ...(opts.minAgeDays !== undefined ? { minAgeDays: opts.minAgeDays } : {}), ...(opts.now ? { now: opts.now } : {}) },
    (eligible, minAgeDays) => {
      const decision = recordSystemDecision(
        { store, ...(deps.events ? { events: deps.events } : {}) },
        {
          workspaceId, actor: 'user', actorId: actor(opts), refs: eligible.map((x) => x.artifactId),
          payload: {
            tool: 'artifact_prune', minAgeDays, ...(opts.reason ? { reason: opts.reason } : {}),
            artifacts: eligible.map((x) => ({ id: x.artifactId, workspaceId: x.workspaceId, bytes: x.bytes, ageDays: x.ageDays })),
          },
        },
      );
      decisionId = decision.id;
      for (const x of eligible) {
        const a = store.artifacts.get(x.artifactId)!;
        feedback.push(recordFeedback(store, {
          workspaceId: a.workspaceId,
          actor: actor(opts),
          kind: 'artifact_prune',
          targetType: 'artifact',
          targetId: a.id,
          beforeJson: { path: a.path, sha256: a.sha256, bytes: x.bytes, lastCapturedAt: x.lastCapturedAt, ageDays: x.ageDays },
          afterJson: { fileRemoved: true, decisionId: decision.id, minAgeDays },
          ...(opts.reason ? { reason: opts.reason } : {}),
        }));
      }
    },
  );
  return { ...result, decisionId, feedback };
}
// --- end knowledge store KS-7 ----------------------------------------------------------------------
