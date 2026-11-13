/**
 * Human actions with feedback provenance (learning loop WP-A). Each function performs one user
 * action on agent output and, in the same transaction, records who did it, when, why and what
 * changed (`recordFeedback`), plus — where the action is a learning signal — a rating-equivalent
 * row for calibration (`signals.ts`). The API calls these with `actor = actorOf(config)`.
 */
import type { BifConfig } from '../config/schema.js';
import type { EventBus } from '../events.js';
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
import { DEFAULT_ACTOR, recordFeedback, type FeedbackEvent } from './events.js';
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
  const { store } = deps;
  const who = actor(opts);
  return store.transaction(() => {
    const before = store.userRequests.get(id);
    if (!before) throw new FeedbackActionError(`user request '${id}' not found`, 404);
    if (before.status !== 'pending') throw new FeedbackActionError(`user request '${id}' is already ${before.status}`, 409);
    resolveUserRequest(deps, id, status, response);
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
      afterJson: { status, ...(response !== undefined ? { response } : {}) },
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
