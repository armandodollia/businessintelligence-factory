/**
 * Web-side view of the API contract (Task 14). Domain types come from `src/core/types.ts`; the
 * types below cover API response shapes and the scope/tree fields from Task 10b, declared
 * optional here so the web compiles both before and after that task lands.
 */
import type {
  Artifact,
  Competitor,
  Criteria,
  Finding,
  InterviewTurn,
  Persona,
  Phase,
  Rating,
  Recommendation,
  Schedule,
  Symptom,
  Workspace,
} from '../../../src/core/types.js';
import type { BifConfig } from '../../../src/core/config/schema.js';

export type {
  AgentRun,
  Artifact,
  Competitor,
  Criteria,
  Decision,
  Finding,
  InterviewTurn,
  Persona,
  PersonaFeedback,
  Phase,
  Rating,
  Recommendation,
  ResearchRun,
  Schedule,
  Symptom,
  Task,
  UserRequest,
  Workspace,
} from '../../../src/core/types.js';
export type { BusEvent } from '../../../src/core/events.js';
export type { BifConfig };

export type ScopeLevel = 'company' | 'division' | 'slice';
export type Audience = 'external' | 'internal';
export interface WorkspaceScope {
  level: ScopeLevel;
  name: string;
  description: string;
}

/** Workspace plus Task 10b fields (scope, audiences, tree link). */
export type WorkspaceNode = Workspace & {
  scope?: WorkspaceScope;
  audiences?: Audience[];
  parentWorkspaceId?: string;
};

export interface CreateWorkspaceInput {
  name: string;
  sector: string;
  scope?: WorkspaceScope;
  audiences?: Audience[];
  parentWorkspaceId?: string;
}

export interface TreeNode {
  workspace: WorkspaceNode;
  children: TreeNode[];
}

export interface UnitProposal {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  level: ScopeLevel;
  audiences: Audience[];
  evidence: string[];
  reasoning: string;
  status: 'proposed' | 'accepted' | 'rejected';
  childWorkspaceId?: string;
}

export type UnitProposalEdits = Partial<Pick<UnitProposal, 'name' | 'description' | 'level' | 'audiences'>>;

export type Sourced<T> = T & { sourceWorkspaceId: string };

export interface CrossCuttingGroup {
  /** Normalized title used for grouping. */
  key: string;
  title: string;
  sourceWorkspaceIds: string[];
  symptoms: Sourced<Symptom>[];
}

export interface Rollup {
  symptoms: Sourced<Symptom>[];
  recommendations: Sourced<Recommendation>[];
  findings: Sourced<Finding>[];
  crossCutting?: CrossCuttingGroup[];
}

export interface InterviewState {
  turns: InterviewTurn[];
  coverage: Record<string, boolean>;
}

export type RatingTargetType = Rating['targetType'];
export type RatingInput = Omit<Rating, 'id' | 'createdAt' | 'agentValue'>;

export interface ReviewQueueItem {
  targetType: RatingTargetType;
  targetId: string;
  title: string;
  criteria: Criteria;
  /** Criterion keys not yet rated by the user. */
  unrated: string[];
}

export interface CalibrationRow {
  targetType: RatingTargetType;
  criterion: string;
  n: number;
  agreeRate: number;
  meanDelta: number;
}

export interface CalibrationReport {
  byCriterion: CalibrationRow[];
  /** Same, per role and task type that produced the value (spec §10). */
  byRoleTask?: Array<CalibrationRow & { role: string; taskType?: string }>;
}

/** `GET .../competitors`: a rated competitor (spec §9) with its ratable criteria. */
export type CompetitorView = Competitor & { criteria: Criteria };

/**
 * Ratable finding criteria (mirrors core `CRITERIA.finding`). Competitor keys (threat, pricing,
 * ...) belong on competitors, never on findings.
 */
export const FINDING_CRITERIA = ['relevance', 'reliability', 'novelty'] as const;

/** Ratable competitor criteria (mirrors core `CRITERIA.competitor`). */
export const COMPETITOR_CRITERIA = ['threat', 'directness', 'pricing', 'onboarding', 'ux', 'features'] as const;

export type PersonaNode = Persona & { audience?: Audience };

export type NewSchedule = Pick<Schedule, 'name' | 'cron' | 'phases' | 'enabled'>;
export type SchedulePatch = Partial<NewSchedule>;

