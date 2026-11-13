/**
 * Web-side view of the API contract (Task 14). Domain types come from `src/core/types.ts`; the
 * types below cover API response shapes and the scope/tree fields from Task 10b, declared
 * optional here so the web compiles both before and after that task lands.
 */
import type {
  Artifact,
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

export interface CalibrationReport {
  byCriterion: Array<{
    targetType: RatingTargetType;
    criterion: string;
    n: number;
    agreeRate: number;
    meanDelta: number;
  }>;
}

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
