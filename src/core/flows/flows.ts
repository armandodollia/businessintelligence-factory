/**
 * Flow records (design 2026-11-14-flow-records-and-ranking-design.md §8.2–§8.4, §10 intro): one
 * subject's way of doing one flow type, as observed, with its ordered steps.
 *
 * - Identity: subject entity + flow type + `variantKey` (`titleKey(variant)`), within one business
 *   tree. A flow record belongs to its subject, not to a node, so two nodes with the same subject
 *   share it.
 * - Versions (like facts): every version of one identity shares a `lineageId`. A first save is
 *   `current` at version 1. A save with equal `stepsHash` confirms the current version (no new row);
 *   `{ replaces }` saves version n+1 as a `candidate`, which becomes `current` only when its task ends
 *   `verified` (`applyFlowStatus`); the version it replaces is then `replaced`. Confirmation applies at
 *   save, unlike facts (plan decision).
 * - Review status: flows are task outputs like competitors (`status`, `taskId`, `taskRound`,
 *   `includeOverride`; `research/outputs.ts`). A version whose status is `superseded` is never the
 *   current one of its variant.
 * - Knowledge store: each flow belongs to a `flow` entity named "<subject>: <flow type> (<variant>)",
 *   linked from the subject with `has_flow` (source: the flow version) in the same transaction.
 * - Step text, name, goal and notes are third-party text: stored redacted and fence-stripped.
 *
 * Import cycle note: `research/outputs.ts` imports `applyFlowStatus` from here and this module
 * imports `isOutputUsable` from there. Both are function declarations used at call time only, so
 * the cycle is safe in either load order; keep it that way (no top-level use of either import). The
 * same holds for `./catalog.ts`, which imports `reconcileSubjectFlows` from here while this module
 * imports `flowTypeByKey` from there.
 */
import { createHash } from 'node:crypto';
import type { EntityKind } from '../config/schema.js';
import { titleKey } from '../harness/tools/idempotency.js';
import { lookupCompanyEntity, resolveEntityDetailed, type EntityRef } from '../knowledge/entities.js';
import { survivorOf } from '../knowledge/entityKeys.js';
import { normalizeText } from '../knowledge/extract/normalize.js';
import { addRelation } from '../knowledge/relations.js';
import { KnowledgeNotFoundError, inTree, scopeFor, type KnowledgeScope } from '../knowledge/scope.js';
import { redactServed, stripFences } from '../knowledge/trust.js';
import { isOutputUsable, type TaskOutcome } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { Entity, Task } from '../types.js';
import { flowTypeByKey } from './catalog.js';
import { flowRepos } from './repos.js';
import type { Flow, FlowStep, StopReason } from './types.js';

export type FlowStepInput = { action: string; observation: string; asked?: string[]; error?: string; artifactId?: string; pageUrl?: string };
export type SaveFlowInput = {
  subject: EntityRef;
  flowTypeKey: string;
  variant: string;
  primary: boolean;
  name: string;
  goal: string;
  entryUrl?: string;
  reachedGoal: boolean;
  stopReason?: StopReason;
  notable?: string;
  steps: FlowStepInput[];
  relation?: 'new' | { replaces: string } | { confirms: string };
};
export type SaveFlowResult =
  | { saved: true; flow: Flow; relation: 'new' | 'replaced' | 'confirmed' }
  | { saved: false; reason: 'exists'; existing: Array<{ id: string; variant: string; version: number; steps: number; sameSteps: boolean }> };
export type FlowCtx = { workspaceId: string; taskId?: string; taskRound?: number; runId?: string; agentRunId?: string };

/** A save refused for its input; the message is written to be returned to the agent as it is. */
export class FlowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowInputError';
  }
}

export const MAX_FLOW_STEPS = 60;
export const STOP_REASONS: readonly StopReason[] = ['payment', 'phone', 'kyc', 'captcha', 'approval_needed', 'error', 'not_found'];
/** Entity kinds a flow's subject may be (spec §7: a company, competitor or alternative, or product). */
export const FLOW_SUBJECT_KINDS: readonly EntityKind[] = ['company', 'competitor', 'product'];

