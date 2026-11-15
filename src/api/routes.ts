import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ConfigError, parseConfig } from '../core/config/load.js';
import { ROLES, type BifConfig } from '../core/config/schema.js';
import type { EventBus } from '../core/events.js';
import { ArtifactFileGoneError, ArtifactNotFoundError, ArtifactTooLargeError, type ArtifactStore } from '../core/evidence/artifacts.js';
import { treeWorkspaceIds } from '../core/evidence/synthesis.js';
import { lastReviewsByTask, withLastReview } from '../core/research/outputs.js';
import { isPipelineLocked } from '../core/research/lock.js';
import { uploadInternal } from '../core/internal/uploads.js';
import { interviewCoverage, sendInterviewMessage, type InterviewerFake } from '../core/interview/interview.js';
import { competitorCriteria } from '../core/market/competitors.js';
import type { ResearchDeps } from '../core/research/deps.js';
import { currentResearchRun, runPipeline } from '../core/research/orchestrator.js';
import { ALL_PHASES } from '../core/research/phases.js';
import { validateCron } from '../core/scheduler/scheduler.js';
import { calibrationReport, proposePromptPatch, proposeWeights } from '../core/scoring/calibration.js';
import { RECOMMENDATION_KEYS } from '../core/scoring/criteria.js';
import { exportTrainingDataWithSummary } from '../core/scoring/export.js';
import { scoreRecommendations } from '../core/scoring/priority.js';
import { isHidden, segmentPersonas } from '../core/stakeholders/personas.js';
import { withholding } from '../core/stakeholders/withheld.js';
import { RatingError, rateCriterion } from '../core/scoring/ratings.js';
import { reviewQueue } from '../core/scoring/reviewQueue.js';
import { decisionReviewQueue } from '../core/scoring/decisionQueue.js';
import type { Store } from '../core/store/db.js';
import { newId } from '../core/store/repos.js';
import { recordSystemDecision } from '../core/systemDecision.js';
import type { Decision, Phase, Rating, Schedule, UserRequest, Workspace } from '../core/types.js';
import { crossCuttingSymptoms, rollup } from '../core/workspace/businessMap.js';
import { createWorkspace, workspaceTree } from '../core/workspace/tree.js';
import { mountMcp, type McpDeps } from './mcp.js';
// Learning loop WP-A: feedback provenance on every human route.
import {
  FeedbackActionError,
  answerUserRequest,
  applyPromptPatchAsUser,
  decideUnitProposal,
  recordUserAction, // re-gate (Opus 4)
  recordWeightsChange,
  setIncludeOverride,
} from '../core/feedback/actions.js';
import { actorOf } from '../core/feedback/events.js';
import { mountFeedbackRoutes } from './feedbackRoutes.js';
import { mountOutcomeRoutes } from './learningRoutes.js';
import { sseResponse } from './sse.js';
import { mountUsageRoutes } from './usageRoutes.js';
import { mountOversightRoutes } from './oversightRoutes.js'; // WP-D
import { mountKnowledgeMetricsRoutes } from './knowledgeMetricsRoutes.js'; // knowledge store KS-6
import { mountKnowledgeRoutes } from './knowledgeRoutes.js'; // knowledge store KS-7
import { mountLessonsRoutes } from './lessonsRoutes.js'; // learning loop WP-E
import { recordLessonsPromptVersions } from '../core/learning/lessons/switch.js'; // ruling R1
import { mountWpfRoutes } from './experimentRoutes.js'; // learning loop WP-F
import { mountMetricsRoutes } from './metricsRoutes.js'; // learning loop WP-G
import { mountFlowRoutes } from './flowRoutes.js'; // flow records and ranking
import { mountPersonaLearningRoutes } from './personaLearningRoutes.js'; // persona learning
import { mountStakeholderRoutes } from './stakeholderRoutes.js'; // stakeholder personas
import { mountUserPersonaRoutes } from './userPersonaRoutes.js'; // user persona

export type AppDeps = {
  store: Store;
  artifacts: ArtifactStore;
  events: EventBus;
  /** Shared, mutable config object: `PUT /api/config` updates it in place. */
  config: BifConfig;
  /** Deps for `runPipeline` (also supplies the supervisor for interview runs). */
  research: ResearchDeps;
  /** Where `PUT /api/config` and `PUT .../scoring-weights` persist the config; not persisted when absent. */
  configPath?: string;
  /** In-process interviewer (tests / dry runs). */
  interviewFake?: InterviewerFake;
  /** Mounts the harness MCP server at `/mcp/:token` (and bearer-token `/mcp`) when given. */
  mcp?: McpDeps;
  /** Built web app (`web/dist`); served at `/` when the directory exists. */
  webDist?: string;
  /** SSE keep-alive interval (default 15 s). */
  sseHeartbeatMs?: number;
  /**
   * Config-file values of fields overridden at boot (`BIF_DATA_DIR`, `PORT`). Persisting writes
   * these back instead of the runtime override, unless the user changed the field since boot.
   */
  fileValues?: { dataDir?: string; port?: number };
};

