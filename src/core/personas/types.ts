/**
 * Persona learning (migration 24; design 2026-11-15-persona-learning-design.md): the user's reactions
 * to simulated personas become proposed persona adjustments in the weekly retro. Types only (no
 * runtime imports), so the web app can mirror them.
 */

/** Where a persona signal came from. */
export type SignalSource =
  | 'verdict_reaction'
  | 'override'
  | 'feedback_rating'
  | 'profile_rating'
  | 'include'
  // stakeholder personas (stakeholder design §11)
  | 'read_reaction'
  | 'decision_record';

/** One reaction of the user to something a persona said, read from the feedback log. */
export type PersonaSignal = {
  id: string;
  source: SignalSource;
  personaId: string;
  personaVersion?: number;
  polarity: 'agree' | 'disagree';
  /** The item reacted to (one item counts once toward `minDistinctItems`). */
  itemKey: string;
  topic: string;
  detail: string;
  reason?: string;
  refs: string[];
  at: string;
};

/** Gate numbers of a persona's signals: count, agree / disagree, distinct items, lower bound of the disagree rate. */
export type GateStats = { n: number; agree: number; disagree: number; items: number; lower: number };
export type GateResult = GateStats & { qualifies: boolean; missing: string[] };

/** `active`: applied to the persona. `retired`: no longer applied. */
export type AdjustmentStatus = 'active' | 'retired';

/** One accepted adjustment of a persona (`persona_adjustments`). */
export interface PersonaAdjustment {
  id: string;
  rootWorkspaceId: string;
  workspaceId: string;
  personaId: string;
  /** Persona field the adjustment refines, when it targets one. */
  field?: string;
  /** Tracking marker (unique). */
  marker: string;
  text: string;
  version: number;
  status: AdjustmentStatus;
  source: 'retro' | 'engine' | 'user';
  /** The accepted proposal that created it. */
  proposalId?: string;
  actor: string;
  /** Gate numbers when it was proposed. */
  stats: Partial<GateStats>;
  /** Accepted from a proposal of a run that was shown the user's statements (stakeholder design §11): internal text, left out of exports by default. */
  internal: boolean;
  createdAt: string;
  changedAt: string;
  endedAt?: string;
  /**
   * The persona version its last accepted `add` or `replace` made. Reactions to output of an older
   * persona version do not count toward its effect (absent: every reaction counts).
   */
  personaVersion?: number;
}

export type ProposalAction = 'add' | 'replace' | 'retire';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

/** A proposed persona adjustment the user accepts or rejects (`persona_proposals`). */
export interface PersonaProposal {
  id: string;
  rootWorkspaceId: string;
  workspaceId: string;
  personaId: string;
  runId?: string;
  action: ProposalAction;
  /** The adjustment replaced or retired. */
  adjustmentId?: string;
  field?: string;
  text: string;
  rationale: string;
  /** Signal ids behind the proposal. */
  evidence: string[];
  stats: Partial<GateStats>;
  source: 'retro' | 'engine';
  status: ProposalStatus;
  /** The text as accepted (after the user's edits). */
  finalText?: string;
  createdAt: string;
  decidedAt?: string;
  actor?: string;
  reason?: string;
  decisionId?: string;
  feedbackEventId?: string;
  /** Its run was shown the user's statements (stakeholder design §11), or it retires an internal adjustment; absent: false. */
  internal?: boolean;
}

export type LearningRunStatus = 'running' | 'proposed' | 'no_change' | 'failed';

/** One persona's learning pass inside a retro (`persona_learning_runs`). */
export interface PersonaLearningRun {
  id: string;
  rootWorkspaceId: string;
  personaId: string;
  retroId?: string;
  status: LearningRunStatus;
  /** Newest signal time the run read. */
  signalsThrough: string;
  /** Signals shown to the agent (the only ones a proposal may cite). */
  shownSignalIds: string[];
  /** Stakeholder statements shown to the agent (a proposal may cite them too); consumed when the run ends `proposed` or `no_change`. */
  shownStatementIds: string[];
  stats: GateStats;
  assumption?: string;
  agentRunId?: string;
  failureReason?: string;
  createdAt: string;
  endedAt?: string;
}