const norm = (s: string | undefined) => titleKey(normalizeText(s ?? ''));

/** sha256 over the normalized step sequence: per step, in order, its action, what it asked (sorted) and its error. */
export function stepsHash(steps: FlowStepInput[]): string {
  const seq = steps.map((s) => [norm(s.action), (s.asked ?? []).map(norm).sort(), norm(s.error)]);
  return createHash('sha256').update(JSON.stringify(seq)).digest('hex');
}

/** The steps of a flow version, in order. */
export function flowSteps(store: Store, flowId: string): FlowStep[] {
  return flowRepos(store)
    .flowSteps.list({ flowId })
    .sort((a, b) => a.seq - b.seq);
}

/** Current versions of a subject's flows of one type (every variant), except superseded ones. */
function liveCurrent(store: Store, rootWorkspaceId: string, subjectEntityId: string, flowTypeId: string): Flow[] {
  return flowRepos(store)
    .flows.list({ rootWorkspaceId, subjectEntityId, flowTypeId, lifecycle: 'current' })
    .filter((f) => f.status !== 'superseded');
}

/** Clears `isPrimary` on the current versions of the flow's other variants (one primary per subject and type). */
function clearOtherPrimaries(store: Store, flow: Flow): void {
  const r = flowRepos(store);
  for (const f of r.flows.list({ rootWorkspaceId: flow.rootWorkspaceId, subjectEntityId: flow.subjectEntityId, flowTypeId: flow.flowTypeId, lifecycle: 'current' })) {
    if (f.id !== flow.id && f.variantKey !== flow.variantKey && f.isPrimary) r.flows.update(f.id, { isPrimary: false });
  }
}

/**
 * The subject entity of a save (a flow, or review mentions): resolved with the knowledge store's
 * rule, in the caller's tree only. Throws `FlowInputError`; another tree's entity reads as not found.
 */
export function resolveSubject(store: Store, scope: KnowledgeScope, ref: EntityRef, ctx: FlowCtx): Entity {
  if (!ref || typeof ref !== 'object') throw new FlowInputError('subject is required: { id } or { kind, name }');
  if (!('id' in ref)) {
    if (!FLOW_SUBJECT_KINDS.includes(ref.kind)) {
      throw new FlowInputError(`subject kind '${String(ref.kind)}' cannot have flows; use one of: ${FLOW_SUBJECT_KINDS.join(', ')}`);
    }
    if (typeof ref.name !== 'string' || !ref.name.trim()) throw new FlowInputError('subject name is empty');
  }
  let entity: Entity;
  try {
    entity = resolveEntityDetailed(store, scope, ref, {
      workspaceId: ctx.workspaceId,
      ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
    }).entity;
  } catch (e) {
    if (e instanceof KnowledgeNotFoundError) throw new FlowInputError(`subject ${e.message} in this business tree`);
    throw e;
  }
  if (!FLOW_SUBJECT_KINDS.includes(entity.kind)) {
    throw new FlowInputError(`subject '${entity.name}' is a ${entity.kind} entity and cannot have flows; use a ${FLOW_SUBJECT_KINDS.join(', ')} entity`);
  }
  return entity;
}

/**
 * Saves a walked flow (spec §8.2–§8.4), all in one transaction. With no `relation` (or `'new'`): no
 * current version of the variant → a new current version; a current one with equal `stepsHash` →
 * confirmed; otherwise nothing is saved and every current variant of the subject and type is listed
 * (`exists`). `{ replaces: id }` saves the next version as a candidate (see `applyFlowStatus`);
 * `{ confirms: id }` confirms that version whatever the steps. Throws `FlowInputError` on bad input.
 */
