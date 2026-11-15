/**
 * The worker tools of flow records (design 2026-11-14-flow-records-and-ranking-design.md §8, §9,
 * §12.1, §14): thin handlers over the core functions of this module, for
 * `createToolHandlers({ extraHandlers })`.
 *
 * - `read_flow_catalog`: the tree's flow types with the node's subjects (its own company and usable
 *   competitors, `{ id, name, kind }`, so a save names them by id), or one type's active checklist
 *   items (paged).
 * - `save_flow` (`saveFlow`), then the review-answered checks of the flow (`applyReviewChecks`) and
 *   what a walkthrough still has to answer. A replay of a saved call (same run or task, same subject,
 *   type, variant and steps) returns the earlier result with `duplicate: true`.
 * - `save_flow_checks` (`saveCheckAnswers`) on a flow the caller's task saved, then `applyReviewChecks`.
 * - `save_review_mentions` (`saveReviewMentions`), then `applyReviewChecks` for the current flows of the
 *   subject and each flow type the saved mentions name.
 * - `propose_flow_type`, `propose_checklist` (origin `agent`).
 *
 * `FlowInputError` / `FlowCatalogError` go back to the agent as `{ ok: false, error }` (every handler,
 * `read_flow_catalog` included); any other error
 * propagates to the dispatcher. Every successful save is logged as a `decision` Decision naming the
 * records and the artifacts it rests on (provenance; the Flows page reloads on them). Third-party text
 * in a result (variant names, agent-written definitions) is fenced; the response says
 * `content_trust: "untrusted"`.
 */
import { createHash } from 'node:crypto';
import { factToolEnv, type ExtraToolHandler, type ToolResult } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import type { RunContext } from '../harness/tokens.js';
import { redactIdentitySecrets } from '../identity/identities.js';
import { budgetFor, cursorKey, InvalidCursorError } from '../knowledge/budget.js';
import { companyEntity, lookupEntity } from '../knowledge/entities.js';
import { assemblePage } from '../knowledge/paging.js';
import { scopeFor } from '../knowledge/scope.js';
import { CONTENT_TRUST, fenceEvidence, redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Task } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { BUILTIN_FLOW_TYPES } from './builtinChecklists.js';
import { activeChecklists, ensureCatalog, FlowCatalogError, flowTypeByKey, listFlowTypes, proposeChecklist, proposeFlowType } from './catalog.js';
import { applyReviewChecks, saveCheckAnswers } from './checks.js';
import { flowsSettings } from './config.js';
import { FlowInputError, nodeSubjects, resolveSubject, saveFlow, stepsHash, type FlowCtx, type FlowStepInput, type SaveFlowInput } from './flows.js';
import { flowRepos } from './repos.js';
import { saveReviewMentions, type ReviewMentionInput } from './reviews.js';
import type { ChecklistItem, FlowType } from './types.js';

type Deps = Parameters<ExtraToolHandler>[2];

/** Smallest response budget of `read_flow_catalog` (tokens): a header and at least one item. */
export const FLOW_CATALOG_FLOOR_TOKENS = 200;

const BUILTIN_KEYS: ReadonlySet<string> = new Set(BUILTIN_FLOW_TYPES.map((t) => t.key));

/** Most subjects `read_flow_catalog` lists (the page header holds identity only, bounded). */
export const MAX_CATALOG_SUBJECTS = 40;
/** A subject name in that list is cut to this many characters. */
const SUBJECT_NAME_MAX = 120;
const boundedName = (s: string) => (s.length > SUBJECT_NAME_MAX ? `${s.slice(0, SUBJECT_NAME_MAX - 1)}…` : s);

const ok = (data: unknown): ToolResult => ({ ok: true, data });
const fail = (error: string): ToolResult => ({ ok: false, error });

/** Runs `fn`; a validation refusal of the flow module is returned to the agent, anything else propagates. */
async function refusing(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FlowInputError || e instanceof FlowCatalogError) return fail(e.message);
    throw e;
  }
}

/** The run's task, when it belongs to the caller's workspace. */
function ownTask(store: Store, ctx: RunContext): Task | undefined {
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  return task && task.workspaceId === ctx.workspaceId ? task : undefined;
}

function flowCtxOf(ctx: RunContext, task: Task | undefined): FlowCtx {
  return {
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    ...(task ? { taskId: task.id, taskRound: task.round, runId: task.runId } : {}),
  };
}

