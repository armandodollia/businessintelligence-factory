import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { loadConfig } from '../core/config/load.js';
import type { BifConfig } from '../core/config/schema.js';
import { EventBus } from '../core/events.js';
import { ArtifactStore } from '../core/evidence/artifacts.js';
import { browserStartupWarnings } from '../core/harness/browser.js';
import { Supervisor } from '../core/harness/supervisor.js';
import { TokenRegistry } from '../core/harness/tokens.js';
import { createToolHandlers, type HandleTool } from '../core/harness/tools/handlers.js';
import { interviewToolHandlers } from '../core/interview/interview.js';
import { personaPanelRunner } from '../core/market/panel.js';
import { marketToolHandlers } from '../core/market/personas.js';
import type { PhaseRunner, ResearchDeps } from '../core/research/deps.js';
import { resumeInterrupted } from '../core/research/orchestrator.js';
import { researchToolHandlers } from '../core/research/tools.js';
import { startScheduler, type SchedulerHandle } from '../core/scheduler/scheduler.js';
import { scoreRecommendations, scoringToolHandlers } from '../core/scoring/priority.js';
import { openStore, type Store } from '../core/store/db.js';
import { createApp } from './routes.js';
// WP-D
import { escalationToolHandlers, startEscalations, type EscalationService } from '../core/escalation/escalation.js';
import { attachEventRecorders, type EventRecorders } from '../core/telemetry/recorders.js';
import { registerFeedbackOutcomes } from '../core/learning/feedbackOutcomes.js';

/** `scoring` phase: recompute every recommendation's priority with the current weights. */
export const scoringRunner: PhaseRunner = async (workspaceId, deps) => {
  scoreRecommendations(workspaceId, deps);
};

export type BootOptions = {
  /** Config file; default `./bif.config.json` (loaded when it exists, written by `PUT /api/config`). */
  configPath?: string;
  /** Overrides `config.dataDir`. */
  dataDir?: string;
  /** Overrides `config.server.port`. */
  port?: number;
  /** Built web app; default `<repo>/web/dist`. */
  webDist?: string;
};

export type Runtime = {
  app: Hono;
  config: BifConfig;
  store: Store;
  events: EventBus;
  tokens: TokenRegistry;
  supervisor: Supervisor;
  handle: HandleTool;
  research: ResearchDeps;
  dataDir: string;
  port: number;
};

/** Builds every runtime dependency and the app (no listening, no resume, no scheduler). */
export function createRuntime(opts: BootOptions = {}): Runtime {
  const configPath = resolve(opts.configPath ?? 'bif.config.json');
  const config = loadConfig(existsSync(configPath) ? configPath : undefined);
  // Env/CLI overrides apply at runtime only; the file keeps its own values (see AppDeps.fileValues).
  const fileValues: { dataDir?: string; port?: number } = {};
  if (opts.dataDir) {
    fileValues.dataDir = config.dataDir;
    config.dataDir = opts.dataDir;
  }
  if (opts.port) {
    fileValues.port = config.server.port;
    config.server.port = opts.port;
  }
  const dataDir = resolve(config.dataDir);
  const port = config.server.port;

  const store = openStore(join(dataDir, 'bif.db'));
  // Learning loop: human actions (feedback events) become decision outcomes through one listener.
  registerFeedbackOutcomes();
  const artifacts = new ArtifactStore(store, dataDir);
  const events = new EventBus();
  const tokens = new TokenRegistry(store);
  const handle = createToolHandlers({
    store,
    artifacts,
    config,
    events,
    extraHandlers: {
      ...researchToolHandlers(),
      ...interviewToolHandlers(),
      ...scoringToolHandlers(),
      ...marketToolHandlers({ dataDir }),
      ...escalationToolHandlers(), // WP-D
    },
  });
  const supervisor = new Supervisor({
    store,
    config,
    tokens,
    events,
    handle,
    dataDir,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
  });
  const research: ResearchDeps = {
    store,
    config,
    supervisor,
    events,
    tokens,
    phaseRunners: { persona_panel: personaPanelRunner, scoring: scoringRunner },
  };
  const app = createApp({
    store,
    artifacts,
    events,
    config,
    research,
    configPath,
    fileValues,
    mcp: { tokens, handle },
    webDist: opts.webDist ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
  });
  return { app, config, store, events, tokens, supervisor, handle, research, dataDir, port };
}

export type Booted = {
  runtime: Runtime;
  server: ServerType;
  scheduler: SchedulerHandle;
  /** WP-D: bus-event / policy-event recorders (and OTLP export when enabled). */
  recorders: EventRecorders;
  /** WP-D: escalation agent on unverified / failed tasks, re-runs on answers. */
  escalations: EscalationService;
  close(): Promise<void>;
};

/**
 * Boots the local server: config → store → harness → app (API + MCP + web) → listen on
 * 127.0.0.1:<port> → `resumeInterrupted` (continues in the background) → scheduler.
 */
export async function boot(opts: BootOptions = {}): Promise<Booted> {
  const runtime = createRuntime(opts);
  for (const w of browserStartupWarnings(runtime.config)) console.warn(`[bif] warning: ${w}`);
  const server = await new Promise<ServerType>((ok, fail) => {
    const s = serve({ fetch: runtime.app.fetch, port: runtime.port, hostname: '127.0.0.1' }, () => ok(s));
    s.once('error', fail);
  });
  // Blocking MCP tools (request_approval) keep requests open for as long as the user takes.
  if ('requestTimeout' in server) server.requestTimeout = 0;
  // WP-D: subscribe before resuming, so events of resumed work are recorded and escalated.
  const recorders = attachEventRecorders({ store: runtime.store, events: runtime.events, config: runtime.config });
  const escalations = startEscalations(runtime.research);
  const report = resumeInterrupted(runtime.research);
  if (report.failedRuns.length || report.requeuedTasks.length || report.continuedRuns.length || report.continuedPipelines.length) {
    console.log(
      `[bif] resumed: ${report.failedRuns.length} interrupted agent runs failed, ${report.requeuedTasks.length} tasks requeued, ` +
        `${report.waitingTasks.length} waiting for the user, ${report.continuedRuns.length} research runs and ` +
        `${report.continuedPipelines.length} pipelines continued`,
    );
  }
  const scheduler = startScheduler(runtime.research);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    scheduler.stop();
    escalations.stop(); // WP-D
    await recorders.stop(); // WP-D
    const closing = new Promise<void>((r) => server.close(() => r()));
    // Open SSE streams would otherwise keep close() pending forever.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    // The shared browser server lives in its own process group: stop it explicitly.
    await runtime.supervisor.close();
    runtime.store.close();
  };
  return { runtime, server, scheduler, recorders, escalations, close };
}

const isEntry = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isEntry) {
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const opts: BootOptions = {};
  if (process.env.BIF_CONFIG) opts.configPath = process.env.BIF_CONFIG;
  if (process.env.BIF_DATA_DIR) opts.dataDir = process.env.BIF_DATA_DIR;
  if (envPort && Number.isInteger(envPort)) opts.port = envPort;
  boot(opts)
    .then((b) => {
      const { port, dataDir } = b.runtime;
      console.log(`[bif] listening on http://127.0.0.1:${port} (data: ${dataDir})`);
      const shutdown = () => {
        console.log('[bif] shutting down');
        // Running CLI process groups are left to resumeInterrupted on the next start.
        b.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((e) => {
      console.error(`[bif] failed to start: ${(e as Error).message}`);
      process.exit(1);
    });
}