export function saveFlow(store: Store, ctx: FlowCtx, input: SaveFlowInput): SaveFlowResult {
  const scope = scopeFor(store, ctx.workspaceId);
  // Third-party text: the tree's identity secrets redacted (whole input at once), then fence-stripped.
  const red = redactServed(store, ctx.workspaceId, input);
  const clean = (s: unknown) => (typeof s === 'string' ? stripFences(s).trim() : '');
  const optional = (s: unknown) => clean(s) || undefined;
  const required = (s: unknown, field: string) => {
    const v = clean(s);
    if (!v) throw new FlowInputError(`${field} is required`);
    return v;
  };

  const variant = required(red.variant, 'variant');
  const variantKey = titleKey(variant);
  const name = required(red.name, 'name');
  const goal = required(red.goal, 'goal');
  if (!Array.isArray(red.steps) || red.steps.length === 0) throw new FlowInputError('a flow needs at least one step');
  if (red.steps.length > MAX_FLOW_STEPS) throw new FlowInputError(`a flow has at most ${MAX_FLOW_STEPS} steps (got ${red.steps.length})`);
  let stopReason: StopReason | undefined;
  if (input.reachedGoal) {
    if (input.stopReason !== undefined) throw new FlowInputError('stopReason is only for a flow whose goal was not reached (reachedGoal: false)');
  } else {
    if (!STOP_REASONS.includes(input.stopReason as StopReason)) {
      throw new FlowInputError(`reachedGoal is false: stopReason is required, one of ${STOP_REASONS.join(', ')}`);
    }
    stopReason = input.stopReason;
  }
  const steps: FlowStepInput[] = red.steps.map((s, i) => {
    const step: FlowStepInput = {
      action: required(s.action, `step ${i + 1} action`),
      observation: clean(s.observation),
      asked: (s.asked ?? []).map(clean).filter((a) => a !== ''),
    };
    const error = optional(s.error);
    const pageUrl = optional(s.pageUrl);
    const artifactId = input.steps[i]!.artifactId; // an id, kept as given
    if (error !== undefined) step.error = error;
    if (pageUrl !== undefined) step.pageUrl = pageUrl;
    if (artifactId !== undefined) step.artifactId = artifactId;
    return step;
  });
  const hash = stepsHash(steps);
  const notable = optional(red.notable);
  const entryUrl = optional(red.entryUrl);

  return store.transaction((): SaveFlowResult => {
    const type = flowTypeByKey(store, ctx.workspaceId, input.flowTypeKey);
    if (!type) throw new FlowInputError(`unknown flow type '${input.flowTypeKey}'; read the flow catalog or propose the type first`);
    if (type.status !== 'active' && type.status !== 'proposed') {
      throw new FlowInputError(`flow type '${type.key}' was ${type.status} by the user and takes no flows; use another type`);
    }
    for (const s of steps) {
      if (s.artifactId === undefined) continue;
      const a = store.artifacts.get(s.artifactId);
      if (!a || !inTree(scope, a.workspaceId)) throw new FlowInputError(`artifact '${s.artifactId}' not found in this business tree`);
    }
    const subject = resolveSubject(store, scope, input.subject, ctx);

    const r = flowRepos(store);
    const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
    const owner = task && task.workspaceId === ctx.workspaceId ? task : undefined;
    // Review tracking (as competitors): pending until the owning task's review loop ends, in the round
    // it was (re-)saved; without an owning task nothing will review it: unverified.
    const tracking: Pick<Flow, 'status' | 'taskRound' | 'taskId'> = owner
      ? { status: 'pending', taskRound: ctx.taskRound ?? owner.round, taskId: owner.id }
      : { status: 'unverified', taskRound: undefined, taskId: undefined };
    const now = new Date().toISOString();

    const variants = liveCurrent(store, scope.rootId, subject.id, type.id);
    const current = variants.find((f) => f.variantKey === variantKey);

    /** A version named by `relation`: a live current version of this subject, type and variant. */
    const target = (id: string): Flow => {
      const f = typeof id === 'string' ? r.flows.get(id) : undefined;
      if (!f || f.rootWorkspaceId !== scope.rootId) throw new FlowInputError(`flow '${id}' not found in this business tree`);
      if (f.subjectEntityId !== subject.id || f.flowTypeId !== type.id) {
        throw new FlowInputError(`flow '${id}' is not a ${type.key} flow of this subject`);
      }
      if (f.variantKey !== variantKey) {
        throw new FlowInputError(`flow '${id}' is the variant '${f.variant}', not '${variant}'; a different variant is a different flow, never a new version`);
      }
      if (f.lifecycle !== 'current' || f.status === 'superseded') {
        throw new FlowInputError(`flow '${id}' is not the current version of its variant${current ? ` (current: ${current.id})` : ''}`);
      }
      return f;
    };

    const confirm = (f: Flow): SaveFlowResult => {
      const patch: Partial<Flow> = { lastConfirmedAt: now, confirmCount: f.confirmCount + 1, isPrimary: input.primary === true };
      // Re-submitted by its own task (marks the round), or taken over from a task that did not verify
      // it; a version verified by another task keeps its owner and status.
      if (owner && (f.taskId === owner.id || f.status !== 'verified')) Object.assign(patch, tracking);
      const flow = r.flows.update(f.id, patch);
      if (flow.isPrimary) clearOtherPrimaries(store, flow);
      return { saved: true, flow, relation: 'confirmed' };
    };

    const insert = (lifecycle: 'current' | 'candidate', replaces: Flow | undefined): Flow => {
      const lineage = r.flows.list({ rootWorkspaceId: scope.rootId, subjectEntityId: subject.id, flowTypeId: type.id, variantKey });
      const id = newId('flw');
      const prior = replaces ?? lineage.at(-1);
      const priorEntity = prior?.entityId ? knowledgeRepos(store).entities.get(prior.entityId) : undefined;
      const entity =
        (priorEntity && survivorOf(store, priorEntity)) ??
        resolveEntityDetailed(store, scope, { kind: 'flow', name: `${subject.name}: ${type.name} (${variant})` }, {
          workspaceId: ctx.workspaceId,
          ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
        }).entity;
      const flow: Flow = {
        id,
        workspaceId: ctx.workspaceId,
        rootWorkspaceId: scope.rootId,
        subjectEntityId: subject.id,
        flowTypeId: type.id,
        variant,
        variantKey,
        isPrimary: input.primary === true,
        name,
        goal,
        reachedGoal: input.reachedGoal === true,
        stepsHash: hash,
        lineageId: prior?.lineageId ?? id,
        version: lineage.length ? Math.max(...lineage.map((f) => f.version)) + 1 : 1,
        lifecycle,
        ...tracking,
        entityId: entity.id,
        firstSeenAt: now,
        confirmCount: 0,
        createdAt: now,
      };
      if (entryUrl !== undefined) flow.entryUrl = entryUrl;
      if (stopReason !== undefined) flow.stopReason = stopReason;
      if (notable !== undefined) flow.notable = notable;
      if (replaces) flow.replacesId = replaces.id;
      if (ctx.runId !== undefined) flow.runId = ctx.runId;
      r.flows.insert(flow);
      steps.forEach((s, i) => r.flowSteps.insert({ flowId: id, seq: i + 1, action: s.action, observation: s.observation, asked: s.asked ?? [], error: s.error, artifactId: s.artifactId, pageUrl: s.pageUrl }));
      addRelation(store, scope, { from: subject.id, type: 'has_flow', to: entity.id, sourceKind: 'flow', sourceId: id });
      const saved = r.flows.get(id)!;
      if (lifecycle === 'current' && saved.isPrimary) clearOtherPrimaries(store, saved);
      return saved;
    };

    const rel = input.relation;
    if (rel && typeof rel === 'object' && 'confirms' in rel) return confirm(target(rel.confirms));
    if (rel && typeof rel === 'object' && 'replaces' in rel) {
      return { saved: true, flow: insert('candidate', target(rel.replaces)), relation: 'replaced' };
    }
    if (rel !== undefined && rel !== 'new') throw new FlowInputError("relation must be 'new', { replaces: id } or { confirms: id }");
    if (current) {
      if (current.stepsHash === hash) return confirm(current);
      return {
        saved: false,
        reason: 'exists',
        existing: variants.map((f) => ({
          id: f.id, variant: f.variant, version: f.version, steps: r.flowSteps.list({ flowId: f.id }).length, sameSteps: f.stepsHash === hash,
        })),
      };
    }
    return { saved: true, flow: insert('current', undefined), relation: 'new' };
  });
}

