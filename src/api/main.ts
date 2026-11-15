import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { configWarnings, loadConfig } from '../core/config/load.js';
import type { BifConfig } from '../core/config/schema.js';
import { EventBus } from '../core/events.js';
import { ArtifactStore } from '../core/evidence/artifacts.js';
import { browserStartupWarnings } from '../core/harness/browser.js';
import { Supervisor, type SupervisorDeps } from '../core/harness/supervisor.js';
import { TokenRegistry } from '../core/harness/tokens.js';
import { createToolHandlers, type HandleTool } from '../core/harness/tools/handlers.js';
import { interviewToolHandlers } from '../core/interview/interview.js';
import { flowRankingRunner, flowRoundToolHandlers } from '../core/flows/round.js';
import { flowToolHandlers } from '../core/flows/tools.js';
import { personaPanelRunner } from '../core/market/panel.js';
import { marketToolHandlers } from '../core/market/personas.js';
import { stakeholderToolHandlers } from '../core/stakeholders/personas.js';
import { submitStakeholderReadHandler } from '../core/stakeholders/reads.js';
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
// Knowledge store KS-0: idempotent backfill after migrations.
import { backfillChanged, backfillKnowledge } from '../core/knowledge/backfill.js';
// Knowledge store KS-1: extraction queue (one per artifact store).
import { ingestorFor } from '../core/knowledge/ingest.js';
import { configuredOcrReader, type OcrReader } from '../core/knowledge/ocr/haiku.js'; // two-pass OCR
import { OcrQueue } from '../core/knowledge/ocr/worker.js';
import { backfillEntityLinks } from '../core/knowledge/entityLinks.js'; // knowledge store KS-3
import { retroToolHandlers } from '../core/learning/lessons/retro.js'; // learning loop WP-E
import { personaLearningToolHandlers } from '../core/personas/learn.js'; // persona learning
import { recordLessonsPromptVersions } from '../core/learning/lessons/switch.js'; // ruling R1
import { recoverExperiments } from '../core/learning/experiments.js'; // learning loop WP-F

/** `scoring` phase: recompute every recommendation's priority with the current weights. */
export const scoringRunner: PhaseRunner = async (workspaceId, deps) => {
  scoreRecommendations(workspaceId, deps);
};

export type BootOptions = {
  /** Config file; default `./bif.config.json` (loaded when it exists, written by `PUT /api/config`). */
  configPath?: string;
  /** Overrides `config.dataDir`. */
  dataDir?: string;
  /** Overrides `config.server.port`; `0` listens on an ephemeral port (tests). */
  port?: number;
  /** Built web app; default `<repo>/web/dist`. */
  webDist?: string;
  /**
   * OCR pass 2 (knowledge store). Default: none — no model is called and no OCR is planned.
   * `'claude-cli'`: the Claude CLI of `providers.claude` with `knowledge.ocr.model` (the server
   * entry point passes this). A reader object is used as given (tests).
   */
  ocrReader?: OcrReader | 'claude-cli';
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
  /** Port to listen on; after `boot` the port actually listened on (resolved when `0` was asked for). */
  port: number;
  /** Points the runtime (MCP URLs given to agents) at the port actually listened on. */
  setListeningPort(port: number): void;
  /** KS-1: the artifact store (its extraction queue is `ingestorFor`). */
  artifacts: ArtifactStore;
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
  // `port: 0` means an ephemeral port and leaves `config.server.port` alone (nothing to persist).
  if (opts.port) {
    fileValues.port = config.server.port;
    config.server.port = opts.port;
  }
  const dataDir = resolve(config.dataDir);
  const port = opts.port === 0 ? 0 : config.server.port;

  const store = openStore(join(dataDir, 'bif.db'));
  // Knowledge store KS-0: complete rows the knowledge store needs (entities, url keys, upload flags,
  // invariant rows). Idempotent; a no-op when nothing is missing.
  const knowledgeBackfill = backfillKnowledge(store);
  if (backfillChanged(knowledgeBackfill)) console.log(`[bif] knowledge store backfill: ${JSON.stringify(knowledgeBackfill)}`);
  // Knowledge store KS-3: hypothesis cause entities and competitor edges for rows saved before KS-3.
  const entityLinks = backfillEntityLinks(store);
  if (entityLinks.hypotheses + entityLinks.competitorEdges > 0) console.log(`[bif] knowledge entity links: ${JSON.stringify(entityLinks)}`);
  // Learning loop: human actions (feedback events) become decision outcomes through one listener.
  registerFeedbackOutcomes();
  const artifacts = new ArtifactStore(store, dataDir);
  // KS-1: bind the extraction queue to this runtime's config (tools and uploads share it).
  ingestorFor({ store, artifacts, config });
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
      ...retroToolHandlers(), // learning loop WP-E
      ...personaLearningToolHandlers(), // persona learning (retro role)
      ...flowRoundToolHandlers(), // flow ranking: persona verdicts
      ...flowToolHandlers(), // flow records: worker tools
      ...stakeholderToolHandlers({ dataDir }), // stakeholder personas: save_stakeholder
      submit_stakeholder_read: submitStakeholderReadHandler, // stakeholder personas: reads in the panel
    },
  });
  const supervisorDeps: SupervisorDeps = {
    store,
    config,
    tokens,
    events,
    handle,
    dataDir,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
  };
  const supervisor = new Supervisor(supervisorDeps);
  const research: ResearchDeps = {
    store,
    config,
    supervisor,
    events,
    tokens,
    phaseRunners: { flow_ranking: flowRankingRunner, persona_panel: personaPanelRunner, scoring: scoringRunner },
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
  const runtime: Runtime = {
    app, config, store, events, tokens, supervisor, handle, research, dataDir, port, artifacts,
    setListeningPort(p) {
      runtime.port = p;
      supervisorDeps.mcpBaseUrl = `http://127.0.0.1:${p}`; // read by the supervisor on every spawn
    },
  };
  return runtime;
}