/** Error with an HTTP status, rendered as `{ error, ...extra }`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 500 | 502,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const PHASES = ['mapping', ...ALL_PHASES] as const satisfies readonly Phase[];
const phaseSchema = z.enum(PHASES);
const scopeLevel = z.enum(['company', 'division', 'slice']);
const audience = z.enum(['external', 'internal']);
const targetType = z.enum(['finding', 'recommendation', 'symptom', 'competitor', 'persona', 'persona_feedback', 'decision']);
const DECISION_KINDS = ['decision', 'review', 'pushback', 'task_proposal', 'persona_feedback', 'score', 'flow_verdicts'] as const;
const REQUEST_STATUSES = ['pending', 'resolved', 'denied'] as const;

const schemas = {
  createWorkspace: z.object({
    name: z.string().trim().min(1),
    sector: z.string().trim().min(1),
    scope: z.object({ level: scopeLevel.optional(), name: z.string().optional(), description: z.string().optional() }).optional(),
    audiences: z.array(audience).min(1, 'select at least one audience').optional(),
    parentWorkspaceId: z.string().min(1).optional(),
  }),
  interview: z.object({ text: z.string().refine((s) => s.trim().length > 0, 'text must not be empty') }),
  research: z.object({ phases: z.array(phaseSchema).min(1).optional() }),
  resolveRequest: z.object({ status: z.enum(['resolved', 'denied']), response: z.string().optional() }),
  rating: z.object({
    workspaceId: z.string().min(1),
    targetType,
    targetId: z.string().min(1),
    criterion: z.string().min(1),
    verdict: z.enum(['agree', 'disagree']),
    userValue: z.union([z.number(), z.string()]).optional(),
    reason: z.string().optional(),
  }),
  unitProposal: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('accept'),
      reason: z.string().optional(),
      edits: z
        .object({ name: z.string().min(1).optional(), description: z.string().optional(), level: scopeLevel.optional(), audiences: z.array(audience).min(1).optional() })
        .optional(),
    }),
    z.object({ action: z.literal('reject'), reason: z.string().optional() }),
  ]),
  newSchedule: z.object({
    name: z.string().trim().min(1),
    cron: z.string().trim().min(1),
    phases: z.array(phaseSchema).min(1),
    enabled: z.boolean().optional(),
  }),
  patchSchedule: z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1).optional(),
    cron: z.string().trim().min(1).optional(),
    phases: z.array(phaseSchema).min(1).optional(),
    enabled: z.boolean().optional(),
  }),
  promptPatchRole: z.object({ role: z.enum(ROLES) }),
  applyPromptPatch: z.object({
    role: z.enum(ROLES),
    patchText: z.string(),
    examples: z.array(z.unknown()).optional(),
  }),
  /** `null` clears the override (back to the default: verified only). Findings, recommendations, personas. */
  includeFinding: z.object({ include: z.boolean().nullable() }),
  scoringWeights: z.object({
    weights: z.partialRecord(z.enum(RECOMMENDATION_KEYS), z.number().min(0)).optional(),
    personaWeight: z.number().min(0).optional(),
  }),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    throw new HttpError(400, issues.map((i) => `${i.path || '<body>'}: ${i.message}`).join('; '), { issues });
  }
  return r.data;
}

/** Copies every top-level key of `next` onto the shared config object (in place). */
function replaceConfig(target: BifConfig, next: BifConfig): void {
  for (const key of Object.keys(next) as (keyof BifConfig)[]) {
    (target as Record<keyof BifConfig, unknown>)[key] = next[key];
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for `127.0.0.1`, `localhost` or `[::1]`, with or without a port. */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  return !!m && LOCAL_HOSTNAMES.has(m[1]!);
}

/** True when `origin` is an http(s) origin on a local host (any port; covers the Vite dev server). */
export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.host);
  } catch {
    return false;
  }
}

/**
 * Artifact mime types a browser would render as an active document (scripts, same-origin access):
 * served as downloads. Everything else is still sandboxed by CSP.
 */
const ACTIVE_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|multipart\/related|text\/xml|application\/xml)\b/i;

/** Exactly `application/pdf` (parameters allowed), so no other type borrows the PDF exemption. */
const isPdfMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase() === 'application/pdf';

/**
 * Builds the HTTP app (JSON API, SSE, optional MCP and static web). Separate from `listen` so tests
 * use `app.request`. Errors render as `{ error }` with 400 (validation, RatingError), 404 (unknown
 * id), 409 (state conflict), 413 (artifact > 50 MB) or 500.
 */