/** Logs the tool call (identity secrets redacted, as the dispatcher's own Decisions); refs gain the task. */
function record(deps: Deps, ctx: RunContext, payload: unknown, refs: string[], kind: Decision['kind'] = 'decision'): Decision {
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind,
    payload: redactIdentitySecrets(deps.store, ctx.workspaceId, payload),
    refs: [...new Set([...refs, ...(ctx.taskId ? [ctx.taskId] : [])])],
    promptVersion: ctx.promptVersion,
    createdAt: new Date().toISOString(),
  };
  deps.store.decisions.insert(decision);
  return decision;
}

const emit = (deps: Deps, decision: Decision | undefined) => {
  if (decision) deps.events.emit({ type: 'decision', workspaceId: decision.workspaceId, decision });
};

/** Agent-written text: the tree's identity secrets redacted, fence sequences removed, trimmed. */
const cleanText = (store: Store, workspaceId: string, s: string): string => stripFences(redactServed(store, workspaceId, s)).trim();

/** The tree's flow type named by a tool input: its id, or its key (merges resolved). */
function flowTypeNamed(store: Store, workspaceId: string, name: string): FlowType | undefined {
  const byId = flowRepos(store).flowTypes.get(name);
  if (byId && byId.rootWorkspaceId === rootOf(store, workspaceId)) return flowTypeByKey(store, workspaceId, byId.key);
  return flowTypeByKey(store, workspaceId, name);
}

const unknownType = (name: string) => `unknown flow type '${name}': read_flow_catalog without flow_type lists this business's flow types`;

// ---------------------------------------------------------------------------
// read_flow_catalog

/** One flow type as listed: an agent-written name and definition are third-party-like text (fenced definition). */
function typeLine(store: Store, workspaceId: string, t: FlowType): Record<string, unknown> {
  if (BUILTIN_KEYS.has(t.key)) return { key: t.key, name: t.name, definition: t.definition, status: t.status };
  return {
    key: t.key,
    name: cleanText(store, workspaceId, t.name),
    definition: fenceEvidence(t.id, redactServed(store, workspaceId, t.definition)),
    status: t.status,
  };
}

const readFlowCatalog: ExtraToolHandler = (ctx, raw, deps) => refusing(() => readFlowCatalogPage(ctx, raw, deps));

