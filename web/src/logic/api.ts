/**
 * Typed client for the local API (route contract: plan Task 14). The only module that calls
 * `fetch`. All paths are relative so the Vite dev proxy (and same-origin prod serving) work.
 */
import type {
  AppliedPromptPatch,
  Artifact,
  BifConfig,
  PatchRole,
  PromptPatch,
  ScoringWeights,
  CalibrationReport,
  CompetitorView,
  CreateWorkspaceInput,
  Decision,
  Finding,
  InterviewState,
  InterviewTurn,
  NewSchedule,
  PersonaNode,
  PersonaView,
  ResearchPhase,
  Rating,
  RatingInput,
  Recommendation,
  RecommendationView,
  ResearchRun,
  ReviewQueueItem,
  Rollup,
  Schedule,
  SchedulePatch,
  Symptom,
  Task,
  TreeFindingView,
  UnitProposal,
  UnitProposalEdits,
  UserRequest,
  WorkspaceNode,
} from './types.js';
import type { FeedbackEvent, HypothesisCorrection, SymptomHypothesis } from './types.js';
import type { OutcomeReport } from './types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const enc = encodeURIComponent;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `${method} ${path} failed (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const ws = (id: string) => `/api/workspaces/${enc(id)}`;

/** URL serving an artifact's bytes with its mime type. */
export const artifactUrl = (id: string): string => `/api/artifacts/${enc(id)}`;
/** URL downloading decisions + ratings as JSONL. */
export const exportUrl = (workspaceId: string): string => `${ws(workspaceId)}/export`;
/** SSE stream of `BusEvent`s for one workspace. */
export const eventsUrl = (workspaceId: string): string => `/api/events?workspaceId=${enc(workspaceId)}`;

export const api = {
  // workspaces & business map
  listWorkspaces: () => get<WorkspaceNode[]>('/api/workspaces'),
  createWorkspace: (input: CreateWorkspaceInput) => post<WorkspaceNode>('/api/workspaces', input),
  getProfile: (id: string) => get<Record<string, unknown> | { data: Record<string, unknown> } | null>(`${ws(id)}/profile`),
  getTree: (id: string) => get<unknown>(`${ws(id)}/tree`),
  getRollup: (id: string) => get<Rollup>(`${ws(id)}/rollup`),
  listUnitProposals: (id: string) => get<UnitProposal[]>(`${ws(id)}/unit-proposals`),
  resolveUnitProposal: (
    id: string,
    body: { action: 'accept'; edits?: UnitProposalEdits } | { action: 'reject'; reason?: string },
  ) => post<unknown>(`/api/unit-proposals/${enc(id)}`, body),

  // interview & uploads
  getInterview: (id: string) => get<InterviewState>(`${ws(id)}/interview`),
  sendInterview: (id: string, text: string) =>
    post<InterviewTurn | InterviewState | null>(`${ws(id)}/interview`, { text }),
  upload: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return post<Artifact>(`${ws(id)}/uploads`, form);
  },

  // research
  startResearch: (id: string, phases?: ResearchPhase[]) =>
    post<ResearchRun | ResearchRun[] | null>(`${ws(id)}/research`, phases ? { phases } : {}),
  listRuns: (id: string) => get<ResearchRun[]>(`${ws(id)}/runs`),
  listTasks: (id: string, runId?: string) =>
    get<Task[]>(`${ws(id)}/tasks${runId ? `?runId=${enc(runId)}` : ''}`),

  // results
  /** `tree`: findings of every node of the business tree (each tagged with `sourceWorkspaceId`). */
  listFindings: (id: string, opts: { tree?: boolean } = {}) =>
    get<TreeFindingView[]>(`${ws(id)}/findings${opts.tree ? '?scope=tree' : ''}`),
  setFindingInclude: (id: string, include: boolean | null) => post<Finding>(`/api/findings/${enc(id)}/include`, { include }),
  /** Persona-panel / Strategy override; `null` resets to the default (verified only). */
  setRecommendationInclude: (id: string, include: boolean | null) =>
    post<Recommendation>(`/api/recommendations/${enc(id)}/include`, { include }),
  setCompetitorInclude: (id: string, include: boolean | null) =>
    post<CompetitorView>(`/api/competitors/${enc(id)}/include`, { include }),
  setPersonaInclude: (id: string, include: boolean | null) => post<PersonaNode>(`/api/personas/${enc(id)}/include`, { include }),
  listSymptoms: (id: string) => get<Symptom[]>(`${ws(id)}/symptoms`),
  listPersonas: (id: string) => get<PersonaView[]>(`${ws(id)}/personas`),
  listCompetitors: (id: string) => get<CompetitorView[]>(`${ws(id)}/competitors`),
  listRecommendations: (id: string) => get<RecommendationView[]>(`${ws(id)}/recommendations`),
  listDecisions: (id: string, kind?: Decision['kind']) =>
    get<Decision[]>(`${ws(id)}/decisions${kind ? `?kind=${enc(kind)}` : ''}`),
  /**
   * Artifact metadata. NOT in the Task 14 route list (which only serves bytes); assumed
   * `GET /api/artifacts/:id/meta` → `Artifact`. Callers must tolerate failure.
   */
  getArtifactMeta: (id: string) => get<Artifact>(`${artifactUrl(id)}/meta`),

  // user requests
  listPendingRequests: (id: string) => get<UserRequest[]>(`${ws(id)}/requests?status=pending`),
  resolveRequest: (id: string, status: 'resolved' | 'denied', response?: string) =>
    post<UserRequest>(
      `/api/requests/${enc(id)}`,
      response === undefined ? { status } : { status, response },
    ),

  // ratings
  rate: (input: RatingInput) => post<Rating>('/api/ratings', input),
  /** The user's current (latest) rating per target + criterion. */
  listRatings: (id: string) => get<Rating[]>(`${ws(id)}/ratings`),
  getReviewQueue: (id: string) => get<ReviewQueueItem[]>(`${ws(id)}/review-queue`),
  getCalibration: (id: string) => get<CalibrationReport>(`${ws(id)}/calibration`),
  proposePromptPatch: (id: string, role: PatchRole) =>
    post<PromptPatch>(`${ws(id)}/calibration/prompt-patch`, { role }),
  applyPromptPatch: (id: string, patch: PromptPatch) =>
    post<AppliedPromptPatch>(`${ws(id)}/calibration/prompt-patch/apply`, patch),
  getScoringWeights: (id: string) => get<ScoringWeights>(`${ws(id)}/scoring-weights`),
  putScoringWeights: (id: string, body: { weights?: Record<string, number>; personaWeight?: number }) =>
    request<ScoringWeights>('PUT', `${ws(id)}/scoring-weights`, body),

  // scheduler diffs
  listChanges: (id: string) => get<Decision[]>(`${ws(id)}/changes`),

  // schedules
  listSchedules: (id: string) => get<Schedule[]>(`${ws(id)}/schedules`),
  createSchedule: (id: string, input: NewSchedule) => post<Schedule>(`${ws(id)}/schedules`, input),
  updateSchedule: (wsId: string, id: string, patch: SchedulePatch) =>
    request<Schedule>('PATCH', `${ws(wsId)}/schedules`, { id, ...patch }),

  // config
  getConfig: () => get<BifConfig>('/api/config'),
  putConfig: (config: BifConfig) => request<BifConfig>('PUT', '/api/config', config),

  // WP-D: structured escalation answers (dismiss with `resolveRequest(id, 'denied')`)
  answerEscalation: (id: string, choice: number, note?: string) =>
    post<UserRequest>(`/api/requests/${enc(id)}/escalation-answer`, note ? { choice, note } : { choice }),
};

