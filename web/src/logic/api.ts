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
export const exportUrl = (workspaceId: string, includeUploads = false): string => `${ws(workspaceId)}/export${includeUploads ? '?includeUploads=1' : ''}`;
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
  // Design §12 ruling: what the training export leaves out by default, by cause.
  exportSummary: (id: string) => get<import('./exportSummary.js').ExportSummary>(`${ws(id)}/export/summary`),
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
  /** `duplicateOf` (KS-6 × KS-7): retract as a duplicate of another fact of the same tree (`duplicate-saved` trigger b). */
  retractFact: (wsId: string, id: string, reason?: string, duplicateOf?: string) =>
    post<unknown>(kn(wsId, `/facts/${enc(id)}/retract`), { ...(reason ? { reason } : {}), ...(duplicateOf ? { duplicateOf } : {}) }),
  acceptReplacement: (wsId: string, id: string) => post<unknown>(kn(wsId, `/facts/${enc(id)}/accept-replacement`)),
  setFactScopes: (wsId: string, id: string, workspaceIds: string[]) =>
    request<{ workspaceIds: string[] }>('PUT', kn(wsId, `/facts/${enc(id)}/scopes`), { workspaceIds }),
  gcReport: (wsId: string, scope: KScope) => get<import('./knowledge.js').GcReportView>(kn(wsId, '/gc', { scope })),
  prune: (wsId: string, artifactIds: string[]) =>
    post<{ pruned: string[]; bytes: number; decisionId: string }>(kn(wsId, '/gc/prune'), { artifactIds }),
};
// --- end knowledge store KS-7 --------------------------------------------------------------------

// --- learning loop WP-E: lessons page (proposals, rules and their effect, retros) ----------------
const ls = (wsId: string, rest = '') => `${ws(wsId)}/lessons${rest}`;
export const lessonsApi = {
  page: (wsId: string) => get<import('./lessons.js').LessonsPage>(ls(wsId)),
  evaluate: (wsId: string) => post<{ proposals: import('./lessons.js').LessonProposal[] }>(ls(wsId, '/evaluate')),
  accept: (wsId: string, proposalId: string, reason?: string) =>
    post<unknown>(ls(wsId, `/proposals/${enc(proposalId)}/accept`), reason ? { reason } : {}),
  reject: (wsId: string, proposalId: string, reason?: string) =>
    post<unknown>(ls(wsId, `/proposals/${enc(proposalId)}/reject`), reason ? { reason } : {}),
  proposeRetire: (wsId: string, ruleId: string) => post<import('./lessons.js').LessonProposal>(ls(wsId, `/rules/${enc(ruleId)}/propose-retire`)),
  startRetro: (wsId: string) => post<{ started: boolean }>(ls(wsId, '/retro')),
};
// --- end WP-E ------------------------------------------------------------------------------------
// --- learning loop WP-F: reviewer audits and experiments --------------------------------------
export const wpfApi = {
  /** Audits of the workspace's business tree, their summary and the tree's audit schedules. */
  getAudits: (wsId: string) => get<import('./types.js').AuditsView>(`${ws(wsId)}/audits`),
  /** Starts an audit of the N most recently verified tasks of the tree (runs in the background). */
  startAudit: (wsId: string, body: { n?: number; taskIds?: string[] }) =>
    post<{ batchId: string; audits: import('./types.js').ReviewerAudit[] }>(`${ws(wsId)}/audits`, body),
  createAuditSchedule: (wsId: string, cron: string, n: number) =>
    post<import('./types.js').AuditSchedule>(`${ws(wsId)}/audit-schedules`, { cron, n }),
  updateAuditSchedule: (id: string, patch: { enabled?: boolean; cron?: string; n?: number }) =>
    post<import('./types.js').AuditSchedule>(`/api/audit-schedules/${enc(id)}`, patch),
  listExperiments: (wsId: string) => get<import('./types.js').Experiment[]>(`${ws(wsId)}/experiments`),
  startExperiment: (wsId: string, body: import('./types.js').NewExperiment) =>
    post<import('./types.js').Experiment>(`${ws(wsId)}/experiments`, body),
  getExperiment: (id: string) => get<import('./types.js').ExperimentComparison>(`/api/experiments/${enc(id)}`),
};
// --- end WP-F ---------------------------------------------------------------------------------
// --- learning loop WP-G: metrics view ------------------------------------------------------------
export const metricsApi = {
  /** `query`: from `metricsQuery` (scope, groupBy, bucket, since, until, includeExperiments). */
  getMetrics: (wsId: string, query: string) => get<import('./metrics.js').MetricsReport>(`${ws(wsId)}/metrics${query ? `?${query}` : ''}`),
};
// --- end WP-G ------------------------------------------------------------------------------------
// --- flow records and flow ranking: the Flows page (`src/api/flowRoutes.ts`) ----------------------
const fl = (wsId: string, rest: string) => `${ws(wsId)}/flows${rest}`;
/** The optional reason of a reaction, sent only when given (the server caps it at 2,000 characters). */
const withReason = (reason?: string) => (reason ? { reason } : {});
type FT = import('./types.js').FlowTypeDecisionInput;
type CD = import('./types.js').ChecklistDecisionInput;
type Reaction = import('./types.js').FlowReaction;
type Override = import('./types.js').FlowOverride;
type FeedbackRow = import('./types.js').FeedbackEvent;

