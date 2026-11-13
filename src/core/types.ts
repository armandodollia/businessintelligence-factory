/**
 * Shared domain types — the contract between core, api and web.
 * All ids are prefixed ULID-like strings from `newId(prefix)`; timestamps are ISO-8601 strings.
 */
export type { ModelRef, ProviderId, Role, TaskType } from './config/schema.js';
import type { ModelRef, Role, TaskType } from './config/schema.js';

export type Phase =
  /** Optional; runs first when present; not in the default pipeline (Task 10b). */
  | 'mapping'
  | 'market_research'
  | 'competitor_discovery'
  | 'deep_dives'
  | 'synthesis'
  | 'persona_panel'
  | 'scoring';

export type Criteria = Record<string, number | string>;

export type ScopeLevel = 'company' | 'division' | 'slice';
export type Audience = 'external' | 'internal';

export interface WorkspaceScope {
  level: ScopeLevel;
  name: string;
  description: string;
}

/**
 * A node of the business map (spec §8c). `scope`, `audiences` and `parentWorkspaceId` were added in
 * migration 6. `scope` and `audiences` are optional on insert only so older literals keep compiling:
 * the columns have DB defaults (`company`, `['external']`), so rows read from the store always carry
 * them. Use `scopeOf` / `audiencesOf` (workspace/tree.ts) when reading untrusted objects.
 */
export interface Workspace {
  id: string;
  name: string;
  sector: string;
  createdAt: string;
  scope?: WorkspaceScope;
  /** Default `['external']`. */
  audiences?: Audience[];
  /** Parent node in the business tree (any depth). */
  parentWorkspaceId?: string;
}

/** A child business unit proposed by a `map_business_units` task; the user accepts or rejects it. */
export interface UnitProposal {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  level: ScopeLevel;
  audiences: Audience[];
  /** Artifact ids (same business tree). */
  evidence: string[];
  reasoning: string;
  status: 'proposed' | 'accepted' | 'rejected';
  childWorkspaceId?: string;
  /** The Decision logged when the unit was proposed (ratable). */
  decisionId?: string;
  createdAt: string;
  // --- learning loop WP-A (migration 14) ---
  /** When the user accepted or rejected it. */
  decidedAt?: string;
  /** Who decided (`config.user.id`). The column defaults to `local-user`. */
  actor?: string;
  /** The user's reason for accepting / rejecting. */
  decisionReason?: string;
  /** The proposal as the agent made it, kept verbatim when the user accepted it with edits. */
  originalPayload?: UnitProposalSnapshot;
}

/** The user-editable part of a unit proposal, as the agent proposed it (WP-A). */
export type UnitProposalSnapshot = Pick<UnitProposal, 'name' | 'description' | 'level' | 'audiences' | 'evidence' | 'reasoning'>;

/** An item tagged with the workspace it comes from (roll-up / cross-tree reading). */
export type Sourced<T> = T & { sourceWorkspaceId: string };

export interface CrossCuttingGroup {
  /** Normalized title used for grouping. */
  key: string;
  title: string;
  sourceWorkspaceIds: string[];
  /** Top-level children of the queried workspace the sources roll up to (always ≥ 2). */
  childWorkspaceIds: string[];
  symptoms: Sourced<Symptom>[];
}

export interface Rollup {
  symptoms: Sourced<Symptom>[];
  recommendations: Sourced<Recommendation>[];
  findings: Sourced<Finding>[];
}

export interface Artifact {
  id: string;
  workspaceId: string;
  kind: 'screenshot' | 'page_snapshot' | 'document' | 'text' | 'upload';
  path: string;
  sha256: string;
  mime: string;
  sourceUrl?: string;
  title?: string;
  flow?: string;
  step?: number;
  note?: string;
  capturedAt: string;
}

/**
 * Review status of a task output (finding, recommendation, persona; migration 11). `pending` while
 * its task is in the review loop; then the task's final status (`verified | unverified | failed`).
 * `superseded`: created in an earlier round of its task and not re-submitted in the final round
 * (re-saved, or cited by id in the final deliverable) — excluded from synthesis, panel and Strategy.
 */
export type OutputStatus = 'pending' | 'verified' | 'unverified' | 'failed' | 'superseded';

export interface Finding {
  id: string;
  workspaceId: string;
  runId: string;
  taskId: string;
  subject: string;
  claim: string;
  criteria: Criteria;
  /** Artifact ids. */
  evidence: string[];
  status: OutputStatus;
  createdAt: string;
  /** Review round of its task in which the finding was last saved or re-saved (migration 11). */
  taskRound?: number;
  /**
   * User override for recommendation synthesis (migration 8). Unset: only `verified` findings are
   * used (spec §7.2). `true`: used even if unverified. `false`: excluded even if verified.
   */
  includeInSynthesis?: boolean;
}

