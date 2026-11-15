/**
 * Flow records and flow ranking (design 2026-11-14-flow-records-and-ranking-design.md §7–§10): the
 * record types of the module. Tables are created by migration 22; repositories are in `./repos.ts`.
 */
import type { OutputStatus } from '../types.js';

/** Longest step text (action, observation, error), "anything else notable", check note and recorded value (tool bound). */
export const FLOW_TEXT_MAX = 2000;
/** Longest flow name, goal, variant and item of `asked` (tool bound). */
export const FLOW_LABEL_MAX = 200;

/**
 * A flow type of a business tree's catalog (sign-up, checkout, ...). A `rejected` type is kept so a
 * re-proposal of its key does not ask the user again.
 */
export type FlowTypeStatus = 'proposed' | 'active' | 'merged' | 'rejected';
export interface FlowType {
  id: string;
  rootWorkspaceId: string;
  /** Normalized name; unique per business tree. */
  key: string;
  name: string;
  /** One-line definition of the job. */
  definition: string;
  status: FlowTypeStatus;
  mergedIntoId?: string;
  proposedByRun?: string;
  createdAt: string;
  updatedAt: string;
}

export type CheckKind = 'yes_no' | 'count' | 'one_of' | 'recorded';
export type CheckAnsweredBy = 'walkthrough' | 'reviews' | 'both';
export interface ChecklistItem {
  key: string;
  question: string;
  kind: CheckKind;
  options?: string[];
  /** yes_no: the passing answer; count: passes when value <= max; one_of: the passing options. Absent for `recorded`. */
  pass?: { answer?: 'yes' | 'no'; max?: number; options?: string[] };
  weight: number;
  /** objective = true (counts in the checklist score), audience_dependent = false. */
  scored: boolean;
  answeredBy: CheckAnsweredBy;
  source?: string;
}
export interface Checklist {
  id: string;
  rootWorkspaceId: string;
  /** Absent = the general checklist. */
  flowTypeId?: string;
  version: number;
  status: 'proposed' | 'active' | 'retired';
  /** How much of judging the flow type the objective checks settle, 0–1. */
  coverage: number;
  items: ChecklistItem[];
  origin: 'builtin' | 'agent' | 'user';
  createdAt: string;
  acceptedAt?: string;
}

export type FlowLifecycle = 'candidate' | 'current' | 'replaced';
export type StopReason = 'payment' | 'phone' | 'kyc' | 'captcha' | 'approval_needed' | 'error' | 'not_found';
/** One subject's way of doing one flow type, as observed (one version of it). */
export interface Flow {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  subjectEntityId: string;
  flowTypeId: string;
  variant: string;
  variantKey: string;
  isPrimary: boolean;
  name: string;
  goal: string;
  entryUrl?: string;
  reachedGoal: boolean;
  stopReason?: StopReason;
  /** Unscored "anything else notable". */
  notable?: string;
  /** Hash of the normalized step sequence (sameness on re-walk). */
  stepsHash: string;
  lineageId: string;
  version: number;
  replacesId?: string;
  lifecycle: FlowLifecycle;
  status: OutputStatus;
  taskId?: string;
  taskRound?: number;
  includeOverride?: boolean;
  runId?: string;
  /** The knowledge-store `flow` entity. */
  entityId?: string;
  firstSeenAt: string;
  lastConfirmedAt?: string;
  confirmCount: number;
  createdAt: string;
}
export interface FlowStep {
  flowId: string;
  seq: number;
  action: string;
  observation: string;
  /** What the step asked the user for (fields, permissions, commitments). */
  asked: string[];
  error?: string;
  artifactId?: string;
  pageUrl?: string;
}

export type CheckAnswer = 'pass' | 'fail' | 'na' | 'recorded' | 'reported_problem' | 'no_signal' | 'disputed';
export interface FlowCheck {
  flowId: string;
  checklistId: string;
  itemKey: string;
  answer: CheckAnswer;
  value?: unknown;
  stepRefs: number[];
  mentionRefs: string[];
  note?: string;
  origin: 'walkthrough' | 'reviews' | 'user';
  updatedAt: string;
}

export type ReviewSourceType = 'app_store' | 'review_site' | 'forum' | 'community' | 'support_board' | 'social' | 'user_provided';
/** One piece of public (or user-provided) feedback, quoted from a stored copy of its source. */
export interface ReviewMention {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  subjectEntityId: string;
  sourceType: ReviewSourceType;
  sourceUrl?: string;
  artifactId: string;
  chunkId?: string;
  quote: string;
  quoteHash: string;
  publishedAt?: string;
  rating?: number;
  polarity: 'negative' | 'neutral' | 'positive';
  flowTypeId?: string;
  checkKey?: string;
  attributionConfidence: number;
  taskId?: string;
  createdAt: string;
}

/** One persona's judgment of one pair of flows. Always simulated. */
export interface FlowVerdict {
  id: string;
  workspaceId: string;
  flowTypeId: string;
  flowAId: string;
  /** flowAId < flowBId */
  flowBId: string;
  personaId: string;
  personaVersion: number;
  stage: 'broad' | 'focused';
  winner: 'a' | 'b' | 'tie';
  strength: 1 | 2 | 3;
  confidence: number;
  reason: string;
  agentRunId?: string;
  supersededById?: string;
  createdAt: string;
}

/** The user's ruling on a pair. Always wins. */
export interface FlowOverride {
  id: string;
  workspaceId: string;
  flowTypeId: string;
  winnerFlowId: string;
  loserFlowId: string;
  reason?: string;
  actor: string;
  needsConfirm: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface FlowRankSnapshot {
  id: string;
  workspaceId: string;
  flowTypeId: string;
  researchRunId?: string;
  /** `rankScore` is absent for a flow with neither a checklist nor a persona score yet. */
  ranking: Array<{ flowId: string; position: number; rankScore?: number }>;
  createdAt: string;
}
