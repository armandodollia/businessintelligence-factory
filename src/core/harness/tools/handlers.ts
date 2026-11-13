import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import type { BifConfig } from '../../config/schema.js';
import { AbortError, type EventBus } from '../../events.js';
import type { ArtifactStore } from '../../evidence/artifacts.js';
import { ineligibleFindingIds } from '../../evidence/synthesis.js';
import { redactIdentitySecrets } from '../../identity/identities.js';
import type { Store } from '../../store/db.js';
import { newId } from '../../store/repos.js';
import type { Decision, Finding, Task, UserRequest } from '../../types.js';
import type { RunContext } from '../tokens.js';
import { browserConfigured } from '../browser.js';
import { isAllowedRunFile } from '../paths.js';
import { taskOutputEvidence } from '../../research/outputs.js';
import { findReplay } from './idempotency.js';
// Knowledge store KS-1: captures, captions, entity / applies_to, extraction, describe_artifact.
import { captureMeta, checkArtifactSave, describeArtifact, finishArtifactSave } from '../../knowledge/artifactTools.js';
import type { CaptureResult } from '../../evidence/artifacts.js';
import { observeFact, saveFindingFact, type FactToolEnv } from '../../knowledge/factTools.js'; // KS-2
import { ROLE_TOOLS, TOOL_NAMES, toolInputSchemas, type IssueClass, type ToolInput, type ToolName } from './registry.js';

export type ToolResult =
  | {
      ok: true;
      data: unknown;
      images?: Array<{ data: string; mimeType: string }>;
      /**
       * Set by an extra handler that wrote its own judgment Decision atomically with its side
       * effects (e.g. `propose_tasks`); the dispatcher then writes none.
       */
      recorded?: boolean;
    }
  | { ok: false; error: string };

export type ToolCallOptions = { signal?: AbortSignal };

/**
 * Handler for a tool implemented outside this section. Receives the zod-validated input
 * (`ToolInput<name>`). For `propose_tasks` / `submit_persona_feedback` the dispatcher records the
 * Decision row (kind `task_proposal` / `persona_feedback`) after a successful call — extra
 * handlers must not insert it themselves.
 */
export type ExtraToolHandler = (
  ctx: RunContext,
  input: unknown,
  deps: ToolHandlerDeps,
  opts: ToolCallOptions,
) => Promise<ToolResult>;

export type ToolHandlerDeps = {
  store: Store;
  artifacts: ArtifactStore;
  config: BifConfig;
  events: EventBus;
  /** Handlers for tools owned by later sections (propose_tasks, save_persona, get_identity, ...). */
  extraHandlers?: Partial<Record<ToolName, ExtraToolHandler>>;
};

export type HandleTool = (
  ctx: RunContext,
  name: ToolName,
  input: unknown,
  opts?: ToolCallOptions,
) => Promise<ToolResult>;

export type ReviewIssue = { id: string; class: IssueClass; description: string; evidence?: string[] };
export type ReviewResponse = { issueId: string; action: 'fix' | 'pushback'; reason: string };
export type RunOutputs = {
  /** Last `submit_result` payload of the run. */
  result?: unknown;
  /** Last `submit_review` of the run. */
  review?: { score: number; issues: ReviewIssue[]; summary?: string };
  /** Every `respond_to_review`, in call order. */
  responses: ReviewResponse[];
};

const READ_TEXT_LIMIT = 200_000;
const READ_IMAGE_LIMIT = 5 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-ndjson)|.*\+xml$|.*\+json$)/i;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;

/** Tools that are judgment calls recorded by the dispatcher when implemented by an extra handler. */
const EXTRA_DECISION_KIND: Partial<Record<ToolName, Decision['kind']>> = {
  propose_tasks: 'task_proposal',
  submit_persona_feedback: 'persona_feedback',
};

const fail = (error: string): ToolResult => ({ ok: false, error });
const okData = (data: unknown): ToolResult => ({ ok: true, data });

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

/**
 * Builds the harness tool dispatcher: role-scope check → zod validation → handler. Never throws;
 * every failure is an `{ ok: false, error }` result with no side effects, and every call is
 * announced on the bus as a `tool_call` event.
 */
