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

/** `GET .../competitors`: a rated competitor (spec §9) with its ratable criteria and its task's last review. */
export type CompetitorView = Competitor & { criteria: Criteria; lastReview?: LastReview };

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
  'stakeholders',
  'flow_ranking',
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
  /** The calibration history version the approval created (revertable on the Usage & prompts page). */
  versionId: string;
  promptVersion: string;
  previousPromptVersion: string;
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
  // --- knowledge store KS-5: fact lineage of the next run (absent on older diffs) ---
  replaced?: Array<{ from: string; to: string }>;
  retracted?: string[];
  confirmed?: number;
  // --- end KS-5 ---
  /** Flow records: new flows, new versions, confirmations and ranking moves (absent on older diffs). */
  flows?: FlowChanges;
}

/** "What changed" in the flow records of a node (`scheduler/diff.ts` `FlowChanges`). */
export interface FlowChanges {
  newFlows: string[];
  newVersions: Array<{ from: string; to: string }>;
  confirmed: number;
  rankMoves: Array<{ flowTypeId: string; flowId: string; from: number; to: number }>;
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
  /** KS-5: replaced facts (old → new version), retracted facts and the confirmation count. */
  replaced: Array<{ from: string; to: string }>;
  retracted: string[];
  confirmed: number;
  /** Flow records (empty on older diffs). */
  flows: FlowChanges;
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
  /** Harness-recorded score 0 because the reviewer run failed or returned no valid review (or the council round did not count). */
  synthetic?: boolean;
  /** Review council: the review is a council round of this task. */
  council?: { taskId: string };
}

// --- review council: the council table of a task, the configured council (`src/api/councilRoutes.ts`) ---
export type { CouncilRound, CouncilView, WithheldCouncilRound } from '../../../src/core/council/store.js';
export type { CouncilOverview } from '../../../src/core/council/settings.js';
export type { CouncilResult, MergedIssue } from '../../../src/core/council/merge.js';

export type FindingView = Finding & { lastReview?: LastReview };

export type { OutputStatus } from '../../../src/core/types.js';

/** A finding as listed by the API; `sourceWorkspaceId` names its node (`?scope=tree` lists the whole tree). */
export type TreeFindingView = FindingView & { sourceWorkspaceId?: string };

// --- persona panel (design 2026-11-16-persona-panel-design.md §8) ---
export type { AboutOthersFlag, PanelBaseline, PersonaRuling } from '../../../src/core/types.js';
import type { RecommendationPanel } from '../../../src/core/market/panelView.js';
export type { RecommendationPanel };

/**
 * Recommendation with the last review of the task that saved it (`GET .../recommendations`) and, when
 * the persona panel is configured (or has stored rounds), what the panel shows beyond the current reactions.
 */
export type RecommendationView = Recommendation & { lastReview?: LastReview; panel?: RecommendationPanel };

/** Persona with the last review of the task that last saved it (`GET .../personas`). */
export type PersonaView = PersonaNode & { lastReview?: LastReview };

// --- learning loop WP-A: feedback log and symptom hypotheses -------------------------------
export type { FeedbackEvent, FeedbackKind, FeedbackTargetType } from '../../../src/core/feedback/events.js';
export type { SymptomHypothesis } from '../../../src/core/types.js';

/** `POST /api/hypotheses/:id/correct`: the user's correction (text and/or confidence 0–100) and why. */
export type HypothesisCorrection = import('../../../src/core/feedback/actions.js').HypothesisCorrection & { reason?: string };

// ---------------------------------------------------------------------------
// learning loop WP-B: usage, costs, agent runs, prompt versions, calibration history

export type {
  AgentRunAttempt,
  AgentUsage,
  CalibrationVersion,
  PromptVersionRecord,
} from '../../../src/core/types.js';
export type { RunEvent } from '../../../src/core/harness/adapter.js';

// Same shapes as the core report types (type-only re-exports; no duplicated definitions).
export type { CostGroup, UsageTotals } from '../../../src/core/metrics/usage.js';
export type { BudgetStatus } from '../../../src/core/harness/budget.js';
export type { PromptVersionMetrics } from '../../../src/core/metrics/promptMetrics.js';
export type { RunEventsPage } from '../../../src/core/harness/runEvents.js';

/** `GET /api/costs[?workspaceId=]`: the core cost report plus, with a workspace, its budget status. */
export type CostReport = import('../../../src/core/metrics/usage.js').CostReport & {
  budgets?: import('../../../src/core/harness/budget.js').BudgetStatus[];
};

