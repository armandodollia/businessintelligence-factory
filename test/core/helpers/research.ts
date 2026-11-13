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

/** Revision script: answers every issue in the prompt with `action`, then resubmits. */
export const revise =
  (action: 'fix' | 'pushback' = 'fix', deliverable: Record<string, unknown> = { summary: 'revised' }) =>
  (req: AgentRequest): FakeScript =>
  async (t) => {
    for (const m of req.prompt.matchAll(/^- \[(\w+)\]/gm)) {
      await t.call('respond_to_review', { issue_id: m[1], action, reason: `${action} because reasons` });
    }
    await t.call('submit_result', deliverable);
  };

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
