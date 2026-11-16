import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { Supervisor } from '../../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../../src/core/harness/tokens.js';
import { createToolHandlers, type ExtraToolHandler, type ToolHandlerDeps } from '../../../src/core/harness/tools/handlers.js';
import type { ToolName } from '../../../src/core/harness/tools/registry.js';
import type { AgentRequest, ResearchDeps } from '../../../src/core/research/deps.js';
import { taskOutputIds } from '../../../src/core/research/reviewLoop.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';

export type Picker = (req: AgentRequest) => FakeScript | undefined;

export type SetupOptions = {
  dir?: string;
  config?: (c: BifConfig) => void;
  extraHandlers?: (deps: Omit<ToolHandlerDeps, 'extraHandlers'>) => Partial<Record<ToolName, ExtraToolHandler>>;
  pick?: Picker;
};

export function researchSetup(opened: Store[], opts: SetupOptions = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'bif-research-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  config.dataDir = dir;
  config.limits.idleTimeoutMs = 5000;
  opts.config?.(config);
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const artifacts = new ArtifactStore(store, dir);
  const tokens = new TokenRegistry(store);
  const base = { store, artifacts, config, events };
  const handle = createToolHandlers({ ...base, extraHandlers: opts.extraHandlers?.(base) ?? {} });
  const supervisor = new Supervisor({
    store, config, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://127.0.0.1:4317',
    backoff: { baseMs: 5, maxMs: 20, maxAttempts: 3 }, killGraceMs: 100,
  });
  const requests: AgentRequest[] = [];
  const state = { pick: opts.pick ?? ((() => undefined) as Picker) };
  const deps: ResearchDeps = {
    store, config, supervisor, events, tokens,
    fake: (req) => {
      requests.push(req);
      return state.pick(req) ?? (async () => { throw new Error(`no fake script for ${req.kind}`); });
    },
  };
  return { dir, store, config, events, seen, artifacts, tokens, handle, supervisor, deps, requests, state };
}

export function addTask(store: Store, extra: Partial<Task> = {}): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan',
    brief: 'Scan recent news about Acme', subject: 'Acme', model: { provider: 'claude', model: 'sonnet' },
    needsBrowser: false, acceptanceCriteria: ['at least one dated article'], status: 'queued', round: 1,
    createdAt: new Date().toISOString(), ...extra,
  });
}

/** Worker script: saves one artifact + finding, submits a deliverable. */
export const submitWork =
  (deliverable: Record<string, unknown> = { summary: 'Acme raised prices' }, claim = 'Acme raised prices'): FakeScript =>
  async (t: ToolClient) => {
    const a = (await t.call('save_artifact', { kind: 'text', mime: 'text/plain', content: `evidence for ${claim}` })) as {
      artifactId: string;
    };
    await t.call('save_finding', { claim, subject: 'Acme', evidence: [a.artifactId] });
    await t.call('submit_result', { ...deliverable, evidence: [a.artifactId] });
  };

export const review =
  (score: number, issues: Array<{ class: string; description: string }> = []): FakeScript =>
  async (t) => {
    await t.call('submit_review', { score, issues, summary: `score ${score}` });
  };

/**
 * Revision script: answers every issue in the prompt with `action`, then resubmits. With
 * `keepOutputs` (default) the resubmitted deliverable cites the current outputs listed in the prompt
 * (`keep: [ids]`) so they stay current; `false` withdraws every output not re-saved in the revision.
 */
export const revise =
  (action: 'fix' | 'pushback' = 'fix', deliverable: Record<string, unknown> = { summary: 'revised' }, keepOutputs = true) =>
  (req: AgentRequest): FakeScript =>
  async (t) => {
    for (const m of req.prompt.matchAll(/^- \[(\w+)\]/gm)) {
      await t.call('respond_to_review', { issue_id: m[1], action, reason: `${action} because reasons` });
    }
    const keep = keepOutputs
      ? [...req.prompt.matchAll(/^- (?:finding|recommendation|persona|competitor|hypothesis|flow) (\w+):/gm)].map((m) => m[1])
      : [];
    await t.call('submit_result', keep.length ? { ...deliverable, keep } : deliverable);
  };