/** An agent run as listed by `GET /api/workspaces/:id/agent-runs` (no token). */
export type AgentRunView = Omit<import('../../../src/core/types.js').AgentRun, 'token'> & {
  usage: import('../../../src/core/metrics/usage.js').UsageTotals;
};

/** `GET /api/runs/:id`. */
export interface AgentRunDetail {
  run: Omit<import('../../../src/core/types.js').AgentRun, 'token'>;
  attempts: import('../../../src/core/types.js').AgentRunAttempt[];
  usage: import('../../../src/core/metrics/usage.js').UsageTotals;
  usageRows: import('../../../src/core/types.js').AgentUsage[];
}

/** `POST .../calibration/versions/:id/revert`. */
export interface RevertedCalibration {
  path: string;
  version: import('../../../src/core/types.js').CalibrationVersion;
  decisionId: string;
  promptVersion: string;
  previousPromptVersion: string;
}

// ---------------------------------------------------------------------------
// learning loop WP-C: decision outcomes report (`GET .../outcomes`)

export type { OutcomeLabel, OutcomeReport, OutcomeReportRow } from '../../../src/core/learning/types.js';

// --- learning loop WP-F: reviewer audits and experiments --------------------------------------
export type {
  ArmResult,
  AuditMiss,
  AuditSchedule,
  AuditSummary,
  AuditVerdict,
  Experiment,
  ExperimentComparison,
  ReviewerAudit,
} from '../../../src/core/learning/wpfTypes.js';
/** `GET /api/workspaces/:id/audits`: the business tree's audits (newest first), summary and schedules. */
export type AuditsView = {
  rootWorkspaceId: string;
  summary: import('../../../src/core/learning/wpfTypes.js').AuditSummary;
  audits: import('../../../src/core/learning/wpfTypes.js').ReviewerAudit[];
  schedules: import('../../../src/core/learning/wpfTypes.js').AuditSchedule[];
};
export type ExperimentArmInput = { model?: import('../../../src/core/config/schema.js').ModelRef; promptVersion?: string; promptText?: string };
export type NewExperiment = { taskId: string; name?: string; repeats?: number; arms: [ExperimentArmInput, ExperimentArmInput]; confirmBrowser?: boolean };
// --- end WP-F ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flow records and flow ranking: the Flows page (`src/api/flowRoutes.ts` response shapes)

export type {
  CheckAnswer,
  Checklist,
  ChecklistItem,
  Flow,
  FlowCheck,
  FlowOverride,
  FlowStep,
  FlowType,
  FlowVerdict,
  ReviewMention,
  StopReason,
} from '../../../src/core/flows/types.js';
type CoreFlow = import('../../../src/core/flows/types.js').Flow;
type CoreFlowType = import('../../../src/core/flows/types.js').FlowType;
type CoreVerdict = import('../../../src/core/flows/types.js').FlowVerdict;
/** A ruling as the flow routes serve it: with the names ("subject — variant") of its two flows. */
export type ServedOverride = import('../../../src/core/flows/types.js').FlowOverride & { winnerName: string; loserName: string };
type CoreOverride = ServedOverride;
type CoreChecklist = import('../../../src/core/flows/types.js').Checklist;
type CoreStep = import('../../../src/core/flows/types.js').FlowStep;

/** A persona as the flow routes name it (`slug` etc. absent when the persona row is gone). */
export interface FlowPersonaRef {
  id: string;
  slug?: string;
  segment?: string;
  version?: number;
}
export interface FlowSubjectRef {
  id: string;
  name: string;
}

/** `GET .../flows/types`. */
export type FlowTypeRow = CoreFlowType & { flowCount: number; variantCount: number };
export interface FlowTypesView {
  flowTypes: FlowTypeRow[];
  proposals: { flowTypes: CoreFlowType[]; checklists: CoreChecklist[] };
}

export type IgnoredOverride = { id: string; reason: 'conflict' | 'not_ranked' };

/** One position of `GET .../flows/rankings/:flowTypeId` (core `NodeRanking` row plus the subject). */
export interface RankedFlowRow {
  flowId: string;
  /** 1-based; flows sharing a position have the same one. */
  position: number;
  rankScore?: number;
  checklist?: number;
  persona?: number;
  decidedBy: 'blend' | 'checklist_only' | 'persona_only' | 'none';
  tieBrokenWith?: string[];
  sharedPosition?: boolean;
  /** Ids of the user's rulings that moved this flow or the flow it was ruled against. */
  overriddenBy?: string[];
  flow: CoreFlow;
  subject: FlowSubjectRef;
  /** The subject's main way through (served by the rankings' rule; not the stored flag). */
  primary: boolean;
  partial: boolean;
  reviews: { total: number; negative: number };
  wins: number;
  comparisons: number;
}
export interface FlowRankingView {
  flowType: CoreFlowType;
  /** False for a proposed flow type: its flows are listed (position 0) but not ranked until the user accepts it. */
  isRanked: boolean;
  coverage: number;
  ranked: RankedFlowRow[];
  /** Rulings the order does not follow: `conflict` (contradicts a newer one) or `not_ranked` (a flow of it is not in this list). */
  ignoredOverrides: IgnoredOverride[];
  noPersonas: boolean;
  pendingProposals: { flowTypes: number; checklists: number };
  overrides: CoreOverride[];
  personas: FlowPersonaRef[];
}

