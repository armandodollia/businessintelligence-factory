import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import type { BifConfig } from '../../config/schema.js';
import { AbortError, type EventBus } from '../../events.js';
import type { ArtifactStore } from '../../evidence/artifacts.js';
import type { Store } from '../../store/db.js';
import { newId } from '../../store/repos.js';
import type { Decision, Finding, Task, UserRequest } from '../../types.js';
import type { RunContext } from '../tokens.js';
import { ROLE_TOOLS, TOOL_NAMES, toolInputSchemas, type IssueClass, type ToolInput, type ToolName } from './registry.js';

export type ToolResult =
  | { ok: true; data: unknown; images?: Array<{ data: string; mimeType: string }> }
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
      payload,
      refs: [...new Set(refs)],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    store.decisions.insert(decision);
    return decision;
  }

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
    const id = newId('ureq');
    // Register the waiter before the row exists so a fast resolve cannot be missed. `local`
    // tears the waiter down if the insert fails.
    const local = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, local.signal]) : local.signal;
    const waiter = events.waitFor((e) => e.type === 'user_request_resolved' && e.request.id === id, signal);
    waiter.catch(() => {});
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
    try {
      const e = await waiter;
      // Task status restoration happens in resolveUserRequest (works after restarts too).
      const resolved = (e as Extract<typeof e, { type: 'user_request_resolved' }>).request;
      const data: Record<string, unknown> = {
        requestId: id,
        status: resolved.status,
        approved: resolved.status === 'resolved',
      };
      if (resolved.response !== undefined) data.response = resolved.response;
      return okData(data);
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
      let artifact;
      if (input.file_path !== undefined) {
        if (!isAbsolute(input.file_path)) return fail('file_path must be an absolute path');
        artifact = artifacts.saveFromPath({ ...meta, filePath: input.file_path });
      } else if (input.content_base64 !== undefined) {
        artifact = artifacts.save({ ...meta, bytes: new Uint8Array(Buffer.from(input.content_base64, 'base64')) });
      } else {
        artifact = artifacts.save({ ...meta, bytes: input.content ?? '' });
      }
      return okData({ artifactId: artifact.id, sha256: artifact.sha256 });
    },

    async read_artifact(ctx, input: ToolInput<'read_artifact'>) {
      const meta = store.artifacts.get(input.artifact_id);
      if (!meta || meta.workspaceId !== ctx.workspaceId) return fail(`artifact '${input.artifact_id}' not found`);
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
        return fail(`evidence references unknown artifacts (not in this workspace): ${missing.join(', ')}`);
      }
      const finding: Finding = {
        id: newId('fnd'),
        workspaceId: ctx.workspaceId,
        runId: task.runId,
        taskId: task.id,
        subject: input.subject,
        claim: input.claim,
        criteria: input.criteria,
        evidence: input.evidence,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      const d = store.transaction(() => {
        store.findings.insert(finding);
        return recordDecision(
          ctx,
          'score',
          { tool: 'save_finding', findingId: finding.id, criteria: input.criteria },
          [finding.id, ...input.evidence],
        );
      });
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
      return okData({ findingId: finding.id });
    },

    async submit_result(ctx, input: ToolInput<'submit_result'>) {
      const task = taskOf(ctx);
      const d = store.transaction(() => {
        if (task) store.tasks.update(task.id, { result: input });
        return recordDecision(ctx, 'decision', { tool: 'submit_result', result: input }, task ? [task.id] : []);
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
      const result = await extra(ctx, parsed.data, deps, opts);
      const kind = EXTRA_DECISION_KIND[name];
      if (result.ok && kind) {
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