/**
 * Called from `applyTaskStatus` after the task's flows took their status (same transaction): when the
 * task ends `verified`, each of its verified candidate versions becomes `current` and every other
 * current version of its variant (the one it replaces, or one promoted since) becomes `replaced`; a
 * primary candidate takes the primary flag from the subject's other variants. Any other outcome leaves
 * candidates as they are, so the prior version stays current.
 */
export function applyFlowStatus(store: Store, task: Task, status: TaskOutcome): void {
  if (status !== 'verified') return;
  const r = flowRepos(store);
  for (const f of r.flows.list({ taskId: task.id })) {
    if (f.workspaceId !== task.workspaceId || f.lifecycle !== 'candidate' || f.status !== 'verified') continue;
    const identity = { rootWorkspaceId: f.rootWorkspaceId, subjectEntityId: f.subjectEntityId, flowTypeId: f.flowTypeId, variantKey: f.variantKey };
    for (const o of r.flows.list({ ...identity, lifecycle: 'current' })) r.flows.update(o.id, { lifecycle: 'replaced' });
    const promoted = r.flows.update(f.id, { lifecycle: 'current' });
    if (promoted.isPrimary) clearOtherPrimaries(store, promoted);
  }
}

/**
 * Restores the flow record invariants of one subject after its entity took over another's flows (an
 * entity merge, `mergeEntities`; run in the caller's transaction): (a) at most one current version per
 * flow type and variant, (b) at most one primary among the current versions of a flow type. In each
 * case the most recently seen flow wins (greatest `lastConfirmedAt ?? firstSeenAt`, ties by greater
 * id); the other current versions become `replaced`, the other primaries lose the flag. Nothing is
 * deleted and no review `status` changes. Superseded versions are never current (`liveCurrent`), so
 * they are left as they are. Verdicts on a replaced version stop being live (existing rule).
 */