/** A persona verdict as served: always `simulated`. */
export type ServedVerdict = CoreVerdict & { simulated: true; persona: FlowPersonaRef };

/** `GET .../flows/:flowId`: one flow and everything behind its position (spec §10.5). */
export interface FlowDetailView {
  flow: CoreFlow;
  subject: FlowSubjectRef;
  /** The subject's main way through (served by the rankings' rule; not the stored flag). */
  primary: boolean;
  partial: boolean;
  /** The flow rests on material the user uploaded. */
  upload: boolean;
  /** This is the current version of the flow. */
  current: boolean;
  steps: CoreStep[];
  checks: Array<import('../../../src/core/flows/types.js').FlowCheck & { question: string; scored: boolean }>;
  verdicts: Array<
    ServedVerdict & {
      opponentId: string;
      opponent: { id: string; name?: string; variant?: string; subject?: FlowSubjectRef };
      /** The opponent is in the ranking the persona score comes from. */
      counted: boolean;
    }
  >;
  mentions: Array<import('../../../src/core/flows/types.js').ReviewMention & { counted: boolean }>;
  overrides: CoreOverride[];
  checklist?: number;
  persona?: number;
  coverage: number;
}

/** `GET .../flows/compare?a=&b=`. */
export interface FlowCompareSide {
  flow: CoreFlow;
  subject: FlowSubjectRef;
  /** The subject's main way through (served by the rankings' rule; not the stored flag). */
  primary: boolean;
  partial: boolean;
  steps: CoreStep[];
}
export interface FlowCompareView {
  flowType: CoreFlowType;
  a: FlowCompareSide;
  b: FlowCompareSide;
  verdicts: ServedVerdict[];
  overrides: CoreOverride[];
}

/** `POST .../flows/types/:typeId/decision`. */
export type FlowTypeDecisionInput =
  | { action: 'accept' }
  | { action: 'reject' }
  | { action: 'merge'; intoId: string }
  | { action: 'edit'; name?: string; definition?: string };
/** `GET .../flows/checklists?flowTypeId=`: the active checklists (the specific one when the type has one). */
export interface FlowChecklistsView {
  general: CoreChecklist;
  specific?: CoreChecklist;
}
/** One item's change in `POST .../flows/checklists/:checklistId/edit` (only what changed is sent). */
export type ChecklistItemEdit = { key: string; question?: string; weight?: number; remove?: boolean };
/** `POST .../flows/checklists/:checklistId/edit`: coverage (0–1) and item changes; no new items, no kind or pass rule changes. */
export type ChecklistEditInput = { coverage?: number; items: ChecklistItemEdit[] };

/** `POST .../flows/checklists/:checklistId/decision`. */
export type ChecklistDecisionInput = { action: 'accept'; coverage?: number } | { action: 'reject' };
export type FlowReaction = 'agree' | 'disagree';

// ---------------------------------------------------------------------------
// Persona learning: the "What the tool has learned" block (`src/api/personaLearningRoutes.ts` shapes)

export type {
  GateResult,
  GateStats,
  PersonaAdjustment,
  PersonaLearningRun,
  PersonaProposal,
  PersonaSignal,
} from '../../../src/core/personas/types.js';
type CoreGateStats = import('../../../src/core/personas/types.js').GateStats;
/** Gate numbers when the adjustment was proposed (`before`) and of the persona's signals since it last changed. */
export type AdjustmentEffect = { before: Partial<CoreGateStats>; since: CoreGateStats };
/** One persona of the node in `GET .../persona-learning`. */
export interface PersonaLearningEntry {
  personaId: string;
  segment: string;
  version: number;
  gate: import('../../../src/core/personas/types.js').GateResult;
  adjustments: Array<import('../../../src/core/personas/types.js').PersonaAdjustment & { effect: AdjustmentEffect }>;
  /** Pending first, then decided, newest first, at most 20. */
  proposals: import('../../../src/core/personas/types.js').PersonaProposal[];
  lastRun?: Pick<import('../../../src/core/personas/types.js').PersonaLearningRun, 'id' | 'status' | 'assumption' | 'createdAt' | 'stats'>;
}
/** `GET .../persona-learning`. */
export interface PersonaLearningView {
  enabled: boolean;
  personas: PersonaLearningEntry[];
  /** Pending persona proposals in the whole business tree (the Lessons page count). */
  pendingInTree?: number;
  /** Of those, the proposals about the person using the tool (their user persona; the You page). */
  pendingUser?: number;
}