// ---------------------------------------------------------------------------
// learning loop WP-A: feedback log, symptom hypotheses (include override + user correction)

export const feedbackApi = {
  /** Feedback events (who / when / what / why) of a workspace, oldest first. */
  listFeedback: (id: string) => get<FeedbackEvent[]>(`${ws(id)}/feedback`),
  listHypotheses: (id: string) => get<SymptomHypothesis[]>(`${ws(id)}/hypotheses`),
  /** `null` resets to the default (verified hypotheses only). */
  setHypothesisInclude: (id: string, include: boolean | null) =>
    post<SymptomHypothesis>(`/api/hypotheses/${enc(id)}/include`, { include }),
  correctHypothesis: (id: string, body: HypothesisCorrection) =>
    post<SymptomHypothesis>(`/api/hypotheses/${enc(id)}/correct`, body),
};

// ---------------------------------------------------------------------------
// learning loop WP-B: costs, agent runs and events, prompt store, prompt-version metrics,
// calibration history

export const usageApi = {
  /** Costs per workspace / task / role / model / prompt version; with a workspace also budget status. */
  getCosts: (workspaceId?: string) =>
    get<import('./types.js').CostReport>(`/api/costs${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  listAgentRuns: (wsId: string, limit?: number) =>
    get<import('./types.js').AgentRunView[]>(`${ws(wsId)}/agent-runs${limit ? `?limit=${limit}` : ''}`),
  getRun: (runId: string) => get<import('./types.js').AgentRunDetail>(`/api/runs/${enc(runId)}`),
  getRunEvents: (runId: string, offset: number, limit: number) =>
    get<import('./types.js').RunEventsPage>(`/api/runs/${enc(runId)}/events?offset=${offset}&limit=${limit}`),
  getPrompt: (hash: string) => get<import('./types.js').PromptVersionRecord>(`/api/prompts/${enc(hash)}`),
  getPromptVersionMetrics: (wsId: string, role?: string) =>
    get<import('./types.js').PromptVersionMetrics[]>(`${ws(wsId)}/metrics/prompt-versions${role ? `?role=${enc(role)}` : ''}`),
  listCalibrationVersions: (wsId: string, role?: string) =>
    get<import('./types.js').CalibrationVersion[]>(`${ws(wsId)}/calibration/versions${role ? `?role=${enc(role)}` : ''}`),
  revertCalibration: (wsId: string, versionId: string) =>
    post<import('./types.js').RevertedCalibration>(`${ws(wsId)}/calibration/versions/${enc(versionId)}/revert`),
};

// --- learning loop WP-C: decision outcomes ----------------------------------------------------
export const outcomesApi = {
  /** Outcome label counts per role / task type / prompt version; `tree`: every node of the business tree. */
  getOutcomes: (id: string, opts: { tree?: boolean } = {}) =>
    get<OutcomeReport>(`${ws(id)}/outcomes${opts.tree ? '?scope=tree' : ''}`),
};

// --- knowledge store KS-7: Knowledge view (design §17) -------------------------------------------
// `scope`: 'node' (this part of the business, default) or 'tree' (the whole business).
type KScope = 'node' | 'tree';
const kn = (wsId: string, rest: string, q: Record<string, string | number | undefined> = {}) => {
  const qs = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .join('&');
  return `${ws(wsId)}/knowledge${rest}${qs ? `?${qs}` : ''}`;
};

export const knowledgeApi = {
  search: (wsId: string, q: string, scope: KScope, opts: { kinds?: string[]; cursor?: string } = {}) =>
    get<import('./knowledge.js').SearchResult>(kn(wsId, '/search', { q, scope, kinds: opts.kinds?.join(','), cursor: opts.cursor })),
  entities: (wsId: string, scope: KScope) => get<import('./knowledge.js').EntityRow[]>(kn(wsId, '/entities', { scope })),
  card: (wsId: string, entityId: string, scope: KScope, cursor?: string) =>
    get<import('./knowledge.js').CardView>(kn(wsId, `/entities/${enc(entityId)}`, { scope, cursor })),
  item: (wsId: string, itemId: string, scope: KScope, cursor?: string) =>
    get<import('./knowledge.js').ItemView>(kn(wsId, `/items/${enc(itemId)}`, { scope, cursor })),
  artifactText: (wsId: string, artifactId: string, scope: KScope, cursor?: string) =>
    get<import('./knowledge.js').ArtifactTextView>(kn(wsId, `/artifacts/${enc(artifactId)}`, { scope, mode: 'text', cursor })),
  changes: (wsId: string, scope: KScope) => get<import('./knowledge.js').ChangesView>(kn(wsId, '/changes', { scope })),
  stats: (wsId: string, scope: KScope) => get<import('./knowledge.js').KnowledgeStats>(kn(wsId, '/stats', { scope })),
  stale: (wsId: string, scope: KScope) => get<{ facts: import('./knowledge.js').FactRow[]; more: number }>(kn(wsId, '/stale', { scope })),
  conflicts: (wsId: string, scope: KScope) =>
    get<{ conflicts: import('./knowledge.js').FactRow[]; unverifiedUpdates: import('./knowledge.js').FactRow[] }>(kn(wsId, '/conflicts', { scope })),
  mergeSuggestions: (wsId: string, scope: KScope) => get<import('./knowledge.js').MergeSuggestionRow[]>(kn(wsId, '/merge-suggestions', { scope })),
  acceptSuggestion: (wsId: string, id: string) => post<unknown>(kn(wsId, `/merge-suggestions/${enc(id)}/accept`)),
  rejectSuggestion: (wsId: string, id: string) => post<unknown>(kn(wsId, `/merge-suggestions/${enc(id)}/reject`)),
  retractFact: (wsId: string, id: string, reason?: string) => post<unknown>(kn(wsId, `/facts/${enc(id)}/retract`), reason ? { reason } : {}),
  acceptReplacement: (wsId: string, id: string) => post<unknown>(kn(wsId, `/facts/${enc(id)}/accept-replacement`)),
  setFactScopes: (wsId: string, id: string, workspaceIds: string[]) =>
    request<{ workspaceIds: string[] }>('PUT', kn(wsId, `/facts/${enc(id)}/scopes`), { workspaceIds }),
  gcReport: (wsId: string, scope: KScope) => get<import('./knowledge.js').GcReportView>(kn(wsId, '/gc', { scope })),
  prune: (wsId: string, artifactIds: string[]) =>
    post<{ pruned: string[]; bytes: number; decisionId: string }>(kn(wsId, '/gc/prune'), { artifactIds }),
};
// --- end knowledge store KS-7 --------------------------------------------------------------------