export function reconcileSubjectFlows(store: Store, subjectEntityId: string): { replaced: string[]; primaryCleared: string[] } {
  const r = flowRepos(store);
  const seen = (f: Flow) => f.lastConfirmedAt ?? f.firstSeenAt;
  const newestFirst = (a: Flow, b: Flow) => seen(b).localeCompare(seen(a)) || b.id.localeCompare(a.id);
  const groups = (flows: Flow[], key: (f: Flow) => string) => {
    const out = new Map<string, Flow[]>();
    for (const f of flows) out.set(key(f), [...(out.get(key(f)) ?? []), f]);
    return [...out.values()].map((g) => g.sort(newestFirst));
  };
  const current = () => r.flows.list({ subjectEntityId, lifecycle: 'current' }).filter((f) => f.status !== 'superseded');
  const replaced: string[] = [];
  for (const g of groups(current(), (f) => `${f.rootWorkspaceId}|${f.flowTypeId}|${f.variantKey}`)) {
    for (const f of g.slice(1)) {
      r.flows.update(f.id, { lifecycle: 'replaced' });
      replaced.push(f.id);
    }
  }
  const primaryCleared: string[] = [];
  for (const g of groups(current().filter((f) => f.isPrimary), (f) => `${f.rootWorkspaceId}|${f.flowTypeId}`)) {
    for (const f of g.slice(1)) {
      r.flows.update(f.id, { isPrimary: false });
      primaryCleared.push(f.id);
    }
  }
  return { replaced, primaryCleared };
}

/**
 * The primary variant of each subject among `flows` (current, usable flows of one type): the variants
 * flagged primary; for a subject none of whose variants is flagged, the most recently seen one
 * (greatest `lastConfirmedAt ?? firstSeenAt`, ties by greater id). Ordinary saves can leave a subject
 * without a flag (a variant saved or confirmed with `primary: false`, a merge keeping a non-primary
 * winner), so the rule is applied on read and the flag is never written here.
 */
function primaryIds(flows: Flow[]): Set<string> {
  const bySubject = new Map<string, Flow[]>();
  for (const f of flows) bySubject.set(f.subjectEntityId, [...(bySubject.get(f.subjectEntityId) ?? []), f]);
  const seen = (f: Flow) => f.lastConfirmedAt ?? f.firstSeenAt;
  const out = new Set<string>();
  for (const group of bySubject.values()) {
    const flagged = group.filter((f) => f.isPrimary);
    if (flagged.length > 0) {
      for (const f of flagged) out.add(f.id);
      continue;
    }
    const newest = group.reduce((a, b) => (seen(b).localeCompare(seen(a)) || b.id.localeCompare(a.id)) > 0 ? b : a);
    out.add(newest.id);
  }
  return out;
}