// ---------------------------------------------------------------------------
// User persona: the You page (`src/api/userPersonaRoutes.ts` shapes; mirrors `src/core/userPersona/interactions.ts`)

export type UserStance = 'accept' | 'reject' | 'edit' | 'neutral';
/** One of the person's actions in the tree, as the learning run reads it. */
export interface UserInteraction {
  id: string;
  kind: string;
  stance: UserStance;
  target: string;
  topic: string;
  detail: string;
  reason?: string;
  refs: string[];
  at: string;
}
/** Open actions toward the next retro and what is missing ("7 of 12 actions"). */
export type UserInteractionGate = { n: number; targets: number; qualifies: boolean; missing: string[] };
/** The person's actions over the window, by kind and stance. */
export type UserInteractionStats = { byKind: Record<string, Partial<Record<UserStance, number>>>; total: number };
type CorePersonaAdjustment = import('../../../src/core/personas/types.js').PersonaAdjustment;
/** An active line of the user persona (served without `actor`) and the number of actions it rests on. */
export type UserPersonaLine = Omit<CorePersonaAdjustment, 'actor'> & { evidence: number };
/** `GET .../user-persona`. */
export interface UserPersonaView {
  enabled: boolean;
  usedBy: string[];
  useInPrompts: boolean;
  gate: UserInteractionGate;
  stats: UserInteractionStats;
  persona?: { id: string; version: number };
  fields: Array<{ field: string; lines: UserPersonaLine[] }>;
  /** Pending first, then decided, newest first, at most 20 (served without `actor`). */
  proposals: import('../../../src/core/personas/types.js').PersonaProposal[];
  lastRun?: Pick<import('../../../src/core/personas/types.js').PersonaLearningRun, 'id' | 'status' | 'assumption' | 'createdAt'>;
}

// ---------------------------------------------------------------------------
// Stakeholder personas: the Stakeholders page and reads on a recommendation (`src/api/stakeholderRoutes.ts` shapes)

export type { StakeholderQuestion, StakeholderRead, StakeholderStatement, StakeholderType } from '../../../src/core/stakeholders/types.js';
type CoreStakeholderType = import('../../../src/core/stakeholders/types.js').StakeholderType;
/** All a hidden stakeholder shows (design §7): label, type and the number of its open questions. */
export interface HiddenStakeholderView {
  id: string;
  label: string;
  stakeholderType: CoreStakeholderType;
  disclosure: 'hidden';
  questions: number;
}
/** An open stakeholder: what research found, its review status and how many statements the user made. */
export type OpenStakeholderView = Omit<HiddenStakeholderView, 'disclosure'> & {
  disclosure: 'open';
  /** `former`: a parked former colleague, who left for somewhere that is no competitor. */
  subjectKind: 'own' | 'competitor' | 'former';
  relation: string;
  /** For a former colleague: the combined profile, each field with what it rests on (`basis`, `conflict`). */
  profile: Record<string, PersonaProfileField>;
  version: number;
  status: string;
  includeOverride?: boolean;
  statements: number;
  /** The current title, when the user gave one. */
  positionTitle?: string;
  /** Former colleagues only: the day the person left (YYYY-MM-DD) and the position held then. */
  leftAt?: string;
  leftFrom?: import('../../../src/core/types.js').LeftFrom;
  /** Former colleagues only: what research last saw of the person's company and title. */
  publicPosition?: { text: string; evidence: string[] };
  /** Former colleagues only: whether research has stored a public layer. */
  hasPublicLayer?: boolean;
};
export type StakeholderView = HiddenStakeholderView | OpenStakeholderView;
type PersonaProfileField = import('../../../src/core/types.js').PersonaProfileField;
/** Where a person can go: the competitors and the nodes of the business tree. */
export interface StakeholderPlaces {
  competitors: Array<{ competitorId: string; name: string }>;
  nodes: Array<{ workspaceId: string; name: string }>;
}
/** `GET .../stakeholders`. `own`: own stakeholders that have not left; `former`: parked former colleagues. */
export interface StakeholdersView {
  enabled: boolean;
  own: StakeholderView[];
  competitors: Array<{ competitorId: string; name: string; stakeholders: StakeholderView[] }>;
  /** Absent from a server older than stakeholder positions, like `places`. */
  former?: StakeholderView[];
  places?: StakeholderPlaces;
}
/** `GET .../stakeholders/:personaId/positions`: the history, newest first, and the two layers of a former colleague. */
export interface StakeholderPositionsView {
  positions: Array<import('../../../src/core/stakeholders/types.js').StakeholderPosition & { placeName?: string }>;
  /** What we knew: the profile as it was when the person left. */
  internalProfile?: Record<string, PersonaProfileField>;
  /** What is public: what research found on the web since. */
  publicProfile?: Record<string, PersonaProfileField>;
  /** With a public layer: when research saved it. */
  publicSavedAt?: string;
  /** With a public layer: false when the research that saved it failed (stored, not used). */
  publicLayerUsed?: boolean;
  /** With a public layer: how the research that saved it ended (`pending`: not yet). `unverified` research is used. */
  publicLayerStatus?: 'verified' | 'unverified' | 'failed' | 'pending';
  /** When the combined profile was last written from both layers. */
  combinedAt?: string;
}
/** `POST .../stakeholders/:personaId/position`. `left` for a former colleague: they moved on to another company. */
export type StakeholderPositionInput =
  | {
      change: 'left';
      date: string;
      to: { competitorId: string } | { newCompetitor: { name: string; site?: string } } | { elsewhere: { companyName?: string } };
      label?: string;
      title?: string;
      note?: string;
    }
  | { change: 'moved' | 'promoted' | 'demoted'; date: string; toWorkspaceId?: string; stakeholderType?: CoreStakeholderType; title?: string; note?: string }
  | { change: 'returned'; date: string; toWorkspaceId: string; label?: string; stakeholderType?: CoreStakeholderType; title?: string; note?: string };
