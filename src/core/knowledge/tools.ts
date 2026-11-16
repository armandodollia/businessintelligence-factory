/**
 * The knowledge read tools' one entry point (design §9, §12, §13; build plan KS-4): `search`,
 * `get_card`, `expand`, `read_artifact`, `list_changes`, `read_workspace`. The harness dispatcher
 * calls `knowledgeRead` for agent runs; KS-7's API calls it with `role: 'user'`.
 *
 * For every call it builds the caller's `KnowledgeScope`, picks the budget (`budgetFor`: the role's
 * budget, or the caller's `max_tokens`, which may lower it or raise it up to the hard maximum; then
 * clamped up to the tool's floor, `READ_FLOOR_TOKENS`), enforces the reviewer / escalation slice, runs
 * the tool (each page assembled and measured whole by `assemblePage`, envelope included) and writes ONE
 * `retrieval_events` row listing every item whose text the response carried (its `upload_derived` also
 * re-checks every listed id), with the measured latency.
 *
 * Errors carry no store text: unknown ids, ids of another tree and (reviewer) ids outside the slice
 * all answer the same "<kind> '<id>' not found". An attempt on an id that exists outside the caller's
 * reach is a blocked attempt: a `policy_blocked` bus event (KS-6 persists it as a policy event).
 */
import type { BifConfig, ModelRef } from '../config/schema.js';
import type { EventBus } from '../events.js';
import type { Store } from '../store/db.js';
import type { RetrievalRole } from '../types.js';
import { budgetFor, cursorKey, InvalidCursorError, maxRequestTokens, READ_FLOOR_TOKENS } from './budget.js';
import { cardPageLines, entityCard, nodeCard, nodeLineRecover, type Card } from './cards.js';
import { runListChanges } from './changes.js';
import { artifactNotFound, assertEntityReadable, expandNotFound, runExpand, runReadArtifact, type ArtifactBytes, type ReadArtifactMode } from './expand.js';
import { assemblePage, type PageItem } from './paging.js';
import {
  anyUploadDerived, BUDGET_KIND, inSlice, ReadInputError, readableById, usableOnly,
  type ReadEnv, type ReadOutput, type Recover, type ReviewSlice,
} from './readCommon.js';
import { recordRetrieval } from './retrievalLog.js';
import { factScope } from './facts.js';
import { KnowledgeNotFoundError, narrowTo, notFound, type KnowledgeScope, type ScopeMode } from './scope.js';
import { runSearch, type SearchKind } from './search.js';
import { FOLLOW_TASK_TYPES } from '../stakeholders/kinds.js'; // stakeholder positions

/**
 * Smallest response budget of any knowledge read (tokens): every tool's floor (`READ_FLOOR_TOKENS`) is at
 * least this, and a pointer never asks for less.
 */
export const MIN_RESPONSE_TOKENS = 100;

export const KNOWLEDGE_READ_TOOLS = ['search', 'get_card', 'expand', 'read_artifact', 'list_changes', 'read_workspace'] as const;
export type KnowledgeReadTool = (typeof KNOWLEDGE_READ_TOOLS)[number];

export { READ_FLOOR_TOKENS };

/** Input as validated by the tool registry (snake_case, as agents send it). */
export type KnowledgeReadInput = {
  query?: string;
  kinds?: SearchKind[];
  scope?: ScopeMode;
  workspace_id?: string;
  entity_id?: string;
  include_unverified?: boolean;
  include_history?: boolean;
  since?: string;
  limit?: number;
  id?: string;
  around?: number;
  artifact_id?: string;
  mode?: ReadArtifactMode;
  run_id?: string;
  cursor?: string;
  max_tokens?: number;
};

/** Who reads: an agent run (a `RunContext` fits) or the user through the API (`role: 'user'`). */
export type ReadCaller = {
  workspaceId: string;
  role: RetrievalRole;
  agentRunId?: string;
  taskId?: string;
  model?: ModelRef;
  promptVersion?: string;
};