export interface EvidenceItem {
  id: string;
  /** Bytes URL (`GET /api/artifacts/:id`). */
  url: string;
  /** Metadata, when the server provides it. */
  artifact?: Artifact;
}

export interface EvidenceGroups {
  /** Screenshot flows, each ordered by step. */
  flows: Array<{ flow: string; items: EvidenceItem[] }>;
  /** Archived pages, documents, uploads, text and unknown artifacts. */
  links: EvidenceItem[];
}

/** `mapping` (Task 10b) is optional and runs first when present; not in the default set. */
export type ResearchPhase = Phase | 'mapping';
export const OPTIONAL_PHASES: ResearchPhase[] = ['mapping'];

export const ALL_PHASES: ResearchPhase[] = [
  'market_research',
  'competitor_discovery',
  'deep_dives',
  'synthesis',
  'persona_panel',
  'scoring',
];

// ---------------------------------------------------------------------------
// calibration patches, scoring weights, "what changed" (Task 14 routes)

/** Agent roles a prompt calibration patch can target (mirrors `ROLES` in the core config). */
export const PATCH_ROLES = ['orchestrator', 'worker', 'reviewer', 'interviewer', 'persona', 'synthesizer'] as const;
export type PatchRole = (typeof PATCH_ROLES)[number];

/** `POST .../calibration/prompt-patch` → proposed patch (nothing written yet). */
export interface PromptPatch {
  role: PatchRole;
  examples: Array<{ criterion: string; agentValue: unknown; userValue: unknown; reason?: string }>;
  patchText: string;
}

/** `POST .../calibration/prompt-patch/apply` → where the patch was written. */
export interface AppliedPromptPatch {
  path: string;
  decisionId: string;
}

/** Recommendation criteria the priority weights apply to (mirrors `RECOMMENDATION_KEYS`). */
export const WEIGHT_KEYS = [
  'upside',
  'difficulty',
  'cost',
  'timeToValue',
  'risk',
  'confidence',
  'strategicFit',
  'competitiveUrgency',
] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

/** `GET/PUT .../scoring-weights`. */
export interface ScoringWeights {
  weights: Record<string, number>;
  personaWeight: number;
  proposedWeights?: Record<string, number>;
  decisionId?: string;
}

/** `subject`: competitor / company the flow belongs to (absent on diffs recorded before final review C). */
export type ChangedArtifact = { subject?: string; flow: string; step: number; prev: string; next: string };

/** Payload of a scheduler "what changed" Decision (`GET .../changes`). */
export interface WhatChangedPayload {
  actor?: string;
  event: 'what_changed';
  scheduleId?: string;
  scheduleName?: string;
  phase?: string;
  prevRunId?: string;
  nextRunId?: string;
  /** Finding ids new in the next run. */
  newFindings?: string[];
  removedSubjects?: string[];
  changedArtifacts?: ChangedArtifact[];
}

/** One "what changed" entry as shown on the Research page. */
export interface ChangeEntry {
  id: string;
  createdAt: string;
  scheduleName: string;
  phase: string;
  newFindings: string[];
  removedSubjects: string[];
  changedArtifacts: ChangedArtifact[];
  /** True when the diff found nothing. */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// findings with review state, current ratings

/** Latest reviewer verdict on a finding's task (`GET .../findings` → `lastReview`). */
export interface LastReview {
  score: number;
  issues: Array<{ id?: string; class?: string; description?: string; evidence?: string[] }>;
  decisionId: string;
  at: string;
  /** Harness-recorded score 0 because the reviewer run failed or returned no valid review. */
  synthetic?: boolean;
}

export type FindingView = Finding & { lastReview?: LastReview };

export type { OutputStatus } from '../../../src/core/types.js';

/** A finding as listed by the API; `sourceWorkspaceId` names its node (`?scope=tree` lists the whole tree). */
export type TreeFindingView = FindingView & { sourceWorkspaceId?: string };

/** Recommendation with the last review of the task that saved it (`GET .../recommendations`). */
export type RecommendationView = Recommendation & { lastReview?: LastReview };

/** Persona with the last review of the task that last saved it (`GET .../personas`). */
export type PersonaView = PersonaNode & { lastReview?: LastReview };