/** One group of `GET .../stakeholder-questions`; no `persona`: the node-wide questions. */
export interface StakeholderQuestionGroup {
  persona?: { id: string; label: string; stakeholderType: CoreStakeholderType };
  questions: import('../../../src/core/stakeholders/types.js').StakeholderQuestion[];
}
/** `POST .../stakeholder-questions/answers`. */
export interface StakeholderAnswersInput {
  answers: Array<{ questionId: string; text: string }>;
  skip?: string[];
  skipAll?: boolean;
}
/** A read of `GET .../recommendations/:recId/stakeholder-reads`, with its stakeholder's label and type. */
export type ServedStakeholderRead = import('../../../src/core/stakeholders/types.js').StakeholderRead & {
  /** The user's latest reaction to this read, when they reacted to it. */
  reaction?: 'agree' | 'disagree';
  reactionReason?: string;
  label: string;
  stakeholderType: CoreStakeholderType;
  /** `former`: an old read of a stakeholder who has since left for somewhere that is no competitor. */
  subjectKind: 'own' | 'competitor' | 'former';
};
export type RealDecision = NonNullable<import('../../../src/core/stakeholders/types.js').StakeholderStatement['decision']>;

// --- feedback bundle (`src/api/feedbackBundleRoutes.ts`) ------------------------------------------
export type BundleLevel = 'standard' | 'with_texts';
/** What the tester chose: the level, the period (days, both optional) and a note. */
export type BundleChoices = { level: BundleLevel; since?: string; until?: string; note?: string };
/** What the file would hold: each section with its rows and its size as JSON; `totalBytes` is the file's size. */
export type BundlePreview = {
  id: string;
  level: BundleLevel;
  fileName: string;
  sections: Array<{ name: string; rows: number; bytes: number }>;
  totalBytes: number;
  firstRows?: { section: string; rows: unknown[] };
};
// --- end feedback bundle -------------------------------------------------------------------------

// --- setup check and data folder: the Settings page (`src/api/setupRoutes.ts`) -------------------
export type { ChromeCheck, CliCheck, SetupReport } from '../../../src/core/setup/doctor.js';
/** What `GET /api/setup` answers: the check (null on a server without one), the version and where things are. */
export type SetupInfo = {
  available: boolean;
  report: import('../../../src/core/setup/doctor.js').SetupReport | null;
  /** Whether a configuration file exists (none on the first run). */
  configExists: boolean;
  version: string;
  /** True in the desktop app: data, configuration and logs are in the application folder. */
  packaged: boolean;
  folders: { app?: string; data: string; config?: string; logs?: string; browserProfile?: string; open: string };
  canOpenFolder: boolean;
};
// --- end setup check -----------------------------------------------------------------------------
