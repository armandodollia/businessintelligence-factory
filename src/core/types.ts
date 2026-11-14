/**
 * Shared domain types — the contract between core, api and web.
 * All ids are prefixed ULID-like strings from `newId(prefix)`; timestamps are ISO-8601 strings.
 */
export type { ModelRef, ProviderId, Role, TaskType } from './config/schema.js';
import type { ModelRef, Role, TaskType } from './config/schema.js';
// Knowledge store KS-0
export type { EntityKind } from './config/schema.js';
import type { EntityKind } from './config/schema.js';

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
  // Knowledge store KS-0 (migration 18)
  /** Caption / description (required for agent screenshots, design §8.1); first save sets it. */
  description?: string;
  /** Normalized `sourceUrl` (design §8.1, `urlKey`). */
  urlKey?: string;
  /** Upload-derived (design §12): sticky, set by triggers / backfill. Optional on insert (DB default 0). */
  uploadDerived?: boolean;
  /** First reason the flag was set: `kind:upload` | `profile:<ws>` | `duplicate_of:<artifact>`. */
  uploadCause?: string;
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
  // Knowledge store KS-0 (migration 18): living facts (design §7.2). All optional on insert: the
  // columns have defaults, and triggers set `lineageId` (= id) and `firstSeenAt` (= createdAt).
  /** Stable identity across versions; the first version's id. */
  lineageId?: string;
  /** 1 for the first version of a lineage. */
  version?: number;
  /** The version this one replaces (`relation: replaces`). */
  replacesId?: string;
  lifecycle?: FactLifecycle;
  entityId?: string;
  firstSeenAt?: string;
  lastConfirmedAt?: string;
  confirmCount?: number;
  /** Agent-set freshness TTL; else config by entity kind, else `knowledge.freshness.defaultDays`. */
  ttlDays?: number;
  /** Upload-derived (design §12): sticky along the lineage, set by triggers. */
  uploadDerived?: boolean;
  /**
   * First reason the flag was set: `evidence:<artifact>` | `finding_evidence:<artifact>` |
   * `observation:<observation>` | `lineage:<earlier version>`.
   */
  uploadCause?: string;
  /** A replacement was applied onto a newer head than it named (design §7.2); for the review queue. */
  lineageConflict?: boolean;
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
  /** Why the task ended `failed` (migration 15). */
  failureReason?: string;
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
  /** Why the run ended `failed` (migration 15). */
  failureReason?: string;
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
  /** Attempts made (> 1 after rate-limit retries; migration 15). */
  attempts?: number;
  /** Why the run ended `failed`: supervisor reason or last error event (migration 15). */
  failureReason?: string;
  /** Review round (orchestrator: orchestrator round) the run was started for (migration 15). */
  round?: number;
  /** Task type of the run's task, when it has one (migration 15). */
  taskType?: TaskType;
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
  kind: 'register' | 'login' | 'captcha' | 'approval' | 'other' | 'escalation';
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
  // WP-D (migration 17): structured escalation question (kind `escalation`); `details` is the question.
  optionsJson?: EscalationOptions;
}

// ---------------------------------------------------------------------------
// WP-D (migration 17): structured escalations

/** Multiple-choice payload of an escalation question (`UserRequest.optionsJson`). */
export interface EscalationOptions {
  /** 2–4 answer options shown to the user. */
  options: string[];
  /** Index into `options` of the option the escalation agent recommends. */
  recommended: number;
  /** Why the agent asks / recommends (short). */
  rationale?: string;
  /** The user's choice (index into `options`), set when answered through the escalation route. */
  choice?: number;
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
  /** Knowledge store entity (KS-0, migration 18). */
  entityId?: string;
}

