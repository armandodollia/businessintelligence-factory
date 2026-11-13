/**
 * Shared domain types — the contract between core, api and web.
 * All ids are prefixed ULID-like strings from `newId(prefix)`; timestamps are ISO-8601 strings.
 */
export type { ModelRef, ProviderId, Role, TaskType } from './config/schema.js';
import type { ModelRef, Role, TaskType } from './config/schema.js';

export type Phase =
  | 'market_research'
  | 'competitor_discovery'
  | 'deep_dives'
  | 'synthesis'
  | 'persona_panel'
  | 'scoring';

export type Criteria = Record<string, number | string>;

export interface Workspace {
  id: string;
  name: string;
  sector: string;
  createdAt: string;
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
  taskId: string;
  kind: 'register' | 'login' | 'captcha' | 'approval' | 'other';
  site?: string;
  details: string;
  status: 'pending' | 'resolved' | 'denied';
  response?: string;
  createdAt: string;
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
  enabled: boolean;
}

export interface InterviewTurn {
  id: string;
  workspaceId: string;
  role: 'user' | 'agent';
  text: string;
  createdAt: string;
}

export interface Profile {
  workspaceId: string;
  data: Record<string, unknown>;
}