export function createApp(deps: AppDeps): Hono {
  const { store, artifacts, events, config, research } = deps;
  const app = new Hono();

  // Local-only guard (DNS rebinding / cross-site requests). Every request must address a local
  // host; state-changing requests must be JSON (or multipart for uploads) and, when a browser
  // sends an Origin, come from a local origin. MCP clients (agent CLIs) send JSON and no Origin.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!isLocalHost(host)) return c.json({ error: 'forbidden host' }, 403);
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (origin !== undefined && !isLocalOrigin(origin)) return c.json({ error: 'forbidden origin' }, 403);
    const path = c.req.path;
    if ((path === '/mcp' || path.startsWith('/mcp/')) && method === 'DELETE') return next(); // MCP session close has no body
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    const isJson = type.startsWith('application/json');
    const isUpload = /^\/api\/workspaces\/[^/]+\/uploads$/.test(path) && type.startsWith('multipart/form-data');
    if (!isJson && !isUpload) return c.json({ error: 'content-type must be application/json' }, 415);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status);
    if (err instanceof RatingError) return c.json({ error: err.message }, 400);
    if (err instanceof FeedbackActionError) return c.json({ error: err.message }, err.status);
    if (err instanceof ConfigError) return c.json({ error: err.message, issues: err.issues }, 400);
    if (err instanceof ArtifactNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ArtifactTooLargeError) return c.json({ error: err.message }, 413);
    if (err instanceof ArtifactFileGoneError) return c.json({ error: err.message }, 410); // knowledge store KS-7: pruned file
    console.error(`[bif] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: (err as Error).message ?? String(err) }, 500);
  });

  const workspace = (id: string): Workspace => {
    const ws = store.workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace '${id}' not found`);
    return ws;
  };

  const bootDataDir = config.dataDir;
  const bootPort = config.server.port;
  /** Writes the config file, keeping boot-time env overrides out of it. */
  const persistConfig = () => {
    if (!deps.configPath) return;
    const out = structuredClone(config);
    const file = deps.fileValues ?? {};
    if (file.dataDir !== undefined && out.dataDir === bootDataDir) out.dataDir = file.dataDir;
    if (file.port !== undefined && out.server.port === bootPort) out.server.port = file.port;
    writeFileSync(deps.configPath, `${JSON.stringify(out, null, 2)}\n`);
  };

  /**
   * After `config.scoring` changed from `before`: rescores every workspace and logs a
   * `set_scoring_weights` Decision in `logIn` (the workspaces whose log should show it).
   */
  const scoringChanged = (before: BifConfig['scoring'], logIn: string[], source: string): Decision[] => {
    const after = structuredClone(config.scoring);
    for (const ws of store.workspaces.list()) scoreRecommendations(ws.id, { store, config });
    return logIn.map((workspaceId) => {
      const decision = recordSystemDecision({ store, events }, { workspaceId, actor: 'user', actorId: actorOf(config), payload: { tool: 'set_scoring_weights', source, before, after } });
      recordWeightsChange(store, workspaceId, before, after, { actor: actorOf(config), source, decisionId: decision.id }); // WP-A
      return decision;
    });
  };

  // --- workspaces & business map ------------------------------------------------------------
  app.get('/api/workspaces', (c) => c.json(store.workspaces.list()));
  app.post('/api/workspaces', async (c) => {
    const input = await body(c, schemas.createWorkspace);
    if (input.parentWorkspaceId && !store.workspaces.get(input.parentWorkspaceId)) {
      throw new HttpError(400, `parent workspace '${input.parentWorkspaceId}' not found`);
    }
    const ws = createWorkspace(store, input as Parameters<typeof createWorkspace>[1]);
    recordUserAction(store, { workspaceId: ws.id, action: 'create_workspace', targetType: 'workspace', targetId: ws.id }, { actor: actorOf(config) }); // re-gate (Opus 4)
    return c.json(ws, 201);
  });
  app.get('/api/workspaces/:id', (c) => c.json(workspace(c.req.param('id'))));
  app.get('/api/workspaces/:id/profile', (c) => {
    const ws = workspace(c.req.param('id'));
    return c.json(store.profiles.get(ws.id) ?? { workspaceId: ws.id, data: {} });
  });
  app.get('/api/workspaces/:id/tree', (c) => c.json(workspaceTree(store, workspace(c.req.param('id')).id)));
  app.get('/api/workspaces/:id/rollup', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json({ ...rollup(store, id), crossCutting: crossCuttingSymptoms(store, id) });
  });
  app.get('/api/workspaces/:id/unit-proposals', (c) =>
    c.json(store.unitProposals.list({ workspaceId: workspace(c.req.param('id')).id })),
  );
  app.post('/api/unit-proposals/:id', async (c) => {
    const id = c.req.param('id');
    const input = await body(c, schemas.unitProposal);
    const proposal = store.unitProposals.get(id);
    if (!proposal) throw new HttpError(404, `unit proposal '${id}' not found`);
    if (proposal.status !== 'proposed') throw new HttpError(409, `unit proposal '${id}' is already ${proposal.status}`);
    // WP-A: decidedAt / actor / reason, the original proposal on accept-with-edit, a calibration
    // signal and a feedback event (decideUnitProposal wraps acceptUnitProposal / rejectUnitProposal).
    const out = decideUnitProposal(store, id, input as Parameters<typeof decideUnitProposal>[2], { actor: actorOf(config) });
    if (input.action === 'accept') return c.json({ proposal: out.proposal, workspace: out.workspace, feedbackEventId: out.feedback.id });
    return c.json({ proposal: out.proposal, rating: out.rating, feedbackEventId: out.feedback.id });
  });

  // --- interview & uploads -------------------------------------------------------------------
  const interviewState = (id: string) => ({
    turns: store.interview.list({ workspaceId: id }),
    coverage: interviewCoverage(id, { store }),
  });
  app.get('/api/workspaces/:id/interview', (c) => c.json(interviewState(workspace(c.req.param('id')).id)));
  /** Workspaces with an interview turn in flight: one turn at a time per workspace (409 otherwise). */
  const interviewBusy = new Set<string>();
  app.post('/api/workspaces/:id/interview', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const { text } = await body(c, schemas.interview);
    // Checked and taken synchronously (no await in between), so concurrent requests cannot both pass.
    if (interviewBusy.has(id)) {
      throw new HttpError(409, 'an interview turn is already in progress for this workspace; wait for the reply', interviewState(id));
    }
    interviewBusy.add(id);
    let turn;
    try {
      turn = await sendInterviewMessage(id, text, {
        store,
        config,
        supervisor: research.supervisor,
        ...(deps.interviewFake ? { fake: deps.interviewFake } : {}),
      });
    } catch (e) {
      throw new HttpError(502, (e as Error).message, interviewState(id));
    } finally {
      interviewBusy.delete(id);
    }
    // Re-gate (Opus 4): who sent the message (the user's turn is the one before the agent's reply).
    const userTurn = store.interview.list({ workspaceId: id }).filter((x) => x.role === 'user').at(-1);
    recordUserAction(store, { workspaceId: id, action: 'interview_message', targetType: 'workspace', targetId: id, after: { ...(userTurn ? { turnId: userTurn.id } : {}), replyTurnId: turn.id } }, { actor: actorOf(config) });
    return c.json({ turn, ...interviewState(id) });
  });
  app.post('/api/workspaces/:id/uploads', async (c) => {
    const id = workspace(c.req.param('id')).id;
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new HttpError(400, 'expected a multipart/form-data body');
    }
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "multipart field 'file' is required");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const up = uploadInternal(id, { name: file.name, bytes, mime: file.type }, { store, artifacts });
    recordUserAction(store, { workspaceId: id, action: 'upload', targetType: 'artifact', targetId: up.id }, { actor: actorOf(config) }); // re-gate (Opus 4)
    return c.json(up, 201);
  });

  // --- research -------------------------------------------------------------------------------
  app.post('/api/workspaces/:id/research', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const { phases } = await body(c, schemas.research);
    const running = currentResearchRun(store, id);
    if (running) throw new HttpError(409, `a research run is already running (${running.id}, ${running.phase})`, { run: running });
    // Shared with the scheduler: covers the gaps between phases of a pipeline already in progress.
    if (isPipelineLocked(store, id)) throw new HttpError(409, 'a research pipeline is already running for this workspace');
    // runPipeline takes the lock and inserts the first ResearchRun synchronously, then continues in the background.
    runPipeline(id, phases ?? ALL_PHASES, research).catch((e) =>
      console.error(`[bif] research pipeline for ${id} failed: ${(e as Error).message}`),
    );
    const started = currentResearchRun(store, id);
    recordUserAction(store, {
      workspaceId: id, action: 'research_start', targetType: 'workspace', targetId: id,
      after: { phases: phases ?? ALL_PHASES, ...(started ? { researchRunId: started.id } : {}) },
    }, { actor: actorOf(config) }); // re-gate (Opus 4)
    return c.json(started ?? null, 202);
  });
  app.get('/api/workspaces/:id/runs', (c) => c.json(store.researchRuns.list({ workspaceId: workspace(c.req.param('id')).id })));
  app.get('/api/workspaces/:id/tasks', (c) => {
    const id = workspace(c.req.param('id')).id;
    const runId = c.req.query('runId');
    const w = withholding(store); // stakeholder design §7: own-stakeholder research of a node with a hidden stakeholder
    return c.json(store.tasks.list(runId ? { workspaceId: id, runId } : { workspaceId: id }).map((t) => w.servedTask(t)));
  });

  // --- results --------------------------------------------------------------------------------
  /**
   * Findings plus `lastReview` (spec §7.2): the latest effective reviewer verdict on the finding's
   * task (`score`, `issues`, `decisionId`, `at`, `synthetic`), so unverified findings can show the
   * objections. Reviews from reviewer runs that did not finish are ignored; synthetic reviews count.
   * `?scope=tree`: findings of every node of the business tree, tagged with `sourceWorkspaceId`
   * (recommendations may cite same-tree findings; Strategy resolves them).
   */
  app.get('/api/workspaces/:id/findings', (c) => {
    const id = workspace(c.req.param('id')).id;
    const ids = c.req.query('scope') === 'tree' ? treeWorkspaceIds(store, id) : [id];
    const reviews = lastReviewsByTask(store, ids);
    const findings = ids.flatMap((wsId) => store.findings.list({ workspaceId: wsId }).map((f) => ({ ...f, sourceWorkspaceId: wsId })));
    return c.json(withLastReview(findings, reviews));
  });
  // User override (spec §7.2): include an unverified finding in synthesis, or exclude a verified one.
  app.post('/api/findings/:id/include', async (c) => {
    const id = c.req.param('id');
    const { include } = await body(c, schemas.includeFinding);
    if (!store.findings.get(id)) throw new HttpError(404, `finding '${id}' not found`);
    return c.json(setIncludeOverride(store, 'finding', id, include, { actor: actorOf(config) })); // WP-A
  });
  // User override for the persona panel / Strategy: include an unverified (or failed) recommendation
  // or persona, or exclude a verified one. `null` resets to the default (verified only).
  app.post('/api/recommendations/:id/include', async (c) => {
    const id = c.req.param('id');
    const { include } = await body(c, schemas.includeFinding);
    if (!store.recommendations.get(id)) throw new HttpError(404, `recommendation '${id}' not found`);
    return c.json(setIncludeOverride(store, 'recommendation', id, include, { actor: actorOf(config) })); // WP-A
  });
  app.post('/api/personas/:id/include', async (c) => {
    const id = c.req.param('id');
    const { include } = await body(c, schemas.includeFinding);
    const persona = store.personas.get(id);
    // A hidden stakeholder answers like an unknown id (stakeholder design §7): the response is the whole record.
    // So does a user persona (user persona design §5): it is never included in or excluded from anything.
    if (!persona || isHidden(persona) || persona.kind === 'user') throw new HttpError(404, `persona '${id}' not found`);
    return c.json(setIncludeOverride(store, 'persona', id, include, { actor: actorOf(config) })); // WP-A
  });
  app.get('/api/workspaces/:id/symptoms', (c) => c.json(store.symptoms.list({ workspaceId: workspace(c.req.param('id')).id })));
  /** Rated competitors (spec §9), each with its ratable `criteria` (threat, directness, comparison areas). */
  app.get('/api/workspaces/:id/competitors', (c) => {
    // All statuses with `lastReview`: the web app lists usable ones and offers the include toggle.
    const id = workspace(c.req.param('id')).id;
    const list = store.competitors.list({ workspaceId: id }).map((x) => ({ ...x, criteria: competitorCriteria(x) }));
    return c.json(withLastReview(list, lastReviewsByTask(store, [id])));
  });
  app.post('/api/competitors/:id/include', async (c) => {
    const id = c.req.param('id');
    const { include } = await body(c, schemas.includeFinding);
    if (!store.competitors.get(id)) throw new HttpError(404, `competitor '${id}' not found`);
    return c.json(setIncludeOverride(store, 'competitor', id, include, { actor: actorOf(config) })); // WP-A
  });
  /** Research hypotheses per interview symptom (spec §8 drill-down). */
  app.get('/api/workspaces/:id/hypotheses', (c) => c.json(store.symptomHypotheses.list({ workspaceId: workspace(c.req.param('id')).id })));
  /** Segment personas with review `status` and `lastReview` of the task that last saved them (stakeholders have their own routes). */
  app.get('/api/workspaces/:id/personas', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json(withLastReview(segmentPersonas(store, id), lastReviewsByTask(store, [id])));
  });
  /**
   * Recommendations by priority, with review `status` and `lastReview` of the task that saved them
   * (all statuses: the web app hides superseded and failed ones and flags unverified ones).
   */
  app.get('/api/workspaces/:id/recommendations', (c) => {
    const id = workspace(c.req.param('id')).id;
    const recs = store.recommendations.list({ workspaceId: id }).sort((a, b) => b.priority - a.priority);
    return c.json(withLastReview(recs, lastReviewsByTask(store, [id])));
  });
  app.get('/api/workspaces/:id/decisions', (c) => {
    const id = workspace(c.req.param('id')).id;
    const kind = c.req.query('kind');
    if (kind && !(DECISION_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `unknown decision kind '${kind}'`);
    const w = withholding(store);
    return c.json(store.decisions.list(kind ? { workspaceId: id, kind: kind as Decision['kind'] } : { workspaceId: id }).map((d) => w.servedDecision(d)));
  });
  /** "What changed" Decisions recorded by the scheduler after each recurring run. */
  app.get('/api/workspaces/:id/changes', (c) => {
    const id = workspace(c.req.param('id')).id;
    const w = withholding(store);
    return c.json(
      store.decisions
        .list({ workspaceId: id, agentRunId: 'scheduler' })
        .filter((d) => (d.payload as { event?: string } | null)?.event === 'what_changed')
        .map((d) => w.servedDecision(d)),
    );
  });

  // --- user requests --------------------------------------------------------------------------
  app.get('/api/workspaces/:id/requests', (c) => {
    const id = workspace(c.req.param('id')).id;
    const status = c.req.query('status');
    if (status && !(REQUEST_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `unknown status '${status}'`);
    const w = withholding(store); // stakeholder design §7: requests of withheld research lose their text
    return c.json(store.userRequests.list(status ? { workspaceId: id, status: status as UserRequest['status'] } : { workspaceId: id }).map((r) => w.servedRequest(r)));
  });
  app.post('/api/requests/:id', async (c) => {
    const id = c.req.param('id');
    const input = await body(c, schemas.resolveRequest);
    const req = store.userRequests.get(id);
    if (!req) throw new HttpError(404, `user request '${id}' not found`);
    if (req.status !== 'pending') throw new HttpError(409, `user request '${id}' is already ${req.status}`);
    return c.json(withholding(store).servedRequest(answerUserRequest({ store, events }, id, input.status, input.response, { actor: actorOf(config) }))); // WP-A
  });

  // --- artifacts ------------------------------------------------------------------------------
  app.get('/api/artifacts/:id', (c) => {
    const { artifact, bytes } = artifacts.read(c.req.param('id'));
    // Artifacts come from third-party sites and uploads: never let them run as our origin.
    const headers: Record<string, string> = {
      'content-type': artifact.mime,
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    };
    const active = ACTIVE_MIME.test(artifact.mime);
    const name = artifact.title ?? `${artifact.id}`;
    if (active) {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    } else if (isPdfMime(artifact.mime)) {
      // The browser's PDF viewer will not render a sandboxed document, and a PDF runs no page
      // script as our origin: filings open inline, nosniff kept.
      delete headers['content-security-policy'];
      headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
    } else if (artifact.kind === 'upload' && artifact.title) {
      headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(artifact.title)}`;
    }
    return c.body(new Uint8Array(bytes), 200, headers);
  });
  app.get('/api/artifacts/:id/meta', (c) => {
    const id = c.req.param('id');
    const a = store.artifacts.get(id);
    if (!a) throw new HttpError(404, `artifact '${id}' not found`);
    return c.json(a);
  });

  // --- ratings, review queue, calibration, export --------------------------------------------
  app.post('/api/ratings', async (c) => {
    const input = await body(c, schemas.rating);
    workspace(input.workspaceId);
    return c.json(rateCriterion({ ...(input as Parameters<typeof rateCriterion>[0]), actor: actorOf(config) }, { store }), 201); // WP-A: actor from config
  });
  /**
   * The user's current rating per (targetType, targetId, criterion): ratings are append-only
   * history (every change is a new row, all kept for calibration/export); the latest one wins here.
   */
  app.get('/api/workspaces/:id/ratings', (c) => {
    const id = workspace(c.req.param('id')).id;
    const latest = new Map<string, Rating>();
    for (const r of store.ratings.list({ workspaceId: id })) {
      const key = `${r.targetType}\u0000${r.targetId}\u0000${r.criterion}`;
      const prev = latest.get(key);
      if (!prev || prev.createdAt <= r.createdAt) latest.set(key, r);
    }
    return c.json([...latest.values()]);
  });
  app.get('/api/workspaces/:id/review-queue', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json([...reviewQueue(id, { store }), ...decisionReviewQueue(id, { store })]);
  });
  app.get('/api/workspaces/:id/calibration', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json({
      ...calibrationReport(id, { store }),
      weights: config.scoring.weights,
      personaWeight: config.scoring.personaWeight,
      proposedWeights: proposeWeights(id, { store, config }),
    });
  });
  /** Proposes a prompt calibration patch for a role (nothing is written). */
  app.post('/api/workspaces/:id/calibration/prompt-patch', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const { role } = await body(c, schemas.promptPatchRole);
    return c.json(proposePromptPatch(id, role, { store }));
  });
  /**
   * User approval: merges the (possibly edited) patch into the role's prompt appendix of this
   * workspace's business tree (`<dataDir>/<root>/calibration/<role>.md`; other businesses unaffected).
   */
  app.post('/api/workspaces/:id/calibration/prompt-patch/apply', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const patch = await body(c, schemas.applyPromptPatch);
    // Learning loop WP-A + WP-B: one path — calibration version (history, revertable), a Decision by
    // the real actor at the patched role's new prompt version, and a prompt_patch_apply feedback event.
    const applied = applyPromptPatchAsUser(
      { store, events, config },
      id,
      { role: patch.role, patchText: patch.patchText, examples: (patch.examples ?? []) as never },
      { actor: actorOf(config) },
    );
    return c.json({
      path: applied.path,
      decisionId: applied.decisionId,
      versionId: applied.versionId,
      promptVersion: applied.promptVersion,
      previousPromptVersion: applied.previousPromptVersion,
    });
  });
  app.get('/api/workspaces/:id/scoring-weights', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json({ ...config.scoring, proposedWeights: proposeWeights(id, { store, config }) });
  });
  /** Sets priority weights (global), rescores every workspace and logs the change as a Decision. */
  app.put('/api/workspaces/:id/scoring-weights', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const input = await body(c, schemas.scoringWeights);
    const before = structuredClone(config.scoring);
    const after = {
      weights: (input.weights as Record<string, number> | undefined) ?? before.weights,
      personaWeight: input.personaWeight ?? before.personaWeight,
    };
    config.scoring = after;
    persistConfig();
    const [decision] = scoringChanged(before, [id], 'scoring-weights');
    return c.json({ ...config.scoring, decisionId: decision!.id });
  });
  app.get('/api/workspaces/:id/export', (c) => {
    const id = workspace(c.req.param('id')).id;
    const { jsonl, summary } = exportTrainingDataWithSummary(id, { store }, c.req.query('includeUploads') === '1');
    return c.body(jsonl, 200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="bif-${id}-export.jsonl"`,
      // Design §12 ruling: what the default exclusion left out, by cause (URI-encoded JSON).
      'x-bif-export-summary': encodeURIComponent(JSON.stringify(summary)),
    });
  });
  /** The export's summary alone (the web export UI shows it next to the download link). */
  app.get('/api/workspaces/:id/export/summary', (c) => {
    const id = workspace(c.req.param('id')).id;
    return c.json(exportTrainingDataWithSummary(id, { store }, c.req.query('includeUploads') === '1').summary);
  });

  // --- schedules ------------------------------------------------------------------------------
  const checkCron = (cron: string) => {
    try {
      validateCron(cron);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  };
  app.get('/api/workspaces/:id/schedules', (c) => c.json(store.schedules.list({ workspaceId: workspace(c.req.param('id')).id })));
  app.post('/api/workspaces/:id/schedules', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const input = await body(c, schemas.newSchedule);
    checkCron(input.cron);
    const s: Schedule = { id: newId('sch'), workspaceId: id, name: input.name, cron: input.cron, phases: input.phases, enabled: input.enabled ?? true, activatedAt: new Date().toISOString() };
    const saved = store.schedules.insert(s);
    recordUserAction(store, { workspaceId: id, action: 'schedule_create', targetType: 'schedule', targetId: saved.id, after: { cron: saved.cron, phases: saved.phases, enabled: saved.enabled } }, { actor: actorOf(config) }); // re-gate (Opus 4)
    return c.json(saved, 201);
  });
  app.patch('/api/workspaces/:id/schedules', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const { id: scheduleId, ...patch } = await body(c, schemas.patchSchedule);
    const s = store.schedules.get(scheduleId);
    if (!s || s.workspaceId !== id) throw new HttpError(404, `schedule '${scheduleId}' not found in workspace '${id}'`);
    if (patch.cron) checkCron(patch.cron);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Schedule>;
    // Re-enabling resets the baseline: occurrences missed while disabled are not run.
    if (clean.enabled === true && !s.enabled) clean.activatedAt = new Date().toISOString();
    const updated = store.schedules.update(scheduleId, clean);
    recordUserAction(store, {
      workspaceId: id, action: 'schedule_update', targetType: 'schedule', targetId: scheduleId,
      after: { before: { cron: s.cron, phases: s.phases, enabled: s.enabled }, cron: updated.cron, phases: updated.phases, enabled: updated.enabled },
    }, { actor: actorOf(config) }); // re-gate (Opus 4)
    return c.json(updated);
  });

  // --- config ---------------------------------------------------------------------------------
  app.get('/api/config', (c) => c.json(config));
  /**
   * Replaces the config (validated). Applied in place, so new runs use it; limits that size the
   * supervisor's semaphores (`maxParallelWorkers`, `maxBrowserRuns`) and `server.port` need a restart.
   */
  app.put('/api/config', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, 'request body must be JSON');
    }
    const next = parseConfig(raw, 'PUT /api/config');
    const before = structuredClone(config.scoring);
    const lessonsWereOn = config.lessons?.enabled !== false; // ruling R1
    const keysBefore = JSON.stringify(config);
    const changed = Object.keys({ ...(JSON.parse(keysBefore) as object), ...(next as object) }).filter(
      (k) => JSON.stringify((JSON.parse(keysBefore) as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k]),
    );
    replaceConfig(config, next);
    persistConfig();
    // Re-gate (Opus 4): who changed the config (global: one event per business tree; key names only).
    for (const root of store.workspaces.list().filter((w) => !w.parentWorkspaceId)) {
      recordUserAction(store, { workspaceId: root.id, action: 'config_change', targetType: 'config', targetId: 'config', after: { changedKeys: changed } }, { actor: actorOf(config) });
    }
    // Ruling R1: the lessons kill switch changes role prompt versions; record them in the prompt store.
    if (lessonsWereOn !== (config.lessons?.enabled !== false)) recordLessonsPromptVersions(store, config);
    // Weights are global: a change made here rescores and is logged in every workspace, exactly
    // like `PUT .../scoring-weights`.
    if (JSON.stringify(before) !== JSON.stringify(config.scoring)) {
      scoringChanged(before, store.workspaces.list().map((w) => w.id), 'config');
    }
    return c.json(config);
  });

  // --- events ---------------------------------------------------------------------------------
  app.get('/api/events', (c) => {
    const workspaceId = c.req.query('workspaceId');
    return sseResponse(events, {
      ...(workspaceId ? { workspaceId } : {}),
      ...(deps.sseHeartbeatMs ? { heartbeatMs: deps.sseHeartbeatMs } : {}),
      signal: c.req.raw.signal,
      serve: (e) => withholding(store).servedBusEvent(e), // stakeholder design §7

    });
  });

  // --- learning loop WP-A: feedback log, hypothesis corrections, profile edits ------------------
  mountFeedbackRoutes(app, { store, config });

  // --- learning loop WP-B: costs, runs, prompts, prompt-version metrics, calibration history ---
  mountUsageRoutes(app, { store, config, events });

  // --- learning loop WP-C: decision outcomes report -------------------------------------------
  mountOutcomeRoutes(app, { store }, workspace);

  // --- WP-D: escalation answers, policy-event and bus-event history -----------------------------
  mountOversightRoutes(app, { store, events, config });

  // --- knowledge store KS-6: knowledge metrics and learning signals ------------------------------
  mountKnowledgeMetricsRoutes(app, { store, config, artifacts }, workspace);
  // --- end KS-6 ---
  // --- knowledge store KS-7: Knowledge view (search, cards, items, changes, lists, actions, gc) ----
  mountKnowledgeRoutes(app, { store, artifacts, config, events });
  // --- end knowledge store KS-7 ----------------------------------------------------------------
  // --- learning loop WP-E: lessons page (proposals, rules and their effect, retros) ---------------
  mountLessonsRoutes(app, { store, config, events, research });
  // --- end WP-E --------------------------------------------------------------------------------
  // --- learning loop WP-F: reviewer audits and experiments ---------------------------------------
  mountWpfRoutes(app, { store, config, research }, workspace);
  // --- end WP-F --------------------------------------------------------------------------------
  // --- learning loop WP-G: metrics view --------------------------------------------------------
  mountMetricsRoutes(app, { store, config, artifacts }, workspace);
  // --- end WP-G --------------------------------------------------------------------------------
  // --- flow records and ranking: flow types, rankings, flows, reactions, overrides, decisions -----
  mountFlowRoutes(app, { store, config, artifacts }, workspace);
  // --- end flow records and ranking ------------------------------------------------------------
  // --- persona learning: gate, adjustments, proposals, signals, the user's decisions -------------
  mountPersonaLearningRoutes(app, { store, config }, workspace);
  // --- end persona learning --------------------------------------------------------------------
  // --- stakeholder personas: question round, statements, reads (hidden personas never served) ------
  mountStakeholderRoutes(app, { store, config }, workspace);
  // --- end stakeholder personas ----------------------------------------------------------------
  // --- user persona: the You page (accept / reject / retire use the persona learning routes) ------
  mountUserPersonaRoutes(app, { store, config }, workspace);
  // --- end user persona ------------------------------------------------------------------------

  app.all('/api/*', (c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  // --- MCP + static web -----------------------------------------------------------------------
  if (deps.mcp) mountMcp(app, deps.mcp);
  const dist = deps.webDist;
  if (dist && existsSync(join(dist, 'index.html'))) {
    app.use('/*', serveStatic({ root: dist }));
    const index = readFileSync(join(dist, 'index.html'), 'utf8');
    app.get('*', (c) => c.html(index));
  }
  return app;
}
