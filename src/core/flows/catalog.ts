/**
 * The flow type catalog and the checklists of a business tree (design §7, §8.1, §10.1). Every
 * business tree (`rootOf`) has its own catalog, seeded from `./builtinChecklists.ts` on first use.
 * Agents and the user propose flow types and checklists; a proposal takes part in nothing until the
 * user accepts it.
 *
 * Import cycle note: `./checks.ts` imports `activeChecklists` / `FlowCatalogError` from here and this
 * module imports `carryAnswers` from there; `./flows.ts` imports `flowTypeByKey` from here and this
 * module imports `reconcileSubjectFlows` from there. All are used at call time only, so the cycles are
 * safe in any load order; keep it that way (no top-level use of these imports).
 */
import { titleKey } from '../harness/tools/idempotency.js';
import { redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { rootOf } from '../workspace/tree.js';
import { BUILTIN_CHECKLISTS, BUILTIN_FLOW_TYPES } from './builtinChecklists.js';
import { carryAnswers } from './checks.js';
import { reconcileSubjectFlows } from './flows.js';
import { flowRepos } from './repos.js';
import type { Checklist, ChecklistItem, FlowType, FlowTypeStatus } from './types.js';

/** Validation error of a catalog action (the API maps `status` to the HTTP status). */
export class FlowCatalogError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'FlowCatalogError';
  }
}

export const MAX_CHECKLIST_ITEMS = 40;