export type KnowledgeReadDeps = {
  store: Store;
  config: Pick<BifConfig, 'knowledge'>;
  events?: EventBus;
  /** Stored files (`read_artifact` image / raw modes). */
  files?: ArtifactBytes;
  /** Reviewer / escalation runs: the task's review slice (`reviewSlice`, research/reviewLoop.ts). */
  slice?: ReviewSlice;
  now?: Date;
};

export type KnowledgeReadResult =
  | { ok: true; data: Record<string, unknown>; images?: Array<{ data: string; mimeType: string }>; retrievalEventId: string }
  | { ok: false; error: string };

const ITEM_PREFIXES = ['fnd_', 'art_', 'chk_', 'ent_', 'cmp_', 'per_', 'sym_', 'hyp_', 'rec_', 'flw_', 'rvm_', 'ws_', 'rrun_'];
const ITEM_TABLES: Record<string, string> = {
  fnd_: 'findings', art_: 'artifacts', chk_: 'chunks', ent_: 'entities', cmp_: 'competitors', per_: 'personas',
  sym_: 'symptoms', hyp_: 'symptom_hypotheses', rec_: 'recommendations', flw_: 'flows', rvm_: 'review_mentions', rrun_: 'research_runs',
};

/**
 * Whether an id names a stored item of ANOTHER business tree: a not-found answer for it is a blocked
 * attempt. Unknown ids, and ids of the caller's tree it may not read (e.g. a non-usable fact for the
 * synthesizer), are not.
 */
function inOtherTree(store: Store, scope: KnowledgeScope, id: string): boolean {
  const prefix = ITEM_PREFIXES.find((p) => id.startsWith(p));
  const table = prefix ? ITEM_TABLES[prefix] : undefined;
  let ws: string | undefined;
  if (!table) ws = store.workspaces.get(id)?.id;
  else if (table === 'entities') {
    const row = store.db.prepare('SELECT root_workspace_id AS r FROM entities WHERE id = ?').get(id) as { r: string } | undefined;
    return row !== undefined && row.r !== scope.rootId;
  } else ws = (store.db.prepare(`SELECT workspace_id AS w FROM ${table} WHERE id = ?`).get(id) as { w: string } | undefined)?.w;
  return ws !== undefined && !scope.treeIds.includes(ws);
}

/** Whether the reading run belongs to a task that follows former colleagues on the web (`FOLLOW_TASK_TYPES`). */
function readerFollows(store: Store, taskId: string | undefined): boolean {
  const task = taskId ? store.tasks.get(taskId) : undefined;
  return !!task && FOLLOW_TASK_TYPES.has(task.type);
}

/** The ids a request names (for the slice check and blocked-attempt events). */
function namedIds(tool: KnowledgeReadTool, input: KnowledgeReadInput): string[] {
  switch (tool) {
    case 'expand':
      return input.id ? [input.id] : [];
    case 'read_artifact':
      return input.artifact_id ? [input.artifact_id] : [];
    default:
      return [input.workspace_id, input.entity_id, input.run_id].filter((x): x is string => typeof x === 'string');
  }
}

function narrowed(store: Store, scope: KnowledgeScope, workspaceId: string | undefined): KnowledgeScope {
  if (!workspaceId) return scope;
  const v = narrowTo(store, scope, workspaceId);
  if (!v) throw notFound('workspace', workspaceId);
  return v;
}

function cardOutput(
  env: ReadEnv, card: Card, budget: number, key: string, cursor: string | undefined, query: string, scopeLabel: string,
  recover?: (index: number) => Recover | undefined,
): ReadOutput {
  // A line too big for a page on its own comes back as { text, cut: true, full } (never skipped).
  const items: PageItem[] = cardPageLines(card).map((l, i) => ({
    value: l.text, refs: l.refs, upload: l.upload, ...(recover ? { recover: () => recover(i) } : {}),
  }));
  const page = assemblePage({
    key, cursor, budget, itemsKey: 'lines', header: card.header, headerRefs: card.headerRefs, headerUpload: card.headerUpload,
    notes: env.pageNotes, items, again: env.again,
  });
  return { data: page.data, results: page.results, uploadDerived: page.uploadDerived, truncated: page.truncated, query, scopeLabel };
}

