import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { Supervisor } from '../../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../../src/core/harness/tools/handlers.js';
import { retroToolHandlers } from '../../../src/core/learning/lessons/retro.js';
import type { AgentRequest, ResearchDeps } from '../../../src/core/research/deps.js';
import { learningRepos } from '../../../src/core/learning/store.js';
import { recordPromptVersion } from '../../../src/core/prompts/store.js';
import { workerSystemPrompt, reviewerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { AgentRun, Task, TaskType } from '../../../src/core/types.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';
import type { ReviewIssueRecord } from '../../../src/core/learning/types.js';

/**
 * Two business trees: A (root + child) and B. Timestamps start in the past and increase per call; the
 * mocked system clock follows them (`vi.setSystemTime`), so actions stamped "now" fall in order. Call
 * `vi.useRealTimers()` after each test.
 */
export function lessonsSetup(opened: Store[], configure?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-lessons-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  config.dataDir = dir;
  configure?.(config);
  const a = createWorkspace(store, { name: 'Acme', sector: 'saas' });
  const aChild = createWorkspace(store, { name: 'Acme EU', sector: 'saas', parentWorkspaceId: a.id });
  const b = createWorkspace(store, { name: 'Beta', sector: 'saas' });
  let clock = Date.parse('2025-01-01T00:00:00Z');
  const at = () => {
    clock += 60_000;
    vi.setSystemTime(clock);
    return new Date(clock).toISOString();
  };

  /** A finished worker task whose worker run used the real prompt of its tree (with its lessons). */
  function task(ws: string, opts: { type?: TaskType; status?: Task['status']; role?: 'worker' | 'synthesizer' } = {}) {
    const type = opts.type ?? (opts.role === 'synthesizer' ? 'synthesize_recommendations' : 'news_scan');
    const role = opts.role ?? 'worker';
    const t = store.tasks.insert({
      id: newId('tsk'), workspaceId: ws, runId: 'rrun_x', phase: 'deep_dives', type, brief: 'brief', model: { provider: 'claude', model: 'sonnet' },
      needsBrowser: false, acceptanceCriteria: ['c'], status: opts.status ?? 'verified', round: 1, createdAt: at(),
    });
    const scope = calibrationScope(store, dir, ws);
    const pv = recordPromptVersion(store, role, workerSystemPrompt(config, role, false, type, scope));
    const worker = run(ws, { role, taskId: t.id, promptVersion: pv, taskType: type });
    const rpv = recordPromptVersion(store, 'reviewer', reviewerSystemPrompt(config, scope));
    const reviewer = run(ws, { role: 'reviewer', taskId: t.id, promptVersion: rpv, taskType: type });
    return { task: t, worker, reviewer };
  }

  function run(ws: string, extra: Partial<AgentRun>): AgentRun {
    const startedAt = at();
    return store.agentRuns.insert({
      id: newId('run'), workspaceId: ws, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: newId('tok'), status: 'done',
      startedAt, endedAt: startedAt, ...extra,
    });
  }

  function issue(t: ReturnType<typeof task>, cls: ReviewIssueRecord['class'], text = `issue ${cls}`, evidence: string[] = []): ReviewIssueRecord {
    return learningRepos(store).reviewIssues.insert({
      id: newId('rvi'), workspaceId: t.task.workspaceId, taskId: t.task.id, round: 1, issueId: 'I1', class: cls, text, evidence, status: 'open',
      synthetic: false, reviewerRunId: t.reviewer.id, workerRunId: t.worker.id, ...(t.worker.promptVersion ? { workerPromptVersion: t.worker.promptVersion } : {}),
      createdAt: at(),
    });
  }

  return { dir, store, config, a, aChild, b, at, task, run, issue };
}

/** Supervisor + fake agents over a `lessonsSetup` store (retro tool handler registered). */
export function lessonsHarness(t: ReturnType<typeof lessonsSetup>, pick: (req: AgentRequest) => FakeScript | undefined) {
  const events = new EventBus();
  const artifacts = new ArtifactStore(t.store, t.dir);
  const tokens = new TokenRegistry(t.store);
  const handle = createToolHandlers({ store: t.store, artifacts, config: t.config, events, extraHandlers: retroToolHandlers() });
  const supervisor = new Supervisor({
    store: t.store, config: t.config, tokens, events, handle, dataDir: t.dir, mcpBaseUrl: 'http://127.0.0.1:4317',
    backoff: { baseMs: 5, maxMs: 20, maxAttempts: 2 }, killGraceMs: 100,
  });
  const requests: AgentRequest[] = [];
  const deps: ResearchDeps = {
    store: t.store, config: t.config, supervisor, events, tokens,
    fake: (req) => {
      requests.push(req);
      return pick(req) ?? (async () => { throw new Error(`no fake for ${req.kind}`); });
    },
  };
  return { deps, requests, events, artifacts };
}