/** Current, usable (not superseded) flows of one type in a tree. */
function usableCurrent(store: Store, rootWorkspaceId: string, flowTypeId: string): Flow[] {
  return flowRepos(store).flows.list({ rootWorkspaceId, flowTypeId, lifecycle: 'current' }).filter((f) => isOutputUsable(f));
}

/**
 * Whether the flow is its subject's primary variant as rankings see it (`primaryIds`: the flagged
 * variant, else the most recently seen one). A flow that is not a current usable version takes no
 * part in a ranking: its stored flag answers. The one rule for the ranking, the reactions and the
 * Flows page.
 */
export function isPrimaryVariant(store: Store, flow: Flow): boolean {
  const variants = usableCurrent(store, flow.rootWorkspaceId, flow.flowTypeId).filter((f) => f.subjectEntityId === flow.subjectEntityId);
  if (!variants.some((f) => f.id === flow.id)) return flow.isPrimary;
  return primaryIds(variants).has(flow.id);
}

/** The entity id that `id` was merged into (itself when not merged or unknown). */
function survivorIdOf(store: Store, id: string): string {
  const e = knowledgeRepos(store).entities.get(id);
  return e ? survivorOf(store, e).id : id;
}

/**
 * The node's own subjects (spec §10): its company entity, then the entities of its usable
 * competitors (merges resolved), each once. A read: the company entity is looked up, never created.
 * The subjects whose flows `rankableFlows` ranks; `read_flow_catalog` lists them for the worker.
 */
export function nodeSubjects(store: Store, workspaceId: string): Entity[] {
  const scope = scopeFor(store, workspaceId);
  const entities = knowledgeRepos(store).entities;
  const out = new Map<string, Entity>();
  const company = lookupCompanyEntity(store, scope, workspaceId);
  if (company) out.set(company.id, company);
  for (const c of store.competitors.list({ workspaceId })) {
    if (!c.entityId || !isOutputUsable(c)) continue;
    const e = entities.get(c.entityId);
    const survivor = e && survivorOf(store, e);
    if (survivor && survivor.rootWorkspaceId === scope.rootId && !out.has(survivor.id)) out.set(survivor.id, survivor);
  }
  return [...out.values()];
}

/**
 * Current, usable flows of the node's own subjects for one type (spec §10, `nodeSubjects`): its
 * company entity and the entities of its usable competitors, not those of ancestor or descendant nodes. Each subject's
 * primary variant only (`isPrimaryVariant`'s rule) unless `allVariants`. Insertion order. A read: the
 * company entity is looked up, never created (no own-company flows while it does not exist), and no
 * primary flag is written.
 */
export function rankableFlows(store: Store, workspaceId: string, flowTypeId: string, opts: { allVariants?: boolean } = {}): Flow[] {
  const scope = scopeFor(store, workspaceId);
  const subjects = new Set(nodeSubjects(store, workspaceId).map((e) => e.id));
  const usable = usableCurrent(store, scope.rootId, flowTypeId).filter((f) => subjects.has(survivorIdOf(store, f.subjectEntityId)));
  if (opts.allVariants) return usable;
  const primaries = primaryIds(usable);
  return usable.filter((f) => primaries.has(f.id));
}

/**
 * The current flow of the lineage `flowId` belongs to (the flow itself when it is current; a later
 * version once it was replaced). `undefined` for an unknown id or a lineage with no current,
 * non-superseded version.
 */
export function currentOfLineage(store: Store, flowId: string): Flow | undefined {
  const r = flowRepos(store);
  const f = r.flows.get(flowId);
  if (!f) return undefined;
  return r.flows.list({ rootWorkspaceId: f.rootWorkspaceId, lineageId: f.lineageId, lifecycle: 'current' }).find((x) => x.status !== 'superseded');
}