/** Runs one knowledge read for `caller` (see module doc). Never throws for caller errors. */
export function knowledgeRead(deps: KnowledgeReadDeps, caller: ReadCaller, tool: KnowledgeReadTool, input: KnowledgeReadInput): KnowledgeReadResult {
  const started = performance.now();
  const { store } = deps;
  const blocked = (id: string, reason: 'out_of_slice' | 'out_of_tree') => {
    deps.events?.emit({
      type: 'policy_blocked', workspaceId: caller.workspaceId, tool, itemId: id, reason,
      ...(caller.agentRunId !== undefined ? { agentRunId: caller.agentRunId } : {}),
      ...(caller.taskId !== undefined ? { taskId: caller.taskId } : {}),
    });
  };
  // A workspace without a row (legacy callers, tests) is a tree of one node: nothing else is reachable.
  const home = factScope(store, caller.workspaceId);
  // Stakeholder personas: the reading run's task, so its own withheld page copies stay readable by id.
  const scope: KnowledgeScope = caller.taskId ? { ...home, readerTaskId: caller.taskId } : home;
  const env: ReadEnv = {
    store, config: deps.config, role: caller.role, scope, now: deps.now ?? new Date(),
    ...(caller.model ? { provider: caller.model.provider } : {}),
    ...(deps.slice ? { slice: deps.slice } : {}),
    mode: input.scope ?? 'node',
    // Stakeholder positions: a run of a task that follows former colleagues on the web is served no internal persona text.
    ...(readerFollows(store, caller.taskId) ? { withholdInternal: true } : {}),
  };
  const floor = (t: string) => READ_FLOOR_TOKENS[t as KnowledgeReadTool] ?? MIN_RESPONSE_TOKENS;
  const budget = Math.max(floor(tool), budgetFor(deps.config, caller.role, caller.model?.provider, BUDGET_KIND[tool]!, input.max_tokens));
  // A cursor is bound to its request: tool, caller node and role, and every input except paging.
  const { cursor, max_tokens: _maxTokens, ...rest } = input;
  const key = cursorKey({ tool, ws: caller.workspaceId, role: caller.role, ...rest });
  const roleNotes: string[] = [];
  if (usableOnly(caller.role) && (input.include_unverified || input.include_history)) {
    roleNotes.push(`include_unverified / include_history are ignored for role ${caller.role}: usable facts only`);
  }
  // Every page of the request carries the role notes (only `search` takes the flags that produce them),
  // so every page is measured with them.
  if (roleNotes.length) env.pageNotes = roleNotes;
  // Pointers of cut items (paging rework): the measured budget that holds the item, raised to the target
  // tool's floor; above the hard maximum there is none (the item is flagged `too_large`).
  const maxRequest = Math.max(MIN_RESPONSE_TOKENS, maxRequestTokens(deps.config, caller.model?.provider));
  env.pointerBudget = (need, t) => {
    const n = Math.max(floor(t), need);
    return n <= Math.max(maxRequest, floor(t)) ? n : undefined;
  };
  env.keyFor = (t, inp) => cursorKey({ tool: t, ws: caller.workspaceId, role: caller.role, ...inp });
  env.again = (at, need) => {
    const m = env.pointerBudget!(need, tool);
    return m === undefined ? undefined : { kind: 'same_call', tool, input: { ...rest, cursor: at, max_tokens: m } };
  };

  // Reviewer / escalation: only ids of the task's review slice (design §9). Same "not found" text.
  if (deps.slice) {
    for (const id of namedIds(tool, input)) {
      if (!inSlice(env, id)) {
        blocked(id, 'out_of_slice');
        return { ok: false, error: (tool === 'read_artifact' ? artifactNotFound(id) : expandNotFound(id)).message };
      }
    }
  }

  let out: ReadOutput;
  try {
    switch (tool) {
      case 'search': {
        const view = narrowed(store, scope, input.workspace_id);
        out = runSearch(env, view, {
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.kinds ? { kinds: input.kinds } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.workspace_id ? { narrowed: input.workspace_id } : {}),
          ...(input.entity_id ? { entityId: input.entity_id } : {}),
          ...(input.include_unverified ? { includeUnverified: true } : {}),
          ...(input.include_history ? { includeHistory: true } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(cursor ? { cursor } : {}),
        }, budget, { tool, ws: caller.workspaceId, role: caller.role, ...rest });
        break;
      }
      case 'get_card':
      case 'read_workspace': {
        // Read by id (design §7.1): the named entity / node of any node of the tree (the sibling rule is
        // `allowByIdSiblingRead`); what the card lists around it follows the request's scope.
        const mode = env.mode ?? 'node';
        if (input.entity_id && tool === 'get_card') {
          assertEntityReadable(env, input.entity_id);
          const card = entityCard(env, scope, mode, input.entity_id);
          out = cardOutput(env, card, budget, key, cursor, `entity ${input.entity_id}`, mode);
        } else {
          const view = narrowed(store, scope, input.workspace_id ?? caller.workspaceId);
          if (!readableById(scope, mode, scope.nodeIds.includes(view.workspaceId))) throw notFound('workspace', view.workspaceId);
          const card = nodeCard(env, view, mode);
          out = cardOutput(env, card, budget, key, cursor, `node ${view.workspaceId}`,
            view.workspaceId === caller.workspaceId ? mode : `${mode}:${view.workspaceId}`, nodeLineRecover(env, view.workspaceId, mode, card));
        }
        break;
      }
      case 'expand':
        out = runExpand(env, { id: input.id ?? '', ...(input.around !== undefined ? { around: input.around } : {}), ...(cursor ? { cursor } : {}) }, budget, key);
        break;
      case 'read_artifact': {
        if (!deps.files) throw new Error('read_artifact needs the artifact store');
        out = runReadArtifact(env, deps.files, { artifactId: input.artifact_id ?? '', ...(input.mode ? { mode: input.mode } : {}), ...(cursor ? { cursor } : {}) }, budget, key);
        break;
      }
      case 'list_changes': {
        const view = narrowed(store, scope, input.workspace_id);
        out = runListChanges(env, view, {
          ...(input.since ? { since: input.since } : {}),
          ...(input.run_id ? { runId: input.run_id } : {}),
          ...(input.entity_id ? { entityId: input.entity_id } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          ...(cursor ? { cursor } : {}),
        }, budget, { tool, ws: caller.workspaceId, role: caller.role, ...rest });
        break;
      }
    }
  } catch (err) {
    if (err instanceof KnowledgeNotFoundError) {
      for (const id of namedIds(tool, input)) if (err.message.includes(`'${id}'`) && inOtherTree(store, scope, id)) blocked(id, 'out_of_tree');
      return { ok: false, error: err.message };
    }
    if (err instanceof InvalidCursorError || err instanceof ReadInputError) return { ok: false, error: err.message };
    throw err;
  }

  const data = out.data;
  const uploadDerived = out.uploadDerived || anyUploadDerived(store, out.results);
  const ev = recordRetrieval(
    { store, ...(deps.events ? { events: deps.events } : {}) },
    {
      workspaceId: caller.workspaceId, role: caller.role,
      ...(caller.agentRunId !== undefined ? { agentRunId: caller.agentRunId } : {}),
      ...(caller.taskId !== undefined ? { taskId: caller.taskId } : {}),
      ...(caller.model ? { model: caller.model } : {}),
      ...(caller.promptVersion !== undefined ? { promptVersion: caller.promptVersion } : {}),
    },
    {
      tool, query: out.query, scope: out.scopeLabel, results: out.results, tokensReturned: data.tokens as number,
      truncated: out.truncated, relaxed: out.relaxed ?? false, latencyMs: performance.now() - started, uploadDerived,
    },
  );
  return { ok: true, data, ...(out.images ? { images: out.images } : {}), retrievalEventId: ev.id };
}