export type Booted = {
  runtime: Runtime;
  server: ServerType;
  scheduler: SchedulerHandle;
  /** WP-D: bus-event / policy-event recorders (and OTLP export when enabled). */
  recorders: EventRecorders;
  /** WP-D: escalation agent on unverified / failed tasks, re-runs on answers. */
  escalations: EscalationService;
  /** Two-pass OCR: the queue of pass 2, when `BootOptions.ocrReader` gave a reader. */
  ocr?: OcrQueue;
  close(): Promise<void>;
};

/**
 * Boots the local server: config → store → harness → app (API + MCP + web) → listen on
 * 127.0.0.1:<port> → `resumeInterrupted` (continues in the background) → scheduler.
 */
export async function boot(opts: BootOptions = {}): Promise<Booted> {
  const runtime = createRuntime(opts);
  for (const w of browserStartupWarnings(runtime.config)) console.warn(`[bif] warning: ${w}`);
  for (const w of configWarnings(runtime.config)) console.warn(`[bif] warning: ${w}`); // stakeholder personas: offline providers
  const server = await new Promise<ServerType>((ok, fail) => {
    const s = serve({ fetch: runtime.app.fetch, port: runtime.port, hostname: '127.0.0.1' }, () => ok(s));
    s.once('error', fail);
  });
  runtime.setListeningPort((server.address() as AddressInfo).port);
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
  // Ruling R1: the prompt versions under the current lessons switch are in the prompt store.
  recordLessonsPromptVersions(runtime.store, runtime.config);
  // Learning loop WP-F: experiments the last process left running are interrupted (resume failed their arm tasks).
  const interrupted = recoverExperiments(runtime.store);
  if (interrupted.length) console.log(`[bif] ${interrupted.length} experiments were interrupted by the restart`);
  // Pipeline schedules plus the built-in job sources: (WP-F) audit schedules, (WP-E) weekly retros.
  const scheduler = startScheduler(runtime.research);
  // KS-1: artifacts whose text is still `pending` (saved before a restart, or by older code paths)
  // are extracted in the background.
  const ingestor = ingestorFor({ store: runtime.store, artifacts: runtime.artifacts, config: runtime.config });
  // Two-pass OCR: registered before the re-queue below, so artifacts extracted now are planned too.
  // Artifacts left `pending` by the last process are read; PDFs and images ingested while OCR was
  // unavailable are planned in the background.
  const ocrReader = opts.ocrReader === 'claude-cli' ? configuredOcrReader(runtime.config) : opts.ocrReader;
  const ocr = ocrReader ? new OcrQueue({ store: runtime.store, artifacts: runtime.artifacts, config: runtime.config }, ocrReader) : undefined;
  if (ocr) {
    const waiting = ocr.requeuePending();
    if (waiting) console.log(`[bif] knowledge store: ${waiting} artifacts queued for OCR`);
    void ocr.planExisting().then((planned) => {
      if (planned) console.log(`[bif] knowledge store: ${planned} earlier artifacts queued for OCR`);
    });
  }
  const requeued = ingestor.requeuePending();
  if (requeued) console.log(`[bif] knowledge store: ${requeued} artifacts queued for text extraction`);
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
    await ingestor.stop(); // KS-1: drop the queue, finish running extractions before the store closes
    await ocr?.stop(); // after the ingestor, which may still hand it artifacts
    runtime.store.close();
  };
  return { runtime, server, scheduler, recorders, escalations, close, ...(ocr ? { ocr } : {}) };
}

const isEntry = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isEntry) {
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const opts: BootOptions = {};
  if (process.env.BIF_CONFIG) opts.configPath = process.env.BIF_CONFIG;
  if (process.env.BIF_DATA_DIR) opts.dataDir = process.env.BIF_DATA_DIR;
  if (envPort && Number.isInteger(envPort)) opts.port = envPort;
  opts.ocrReader = 'claude-cli'; // the real server reads scans and images with the configured Claude CLI
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