export const flowsApi = {
  types: (wsId: string) => get<import('./types.js').FlowTypesView>(fl(wsId, '/types')),
  /** `personaId`: rank on that persona's verdicts only; `allVariants`: add the subjects' other variants. */
  ranking: (wsId: string, flowTypeId: string, opts: { personaId?: string; allVariants?: boolean } = {}) => {
    const q = [opts.personaId ? `persona=${enc(opts.personaId)}` : '', opts.allVariants ? 'variants=all' : ''].filter(Boolean).join('&');
    return get<import('./types.js').FlowRankingView>(fl(wsId, `/rankings/${enc(flowTypeId)}${q ? `?${q}` : ''}`));
  },
  flow: (wsId: string, flowId: string) => get<import('./types.js').FlowDetailView>(fl(wsId, `/${enc(flowId)}`)),
  compare: (wsId: string, a: string, b: string) => get<import('./types.js').FlowCompareView>(fl(wsId, `/compare?a=${enc(a)}&b=${enc(b)}`)),
  /** Agree or disagree with a flow's position: both are sent the same way. */
  reactToPosition: (wsId: string, flowId: string, flowTypeId: string, reaction: Reaction, reason?: string) =>
    post<FeedbackRow>(fl(wsId, `/${enc(flowId)}/reaction`), { flowTypeId, reaction, ...withReason(reason) }),
  reactToVerdict: (wsId: string, verdictId: string, reaction: Reaction, reason?: string) =>
    post<FeedbackRow>(fl(wsId, `/verdicts/${enc(verdictId)}/reaction`), { reaction, ...withReason(reason) }),
  override: (wsId: string, flowTypeId: string, winnerFlowId: string, loserFlowId: string, reason?: string) =>
    post<Override>(fl(wsId, '/overrides'), { flowTypeId, winnerFlowId, loserFlowId, ...withReason(reason) }),
  /** Always sends a JSON body: the server requires `content-type: application/json` on DELETE. */
  revokeOverride: (wsId: string, overrideId: string, reason?: string) =>
    request<Override>('DELETE', fl(wsId, `/overrides/${enc(overrideId)}`), withReason(reason)),
  confirmOverride: (wsId: string, overrideId: string, keep: boolean, reason?: string) =>
    post<Override>(fl(wsId, `/overrides/${enc(overrideId)}/confirm`), { keep, ...withReason(reason) }),
  correctCheck: (
    wsId: string,
    flowId: string,
    input: { checklistId: string; itemKey: string; answer: import('./types.js').CheckAnswer; note?: string },
    reason?: string,
  ) => post<{ check: import('./types.js').FlowCheck }>(fl(wsId, `/${enc(flowId)}/checks`), { ...input, ...withReason(reason) }),
  decideFlowType: (wsId: string, typeId: string, decision: FT, reason?: string) =>
    post<import('./types.js').FlowType>(fl(wsId, `/types/${enc(typeId)}/decision`), { ...decision, ...withReason(reason) }),
  /** What a review is about: no `flowTypeKey` = not about any flow (its subject only); `checkKey` needs `flowTypeKey`. */
  correctAttribution: (wsId: string, mentionId: string, input: { flowTypeKey?: string; checkKey?: string }, reason?: string) =>
    post<import('./types.js').ReviewMention>(fl(wsId, `/mentions/${enc(mentionId)}/attribution`), { ...input, ...withReason(reason) }),
  /** The active checklists for a flow type: the general one and, when the type has one, its own. */
  checklists: (wsId: string, flowTypeId: string) =>
    get<import('./types.js').FlowChecklistsView>(fl(wsId, `/checklists?flowTypeId=${enc(flowTypeId)}`)),
  /** Saves the user's edit as a new active version; returns it and the flows needing a re-walk. */
  editChecklist: (wsId: string, checklistId: string, input: import('./types.js').ChecklistEditInput, reason?: string) =>
    post<{ checklist: import('./types.js').Checklist; needRewalk: string[] }>(fl(wsId, `/checklists/${enc(checklistId)}/edit`), {
      ...input,
      ...withReason(reason),
    }),
  /** Returns the flows that need a re-walk for the accepted checklist's new checks. */
  decideChecklist: (wsId: string, checklistId: string, decision: CD, reason?: string) =>
    post<{ checklist: import('./types.js').Checklist; needRewalk: string[] }>(fl(wsId, `/checklists/${enc(checklistId)}/decision`), {
      ...decision,
      ...withReason(reason),
    }),
};
// --- end flows -----------------------------------------------------------------------------------
// --- persona learning: what the tool has learned (`src/api/personaLearningRoutes.ts`) -------------
export const personaLearningApi = {
  view: (wsId: string) => get<import('./types.js').PersonaLearningView>(`${ws(wsId)}/persona-learning`),
  signals: (wsId: string, personaId: string) =>
    get<{ signals: import('./types.js').PersonaSignal[] }>(`${ws(wsId)}/personas/${enc(personaId)}/signals`),
  /** `text`: the user's edit, sent only when it differs from the proposed text. */
  accept: (wsId: string, proposalId: string, input: { text?: string; reason?: string } = {}) =>
    post<unknown>(`${ws(wsId)}/persona-proposals/${enc(proposalId)}/accept`, {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...withReason(input.reason),
    }),
  reject: (wsId: string, proposalId: string, reason?: string) => post<unknown>(`${ws(wsId)}/persona-proposals/${enc(proposalId)}/reject`, withReason(reason)),
  retire: (wsId: string, adjustmentId: string, reason?: string) =>
    post<unknown>(`${ws(wsId)}/persona-adjustments/${enc(adjustmentId)}/retire`, withReason(reason)),
};
// --- end persona learning ------------------------------------------------------------------------
// --- user persona: the You page (`src/api/userPersonaRoutes.ts`); decisions use `personaLearningApi` ---
export const userPersonaApi = {
  view: (wsId: string) => get<import('./types.js').UserPersonaView>(`${ws(wsId)}/user-persona`),
  /** The interactions a line rests on. */
  lineInteractions: (wsId: string, adjustmentId: string) =>
    get<{ interactions: import('./types.js').UserInteraction[] }>(`${ws(wsId)}/user-persona/interactions?line=${enc(adjustmentId)}`),
};
// --- end user persona ----------------------------------------------------------------------------
// --- stakeholder personas: the Stakeholders page and reads on a recommendation (`src/api/stakeholderRoutes.ts`) ---
type SV = import('./types.js').StakeholderView;
type Statement = import('./types.js').StakeholderStatement;
export const stakeholdersApi = {
  list: (wsId: string) => get<import('./types.js').StakeholdersView>(`${ws(wsId)}/stakeholders`),
  questions: (wsId: string) => get<{ groups: import('./types.js').StakeholderQuestionGroup[] }>(`${ws(wsId)}/stakeholder-questions`),
  answer: (wsId: string, input: import('./types.js').StakeholderAnswersInput) =>
    post<{ opened: string[]; statements: Statement[] }>(`${ws(wsId)}/stakeholder-questions/answers`, input),
  /** "Show what the tool found" (recorded as a skip of its questions). */
  reveal: (wsId: string, personaId: string) => post<SV>(`${ws(wsId)}/stakeholders/${enc(personaId)}/reveal`),
  /** The user's statements about a stakeholder, newest first. */
  statements: (wsId: string, personaId: string) => get<{ statements: Statement[] }>(`${ws(wsId)}/stakeholders/${enc(personaId)}/statements`),
  addNote: (wsId: string, personaId: string, text: string) => post<Statement>(`${ws(wsId)}/stakeholders/${enc(personaId)}/notes`, { text }),
  /** The position history, newest first, and the two layers of a former colleague. */
  positions: (wsId: string, personaId: string) =>
    get<import('./types.js').StakeholderPositionsView>(`${ws(wsId)}/stakeholders/${enc(personaId)}/positions`),
  /** Records that the person left, moved, was promoted or demoted, or returned. */
  changePosition: (wsId: string, personaId: string, input: import('./types.js').StakeholderPositionInput) =>
    post<SV>(`${ws(wsId)}/stakeholders/${enc(personaId)}/position`, input),
  reads: (wsId: string, recId: string) =>
    get<{ reads: import('./types.js').ServedStakeholderRead[] }>(`${ws(wsId)}/recommendations/${enc(recId)}/stakeholder-reads`),
  react: (wsId: string, readId: string, reaction: Reaction, reason?: string) =>
    post<FeedbackRow>(`${ws(wsId)}/stakeholder-reads/${enc(readId)}/reaction`, { reaction, ...withReason(reason) }),
  recordDecision: (wsId: string, recId: string, input: { personaId: string; decision: import('./types.js').RealDecision; reasoning: string }) =>
    post<Statement>(`${ws(wsId)}/recommendations/${enc(recId)}/stakeholder-decisions`, input),
};
// --- end stakeholder personas --------------------------------------------------------------------

// --- review council: the council table of a task, the configured council (`src/api/councilRoutes.ts`) ---
export const councilApi = {
  /** The council rounds of a task, read from the node the page is on (a task of another business tree answers 404). */
  getTaskCouncil: (taskId: string, workspaceId: string) =>
    get<import('./types.js').CouncilView>(`${ws(workspaceId)}/tasks/${enc(taskId)}/council`),
  /** The configured council with each member's availability; `council: null` when none is configured. */
  getCouncil: () => get<{ council: import('./types.js').CouncilOverview | null }>('/api/council'),
};
