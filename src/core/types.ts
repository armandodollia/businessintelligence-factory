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
}

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
  status: 'verified' | 'unverified' | 'pending';
  createdAt: string;
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
  findingIds: string[];
  personaFeedback: PersonaFeedback[];
  priority: number;
  createdAt: string;
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