export interface Task {
  id: string;
  workspaceId: string;
  runId: string;
  phase: Phase;
  type: TaskType;
  brief: string;
  subject?: string;
  model: ModelRef;
  needsBrowser: boolean;
  acceptanceCriteria: string[];
  status: 'queued' | 'running' | 'reviewing' | 'waiting_user' | 'verified' | 'unverified' | 'failed';
  round: number;
  result?: unknown;
  /**
   * Review-loop step to run next / being run (migration 7): `work` (initial deliverable), `review`
   * (deliverable of `round` is complete), `revise` (answering `reviewIssues` for `round`). Lets a
   * resumed task continue exactly where it stopped.
   */
  step?: 'work' | 'review' | 'revise';
  /** Last round whose deliverable was fully submitted. */
  submittedRound?: number;
  /** Issues of the last review, handed to the revise step (also after a restart). */
  reviewIssues?: Array<{ id: string; class: 'blocking' | 'substantive' | 'nit' | 'scope_expansion'; description: string; evidence?: string[] }>;
  createdAt: string;
}

export interface ResearchRun {
  id: string;
  workspaceId: string;
  phase: Phase;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** Schedule that started this run (migration 10); unset for manual runs. */
  scheduleId?: string;
  /** Pipeline this run belongs to (migration 11). */
  pipelineId?: string;
}

/**
 * A requested sequence of phases (migration 11), persisted so an interrupted pipeline resumes its
 * remaining phases (and, for scheduled pipelines, the "what changed" step) after a restart.
 */
export interface Pipeline {
  id: string;
  workspaceId: string;
  /** Requested phases in pipeline order. */
  phases: Phase[];
  /** Index into `phases` of the next phase to finish (progress). */
  nextIndex: number;
  scheduleId?: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
}

export interface AgentRun {
  id: string;
  workspaceId: string;
  taskId?: string;
  role: Role;
  model: ModelRef;
  token: string;
  status: 'running' | 'done' | 'failed';
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  /** Prompt version the run was started with (migration 2). */
  promptVersion?: string;
  /**
   * PID of the CLI subprocess (latest attempt), which is also its process-group id since CLIs are
   * spawned detached (migration 4). Absent for in-process fake runs.
   */
  pid?: number;
  /** `ps -o lstart=` of `pid` at spawn, used to verify the process before killing it after a crash (migration 7). */
  pidStartedAt?: string;
}

export interface Decision {
  id: string;
  workspaceId: string;
  agentRunId: string;
  role: Role;
  model: ModelRef;
  kind: 'decision' | 'review' | 'pushback' | 'task_proposal' | 'persona_feedback' | 'score';
  payload: unknown;
  refs: string[];
  promptVersion: string;
  createdAt: string;
}

export interface Rating {
  id: string;
  workspaceId: string;
  targetType:
    | 'finding'
    | 'recommendation'
    | 'symptom'
    | 'competitor'
    | 'persona'
    | 'persona_feedback'
    | 'decision';
  targetId: string;
  criterion: string;
  agentValue: number | string | null;
  verdict: 'agree' | 'disagree';
  userValue?: number | string;
  reason?: string;
  createdAt: string;
  // --- learning loop WP-A (migration 14) ---
  /** Who rated (`config.user.id`). The column defaults to `local-user`. */
  actor?: string;
  /** Agent run whose judgment was rated (resolved from the target's Decision at write time). */
  agentRunId?: string;
  /** Prompt version of that judgment. */
  promptVersion?: string;
}

export interface UserRequest {
  id: string;
  workspaceId: string;
  agentRunId: string;
  /** Absent when the requesting run has no task. */
  taskId?: string;
  kind: 'register' | 'login' | 'captcha' | 'approval' | 'other';
  site?: string;
  details: string;
  status: 'pending' | 'resolved' | 'denied';
  response?: string;
  createdAt: string;
  /** Task status before it entered `waiting_user`; restored when the task's last pending request resolves (migration 3). */
  taskPriorStatus?: Task['status'];
  // --- learning loop WP-A (migration 14) ---
  /** When the user answered (resolved or denied) it. */
  resolvedAt?: string;
  /** Who answered (`config.user.id`). The column defaults to `local-user`. */
  actor?: string;
}

export interface PersonaFeedback {
  personaId: string;
  scores: { appeal: number; adoption: number; willingnessToPay: number; friction: number };
  concerns: string[];
  reasoning: string;
  wouldChangeMind: string;
  /** Persona feedback is always simulated. */
  simulated: true;
}

