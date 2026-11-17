import { existsSync, mkdirSync } from 'node:fs';
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
import { submitCombinedProfileHandler } from '../core/stakeholders/combine.js';
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
// Desktop app (design 2026-11-16 §4): where things are, the port line, the setup check.
import { openFolder } from '../core/runtime/openFolder.js';
import { appVersion, runtimePaths, type Env, type RuntimePaths } from '../core/runtime/paths.js';
import { portLine } from '../core/runtime/portLine.js';
import { shutdownOnce } from '../core/runtime/shutdown.js';
import { onShutdownRequest, STDIN_SHUTDOWN_ENV } from '../core/runtime/shutdownLine.js';
import { serverSetupCheck, type SetupCheck } from '../core/setup/doctor.js';

/** `scoring` phase: recompute every recommendation's priority with the current weights. */
export const scoringRunner: PhaseRunner = async (workspaceId, deps) => {
  scoreRecommendations(workspaceId, deps);
};

export type BootOptions = {
  /** Config file; default `./bif.config.json` (loaded when it exists, written by `PUT /api/config`). */
  configPath?: string;
  /** Overrides `config.dataDir`. */
  dataDir?: string;
  /** Overrides `config.server.port`; `0` listens on a free port chosen at start (tests, the desktop shell). */
  port?: number;
  /** Built web app; default `paths.resources.webDist` (`<repo>/web/dist` in a checkout). */
  webDist?: string;
  /** Where resources and the person's files are; default `runtimePaths()` (a checkout's answers unless the shell set its variables). */
  paths?: RuntimePaths;
  /**
   * The setup check (which agent CLIs are installed and signed in). Default: none, and no command is
   * run. `'system'`: this machine, with the providers' configured commands (the server entry point
   * passes this). A check object is used as given (tests).
   */
  setup?: SetupCheck | 'system';
  /** Opens a folder in the file manager. Default: none. `'system'`: the platform's file manager (the server entry point passes this). */
  openFolder?: ((dir: string) => void) | 'system';
  /**
   * OCR pass 2 (knowledge store). Default: none — no model is called and no OCR is planned.
   * `'claude-cli'`: the Claude CLI of `providers.claude` with `knowledge.ocr.model` (the server
   * entry point passes this). A reader object is used as given (tests).
   */
  ocrReader?: OcrReader | 'claude-cli';
  /** How long a running agent CLI gets between the polite stop and the forced one. Default: the supervisor's (5 s). Tests shorten it. */
  killGraceMs?: number;
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
      submit_combined_profile: submitCombinedProfileHandler, // stakeholder positions: the combine run of a former colleague
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
    ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
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
  const paths = opts.paths ?? runtimePaths();
  // The check of this machine, kept between requests and judged against the config in use each time it is read.
  const setup = opts.setup === 'system' ? serverSetupCheck(config) : opts.setup;
  const open = opts.openFolder === 'system' ? openFolder : opts.openFolder;
  const app = createApp({
    store,
    artifacts,
    events,
    config,
    research,
    configPath,
    fileValues,
    mcp: { tokens, handle },
    webDist: opts.webDist ?? paths.resources.webDist,
    paths,
    appVersion: appVersion(paths),
    ...(setup ? { setup } : {}),
    ...(open ? { openFolder: open } : {}),
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
  let closing: Promise<void> | undefined;
  // One close: a caller that asks while it runs waits for it (it must not take a close that has only begun for one that is done).
  const close = (): Promise<void> => (closing ??= closeAll());
  const closeAll = async () => {
    scheduler.stop();
    escalations.stop(); // WP-D
    // Running agents first: they are what costs. Each is stopped with what it started and left as a
    // crash would leave it, for `resumeInterrupted` at the next start (see `Supervisor`).
    await runtime.supervisor.stopRuns();
    await recorders.stop(); // WP-D
    const serverClosed = new Promise<void>((r) => server.close(() => r()));
    // Open SSE streams would otherwise keep close() pending forever.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await serverClosed;
    // The shared browser server lives in its own process group: stop it explicitly. (The agents are stopped already.)
    await runtime.supervisor.close();
    await ingestor.stop(); // KS-1: drop the queue, finish running extractions before the store closes
    await ocr?.stop(); // after the ingestor, which may still hand it artifacts
    runtime.store.close();
  };
  return { runtime, server, scheduler, recorders, escalations, close, ...(ocr ? { ocr } : {}) };
}

/**
 * The options the server entry starts with, from the environment and `paths`.
 *
 * - A checkout (`npm start`): nothing is passed, so `./bif.config.json`, the configuration's own
 *   `dataDir` (default `./data`) and its port (default 4317) apply, as always.
 * - The packaged app (`paths.packaged`, the shell set `BIF_APP_DIR`): the configuration and the data
 *   are in the application folder, and the port is a free one chosen at start.
 * - `BIF_CONFIG`, `BIF_DATA_DIR` and `PORT` override either. `PORT=0` asks for a free port.
 */
export function entryOptions(env: Env = process.env, paths: RuntimePaths = runtimePaths({ env })): BootOptions {
  const opts: BootOptions = {};
  if (paths.packaged) {
    opts.configPath = paths.configPath;
    if (paths.dataDir) opts.dataDir = paths.dataDir;
    opts.port = 0;
  }
  if (env.BIF_CONFIG) opts.configPath = env.BIF_CONFIG;
  if (env.BIF_DATA_DIR) opts.dataDir = env.BIF_DATA_DIR;
  // As before, any whole number is taken (one that is no port fails at listen); new: `0` is taken too.
  const port = env.PORT?.trim() ? Number(env.PORT) : undefined;
  if (port !== undefined && Number.isInteger(port)) opts.port = port;
  opts.ocrReader = 'claude-cli'; // the real server reads scans and images with the configured Claude CLI
  opts.setup = 'system'; // and checks this machine's agent CLIs when the setup check is asked for
  opts.openFolder = 'system';
  return opts;
}

/**
 * How long a shutdown may take before the process exits anyway. Longer than the worst case of the
 * steps that stop processes: an agent that ignores the polite stop gets the supervisor's kill grace
 * (5 s) before it is stopped by force, and the research browser its own (3 s). The desktop shell
 * waits a little longer than this before it stops the process tree itself (`desktop/server.ts`).
 */
export const SHUTDOWN_LIMIT_MS = 12_000;

/** What a test of the shutdown may shorten: the kill grace of the agents and the limit of the whole shutdown. */
export type EntryTimings = { killGraceMs?: number; shutdownLimitMs?: number };

/**
 * The server entry: boots with the options of the environment (`entryOptions`), says where it listens
 * and shuts down when asked: on SIGINT or SIGTERM, and, when the desktop shell switched it on, on the
 * shutdown line or the end of the standard input.
 */
export function runEntry(timings: EntryTimings = {}): void {
  const paths = runtimePaths();
  const opts: BootOptions = { ...entryOptions(process.env, paths), paths, ...(timings.killGraceMs !== undefined ? { killGraceMs: timings.killGraceMs } : {}) };
  if (paths.appDir) {
    // The application folder is the working directory of the packaged server: a relative path of the
    // configuration (the research browser's profile, `data/browser-profile`) lands in it, as it lands
    // in the checkout for `npm start`. Nothing is written where the app was started from.
    mkdirSync(paths.appDir, { recursive: true });
    process.chdir(paths.appDir);
  }
  boot(opts)
    .then((b) => {
      const { port, dataDir } = b.runtime;
      // The port was chosen at start: say which in the one line the shell reads (`parsePortLine`).
      if (opts.port === 0) console.log(portLine(port));
      console.log(`[bif] listening on http://127.0.0.1:${port} (data: ${dataDir})`);
      // One shutdown, whatever asks for it and however often (`shutdownOnce`). It stops the running
      // agents and the research browser (`Booted.close`); the work the agents were doing is continued
      // by `resumeInterrupted` at the next start.
      const shutdown = shutdownOnce({
        close: () => b.close(),
        killNow: () => b.runtime.supervisor.killRunsNow(),
        exit: (code) => process.exit(code),
        limitMs: timings.shutdownLimitMs ?? SHUTDOWN_LIMIT_MS,
        say: (line) => console.log(line),
      });
      // The handlers stay for the life of the process: a signal that comes again while the shutdown
      // runs must not get the default action, which would end the process before the agents are stopped.
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      // The desktop shell asks on the standard input (a signal ends a Windows process without this
      // shutdown); the end of the input means the shell is gone. Only when the shell switched it on.
      if (process.env[STDIN_SHUTDOWN_ENV] === '1') onShutdownRequest(process.stdin, () => void shutdown());
    })
    .catch((e) => {
      console.error(`[bif] failed to start: ${(e as Error).message}`);
      process.exit(1);
    });
}

const isEntry = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isEntry) runEntry();