/**
 * Review council: what a member script writes for the reviewed task's own finding (an issue's `where`) and
 * for that finding's evidence copy (`evidence`). `withTaskIds` puts the real ids in when the member is
 * started (the work is done by then): a council drops ids that are not outputs of the task or not in its
 * review slice, so an issue on a made-up id is a question.
 */
export const TASK_FINDING = 'the-finding-of-the-task';
export const TASK_COPY = 'the-evidence-copy-of-the-task';

/**
 * `sent` (the input of a `submit_review`) with `TASK_FINDING` and `TASK_COPY` replaced by real ids of
 * `task`. The finding: its first finding, or (a task that re-saved a stored fact has none of its own) the
 * fact it confirms. The copy: that finding's evidence, or else the first artifact its deliverable cites.
 */
export function withTaskIds<T extends { issues?: Array<Record<string, unknown>> }>(store: Store, task: Pick<Task, 'id'> | undefined, sent: T): T {
  const stored = task ? store.tasks.get(task.id) : undefined;
  if (!sent.issues || !stored) return sent;
  const [output] = taskOutputIds({ store }, stored);
  const finding = output === undefined ? undefined : store.findings.get(output);
  const copy = finding?.evidence[0] ?? /\bart_[0-9A-Z]{26}\b/.exec(JSON.stringify(stored.result ?? null))?.[0];
  const real = (id: unknown): unknown => {
    if (id !== TASK_FINDING && id !== TASK_COPY) return id;
    const found = id === TASK_FINDING ? finding?.id : copy;
    if (found === undefined) throw new Error(`task ${stored.id} has no ${id === TASK_FINDING ? 'finding' : 'evidence copy'} to raise an issue about`);
    return found;
  };
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(real) : v);
  return { ...sent, issues: sent.issues.map((i) => ({ ...i, ...('where' in i ? { where: ids(i.where) } : {}), ...('evidence' in i ? { evidence: ids(i.evidence) } : {}) })) };
}

/** Worker script of a task that saves no finding (own-stakeholder research may not): one evidence copy, cited in the deliverable. */
export const submitCopyOnly =
  (summary: string): FakeScript =>
  async (t: ToolClient) => {
    const a = (await t.call('save_artifact', { kind: 'page_snapshot', mime: 'text/plain', source_url: 'https://acme.example/board', content: `evidence for ${summary}` })) as { artifactId: string };
    await t.call('submit_result', { summary, evidence: [a.artifactId] });
  };

/** Runs a worker script (default `submitWork`) as a worker run of `task`, for tests that start at the review step. */
export async function workDone(s: { deps: ResearchDeps }, task: Task, script: FakeScript = submitWork()): Promise<void> {
  const res = await s.deps.supervisor.run({
    ctx: { workspaceId: task.workspaceId, role: 'worker', model: task.model, promptVersion: 'p', taskId: task.id },
    prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: script,
  });
  if (res.status !== 'done') throw new Error(`the fixture's worker run failed: ${res.reason ?? JSON.stringify(res.events.filter((e) => e.t === 'error'))}`);
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * A finished stakeholder research task of `workspaceId` for fixtures that call `save_stakeholder`
 * (only a run of an `own_stakeholders` / `competitor_stakeholders` task may save one): the type that
 * matches `subject` ('own' or a competitor id), one per node and type.
 */
export function fixtureStakeholderTask(store: Store, workspaceId: string, subject: unknown): Task {
  const type = subject === 'own' ? 'own_stakeholders' : 'competitor_stakeholders';
  const brief = 'fixture: saves stakeholders';
  return (
    store.tasks.list({ workspaceId }).find((t) => t.type === type && t.brief === brief) ??
    addTask(store, { workspaceId, phase: 'stakeholders', type, brief, subject: undefined, status: 'verified' })
  );
}