/** Normalized flow type key: `titleKey`, then every run of non-letters/digits as one `_`. */
export function flowTypeKey(s: string): string {
  return titleKey(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

const nowIso = () => new Date().toISOString();

/** Seeds the tree's catalog and built-in checklists (status active, origin builtin) once. Idempotent. */
export function ensureCatalog(store: Store, workspaceId: string): void {
  const root = rootOf(store, workspaceId);
  const r = flowRepos(store);
  const seeded = () => r.checklists.list({ rootWorkspaceId: root, flowTypeId: null }).length > 0;
  if (seeded()) return;
  store.transaction(() => {
    if (seeded()) return;
    const now = nowIso();
    const ids = new Map<string, string>();
    for (const t of BUILTIN_FLOW_TYPES) {
      const existing = r.flowTypes.list({ rootWorkspaceId: root, key: t.key })[0];
      const row = existing ?? r.flowTypes.insert({ id: newId('fty'), rootWorkspaceId: root, ...t, status: 'active', createdAt: now, updatedAt: now });
      ids.set(t.key, row.id);
    }
    for (const c of BUILTIN_CHECKLISTS) {
      const flowTypeId = c.flowTypeKey ? ids.get(c.flowTypeKey) : undefined;
      if (flowTypeId && r.checklists.list({ rootWorkspaceId: root, flowTypeId }).length > 0) continue;
      r.checklists.insert({
        id: newId('ckl'), rootWorkspaceId: root, flowTypeId, version: 1, status: 'active', coverage: c.coverage,
        items: c.items.map((i) => ({ ...i })), origin: 'builtin', createdAt: now, acceptedAt: now,
      });
    }
  });
}

/** The tree's flow types; without a status filter, rejected types are left out. */
export function listFlowTypes(store: Store, workspaceId: string, opts: { status?: FlowTypeStatus } = {}): FlowType[] {
  ensureCatalog(store, workspaceId);
  const types = flowRepos(store).flowTypes.list({ rootWorkspaceId: rootOf(store, workspaceId), status: opts.status });
  return opts.status ? types : types.filter((t) => t.status !== 'rejected');
}

/**
 * Resolves a key through merges; undefined when unknown in this tree. A rejected type is returned
 * as it is (status `rejected`); callers decide what to do with it.
 */
export function flowTypeByKey(store: Store, workspaceId: string, key: string): FlowType | undefined {
  ensureCatalog(store, workspaceId);
  const root = rootOf(store, workspaceId);
  const found = flowRepos(store).flowTypes.list({ rootWorkspaceId: root, key: flowTypeKey(key) })[0];
  return found && resolveMerges(store, found);
}

/** Follows `mergedIntoId` within the type's tree (cycle-safe). */
function resolveMerges(store: Store, t: FlowType): FlowType {
  const types = flowRepos(store).flowTypes;
  const seen = new Set([t.id]);
  let cur = t;
  while (cur.status === 'merged' && cur.mergedIntoId && !seen.has(cur.mergedIntoId)) {
    const next = types.get(cur.mergedIntoId);
    if (!next || next.rootWorkspaceId !== t.rootWorkspaceId) break;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

const required = (value: string, field: string): string => {
  const v = value.trim();
  if (!v) throw new FlowCatalogError(`${field} is required`);
  return v;
};

export function proposeFlowType(
  store: Store,
  workspaceId: string,
  input: { key: string; name: string; definition: string; agentRunId?: string },
): { flowType: FlowType; created: boolean } {
  const key = flowTypeKey(input.key);
  if (!key) throw new FlowCatalogError('key is required');
  const name = required(input.name, 'name');
  const definition = required(input.definition, 'definition');
  ensureCatalog(store, workspaceId);
  const root = rootOf(store, workspaceId);
  const types = flowRepos(store).flowTypes;
  return store.transaction(() => {
    const existing = types.list({ rootWorkspaceId: root, key })[0];
    if (existing) return { flowType: resolveMerges(store, existing), created: false };
    const now = nowIso();
    const flowType = types.insert({
      id: newId('fty'), rootWorkspaceId: root, key, name, definition, status: 'proposed', proposedByRun: input.agentRunId,
      createdAt: now, updatedAt: now,
    });
    return { flowType, created: true };
  });
}

function getFlowType(store: Store, id: string): FlowType {
  const t = flowRepos(store).flowTypes.get(id);
  if (!t) throw new FlowCatalogError(`flow type ${id} not found`, 404);
  return t;
}

/** Tables whose rows hang off a flow type and follow it when it is merged. */
const FLOW_TYPE_REFERENCES = ['flows', 'review_mentions', 'flow_verdicts', 'flow_overrides'] as const;

/** Retires the type's checklists of the given statuses. */
function retireChecklists(store: Store, flowTypeId: string, statuses: Array<Checklist['status']>): void {
  const lists = flowRepos(store).checklists;
  for (const status of statuses) {
    for (const c of lists.list({ flowTypeId, status })) lists.update(c.id, { status: 'retired' });
  }
}

/**
 * The user's decision on a flow type. Accept applies to a proposed or rejected type. Reject applies
 * to a proposed type: it is kept as `rejected` (a re-proposal of its key does not reopen it), its
 * proposed checklists are retired, and it is refused while flows use the type (merge it instead).
 * Merge moves the type's flows, review mentions, verdicts and overrides to the target (same tree,
 * neither merged nor rejected), reconciles each subject whose flows moved (`reconcileSubjectFlows`: a
 * subject with flows in both types keeps one current version per variant and one primary) and
 * retires the type's proposed and active checklists. Edit changes
 * the name or definition, never the key. A merged type takes no further decision.
 */
export function decideFlowType(
  store: Store,
  id: string,
  decision: { action: 'accept' } | { action: 'reject' } | { action: 'merge'; intoId: string } | { action: 'edit'; name?: string; definition?: string },
): FlowType {
  const r = flowRepos(store);
  return store.transaction(() => {
    const t = getFlowType(store, id);
    if (t.status === 'merged') throw new FlowCatalogError(`flow type ${t.key} is merged`, 409);
    const updatedAt = nowIso();
    switch (decision.action) {
      case 'accept':
        if (t.status !== 'proposed' && t.status !== 'rejected') throw new FlowCatalogError(`flow type ${t.key} is not proposed or rejected`, 409);
        return r.flowTypes.update(id, { status: 'active', updatedAt });
      case 'reject': {
        if (t.status !== 'proposed') throw new FlowCatalogError(`flow type ${t.key} is not proposed`, 409);
        const flows = r.flows.list({ flowTypeId: id }).length;
        if (flows > 0) throw new FlowCatalogError(`flow type ${t.key} has ${flows} flow(s); merge it into another type instead`, 409);
        retireChecklists(store, id, ['proposed']);
        return r.flowTypes.update(id, { status: 'rejected', updatedAt });
      }
      case 'merge': {
        const into = r.flowTypes.get(decision.intoId);
        if (!into || into.rootWorkspaceId !== t.rootWorkspaceId) throw new FlowCatalogError(`flow type ${decision.intoId} not found`, 404);
        if (into.id === t.id) throw new FlowCatalogError('a flow type cannot be merged into itself');
        if (into.status === 'merged' || into.status === 'rejected') throw new FlowCatalogError(`flow type ${into.key} is ${into.status}`, 409);
        const subjects = new Set(r.flows.list({ flowTypeId: id }).map((f) => f.subjectEntityId));
        for (const table of FLOW_TYPE_REFERENCES) {
          store.db.prepare(`UPDATE ${table} SET flow_type_id = ? WHERE flow_type_id = ?`).run(into.id, id);
        }
        for (const subjectEntityId of subjects) reconcileSubjectFlows(store, subjectEntityId);
        retireChecklists(store, id, ['proposed', 'active']);
        return r.flowTypes.update(id, { status: 'merged', mergedIntoId: into.id, updatedAt });
      }
      case 'edit': {
        const patch: Partial<FlowType> = { updatedAt };
        if (decision.name !== undefined) patch.name = required(decision.name, 'name');
        if (decision.definition !== undefined) patch.definition = required(decision.definition, 'definition');
        return r.flowTypes.update(id, patch);
      }
    }
  });
}

/**
 * The active general checklist and the active specific one of the type (if any). A merged type's
 * id resolves to the type it was merged into. Without a type: the general checklist only.
 */
export function activeChecklists(store: Store, workspaceId: string, flowTypeId?: string): { general: Checklist; specific?: Checklist } {
  ensureCatalog(store, workspaceId);
  const root = rootOf(store, workspaceId);
  const lists = flowRepos(store).checklists;
  const general = lists.list({ rootWorkspaceId: root, flowTypeId: null, status: 'active' })[0];
  if (!general) throw new FlowCatalogError(`no active general checklist in tree ${root}`, 409);
  if (flowTypeId === undefined) return { general };
  const type = flowRepos(store).flowTypes.get(flowTypeId);
  const typeId = type && type.rootWorkspaceId === root ? resolveMerges(store, type).id : flowTypeId;
  const specific = lists.list({ rootWorkspaceId: root, flowTypeId: typeId, status: 'active' })[0];
  return specific ? { general, specific } : { general };
}

function validateCoverage(coverage: number): void {
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new FlowCatalogError('coverage must be between 0 and 1');
}

function validateItems(items: ChecklistItem[]): void {
  if (items.length === 0) throw new FlowCatalogError('a checklist needs at least one item');
  if (items.length > MAX_CHECKLIST_ITEMS) throw new FlowCatalogError(`a checklist has at most ${MAX_CHECKLIST_ITEMS} items`);
  const keys = new Set<string>();
  for (const i of items) {
    if (!i.key.trim()) throw new FlowCatalogError('every item needs a key');
    if (keys.has(i.key)) throw new FlowCatalogError(`item keys must be unique (${i.key})`);
    keys.add(i.key);
    if (i.scored && !i.pass) throw new FlowCatalogError(`scored item ${i.key} needs a pass rule`);
  }
}

/**
 * A checklist proposal of the tree: status 'proposed', version = max + 1 of its line. For a flow type
 * of the tree (`flowTypeId`), or, without one, a new version of the general checklist.
 */
export function proposeChecklist(
  store: Store,
  workspaceId: string,
  input: { flowTypeId?: string | undefined; coverage: number; items: ChecklistItem[]; origin: 'agent' | 'user' },
): Checklist {
  validateCoverage(input.coverage);
  validateItems(input.items);
  ensureCatalog(store, workspaceId);
  const root = rootOf(store, workspaceId);
  const r = flowRepos(store);
  return store.transaction(() => {
    let flowTypeId: string | undefined;
    if (input.flowTypeId !== undefined) {
      const t = r.flowTypes.get(input.flowTypeId);
      if (!t || t.rootWorkspaceId !== root) throw new FlowCatalogError(`flow type ${input.flowTypeId} not found`, 404);
      if (t.status === 'merged' || t.status === 'rejected') throw new FlowCatalogError(`flow type ${t.key} is ${t.status}`, 409);
      flowTypeId = t.id;
    }
    const version = Math.max(0, ...r.checklists.list({ rootWorkspaceId: root, flowTypeId: flowTypeId ?? null }).map((c) => c.version)) + 1;
    return r.checklists.insert({
      id: newId('ckl'), rootWorkspaceId: root, ...(flowTypeId !== undefined ? { flowTypeId } : {}), version, status: 'proposed',
      coverage: input.coverage, items: input.items.map((i) => ({ ...i })), origin: input.origin, createdAt: nowIso(),
    });
  });
}

/** Longest checklist question the user can write. */
export const CHECK_QUESTION_MAX = 500;
/** Largest weight of a checklist item. */
export const CHECK_WEIGHT_MAX = 100;

/** The user's change to one item of a checklist: its question, its weight, or its removal. */
export type ChecklistItemEdit = { key: string; question?: string; weight?: number; remove?: boolean };

const EDITABLE_ITEM_FIELDS: ReadonlySet<string> = new Set(['key', 'question', 'weight', 'remove']);

/**
 * The user's edit of an active checklist of the tree (spec §10.1: the built-in checklists "can be
 * edited afterwards like any checklist"): its coverage, and per item its weight, its question, or its
 * removal. Adding an item and changing an item's kind or pass rule are not part of this editor and are
 * refused. The edit is a new version of the same line (general, or the flow type's), origin `user`,
 * active at once: the previous version is retired and the flows' answers carry over
 * (`decideChecklistDetailed`); `needRewalk` lists the flows still missing walkthrough answers. A
 * question is user text: stored redacted and fence-stripped. Throws `FlowCatalogError` (404 for a
 * checklist of another tree, 409 when it is not the active one, 400 for a refused edit or no change).
 */
export function editChecklist(
  store: Store,
  workspaceId: string,
  input: { checklistId: string; coverage?: number; items: ChecklistItemEdit[] },
): { checklist: Checklist; previous: Checklist; needRewalk: string[] } {
  const root = rootOf(store, workspaceId);
  const previous = typeof input.checklistId === 'string' ? flowRepos(store).checklists.get(input.checklistId) : undefined;
  if (!previous || previous.rootWorkspaceId !== root) throw new FlowCatalogError(`checklist ${input.checklistId} not found`, 404);
  if (previous.status !== 'active') throw new FlowCatalogError(`checklist ${previous.id} is not the active one: edit the active version`, 409);
  if (!Array.isArray(input.items)) throw new FlowCatalogError('items must be a list of { key, question?, weight?, remove? }');
  if (input.coverage !== undefined) validateCoverage(input.coverage);

  const edits = new Map<string, ChecklistItemEdit>();
  for (const e of input.items) {
    if (!e || typeof e !== 'object' || typeof e.key !== 'string') throw new FlowCatalogError('every item edit names the item key');
    const extra = Object.keys(e).filter((k) => !EDITABLE_ITEM_FIELDS.has(k));
    if (extra.length > 0) throw new FlowCatalogError(`an item's kind or pass rule cannot be changed here (got ${extra.join(', ')}); only its question, weight or removal`);
    if (!previous.items.some((i) => i.key === e.key)) throw new FlowCatalogError(`unknown item '${e.key}': adding items is not possible here`);
    if (edits.has(e.key)) throw new FlowCatalogError(`item '${e.key}' is edited twice`);
    if (e.weight !== undefined && (typeof e.weight !== 'number' || !Number.isFinite(e.weight) || e.weight <= 0 || e.weight > CHECK_WEIGHT_MAX)) {
      throw new FlowCatalogError(`the weight of '${e.key}' must be a number above 0 and at most ${CHECK_WEIGHT_MAX}`);
    }
    if (e.remove !== undefined && typeof e.remove !== 'boolean') throw new FlowCatalogError(`remove of '${e.key}' must be true or false`);
    edits.set(e.key, e);
  }

  const items: ChecklistItem[] = [];
  for (const item of previous.items) {
    const e = edits.get(item.key);
    if (e?.remove) continue;
    const next = { ...item };
    if (e?.weight !== undefined) next.weight = e.weight;
    if (e?.question !== undefined) {
      const q = typeof e.question === 'string' ? stripFences(redactServed(store, workspaceId, e.question)).trim() : '';
      if (!q) throw new FlowCatalogError(`the question of '${item.key}' is empty`);
      if (q.length > CHECK_QUESTION_MAX) throw new FlowCatalogError(`the question of '${item.key}' is at most ${CHECK_QUESTION_MAX} characters`);
      next.question = q;
    }
    items.push(next);
  }
  if (items.length === 0) throw new FlowCatalogError('a checklist needs at least one item');
  const coverage = input.coverage ?? previous.coverage;
  if (coverage === previous.coverage && JSON.stringify(items) === JSON.stringify(previous.items)) throw new FlowCatalogError('nothing to change');

  return store.transaction(() => {
    const draft = proposeChecklist(store, workspaceId, { flowTypeId: previous.flowTypeId, coverage, items, origin: 'user' });
    const { checklist, needRewalk } = decideChecklistDetailed(store, draft.id, { action: 'accept' });
    return { checklist, previous, needRewalk };
  });
}

/**
 * Accepting retires the previous active checklist of that type and carries the flows' answers of
 * unchanged items to the accepted one (`carryAnswers`); rejecting retires the proposal. The flows
 * left needing a re-walk: `decideChecklistDetailed`.
 */
export function decideChecklist(
  store: Store,
  id: string,
  decision: { action: 'accept'; coverage?: number } | { action: 'reject' },
): Checklist {
  return decideChecklistDetailed(store, id, decision).checklist;
}

/**
 * `decideChecklist`, also returning the flows the accepted version leaves with unanswered
 * walkthrough items (`carryAnswers`' `needRewalk`, over every checklist it replaced, first-seen
 * order; empty on reject).
 */
export function decideChecklistDetailed(
  store: Store,
  id: string,
  decision: { action: 'accept'; coverage?: number } | { action: 'reject' },
): { checklist: Checklist; needRewalk: string[] } {
  const lists = flowRepos(store).checklists;
  return store.transaction(() => {
    const c = lists.get(id);
    if (!c) throw new FlowCatalogError(`checklist ${id} not found`, 404);
    if (c.status !== 'proposed') throw new FlowCatalogError(`checklist ${id} is not proposed`, 409);
    if (decision.action === 'reject') return { checklist: lists.update(id, { status: 'retired' }), needRewalk: [] };
    if (decision.coverage !== undefined) validateCoverage(decision.coverage);
    const previous = lists.list({ rootWorkspaceId: c.rootWorkspaceId, flowTypeId: c.flowTypeId ?? null, status: 'active' });
    for (const p of previous) lists.update(p.id, { status: 'retired' });
    const accepted = lists.update(id, { status: 'active', acceptedAt: nowIso(), coverage: decision.coverage ?? c.coverage });
    const needRewalk: string[] = [];
    for (const p of previous) {
      for (const flowId of carryAnswers(store, p.id, id).needRewalk) if (!needRewalk.includes(flowId)) needRewalk.push(flowId);
    }
    return { checklist: accepted, needRewalk };
  });
}

/** Coverage used for ranking: the specific active checklist's, else the general one's (merges resolved). */
export function coverageOf(store: Store, workspaceId: string, flowTypeId: string): number {
  const { general, specific } = activeChecklists(store, workspaceId, flowTypeId);
  return (specific ?? general).coverage;
}