export function createToolHandlers(deps: ToolHandlerDeps): HandleTool {
  const { store, artifacts, events } = deps;

  function recordDecision(ctx: RunContext, kind: Decision['kind'], payload: unknown, refs: string[]): Decision {
    const decision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind,
      // Identity passwords never reach the decision log, whatever the agent wrote.
      payload: redactIdentitySecrets(store, ctx.workspaceId, payload),
      refs: [...new Set(refs)],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    store.decisions.insert(decision);
    return decision;
  }

  // Knowledge store KS-2: living-fact tools (save_finding beyond the replay rule, confirm / retract).
  const factEnv: FactToolEnv = { store, artifacts, config: deps.config, events, recordDecision };

  function taskOf(ctx: RunContext): Task | undefined {
    if (!ctx.taskId) return undefined;
    const task = store.tasks.get(ctx.taskId);
    return task && task.workspaceId === ctx.workspaceId ? task : undefined;
  }

  async function awaitUserRequest(
    ctx: RunContext,
    kind: UserRequest['kind'],
    site: string,
    details: string,
    opts: ToolCallOptions,
  ): Promise<ToolResult> {
    if (opts.signal?.aborted) return fail('call cancelled');
    // A replay of the same request from the same run (e.g. after a rate-limit retry) waits on the
    // request that is already pending, or gets the stored answer, instead of asking the user twice.
    const same = store.userRequests
      .list({ agentRunId: ctx.agentRunId })
      .filter((r) => r.workspaceId === ctx.workspaceId && r.kind === kind && r.site === site && r.details === details);
    const replayOf = same.find((r) => r.status === 'pending') ?? same.at(-1);
    const id = replayOf?.id ?? newId('ureq');
    // Register the waiter before the row exists so a fast resolve cannot be missed. `local`
    // tears the waiter down if the insert fails.
    const local = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, local.signal]) : local.signal;
    const waiter = events.waitFor((e) => e.type === 'user_request_resolved' && e.request.id === id, signal);
    waiter.catch(() => {});
    const answer = (resolved: UserRequest): ToolResult => {
      const data: Record<string, unknown> = {
        requestId: id,
        status: resolved.status,
        approved: resolved.status === 'resolved',
      };
      if (resolved.response !== undefined) data.response = resolved.response;
      if (replayOf) data.reused = true;
      return okData(data);
    };
    if (replayOf) {
      // Already answered (earlier, or between the lookup and the waiter registration): return the
      // stored answer at once instead of asking the user again.
      const now = store.userRequests.get(id);
      if (now && now.status !== 'pending') {
        local.abort();
        return answer(now);
      }
    }
    if (!replayOf) {
      const request: UserRequest = {
        id,
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        kind,
        site,
        details,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      if (ctx.taskId !== undefined) request.taskId = ctx.taskId;
      try {
        store.transaction(() => {
          // Read the task inside the transaction so concurrent requests see each other.
          const task = taskOf(ctx);
          if (task) {
            if (task.status !== 'waiting_user') {
              // First pending request for this task: remember the status to restore later.
              request.taskPriorStatus = task.status;
              store.tasks.update(task.id, { status: 'waiting_user' });
            } else {
              // Already waiting: carry the original prior status from a sibling pending request.
              const prior = store.userRequests
                .list({ taskId: task.id, status: 'pending' })
                .find((r) => r.workspaceId === ctx.workspaceId && r.taskPriorStatus)?.taskPriorStatus;
              if (prior) request.taskPriorStatus = prior;
            }
          }
          store.userRequests.insert(request);
        });
      } catch (err) {
        local.abort();
        throw err;
      }
      events.emit({ type: 'user_request', workspaceId: ctx.workspaceId, request });
    }
    try {
      const e = await waiter;
      // Task status restoration happens in resolveUserRequest (works after restarts too).
      return answer((e as Extract<typeof e, { type: 'user_request_resolved' }>).request);
    } catch (err) {
      if (err instanceof AbortError) {
        return fail(`call cancelled; user request ${id} stays pending until the user answers it`);
      }
      throw err;
    }
  }

  const builtins: Partial<Record<ToolName, (ctx: RunContext, input: never, opts: ToolCallOptions) => Promise<ToolResult>>> = {
    async log_decision(ctx, input: ToolInput<'log_decision'>) {
      const { refs, ...rest } = input;
      const d = recordDecision(ctx, 'decision', { tool: 'log_decision', ...rest }, refs);
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      return okData({ decisionId: d.id });
    },

    async save_artifact(ctx, input: ToolInput<'save_artifact'>) {
      // KS-1: caption rule, entity and applies_to are checked before anything is written.
      const extras = {
        ...(input.description !== undefined && { description: input.description }),
        ...(input.entity !== undefined && { entity: input.entity }),
        ...(input.applies_to !== undefined && { appliesTo: input.applies_to }),
      };
      const check = checkArtifactSave(deps, ctx, { kind: input.kind, mime: input.mime, ...extras });
      if (!check.ok) return fail(check.error);
      const meta = {
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        mime: input.mime,
        ...(input.source_url !== undefined && { sourceUrl: input.source_url }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.flow !== undefined && { flow: input.flow }),
        ...(input.step !== undefined && { step: input.step }),
        ...(input.note !== undefined && { note: input.note }),
      };
      if (input.file_path !== undefined) {
        if (!isAbsolute(input.file_path)) return fail('file_path must be an absolute path');
        // Agents may only hand over files they produced: no reading the user's disk through us.
        if (!isAllowedRunFile(input.file_path, artifacts.dataDir, ctx.workspaceId, ctx.agentRunId)) {
          return fail('file_path must be inside your working directory or the OS temp dir');
        }
      }
      // Every save records a capture (KS-1); the entity is resolved in the same transaction.
      const saved: CaptureResult = store.transaction(() => {
        const full = { ...meta, ...captureMeta(deps, ctx, extras) };
        if (input.file_path !== undefined) return artifacts.captureFromPath({ ...full, filePath: input.file_path });
        if (input.content_base64 !== undefined) {
          return artifacts.capture({ ...full, bytes: new Uint8Array(Buffer.from(input.content_base64, 'base64')) });
        }
        return artifacts.capture({ ...full, bytes: input.content ?? '' });
      });
      const data = await finishArtifactSave(deps, ctx, saved, extras, (payload, refs) => {
        const d = recordDecision(ctx, 'decision', payload, refs);
        events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      });
      return okData(data);
    },

    // Knowledge store KS-1: describe_artifact (design §9).
    async describe_artifact(ctx, input: ToolInput<'describe_artifact'>) {
      const r = describeArtifact(deps, ctx, input);
      return r.ok ? okData(r.value) : fail(r.error);
    },

    async read_artifact(ctx, input: ToolInput<'read_artifact'>) {
      const meta = store.artifacts.get(input.artifact_id);
      // Artifacts of any workspace in the same business tree are readable; other trees are not.
      if (!meta || artifacts.exists(ctx.workspaceId, [meta.id]).length) return fail(`artifact '${input.artifact_id}' not found`);
      const { artifact, bytes } = artifacts.read(meta.id);
      const base = artifact.mime.split(';')[0]!.trim();
      if (TEXT_MIME.test(base)) {
        const text = bytes.toString('utf8');
        const truncated = text.length > READ_TEXT_LIMIT;
        return okData({ artifact, text: truncated ? text.slice(0, READ_TEXT_LIMIT) : text, truncated });
      }
      if (IMAGE_MIME.test(base) && bytes.byteLength <= READ_IMAGE_LIMIT) {
        return { ok: true, data: { artifact }, images: [{ data: bytes.toString('base64'), mimeType: base }] };
      }
      return okData({ artifact, note: `binary content (${bytes.byteLength} bytes, ${base}) not inlined` });
    },

    async save_finding(ctx, input: ToolInput<'save_finding'>) {
      const task = taskOf(ctx);
      if (!task) return fail('save_finding needs a task: this run has no task in this workspace');
      const missing = artifacts.exists(ctx.workspaceId, input.evidence);
      if (missing.length) {
        return fail(`evidence references unknown artifacts (not in this workspace's business tree): ${missing.join(', ')}`);
      }
      // KS-2: artifacts cited by evidence_refs count as evidence too (checked in the tree).
      const refIds = (input.evidence_refs ?? []).map((r) => r.artifact_id);
      const missingRefs = artifacts.exists(ctx.workspaceId, refIds);
      if (missingRefs.length) return fail(`evidence_refs: artifact '${missingRefs[0]}' not found`);
      // Idempotent per (task, claim): a rate-limit retry restarts the agent on the same run and may
      // replay save_finding. The existing finding is kept and the new evidence merged into it.
      const dup = store.findings
        .list({ taskId: task.id, claim: input.claim })
        .find((f) => f.workspaceId === ctx.workspaceId);
      if (dup) {
        // Same (task, claim): update the mutable fields in place (keeping the id) and log a new
        // score Decision when the judgment (criteria / subject) changed. Re-saving marks the finding
        // as re-submitted in the task's current round (superseded tracking, reviewLoop).
        const evidence = [...new Set([...dup.evidence, ...input.evidence, ...refIds])];
        const judgmentChanged =
          JSON.stringify(dup.criteria) !== JSON.stringify(input.criteria) || dup.subject !== input.subject;
        if (!judgmentChanged && evidence.length === dup.evidence.length) {
          if (dup.taskRound !== task.round) store.findings.update(dup.id, { taskRound: task.round });
          return okData({ findingId: dup.id, duplicate: true });
        }
        const d = store.transaction(() => {
          store.findings.update(dup.id, { evidence, criteria: input.criteria, subject: input.subject, taskRound: task.round });
          if (!judgmentChanged) return undefined;
          return recordDecision(
            ctx,
            'score',
            { tool: 'save_finding', findingId: dup.id, criteria: input.criteria, subject: input.subject, revision: true, previous: { criteria: dup.criteria, subject: dup.subject } },
            [dup.id, ...evidence],
          );
        });
        if (d) events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
        return okData({ findingId: dup.id, duplicate: true, updated: true });
      }
      // Knowledge store KS-2: relation / duplicate handshake / applies_to / evidence_refs / ttl_days
      // (knowledge/factTools.ts). KS-3: pass the resolved entity as `{ entityId }`.
      return saveFindingFact(factEnv, ctx, task, input, {});
    },

    // --- knowledge store KS-2: confirm / retract a current fact (design §7.2, §9) ---
    async confirm_finding(ctx, input: ToolInput<'confirm_finding'>) {
      const task = taskOf(ctx);
      if (!task) return fail('confirm_finding needs a task: this run has no task in this workspace');
      return observeFact(factEnv, ctx, task, input.finding_id, input.evidence, 'confirm');
    },

    async retract_finding(ctx, input: ToolInput<'retract_finding'>) {
      const task = taskOf(ctx);
      if (!task) return fail('retract_finding needs a task: this run has no task in this workspace');
      return observeFact(factEnv, ctx, task, input.finding_id, input.evidence, 'retract', { reason: input.reason });
    },
    // --- end KS-2 ---

    async submit_result(ctx, input: ToolInput<'submit_result'>) {
      const task = taskOf(ctx);
      const d = store.transaction(() => {
        if (task) store.tasks.update(task.id, { result: input });
        // Evidence provenance: every artifact the deliverable rests on (the task's findings'
        // evidence, artifacts cited in the deliverable or brief), so the training export can tell
        // upload-derived results apart.
        const provenance = resultProvenance(store, task, input);
        return recordDecision(
          ctx,
          'decision',
          { tool: 'submit_result', result: input, provenance },
          task ? [task.id, ...provenance] : provenance,
        );
      });
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      return okData({ accepted: true });
    },

    async submit_review(ctx, input: ToolInput<'submit_review'>) {
      const used = new Set(input.issues.map((i) => i.id).filter(Boolean));
      let n = 0;
      const nextId = () => {
        let id: string;
        do id = `I${++n}`;
        while (used.has(id));
        used.add(id);
        return id;
      };
      const issues: ReviewIssue[] = input.issues.map((i) => {
        const issue: ReviewIssue = { id: i.id ?? nextId(), class: i.class, description: i.description };
        if (i.evidence) issue.evidence = i.evidence;
        return issue;
      });
      const payload: Record<string, unknown> = { tool: 'submit_review', score: input.score, issues };
      if (input.summary !== undefined) payload.summary = input.summary;
      const d = recordDecision(ctx, 'review', payload, ctx.taskId ? [ctx.taskId] : []);
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      return okData({ score: input.score, issues });
    },

    async respond_to_review(ctx, input: ToolInput<'respond_to_review'>) {
      // Idempotent per (run, issue): a replayed answer (rate-limit retry) is not logged twice.
      if (findReplay(store, ctx, 'respond_to_review', 'run', (p) => p.issueId === input.issue_id)) {
        return okData({ recorded: true, duplicate: true });
      }
      const kind = input.action === 'pushback' ? 'pushback' : 'decision';
      const d = recordDecision(
        ctx,
        kind,
        { tool: 'respond_to_review', issueId: input.issue_id, action: input.action, reason: input.reason },
        ctx.taskId ? [ctx.taskId] : [],
      );
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      return okData({ recorded: true });
    },

    async request_user_action(ctx, input: ToolInput<'request_user_action'>, opts) {
      return awaitUserRequest(ctx, input.kind, input.site, input.instructions, opts);
    },

    async request_approval(ctx, input: ToolInput<'request_approval'>, opts) {
      return awaitUserRequest(ctx, 'approval', input.site, `Action: ${input.action}\n\n${input.details}`, opts);
    },
  };

  return async (ctx, name, input, opts = {}) => {
    const announce = (r: ToolResult): ToolResult => {
      const e: Parameters<EventBus['emit']>[0] = {
        type: 'tool_call',
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        tool: String(name),
        ok: r.ok,
      };
      if (!r.ok) e.error = r.error;
      events.emit(e);
      return r;
    };

    if (!(TOOL_NAMES as readonly string[]).includes(name)) return announce(fail(`unknown tool '${String(name)}'`));
    if (!ROLE_TOOLS[ctx.role].includes(name)) {
      return announce(fail(`tool '${name}' is not available to role '${ctx.role}'`));
    }
    const parsed = toolInputSchemas[name].safeParse(input ?? {});
    if (!parsed.success) return announce(fail(`invalid input for ${name}: ${formatZodError(parsed.error)}`));

    try {
      const builtin = builtins[name];
      if (builtin) return announce(await builtin(ctx, parsed.data as never, opts));

      const extra = deps.extraHandlers?.[name];
      if (!extra) return announce(fail(`tool '${name}' is not available yet in this build`));
      if (name === 'propose_tasks' && !browserConfigured(deps.config)) {
        const tasks = (parsed.data as { tasks: Array<{ needs_browser?: boolean }> }).tasks;
        const idx = tasks.flatMap((t, i) => (t.needs_browser ? [i] : []));
        if (idx.length) {
          return announce(
            fail(
              `tasks ${idx.join(', ')} set needs_browser but no browser is configured (browser.backend 'mcp' without ` +
                `a shared server or mcpServers). Propose them again without needs_browser, or drop them.`,
            ),
          );
        }
      }
      if (name === 'save_recommendation') {
        // Spec §7.2: unverified results are excluded from synthesis unless the user overrides.
        const ids = (parsed.data as ToolInput<'save_recommendation'>).finding_ids;
        const blocked = ineligibleFindingIds(store, ctx.workspaceId, ids);
        if (blocked.length) {
          return announce(
            fail(`finding_ids include findings that are not verified (and not included by the user): ${blocked.join(', ')}`),
          );
        }
      }
      const result = await extra(ctx, parsed.data, deps, opts);
      const kind = EXTRA_DECISION_KIND[name];
      // A handler that recognised a replayed call (`duplicate: true`) already has its Decision.
      const replayed =
        result.ok && (result.recorded === true || (result.data as { duplicate?: unknown } | null)?.duplicate === true);
      if (result.ok && kind && !replayed) {
        const d = recordDecision(ctx, kind, { tool: name, input: parsed.data, result: result.data }, ctx.taskId ? [ctx.taskId] : []);
        events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      }
      return announce(result);
    } catch (err) {
      return announce(fail(`${name} failed: ${(err as Error).message}`));
    }
  };
}

