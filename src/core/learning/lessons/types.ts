/**
 * Learning loop WP-E (migration 19): lessons engine and weekly retro. Types only (no runtime imports
 * beyond role types), so the web app can mirror them.
 */
import type { Role } from '../../config/schema.js';

/** `active`: appended to the role's prompt. `retired`: clean long enough. `reverted`: its rate did not drop. */
export const LESSON_RULE_STATUSES = ['active', 'retired', 'reverted'] as const;
export type LessonRuleStatus = (typeof LESSON_RULE_STATUSES)[number];

/** Who proposed the rule: the deterministic engine, or the retro agent (a prompt edit). */
export type LessonSource = 'engine' | 'retro';

/**
 * One lesson rule of a role in one business tree (`lesson_rules`). Only `active` rules are in the
 * role's prompt, each line tagged `[<marker>.v<version>]` (the tracking marker), so the prompt text of
 * any run tells whether (and which version of) the rule was in it.
 */
export interface LessonRule {
  id: string;
  rootWorkspaceId: string;
  role: Role;
  /** Signal category (`review:substantive:news_scan`, `outcome:missed-evidence`, ...; retro: `retro:<proposal id>`). */
  category: string;
  /** Tracking marker, e.g. `L-7F3A2C` (unique). */
  marker: string;
  text: string;
  /** 1–3: strengthened while the category keeps recurring. */
  strength: number;
  /** Bumped by every accepted change of the text (strengthen). */
  version: number;
  status: LessonRuleStatus;
  source: LessonSource;
  /** The accepted proposal that created it. */
  proposalId?: string;
  /** Who accepted it. */
  actor: string;
  createdAt: string;
  /** Last accepted change (creation or strengthening). */
  changedAt: string;
  endedAt?: string;
  /** Role prompt version before / after the last accepted change (recorded in the prompt store). */
  promptVersionBefore?: string;
  promptVersionAfter?: string;
}

/**
 * - `add`: a new rule (engine). `strengthen`: a stronger text for an active rule. `retire` / `revert`:
 *   take an active rule out of the prompt.
 * - `prompt_edit` (retro): a rule written by the retro agent; accepted like `add`.
 * - `calibration_edit` (retro): a note merged into the role's calibration appendix (WP-B history).
 */
export const LESSON_ACTIONS = ['add', 'strengthen', 'retire', 'revert', 'prompt_edit', 'calibration_edit'] as const;
export type LessonAction = (typeof LESSON_ACTIONS)[number];

export const LESSON_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'superseded'] as const;
export type LessonProposalStatus = (typeof LESSON_PROPOSAL_STATUSES)[number];

/**
 * One piece of evidence behind a proposal: always an id; `quote` only for text that is neither
 * upload-derived nor from an upload-exposed run / task (export bound, design §12), redacted then cut.
 */
export type LessonEvidence = { kind: string; id: string; taskId?: string; quote?: string };

/** Numbers behind a proposal (shown to the user; never text). */
export type LessonStats = {
  /** Distinct tasks (or task-less runs) the category occurred in. */
  tasks?: number;
  /** Under the rule's current version / without the rule. */
  withRule?: number;
  withRuleHits?: number;
  rateWithRule?: number | null;
  beforeRule?: number;
  beforeRuleHits?: number;
  rateBeforeRule?: number | null;
  cleanStreak?: number;
};

export interface LessonProposal {
  id: string;
  rootWorkspaceId: string;
  role: Role;
  action: LessonAction;
  category?: string;
  ruleId?: string;
  /** The rule text (add / strengthen / prompt_edit), the calibration note, or the rule being taken out. */
  text: string;
  rationale: string;
  evidence: LessonEvidence[];
  stats: LessonStats;
  source: LessonSource;
  retroId?: string;
  status: LessonProposalStatus;
  createdAt: string;
  decidedAt?: string;
  actor?: string;
  reason?: string;
  decisionId?: string;
  feedbackEventId?: string;
}

/** A signal another package records for the lessons engine (`recordLessonSignal`), e.g. a WP-F audit miss. */
export interface LessonSignalRecord {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  role: Role;
  category: string;
  /** Who recorded it (`reviewer_audit`, ...). */
  source: string;
  /** Idempotency key within `source` (a replay adds nothing). */
  sourceKey?: string;
  taskId?: string;
  agentRunId?: string;
  promptVersion?: string;
  /** The source record (audit id, ...). */
  refId?: string;
  /** Free text for the user; quoted in proposals only under the upload rules. */
  note?: string;
  createdAt: string;
}

export type RetroStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface RetroRecord {
  id: string;
  rootWorkspaceId: string;
  status: RetroStatus;
  triggeredBy: 'schedule' | 'user';
  windowStart: string;
  windowEnd: string;
  agentRunId?: string;
  /** Counts of the digest (no text). */
  digest: Record<string, number>;
  /** Ids shown in the digest: the only ids the retro may cite as evidence. */
  evidenceIds: string[];
  proposalIds: string[];
  summary?: string;
  failureReason?: string;
  createdAt: string;
  endedAt?: string;
}
