/**
 * Stakeholder personas (migration 25; design 2026-11-15-stakeholder-personas-design.md): simulated
 * personas of the people, teams and systems a node depends on, stored as `personas` rows with
 * `kind: 'stakeholder'`, plus their question round, the user's statements and their simulated reads of
 * recommendations. Types and constants only (no runtime imports), so the web app can mirror them.
 */

export const STAKEHOLDER_TYPES = ['leader', 'manager', 'investor', 'board', 'owner', 'team', 'system', 'regulator', 'partner', 'other'] as const;
export type StakeholderType = (typeof STAKEHOLDER_TYPES)[number];

/** Stances of an own stakeholder's read (§10). */
export const OWN_STANCES = ['approve', 'approve_with_conditions', 'reject', 'not_my_call'] as const;
/** Stances of a competitor stakeholder's read (§10): how the rival would respond. */
export const RIVAL_STANCES = ['ignore', 'watch', 'copy', 'counter'] as const;
/** A real decision the user records on a recommendation (§9). */
export const REAL_DECISIONS = ['approved', 'approved_with_conditions', 'rejected', 'deferred'] as const;

/** One templated question of the question round (§8). No `personaId`: a node-wide question. Id prefix `stq_`. */
export interface StakeholderQuestion {
  id: string;
  rootWorkspaceId: string;
  workspaceId: string;
  personaId?: string;
  field: string;
  text: string;
  status: 'open' | 'answered' | 'skipped';
  /** The statement its answer became. */
  statementId?: string;
  createdAt: string;
  answeredAt?: string;
}

/**
 * Something the user said about a stakeholder (§9). Append-only (the table refuses DELETE and any
 * change except setting `consumedByRunId`). No `personaId`: node-wide, or about someone not yet known.
 * Id prefix `sst_`.
 */
export interface StakeholderStatement {
  id: string;
  rootWorkspaceId: string;
  workspaceId: string;
  personaId?: string;
  source: 'question_answer' | 'note' | 'decision_record' | 'interview';
  field?: string;
  text: string;
  questionId?: string;
  recommendationId?: string;
  decision?: (typeof REAL_DECISIONS)[number];
  actor: string;
  createdAt: string;
  /** The persona learning run that was shown it. */
  consumedByRunId?: string;
}

/** A stakeholder persona's simulated read of one recommendation (§10); one per persona and recommendation. Id prefix `srd_`. */
export interface StakeholderRead {
  id: string;
  rootWorkspaceId: string;
  workspaceId: string;
  recommendationId: string;
  personaId: string;
  personaVersion: number;
  /** One of `OWN_STANCES` (own stakeholder) or `RIVAL_STANCES` (competitor stakeholder). */
  stance: string;
  conditions: string[];
  concerns: string[];
  reasoning: string;
  wouldChangeMind: string;
  agentRunId: string;
  simulated: true;
  createdAt: string;
}

/** Kinds of row in a stakeholder's position history (positions design §4). `joined`: where the person was before the first recorded change. */
export const POSITION_CHANGES = ['joined', 'moved', 'promoted', 'demoted', 'left', 'returned'] as const;

/**
 * One row of a stakeholder persona's position history (migration 28; design
 * 2026-11-15-stakeholder-positions-design.md §4): the place the person is in from `effectiveOn` on.
 * Append-only (the table refuses UPDATE and DELETE). `placeKind` `node`: a node of the tree
 * (`workspaceId`); `competitor`: the competitor `competitorId`; `elsewhere`: a company that is no
 * competitor (`companyName`, when the user gave one). No `effectiveOn`: the `joined` baseline. Id prefix `spo_`.
 */
export interface StakeholderPosition {
  id: string;
  rootWorkspaceId: string;
  personaId: string;
  change: (typeof POSITION_CHANGES)[number];
  placeKind: 'node' | 'competitor' | 'elsewhere';
  workspaceId?: string;
  competitorId?: string;
  companyName?: string;
  stakeholderType?: StakeholderType;
  title?: string;
  relation?: string;
  /** YYYY-MM-DD. */
  effectiveOn?: string;
  actor: string;
  note?: string;
  createdAt: string;
}