/**
 * Answers a pending user request (from the UI / API). `resolved` means done/approved. Wakes the
 * blocked tool call, if any. When this was the task's last pending request and the task is still
 * `waiting_user`, the task goes back to its pre-wait status (`taskPriorStatus`). Throws if the
 * request is unknown or no longer pending.
 */
export function resolveUserRequest(
  deps: { store: Store; events: EventBus },
  id: string,
  status: 'resolved' | 'denied',
  response?: string,
): UserRequest {
  const current = deps.store.userRequests.get(id);
  if (!current) throw new Error(`user request '${id}' not found`);
  if (current.status !== 'pending') throw new Error(`user request '${id}' is already ${current.status}`);
  const patch: Partial<UserRequest> = { status };
  if (response !== undefined) patch.response = response;
  const { store } = deps;
  const request = store.transaction(() => {
    const updated = store.userRequests.update(id, patch);
    const taskId = updated.taskId;
    if (taskId) {
      const stillPending = store.userRequests
        .list({ taskId, status: 'pending' })
        .some((r) => r.workspaceId === updated.workspaceId);
      const task = store.tasks.get(taskId);
      if (!stillPending && task?.workspaceId === updated.workspaceId && task.status === 'waiting_user') {
        const prior =
          updated.taskPriorStatus ??
          store.userRequests.list({ taskId }).find((r) => r.taskPriorStatus)?.taskPriorStatus;
        if (prior && prior !== 'waiting_user') store.tasks.update(taskId, { status: prior });
      }
    }
    return updated;
  });
  deps.events.emit({ type: 'user_request_resolved', workspaceId: request.workspaceId, request });
  return request;
}