function readFlowCatalogPage(ctx: RunContext, raw: unknown, deps: Deps): ToolResult {
  const input = raw as ToolInput<'read_flow_catalog'>;
  const { store, config } = deps;
  ensureCatalog(store, ctx.workspaceId);
  const root = rootOf(store, ctx.workspaceId);
  let header: Record<string, unknown> = {};
  let itemsKey = 'flow_types';
  let values: Array<Record<string, unknown>>;
  let typeId: string | null = null;
  if (input.flow_type === undefined) {
    // The node's subjects, by id: a worker naming its own company "Acme Inc." instead of "Acme" would
    // otherwise create another entity whose flows never rank. The company entity is made on first use.
    companyEntity(store, scopeFor(store, ctx.workspaceId), ctx.workspaceId, { agentRunId: ctx.agentRunId });
    const subjects = nodeSubjects(store, ctx.workspaceId).slice(0, MAX_CATALOG_SUBJECTS);
    header = { subjects: subjects.map((e) => ({ id: e.id, name: boundedName(cleanText(store, ctx.workspaceId, e.name)), kind: e.kind })) };
    values = listFlowTypes(store, ctx.workspaceId)
      .filter((t) => t.status !== 'merged')
      .map((t) => typeLine(store, ctx.workspaceId, t));
  } else {
    const type = flowTypeNamed(store, ctx.workspaceId, input.flow_type);
    if (!type || type.status === 'rejected') return fail(unknownType(input.flow_type));
    typeId = type.id;
    const { general, specific } = activeChecklists(store, ctx.workspaceId, type.id);
    const { name, status } = typeLine(store, ctx.workspaceId, type);
    header = { flow_type: type.key, name, status };
    itemsKey = 'items';
    values = (specific ? [['general', general], ['specific', specific]] as const : [['general', general]] as const).flatMap(([checklist, list]) =>
      list.items.map((i) => ({
        checklist,
        key: i.key,
        question: i.question,
        kind: i.kind,
        ...(i.options ? { options: i.options } : {}),
        answered_by: i.answeredBy,
      })),
    );
  }
  const budget = Math.max(FLOW_CATALOG_FLOOR_TOKENS, budgetFor(config, ctx.role, ctx.model.provider, 'expand', input.max_tokens));
  try {
    const page = assemblePage({
      key: cursorKey(['read_flow_catalog', root, typeId]),
      cursor: input.cursor,
      budget,
      itemsKey,
      header,
      headerRefs: [],
      headerUpload: false,
      items: values.map((value) => ({ value, refs: [], upload: false })),
    });
    return ok(page.data);
  } catch (e) {
    if (e instanceof InvalidCursorError) return fail(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// save_flow

type SaveFlowPayload = {
  tool: 'save_flow';
  flowId: string;
  subjectEntityId: string;
  flowTypeId: string;
  /** Replay identity of the call as sent: `titleKey(variant)` and `stepsHash` of its steps. */
  variantKey: string;
  stepsHash: string;
  result: Record<string, unknown>;
};

const coreSteps = (steps: ToolInput<'save_flow'>['steps']): FlowStepInput[] =>
  steps.map((s) => ({
    action: s.action,
    observation: s.observation,
    ...(s.asked !== undefined ? { asked: s.asked } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(s.artifact_id !== undefined ? { artifactId: s.artifact_id } : {}),
    ...(s.page_url !== undefined ? { pageUrl: s.page_url } : {}),
  }));

/** The earlier saved call this one replays (same run or task, subject, type, variant and steps), if any. */
function savedReplay(store: Store, ctx: RunContext, input: ToolInput<'save_flow'>, variantKey: string, hash: string): SaveFlowPayload | undefined {
  let subjectId: string | undefined;
  try {
    subjectId = lookupEntity(store, scopeFor(store, ctx.workspaceId), input.subject)?.id;
  } catch {
    return undefined; // not resolvable here: the save itself says why
  }
  const type = flowTypeByKey(store, ctx.workspaceId, input.flow_type_key);
  if (!subjectId || !type) return undefined;
  const d = findReplay(store, ctx, 'save_flow', 'task', (p) =>
    p.subjectEntityId === subjectId && p.flowTypeId === type.id && p.variantKey === variantKey && p.stepsHash === hash,
  );
  return d?.payload as SaveFlowPayload | undefined;
}

const saveFlowHandler: ExtraToolHandler = (ctx, raw, deps) =>
  refusing(() => {
    const input = raw as ToolInput<'save_flow'>;
    const { store } = deps;
    const task = ownTask(store, ctx);
    const steps = coreSteps(input.steps);
    const variantKey = titleKey(input.variant);
    const hash = stepsHash(steps);

    const replay = savedReplay(store, ctx, input, variantKey, hash);
    if (replay) {
      // Re-sent by its own task in a later round: the flow is re-submitted in that round (superseded tracking).
      const flow = flowRepos(store).flows.get(replay.flowId);
      if (flow && task && flow.taskId === task.id && flow.status !== 'superseded' && flow.taskRound !== task.round) {
        flowRepos(store).flows.update(flow.id, { taskRound: task.round });
      }
      return ok({ ...replay.result, duplicate: true });
    }

    const core: SaveFlowInput = {
      subject: input.subject,
      flowTypeKey: input.flow_type_key,
      variant: input.variant,
      primary: input.primary,
      name: input.name,
      goal: input.goal,
      reachedGoal: input.reached_goal,
      steps,
      ...(input.entry_url !== undefined ? { entryUrl: input.entry_url } : {}),
      ...(input.stop_reason !== undefined ? { stopReason: input.stop_reason } : {}),
      ...(input.notable !== undefined ? { notable: input.notable } : {}),
      ...(input.relation !== undefined ? { relation: input.relation } : {}),
    };
    const settings = flowsSettings(deps.config);
    const out = store.transaction(() => {
      const r = saveFlow(store, flowCtxOf(ctx, task), core);
      if (!r.saved) {
        const existing = r.existing.map((e) => ({
          id: e.id,
          variant: fenceEvidence(e.id, redactServed(store, ctx.workspaceId, e.variant)),
          version: e.version,
          steps: e.steps,
          same_steps: e.sameSteps,
        }));
        return {
          data: {
            saved: false,
            reason: 'exists',
            existing,
            content_trust: CONTENT_TRUST,
            next:
              'Nothing was saved. This subject already has a current flow of this type and variant with other steps. Call ' +
              'save_flow again with relation {"replaces": "<id>"} if that variant changed, {"confirms": "<id>"} if it is the ' +
              'same, or another variant name if this is a different way through the flow.',
          },
          decision: undefined,
        };
      }
      const flow = r.flow;
      applyReviewChecks(store, ctx.workspaceId, flow.id, settings);
      const unanswered = saveCheckAnswers(store, ctx.workspaceId, flow.id, []).missing;
      const data = {
        saved: true,
        relation: r.relation,
        flow: { id: flow.id, version: flow.version, lifecycle: flow.lifecycle, status: flow.status },
        unanswered,
      };
      const payload: SaveFlowPayload = {
        tool: 'save_flow', flowId: flow.id, subjectEntityId: flow.subjectEntityId, flowTypeId: flow.flowTypeId, variantKey, stepsHash: hash, result: data,
      };
      const artifacts = steps.flatMap((s) => (s.artifactId ? [s.artifactId] : []));
      return { data, decision: record(deps, ctx, payload, [flow.id, ...artifacts]) };
    });
    emit(deps, out.decision);
    return ok(out.data);
  });

// ---------------------------------------------------------------------------
// save_flow_checks

const saveFlowChecksHandler: ExtraToolHandler = (ctx, raw, deps) =>
  refusing(() => {
    const input = raw as ToolInput<'save_flow_checks'>;
    const { store } = deps;
    const task = ownTask(store, ctx);
    if (!task) return fail('save_flow_checks needs a task: this run has no task in this workspace');
    const flow = flowRepos(store).flows.get(input.flow_id);
    // The same refusal for an unknown id, another tree's flow and another task's flow.
    if (!flow || flow.rootWorkspaceId !== rootOf(store, ctx.workspaceId) || flow.taskId !== task.id) {
      return fail(`flow '${input.flow_id}' was not saved by this task: answer the checks of the flows your task saved`);
    }
    const settings = flowsSettings(deps.config);
    const out = store.transaction(() => {
      const r = saveCheckAnswers(store, ctx.workspaceId, flow.id, input.answers);
      // A walkthrough answer replaces the stored row of a 'both' item: re-apply the reviews to it.
      applyReviewChecks(store, ctx.workspaceId, flow.id, settings);
      const data = { saved: r.saved, unanswered: r.missing };
      const decision = record(deps, ctx, { tool: 'save_flow_checks', flowId: flow.id, answers: input.answers, saved: r.saved }, [flow.id]);
      return { data, decision };
    });
    emit(deps, out.decision);
    return ok(out.data);
  });

// ---------------------------------------------------------------------------
// save_review_mentions

const saveReviewMentionsHandler: ExtraToolHandler = (ctx, raw, deps) =>
  refusing(async () => {
    const input = raw as ToolInput<'save_review_mentions'>;
    const { store } = deps;
    const task = ownTask(store, ctx);
    const flowCtx = flowCtxOf(ctx, task);
    const mentions: ReviewMentionInput[] = input.mentions.map((m) => ({
      sourceType: m.source_type,
      artifactId: m.artifact_id,
      quote: m.quote,
      polarity: m.polarity,
      ...(m.source_url !== undefined ? { sourceUrl: m.source_url } : {}),
      ...(m.published_at !== undefined ? { publishedAt: m.published_at } : {}),
      ...(m.rating !== undefined ? { rating: m.rating } : {}),
      ...(m.flow_type_key !== undefined ? { flowTypeKey: m.flow_type_key } : {}),
      ...(m.check_key !== undefined ? { checkKey: m.check_key } : {}),
      ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
    }));
    const env = factToolEnv(deps, (c, kind, payload, refs) => record(deps, c, payload, refs, kind));
    const result = await saveReviewMentions(env, flowCtx, input.subject, mentions);

    const out = store.transaction(() => {
      const subject = resolveSubject(store, scopeFor(store, ctx.workspaceId), input.subject, flowCtx);
      if (result.saved > 0) {
        // The review-answered checks of the subject's current flows of each type the accepted mentions name.
        const rejected = new Set(result.rejected.map((r) => r.index));
        const typeIds = new Set<string>();
        mentions.forEach((m, i) => {
          if (rejected.has(i) || m.flowTypeKey === undefined) return;
          const type = flowTypeByKey(store, ctx.workspaceId, m.flowTypeKey);
          if (type) typeIds.add(type.id);
        });
        const settings = flowsSettings(deps.config);
        for (const flowTypeId of typeIds) {
          const current = flowRepos(store)
            .flows.list({ rootWorkspaceId: subject.rootWorkspaceId, subjectEntityId: subject.id, flowTypeId, lifecycle: 'current' })
            .filter((f) => f.status !== 'superseded');
          for (const f of current) applyReviewChecks(store, ctx.workspaceId, f.id, settings);
        }
      }
      // Provenance: only the stored copies of mentions that were saved or were duplicates of stored ones.
      const rejected = new Set(result.rejected.map((r) => r.index));
      return record(
        deps,
        ctx,
        { tool: 'save_review_mentions', subjectEntityId: subject.id, saved: result.saved, duplicates: result.duplicates, rejected: result.rejected.length },
        [subject.id, ...mentions.flatMap((m, i) => (rejected.has(i) ? [] : [m.artifactId]))],
      );
    });
    emit(deps, out);
    return ok(result);
  });

// ---------------------------------------------------------------------------
// propose_flow_type, propose_checklist

const proposeFlowTypeHandler: ExtraToolHandler = (ctx, raw, deps) =>
  refusing(() => {
    const input = raw as ToolInput<'propose_flow_type'>;
    const { store } = deps;
    const out = store.transaction(() => {
      const r = proposeFlowType(store, ctx.workspaceId, {
        key: input.key,
        name: cleanText(store, ctx.workspaceId, input.name),
        definition: cleanText(store, ctx.workspaceId, input.definition),
        agentRunId: ctx.agentRunId,
      });
      const t = r.flowType;
      const decision = r.created
        ? record(deps, ctx, { tool: 'propose_flow_type', flowTypeId: t.id, key: t.key, name: t.name, definition: t.definition }, [t.id])
        : undefined;
      return { r, decision };
    });
    emit(deps, out.decision);
    const t = out.r.flowType;
    const note =
      t.status === 'rejected'
        ? 'the user rejected this flow type: use another type'
        : !out.r.created
          ? t.status === 'proposed'
            ? 'already proposed; waiting for the user'
            : 'already in the catalog: use this key'
          : 'proposed; it takes part in rankings once the user accepts it. Flows can be saved with it meanwhile.';
    return ok({ key: t.key, status: t.status, created: out.r.created, note });
  });

type ChecklistPayload = { tool: 'propose_checklist'; checklistId: string; flowTypeId: string; fingerprint: string };

const proposeChecklistHandler: ExtraToolHandler = (ctx, raw, deps) =>
  refusing(() => {
    const input = raw as ToolInput<'propose_checklist'>;
    const { store } = deps;
    const type = flowTypeNamed(store, ctx.workspaceId, input.flow_type);
    if (!type || type.status === 'rejected') return fail(unknownType(input.flow_type));
    const clean = (s: string) => cleanText(store, ctx.workspaceId, s);
    const items: ChecklistItem[] = input.items.map((i) => ({
      key: i.key.trim(),
      question: clean(i.question),
      kind: i.kind,
      ...(i.options !== undefined ? { options: i.options.map(clean) } : {}),
      ...(i.pass !== undefined ? { pass: i.pass } : {}),
      weight: i.weight ?? 1,
      scored: i.scored,
      answeredBy: i.answered_by,
      ...(i.source !== undefined ? { source: clean(i.source) } : {}),
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify({ coverage: input.coverage, items })).digest('hex');
    const replay = findReplay(store, ctx, 'propose_checklist', 'task', (p) => p.flowTypeId === type.id && p.fingerprint === fingerprint);
    if (replay) {
      const earlier = flowRepos(store).checklists.get((replay.payload as ChecklistPayload).checklistId);
      if (earlier) return ok({ checklistId: earlier.id, version: earlier.version, status: earlier.status, duplicate: true });
    }
    const out = store.transaction(() => {
      const c = proposeChecklist(store, ctx.workspaceId, { flowTypeId: type.id, coverage: input.coverage, items, origin: 'agent' });
      const payload: ChecklistPayload = { tool: 'propose_checklist', checklistId: c.id, flowTypeId: type.id, fingerprint };
      return { c, decision: record(deps, ctx, payload, [c.id, type.id]) };
    });
    emit(deps, out.decision);
    return ok({ checklistId: out.c.id, version: out.c.version, status: out.c.status, flow_type: type.key });
  });

/** The flow record worker tools, for `createToolHandlers({ extraHandlers })`. */
export function flowToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return {
    read_flow_catalog: readFlowCatalog,
    save_flow: saveFlowHandler,
    save_flow_checks: saveFlowChecksHandler,
    save_review_mentions: saveReviewMentionsHandler,
    propose_flow_type: proposeFlowTypeHandler,
    propose_checklist: proposeChecklistHandler,
  };
}
