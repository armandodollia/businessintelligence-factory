import type { BifConfig } from '../config/schema.js';
import type { ToolClient } from '../harness/adapter.js';
import type { RunOptions, Supervisor } from '../harness/supervisor.js';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import { listUploads } from '../internal/uploads.js';
import { drillDown } from './hypotheses.js';
import { loadPrompt } from '../prompts/index.js';
import { calibrationScope } from '../scoring/calibration.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Criteria, Decision, InterviewTurn, Symptom, Workspace } from '../types.js';
import { audiencesOf, scopeOf } from '../workspace/tree.js';

export const INTERVIEW_TOPICS = ['basics', 'revenue_model', 'customers', 'going_well', 'going_badly'] as const;
export type InterviewTopic = (typeof INTERVIEW_TOPICS)[number];

/**
 * In-process interviewer for tests / dry runs: may call tools and returns the reply text (what a
 * real CLI run produces as its final message).
 */
export type InterviewerFake = (tools: ToolClient) => Promise<string | void>;

export type InterviewDeps = {
  store: Store;
  config: BifConfig;
  supervisor: Pick<Supervisor, 'run'>;
  fake?: InterviewerFake;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// coverage

/** Profile keys that mark a topic as covered (besides the topic key itself). */
const TOPIC_KEYS: Record<'basics' | 'revenue_model' | 'customers', string[]> = {
  basics: ['basics', 'sector', 'business_model', 'size', 'geography'],
  revenue_model: ['revenue_model', 'revenue_streams', 'pricing'],
  customers: ['customers', 'customer_segments'],
};

const present = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Which checklist topics are covered: profile topics when the profile holds a non-empty value
 * under one of their keys; `going_well` / `going_badly` when a strength / symptom exists.
 */
export function interviewCoverage(workspaceId: string, deps: { store: Store }): Record<InterviewTopic, boolean> {
  const data = deps.store.profiles.get(workspaceId)?.data ?? {};
  const symptoms = deps.store.symptoms.list({ workspaceId });
  const has = (keys: string[]) => keys.some((k) => present(data[k]));
  return {
    basics: has(TOPIC_KEYS.basics),
    revenue_model: has(TOPIC_KEYS.revenue_model),
    customers: has(TOPIC_KEYS.customers),
    going_well: symptoms.some((s) => s.kind === 'strength'),
    going_badly: symptoms.some((s) => s.kind === 'symptom'),
  };
}

// ---------------------------------------------------------------------------
// prompt

/** The per-turn user prompt: scope, audiences, coverage, profile, symptoms, uploads, transcript. */
export function buildInterviewPrompt(ws: Workspace, store: Store): string {
  const scope = scopeOf(ws);
  const profile = store.profiles.get(ws.id)?.data ?? {};
  const coverage = interviewCoverage(ws.id, { store });
  const symptoms = store.symptoms.list({ workspaceId: ws.id });
  const uploads = listUploads(ws.id, { store });
  const turns = store.interview.list({ workspaceId: ws.id });
  const lines: string[] = [
    `# Workspace: ${ws.name}${ws.sector ? ` (${ws.sector})` : ''}`,
    '',
    '## Scope',
    `- level: ${scope.level}`,
    `- name: ${scope.name}`,
    `- description: ${scope.description || '(none)'}`,
    `- audiences: ${audiencesOf(ws).join(', ')}`,
    '',
    '## Coverage checklist',
    ...INTERVIEW_TOPICS.map((t) => `- [${coverage[t] ? 'x' : ' '}] ${t}`),
    '',
    '## Current profile (JSON)',
    '```json',
    JSON.stringify(profile, null, 2),
    '```',
    '',
    '## Saved symptoms and strengths',
    ...(symptoms.length
      ? symptoms.map((s) => `- [${s.kind}] ${s.title} — ${JSON.stringify(s.criteria)} (id ${s.id})`)
      : ['(none yet)']),
    '',
    ...drillDownSection(store, ws.id, symptoms),
    '## Internal uploads (ids + titles; contents not included)',
    ...(uploads.length ? uploads.map((u) => `- ${u.id}: ${u.title}`) : ['(none)']),
    '',
    '## Transcript',
    ...turns.map((t) => `**${t.role === 'user' ? 'User' : 'Interviewer'}:** ${t.text}`),
    '',
    'Reply to the latest user message with your next interviewer turn. Save what you learned with the tools first.',
  ];
  return lines.join('\n');
}

const MAX_VERIFIED_FINDINGS = 30;
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Drill-down context (spec §8): research hypotheses per symptom (with the verified findings they
 * cite) and the titles of verified research findings, so the interviewer can ask targeted
 * follow-ups. Empty when research produced neither.
 */
function drillDownSection(store: Store, workspaceId: string, symptoms: Symptom[]): string[] {
  const byId = new Map(symptoms.map((s) => [s.id, s]));
  const hyps = drillDown(store, workspaceId);
  const verified = store.findings.list({ workspaceId, status: 'verified' });
  const lines: string[] = [];
  if (hyps.size) {
    lines.push('## Research hypotheses per symptom (ask targeted follow-ups to confirm or refute them)');
    for (const [symptomId, items] of hyps) {
      const s = byId.get(symptomId);
      lines.push(`- Symptom "${s?.title ?? symptomId}" (id ${symptomId}):`);
      for (const { hypothesis: h, verifiedFindings } of items) {
        lines.push(`  - Hypothesis (${h.confidence}% confidence): ${clip(h.hypothesis)}`);
        for (const f of verifiedFindings) lines.push(`    - verified finding: ${f.subject}: ${clip(f.claim, 160)}`);
      }
    }
    lines.push('');
  }
  if (verified.length) {
    lines.push('## Verified research findings (titles)');
    for (const f of verified.slice(-MAX_VERIFIED_FINDINGS)) lines.push(`- ${f.subject}: ${clip(f.claim, 160)}`);
    lines.push('');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// turn

function insertTurn(store: Store, workspaceId: string, role: InterviewTurn['role'], text: string, agentRunId?: string): InterviewTurn {
  const turn: InterviewTurn = { id: newId('itv'), workspaceId, role, text, createdAt: new Date().toISOString() };
  if (agentRunId) turn.agentRunId = agentRunId; // WP-A: the interviewer run (migration 14)
  return store.interview.insert(turn);
}

/**
 * Stores the user's turn, runs the interviewer agent (role `interviewer`) once over the profile,
 * symptoms, coverage checklist and full transcript, and stores + returns its reply turn. The agent
 * may call `update_profile` / `save_symptom` (wired via `interviewToolHandlers()`). Throws when
 * the run fails or produces no reply; the user's turn stays stored so the chat can be resumed.
 */
export async function sendInterviewMessage(workspaceId: string, text: string, deps: InterviewDeps): Promise<InterviewTurn> {
  const { store, config, supervisor } = deps;
  const ws = store.workspaces.get(workspaceId);
  if (!ws) throw new Error(`workspace '${workspaceId}' not found`);
  if (!text.trim()) throw new Error('interview message is empty');
  const userTurn = insertTurn(store, workspaceId, 'user', text);

  const prompt = loadPrompt('interviewer', calibrationScope(store, config.dataDir, workspaceId));
  let fakeReply: string | undefined;
  const opts: RunOptions = {
    ctx: { workspaceId, role: 'interviewer', model: config.roles.interviewer, promptVersion: prompt.version },
    prompt: buildInterviewPrompt(ws, store),
    systemPrompt: prompt.text,
    needsBrowser: false,
  };
  if (deps.signal) opts.signal = deps.signal;
  const fake = deps.fake;
  if (fake) {
    opts.fake = async (tools) => {
      const r = await fake(tools);
      if (typeof r === 'string') fakeReply = r;
    };
  }
  const outcome = await supervisor.run(opts);
  // WP-A: link the user's turn to the interviewer run that answered (or tried to answer) it.
  store.interview.update(userTurn.id, { agentRunId: outcome.agentRunId });
  if (outcome.status !== 'done') {
    throw new Error(`interviewer run ${outcome.agentRunId} failed${outcome.reason ? `: ${outcome.reason}` : ` (exit ${outcome.exitCode})`}`);
  }
  const reply =
    fakeReply ??
    outcome.events
      .filter((e): e is Extract<typeof e, { t: 'message' }> => e.t === 'message')
      .map((e) => e.text)
      .at(-1);
  if (!reply?.trim()) throw new Error(`interviewer run ${outcome.agentRunId} produced no reply`);
  return insertTurn(store, workspaceId, 'agent', reply.trim(), outcome.agentRunId);
}

// ---------------------------------------------------------------------------
// tool handlers (plugged in via createToolHandlers({ extraHandlers }))

const fail = (error: string): ToolResult => ({ ok: false, error });

/** RFC 7386 JSON merge patch: objects merge recursively, `null` deletes, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** Profile keys owned by the app (see `uploadInternal`); `update_profile` patches never touch them. */
export const PROTECTED_PROFILE_KEYS = ['uploads'] as const;

const TRENDS: Record<string, string> ={ '↑': '↑', '→': '→', '↓': '↓', up: '↑', flat: '→', down: '↓' };

/** Validates/normalizes symptom criteria (severity 1–5, trend ↑/→/↓, causeConfidence 0–100). */
export function validateSymptomCriteria(c: Criteria): { ok: true; criteria: Criteria } | { ok: false; error: string } {
  const severity = Number(c.severity);
  if (c.severity === undefined || !Number.isFinite(severity) || severity < 1 || severity > 5) {
    return { ok: false, error: 'criteria.severity must be a number 1–5' };
  }
  const trend = TRENDS[String(c.trend ?? '').trim().toLowerCase()];
  if (!trend) return { ok: false, error: "criteria.trend must be one of '↑', '→', '↓'" };
  const cc = Number(c.causeConfidence);
  if (c.causeConfidence === undefined || !Number.isFinite(cc) || cc < 0 || cc > 100) {
    return { ok: false, error: 'criteria.causeConfidence must be a number 0–100 (percent)' };
  }
  return { ok: true, criteria: { ...c, severity, trend, causeConfidence: cc } };
}

/** `update_profile` + `save_symptom` handlers for the interviewer role. */
export function interviewToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return {
    async update_profile(ctx, raw, deps) {
      const input = raw as ToolInput<'update_profile'>;
      const { store } = deps;
      // App-managed keys (internal upload links) cannot be set, replaced or deleted by agents.
      const patch = { ...input.patch };
      const ignored = PROTECTED_PROFILE_KEYS.filter((k) => Object.hasOwn(patch, k));
      for (const k of ignored) delete patch[k];
      const data = store.transaction(() => {
        const existing = store.profiles.get(ctx.workspaceId);
        const next = mergePatch(existing?.data ?? {}, patch) as Record<string, unknown>;
        if (existing) store.profiles.update(ctx.workspaceId, { data: next });
        else store.profiles.insert({ workspaceId: ctx.workspaceId, data: next });
        return next;
      });
      return { ok: true, data: ignored.length ? { profile: data, ignored, note: `${ignored.join(', ')} is managed by the app` } : { profile: data } };
    },

    async save_symptom(ctx, raw, deps) {
      const input = raw as ToolInput<'save_symptom'>;
      const { store, artifacts, events } = deps;
      const v = validateSymptomCriteria(input.criteria);
      if (!v.ok) return fail(v.error);
      const missing = artifacts.exists(ctx.workspaceId, input.evidence);
      if (missing.length) return fail(`evidence references unknown artifacts (not in this workspace): ${missing.join(', ')}`);
      // Idempotent per (run, kind, title): a replayed call returns the symptom already saved.
      const replay = findReplay(store, ctx, 'save_symptom', 'run', (p) => {
        const prior = store.symptoms.get(String(p.symptomId));
        return !!prior && prior.kind === input.kind && titleKey(prior.title) === titleKey(input.title);
      });
      if (replay) return { ok: true, data: { symptomId: (replay.payload as { symptomId: string }).symptomId, duplicate: true } };
      const symptom: Symptom = {
        id: newId('sym'),
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        criteria: v.criteria,
        evidence: input.evidence,
      };
      const decision: Decision = {
        id: newId('dec'),
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        role: ctx.role,
        model: ctx.model,
        kind: 'score',
        payload: { tool: 'save_symptom', symptomId: symptom.id, kind: symptom.kind, criteria: v.criteria },
        refs: [...new Set([symptom.id, ...input.evidence])],
        promptVersion: ctx.promptVersion,
        createdAt: new Date().toISOString(),
      };
      store.transaction(() => {
        store.symptoms.insert(symptom);
        store.decisions.insert(decision);
      });
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
      return { ok: true, data: { symptomId: symptom.id } };
    },
  };
}