const ARTIFACT_ID = /\bart_[0-9A-Z]{26}\b/g;

/** Artifact ids mentioned anywhere in `value` (JSON-serialized). */
export function artifactIdsIn(value: unknown): string[] {
  if (value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...new Set(text.match(ARTIFACT_ID) ?? [])];
}

/**
 * Evidence provenance of a task deliverable: the evidence of the task's findings plus every
 * artifact id cited in the deliverable or in the task brief (e.g. an internal upload the
 * orchestrator pointed the task at), restricted to artifacts that exist.
 */
export function resultProvenance(store: Store, task: Task | undefined, result: unknown): string[] {
  const ids = new Set<string>(artifactIdsIn(result));
  if (task) {
    // Every output of the task (findings, recommendations → cited findings, personas, competitors,
    // hypotheses) and its transitive evidence.
    for (const a of taskOutputEvidence(store, task, result)) ids.add(a);
    for (const a of artifactIdsIn(task.brief)) ids.add(a);
  }
  return [...ids].filter((id) => store.artifacts.get(id) !== undefined);
}

/** Reads back what a run submitted through `submit_result`, `submit_review`, `respond_to_review`. */
export function getRunOutputs(store: Store, agentRunId: string): RunOutputs {
  const out: RunOutputs = { responses: [] };
  for (const d of store.decisions.list({ agentRunId })) {
    const p = d.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    switch (p.tool) {
      case 'submit_result':
        out.result = p.result;
        break;
      case 'submit_review': {
        const review: NonNullable<RunOutputs['review']> = {
          score: p.score as number,
          issues: p.issues as ReviewIssue[],
        };
        if (typeof p.summary === 'string') review.summary = p.summary;
        out.review = review;
        break;
      }
      case 'respond_to_review':
        out.responses.push({
          issueId: p.issueId as string,
          action: p.action as ReviewResponse['action'],
          reason: p.reason as string,
        });
        break;
    }
  }
  return out;
}