export interface Symptom {
  id: string;
  workspaceId: string;
  kind: 'symptom' | 'strength';
  title: string;
  detail: string;
  criteria: Criteria;
  evidence: string[];
  /** Knowledge store entity (KS-0, migration 18). */
  entityId?: string;
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
  /** Knowledge store entity (KS-0, migration 18). */
  entityId?: string;
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
  /** Knowledge store entity (KS-0, migration 18). */
  entityId?: string;
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

// ---------------------------------------------------------------------------
// learning loop WP-B (migration 15): usage, cost, timing, prompt store, versioned calibration

/**
 * Token usage of one `usage` RunEvent of an agent run. Token columns are disjoint:
 * `inputTokens` = uncached input, plus cache reads and cache writes, plus output.
 * `costUsd` is computed from the dated price table (`price_version`); `cliReportedCostUsd` is what
 * the CLI itself reported, when it does (Claude Code, OpenCode). Effective cost = `costUsd`, else
 * `cliReportedCostUsd`.
 */
export interface AgentUsage {
  id: string;
  workspaceId: string;
  runId: string;
  taskId?: string;
  researchRunId?: string;
  pipelineId?: string;
  role: Role;
  provider: ModelRef['provider'];
  model: string;
  promptVersion?: string;
  /** Supervisor attempt (rate-limit retry) the usage was reported in. */
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  cliReportedCostUsd?: number;
  /** `version` of the price table used; absent when the model has no price. */
  priceVersion?: string;
  createdAt: string;
}

/** One supervisor attempt of an agent run (first try and every rate-limit retry). */
export interface AgentRunAttempt {
  id: string;
  workspaceId: string;
  runId: string;
  attempt: number;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  rateLimited: boolean;
  failureReason?: string;
  /** Back-off waited after this attempt before the next one. */
  backoffMs?: number;
}

/** Full text of a prompt version (`hash` = the 8-hex `prompt_version` recorded on runs/decisions). */
export interface PromptVersionRecord {
  hash: string;
  role: string;
  text: string;
  createdAt: string;
}

/**
 * One version of a business tree's calibration appendix for a role. The latest row per
 * (rootWorkspaceId, role) is the current one (also written to `calibration/<role>.md`).
 * `source`: `apply` (approved patch), `revert` (back to `revertedFrom`), `import` (file found
 * without history, e.g. written before migration 15).
 */
export interface CalibrationVersion {
  id: string;
  rootWorkspaceId: string;
  role: Role;
  text: string;
  source: 'apply' | 'revert' | 'import';
  revertedFrom?: string;
  decisionId?: string;
  actor: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Knowledge store KS-0 (migration 18): rows of the knowledge-store tables
// (docs/superpowers/specs/2026-11-13-knowledge-store-design.md §7, §8, §13, §15).

/** Across-run lifecycle of a fact (design §7.2); independent of the review `status`. */
export type FactLifecycle = 'candidate' | 'current' | 'replaced' | 'retracted';

/** `artifact_texts.status`: `pending` until extraction ran, then the extractor's status (KS-1a). */
export type ExtractionState = 'pending' | 'ok' | 'empty' | 'unsupported' | 'too_large' | 'failed';

/** One act of saving an artifact (design §8.1). Bytes dedupe; captures never do. */
export interface ArtifactCapture {
  id: string;
  artifactId: string;
  /** Home node of the saving run. */
  workspaceId: string;
  agentRunId?: string;
  taskId?: string;
  /** Research run. */
  runId?: string;
  sourceUrl?: string;
  urlKey?: string;
  title?: string;
  flow?: string;
  step?: number;
  note?: string;
  description?: string;
  entityId?: string;
  capturedAt: string;
}

/** Extraction state and text identity of an artifact (one row per artifact). */
export interface ArtifactText {
  artifactId: string;
  workspaceId: string;
  status: ExtractionState;
  /** `name@n` of the extractor that produced the text. */
  extractor?: string;
  error?: string;
  charCount: number;
  tokenEstimate: number;
  /** sha256 of the normalized text (`contentHash`, KS-1a). */
  contentSha256?: string;
  /** Canonical artifact with the same text in the tree; this artifact then has no chunks (design §8.4). */
  duplicateOf?: string;
  extractedAt?: string;
  // Two-pass OCR (migration 21)
  /** Absent: never planned (OCR unavailable when the artifact was ingested). */
  ocrStatus?: OcrState;
  /** What pass 1 decided the model has to read (`OcrPlan` of `knowledge/ocr/rules.ts`). */
  ocrPlan?: unknown;
  /** Why OCR was skipped or failed, or what a finished OCR left unread. */
  ocrError?: string;
  ocrAt?: string;
}

/**
 * `artifact_texts.ocr_status`: `none` — pass 1 settled it, nothing for a model to read; `pending` —
 * waiting for pass 2; `done` — pass 2 ran (its text, if any, is appended); `failed`; `skipped` — a
 * rule forbids sending the file.
 */
export type OcrState = 'none' | 'pending' | 'done' | 'failed' | 'skipped';

/** One model call of OCR pass 2 (`ocr_runs`). Token columns are disjoint, like `agent_usage`. */
export interface OcrRun {
  id: string;
  artifactId: string;
  workspaceId: string;
  target: 'image' | 'pdf';
  /** Pages asked for (an image is `[1]`). */
  pages: number[];
  pagesRead: number;
  provider: string;
  model: string;
  status: 'ok' | 'failed' | 'rate_limited';
  error?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  cliReportedCostUsd?: number;
  priceVersion?: string;
  durationMs: number;
  createdAt: string;
}

/** A passage of extracted text (design §8.3). Named `TextChunk` to avoid clashing with KS-1a's `Chunk`. */
export interface TextChunk {
  id: string;
  artifactId: string;
  workspaceId: string;
  seq: number;
  headingPath: string;
  locator?: string;
  text: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  /** Optional on insert (DB default 0; a trigger copies the artifact's flag). */
  uploadDerived?: boolean;
}

/** A finding's cited evidence with an optional verified quote (design §7.3, `evidence_refs`). */
export interface FindingEvidence {
  findingId: string;
  seq: number;
  artifactId: string;
  /** Locator hint only; re-resolved by substring search after re-extraction. */
  chunkId?: string;
  quote?: string;
  charStart?: number;
  charEnd?: number;
}

export type ObservationKind = 'create' | 'confirm' | 'replace' | 'retract';
/** `pending` until the task ends; `applied` / `rejected` by its outcome; `superseded` when not re-submitted in the final round. */
export type ObservationStatus = 'pending' | 'applied' | 'rejected' | 'superseded';

/** One run's statement about a fact (design §7.2). */
export interface FactObservation {
  id: string;
  workspaceId: string;
  lineageId: string;
  /** The fact the observation is about (`replace`: the new version). */
  findingId: string;
  /** `replace`: the version it replaces. */
  priorFindingId?: string;
  kind: ObservationKind;
  /** Research run. */
  runId?: string;
  taskId?: string;
  agentRunId?: string;
  taskRound?: number;
  /** Artifact ids (confirm / retract must cite ≥ 1 captured by the same task). */
  evidence: string[];
  reason?: string;
  status: ObservationStatus;
  createdAt: string;
  appliedAt?: string;
}

/** Items with their own scope rows; typed records use their `workspace_id` (design §7.1). */
export type ScopedItemKind = 'fact' | 'artifact';
export type ScopeSource = 'home' | 'agent' | 'user';

/** "Item applies to node" label (design §7.1). */
export interface ItemScope {
  itemKind: ScopedItemKind;
  itemId: string;
  workspaceId: string;
  source: ScopeSource;
}

/** A named thing in one business tree (design §7.4). Unique on (root, kind, nameKey). */
export interface Entity {
  id: string;
  rootWorkspaceId: string;
  /** Home node of the record that created it. */
  workspaceId: string;
  kind: EntityKind;
  /** Display name. */
  name: string;
  /** `entityNameKey(name)` (titleKey: trimmed, lowercased, whitespace collapsed). */
  nameKey: string;
  /** Other display names (merged losers keep their name here). */
  aliases: string[];
  /** Set on a merged loser: the survivor. */
  mergedIntoId?: string;
  createdByRun?: string;
  createdAt: string;
  updatedAt: string;
}

/** Closed list of relation types (design §7.4). */
export type RelationType = 'competes_with' | 'offers' | 'has_flow' | 'targets' | 'experiences' | 'causes' | 'addresses' | 'part_of';
/** Kind of record that asserts an edge; the edge is live only while that record is usable. */
export type RelationSourceKind = 'fact' | 'competitor' | 'persona' | 'symptom' | 'hypothesis' | 'artifact';

export interface Relation {
  id: string;
  rootWorkspaceId: string;
  fromEntityId: string;
  type: RelationType;
  toEntityId: string;
  sourceKind: RelationSourceKind;
  sourceId: string;
  createdAt: string;
}

export type MergeSuggestionStatus = 'open' | 'accepted' | 'rejected';

export interface EntityMergeSuggestion {
  id: string;
  rootWorkspaceId: string;
  entityId: string;
  candidateId: string;
  score: number;
  status: MergeSuggestionStatus;
  createdAt: string;
  decidedAt?: string;
  actor?: string;
}

/**
 * Read tools (design §9) plus `prompt_context` (assembled briefings and the reviewer's knowledge
 * context, design §11) and `save_finding` (duplicate-handshake candidates, KS-2).
 */
export type RetrievalTool =
  | 'search' | 'get_card' | 'expand' | 'read_artifact' | 'list_changes' | 'read_workspace' | 'prompt_context'
  | 'save_finding';
/** Who retrieved: an agent role, or the user through the API (design §17). */
export type RetrievalRole = Role | 'user';
/** One returned item, in response order. `kind`: fact, passage, chunk, artifact, entity, record, card, ... */
export type RetrievalResultRef = { id: string; kind: string };

/** Append-only log of every retrieval (design §13). */
export interface RetrievalEvent {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  agentRunId?: string;
  taskId?: string;
  role: RetrievalRole;
  provider?: string;
  model?: string;
  promptVersion?: string;
  tool: RetrievalTool;
  /** Redacted query text (JSON of the input for non-search tools is fine). */
  query: string;
  /** `node` | `tree`, optionally `node:<workspaceId>` when narrowed with `workspace_id`. */
  scope: string;
  resultIds: RetrievalResultRef[];
  resultCount: number;
  tokensReturned: number;
  truncated: boolean;
  relaxed: boolean;
  latencyMs: number;
  /** The response contained upload-derived text: the run is upload-exposed (design §12). */
  uploadDerived: boolean;
  createdAt: string;
}

/** A retrieved item that a later save of the same run cited (design §13 "use linkage"). */
export interface RetrievalUse {
  retrievalEventId: string;
  itemId: string;
  /** finding, recommendation, persona, competitor, hypothesis, observation, ... */
  usedByKind: string;
  usedById: string;
  createdAt: string;
}