export interface Recommendation {
  id: string;
  workspaceId: string;
  title: string;
  summary: string;
  criteria: Criteria;
  /** Finding ids; may come from any workspace of the same business tree. */
  findingIds: string[];
  personaFeedback: PersonaFeedback[];
  priority: number;
  createdAt: string;
  /** Task that saved it (migration 11). */
  taskId?: string;
  /** Review status (migration 11). Optional on insert only: the column defaults to `pending`. */
  status?: OutputStatus;
  /** Review round of its task in which it was last saved (migration 11). */
  taskRound?: number;
  /**
   * User override (migration 11). Unset: only `verified` recommendations go to the persona panel and
   * failed ones are hidden. `true`: used/shown anyway. `false`: excluded. Never applies to `superseded`.
   */
  includeOverride?: boolean;
}

export interface PersonaProfileField {
  value: string;
  confidence: number;
  evidence: string[];
}

export interface Persona {
  id: string;
  workspaceId: string;
  slug: string;
  segment: string;
  profile: Record<string, PersonaProfileField>;
  agentMdPath: string;
  version: number;
  /** Default `external` (DB default, migration 6). */
  audience?: Audience;
  /** Task that last saved it (migration 11). */
  taskId?: string;
  /** Review status of its last save (migration 11). Optional on insert only: the column defaults to `pending`. */
  status?: OutputStatus;
  /** Review round of its task in which it was last saved (migration 11). */
  taskRound?: number;
  /** User override for the persona panel (migration 11); same semantics as `Recommendation.includeOverride`. */
  includeOverride?: boolean;
}

export interface Symptom {
  id: string;
  workspaceId: string;
  kind: 'symptom' | 'strength';
  title: string;
  detail: string;
  criteria: Criteria;
  evidence: string[];
}

/** Per-area comparison of a competitor vs. the business in scope, each 1–5 (5 = competitor much better). */
export interface CompetitorComparison {
  pricing: number;
  onboarding: number;
  ux: number;
  features: number;
}

/**
 * A rated competitor (spec §9; migration 12), saved by `save_competitor`. One row per workspace +
 * normalized name; a later save updates it. Ratable criteria: threat, directness and the four
 * comparison areas (rating target id = competitor id).
 */
export interface Competitor {
  id: string;
  workspaceId: string;
  name: string;
  site?: string;
  /** 1–5. */
  threat: number;
  /** 1–5. */
  directness: number;
  comparison: CompetitorComparison;
  /** Artifact ids. */
  evidence: string[];
  /** Task whose run saved (or last updated) it. */
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  /** Review status of its last save (migration 13). Optional on insert only: the column defaults to `pending`. */
  status?: OutputStatus;
  /** Review round of its task in which it was last saved (migration 13). */
  taskRound?: number;
  /** User override (migration 13); same semantics as `Recommendation.includeOverride`. */
  includeOverride?: boolean;
}

/** A research hypothesis about the cause of an interview symptom (spec §8 drill-down; migration 12). */
export interface SymptomHypothesis {
  id: string;
  workspaceId: string;
  symptomId: string;
  hypothesis: string;
  /** 0–100 (percent). */
  confidence: number;
  /** Finding and/or artifact ids. */
  evidence: string[];
  taskId?: string;
  createdAt: string;
  /** Review status (migration 13). Optional on insert only: the column defaults to `pending`. */
  status?: OutputStatus;
  /** Review round of its task in which it was last saved (migration 13). */
  taskRound?: number;
  /** User override (migration 13); same semantics as `Recommendation.includeOverride`. */
  includeOverride?: boolean;
}

export interface Schedule {
  id: string;
  workspaceId: string;
  name: string;
  cron: string;
  phases: Phase[];
  lastRunAt?: string;
  /**
   * When the schedule was created or last re-enabled. The scheduler never runs an occurrence
   * before this, so a new or re-enabled schedule waits for its next occurrence.
   */
  activatedAt?: string;
  enabled: boolean;
}

export interface InterviewTurn {
  id: string;
  workspaceId: string;
  role: 'user' | 'agent';
  text: string;
  createdAt: string;
  /**
   * Interviewer run (WP-A, migration 14): the run that wrote an agent turn, or that answered a user
   * turn. Absent for turns stored before migration 14 or whose run never started.
   */
  agentRunId?: string;
}

/** Disposable identity used to sign up on a third-party site (one per workspace + site; migration 5). */
export interface Identity {
  id: string;
  workspaceId: string;
  /** Normalized host, e.g. `acme.com`. */
  site: string;
  name: string;
  email: string;
  /** Password for the site account. Never written to Decisions (redacted). */
  password: string;
  /** Password of the disposable inbox, when the provider has one. */
  emailPassword?: string;
  createdAt: string;
}

export interface Profile {
  workspaceId: string;
  data: Record<string, unknown>;
}
