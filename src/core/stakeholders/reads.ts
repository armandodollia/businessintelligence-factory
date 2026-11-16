/**
 * Stakeholder reads (stakeholder design §7, §10): in the `persona_panel` phase, after the segment
 * personas, each open, usable stakeholder persona of the node reads each usable recommendation of the
 * node — own stakeholders first, then competitors' (each by slug) — in at most `maxReadsPerPanel` runs.
 * A former colleague at a competitor reads as that competitor's stakeholder (a rival read); a parked
 * former colleague (`subjectKind: 'former'`) reads nothing (positions design §6).
 *
 * A read is one ordinary `persona` run (no browser) whose system prompt is the persona's agent.md and
 * whose user prompt is `stakeholder_read.md`. A read by a persona whose agent.md holds internal content
 * (`holdsInternal`: an own stakeholder, and a former colleague at a competitor) is offline, on the
 * persona model or, when that model cannot run offline, on one that can (`offlineModel`); when no
 * enabled provider can, its reads are skipped and one harness Decision says why. A read by a
 * competitor's stakeholder that never worked here is not offline (final review item 5). The persona answers
 * with `submit_stakeholder_read`; the handler refuses a stance outside the persona's set (`OWN_STANCES`
 * or `RIVAL_STANCES`) and a read of another recommendation than the one asked. The dispatcher records
 * the call as a `persona_feedback` Decision (as for `submit_persona_feedback`), which the runner stamps
 * with the persona and the recommendation and turns into the stored read, replacing the persona's
 * earlier read of that recommendation. A run that ends without a read is retried once, as in the panel.
 *
 * Reads are simulated and never change the recommendation (its priority, its persona feedback).
 */
import { latestFeedback, recordFeedback, type FeedbackEvent } from '../feedback/events.js';
import { cleanReason, FlowFeedbackError } from '../flows/feedback.js';
import { NO_OFFLINE_MODEL, offlineModel } from '../harness/offline.js';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import type { ToolInput } from '../harness/tools/registry.js';
import { fenceEvidence, redactServed } from '../knowledge/trust.js';
import { agentMdOf } from '../market/panel.js';
import { loadPrompt, renderTemplate } from '../prompts/index.js';
import { recordPromptVersion } from '../prompts/store.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type ResearchDeps } from '../research/deps.js';
import { isOutputUsable } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Persona, Recommendation } from '../types.js';
import { rootOf, scopeOf } from '../workspace/tree.js';
import { isHidden, stakeholderPersonas } from './personas.js';
import { holdsInternal, isParked } from './kinds.js';
import { stakeholdersSettings } from './settings.js';
import { StakeholderError } from './statements.js';
import { stakeholderRepos } from './store.js';
import { OWN_STANCES, RIVAL_STANCES, type StakeholderRead } from './types.js';

/** Runs per (recommendation, stakeholder) that may end without `submit_stakeholder_read`. */
export const READ_ATTEMPTS = 2;

/** Agent run id of the harness Decision recording the pairs skipped by the cap (no agent run). */
export const READS_ACTOR = 'stakeholder_reads';

export type ReadsReport = {
  /** Reads stored (one per stakeholder per recommendation that answered). */
  reads: number;
  /** Pairs whose stakeholder never submitted a valid read (after retry, or with the cap used up). */
  missing: Array<{ recommendationId: string; personaId: string; reason: string }>;
  /** Pairs not asked because `maxReadsPerPanel` runs were used up. */
  skippedByCap: number;
};

const fail = (error: string): ToolResult => ({ ok: false, error });

/** Reads as a rival: a competitor's stakeholder, whether or not they once worked here. */
const isRival = (p: Pick<Persona, 'subjectKind'>) => p.subjectKind === 'competitor';

/** Reads as an own stakeholder (an approval read): neither a competitor's stakeholder nor parked (`isParked` takes part in no read). */
const readsAsOwn = (p: Pick<Persona, 'kind' | 'subjectKind'>) => !isRival(p) && !isParked(p);

const stancesOf = (p: Pick<Persona, 'subjectKind'>): readonly string[] => (isRival(p) ? RIVAL_STANCES : OWN_STANCES);

/** What each running read was asked, by agent run id (set when the run starts, removed when it ends). */
const asked = new Map<string, { personaId: string; recommendationId: string; stances: readonly string[] }>();

/**
 * `submit_stakeholder_read` handler (persona runs of `runStakeholderReads`). The dispatcher's zod schema
 * bounds the texts and arrays; here: the run was asked for a read, of this recommendation, and the
 * stance belongs to the persona's set. Stores nothing: the dispatcher records the `persona_feedback`
 * Decision on success and the runner stores the read from it.
 */
export const submitStakeholderReadHandler: ExtraToolHandler = async (ctx, raw) => {
  const input = raw as ToolInput<'submit_stakeholder_read'>;
  const read = asked.get(ctx.agentRunId);
  if (!read) return fail('this run was not asked for a stakeholder read');
  if (input.recommendation_id !== read.recommendationId) {
    return fail(`read the recommendation you were given: recommendation_id must be '${read.recommendationId}'`);
  }
  if (!read.stances.includes(input.stance)) return fail(`stance must be one of ${read.stances.join(', ')}`);
  return { ok: true, data: { recommendationId: read.recommendationId, simulated: true } };
};

/** The open, usable stakeholder personas of the node that read: own first, then competitors', each by slug; never a parked former colleague. */
function readers(store: Store, workspaceId: string): Persona[] {
  const open = stakeholderPersonas(store, workspaceId).filter((p) => isOutputUsable(p) && !isHidden(p));
  const bySlug = (a: Persona, b: Persona) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return [...open.filter(readsAsOwn).sort(bySlug), ...open.filter(isRival).sort(bySlug)];
}

/** The read prompt: the recommendation fenced as untrusted data, and the question for an own or a competitor's stakeholder. */
function readPrompt(store: Store, template: string, rec: Recommendation, persona: Persona, scope: string): string {
  const rival = isRival(persona);
  const text = redactServed(store, rec.workspaceId, `Title: ${rec.title}\n\n${rec.summary}`);
  return renderTemplate(template, {
    scope,
    recommendation_id: rec.id,
    recommendation: fenceEvidence(rec.id, text),
    question: rival
      ? `Imagine ${scope}, your rival, did this. How would your company respond: ignore it, watch it, copy it, or counter ` +
        'it? Say what would worry you about it and why.'
      : 'Would you approve this if it came to you? Say on what conditions you would approve it and what worries you. ' +
        'Say `not_my_call` when the decision is not yours.',
    stances: stancesOf(persona).join(', '),
    conditions: rival ? 'what would make your company act on it' : 'the conditions you would set before approving it',
  });
}

/** Stamps the persona and the recommendation on every `submit_stakeholder_read` Decision of a run. */
function stampRead(store: Store, agentRunId: string, personaId: string): void {
  for (const d of store.decisions.list({ agentRunId, kind: 'persona_feedback' })) {
    const p = (d.payload ?? {}) as Record<string, unknown>;
    const recId = (p.input as { recommendation_id?: unknown } | undefined)?.recommendation_id;
    if (p.tool !== 'submit_stakeholder_read' || typeof recId !== 'string') continue;
    const payload = { ...p, personaId, recommendationId: recId, targetId: `${recId}:${personaId}` };
    store.decisions.update(d.id, { payload, refs: [...new Set([...d.refs, recId, personaId])] });
  }
}

/** Last `submit_stakeholder_read` Decision of a run for `recId` with a stance of the persona's set. */
function readOfRun(store: Store, agentRunId: string, recId: string, persona: Persona): { decision: Decision; input: ToolInput<'submit_stakeholder_read'> } | undefined {
  const ds = store.decisions.list({ agentRunId, kind: 'persona_feedback' });
  for (let i = ds.length - 1; i >= 0; i--) {
    const p = ds[i]!.payload as { tool?: string; input?: ToolInput<'submit_stakeholder_read'> } | null;
    if (p?.tool === 'submit_stakeholder_read' && p.input?.recommendation_id === recId && stancesOf(persona).includes(p.input.stance)) {
      return { decision: ds[i]!, input: p.input };
    }
  }
  return undefined;
}

/** Stores the read, replacing the persona's earlier read of the recommendation (one row per pair). */
function storeRead(store: Store, rec: Recommendation, persona: Persona, agentRunId: string, input: ToolInput<'submit_stakeholder_read'>): StakeholderRead {
  const repo = stakeholderRepos(store).reads;
  const fields = {
    personaVersion: persona.version,
    stance: input.stance,
    conditions: input.conditions,
    concerns: input.concerns,
    reasoning: input.reasoning,
    wouldChangeMind: input.would_change_mind,
    agentRunId,
    simulated: true as const,
    createdAt: new Date().toISOString(),
  };
  return store.transaction(() => {
    const existing = repo.list({ recommendationId: rec.id, personaId: persona.id })[0];
    if (existing) return repo.update(existing.id, fields);
    return repo.insert({
      id: newId('srd'), rootWorkspaceId: rootOf(store, rec.workspaceId), workspaceId: rec.workspaceId, recommendationId: rec.id, personaId: persona.id, ...fields,
    });
  });
}

/**
 * Stakeholder reads of the node's usable recommendations (design §10). Nothing runs when stakeholders
 * are disabled. The first `maxReadsPerPanel` pairs (in reader order) are asked; the rest are counted
 * in `skippedByCap` and recorded in one harness Decision. A retry is a run too: it is made only while
 * the cap allows. Usable after the segment personas in the `persona_panel` phase.
 */
export async function runStakeholderReads(workspaceId: string, deps: ResearchDeps): Promise<ReadsReport> {
  const { store, config } = deps;
  const report: ReadsReport = { reads: 0, missing: [], skippedByCap: 0 };
  const settings = stakeholdersSettings(config);
  if (!settings.enabled) return report;
  const model = config.roles.persona;
  const internalModel = offlineModel(config, model);
  const recs = store.recommendations.list({ workspaceId }).filter(isOutputUsable);
  let personas = readers(store, workspaceId);
  const unreadable = internalModel ? [] : personas.filter(holdsInternal);
  if (unreadable.length && recs.length) {
    personas = personas.filter((p) => !holdsInternal(p));
    recordHarnessDecision(
      store,
      { agentRunId: READS_ACTOR, workspaceId, role: 'persona', model, promptVersion: 'n/a' },
      'decision',
      { event: 'stakeholder_reads_offline_unavailable', reason: NO_OFFLINE_MODEL, personaIds: unreadable.map((p) => p.id) },
      unreadable.map((p) => p.id),
    );
  }
  const pairs = personas.flatMap((persona) => recs.map((rec) => ({ persona, rec })));
  if (!pairs.length) return report;
  const ws = store.workspaces.get(workspaceId);
  const scope = ws ? scopeOf(ws).name : workspaceId;
  const template = loadPrompt('stakeholder_read');

  const cap = settings.maxReadsPerPanel;
  const asking = pairs.slice(0, cap);
  const skipped = pairs.slice(cap);
  if (skipped.length) {
    report.skippedByCap = skipped.length;
    recordHarnessDecision(
      store,
      { agentRunId: READS_ACTOR, workspaceId, role: 'persona', model, promptVersion: 'n/a' },
      'decision',
      {
        event: 'stakeholder_reads_capped', maxReadsPerPanel: cap, skipped: skipped.length,
        personaIds: [...new Set(skipped.map((s) => s.persona.id))],
      },
      [...new Set(skipped.map((s) => s.persona.id))],
    );
  }
  let runs = 0;

  const one = async (rec: Recommendation, persona: Persona, systemPrompt: string): Promise<void> => {
    const prompt = readPrompt(store, template.text, rec, persona, scope);
    // Positions design §6: an agent.md holding internal content never reaches a run with web access.
    const offline = holdsInternal(persona);
    const runModel = offline ? internalModel! : model;
    const version = recordPromptVersion(store, 'persona', `${systemPrompt}\n${template.text}`);
    let reason = 'no submit_stakeholder_read call';
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      if (attempt > 1 && runs >= cap) {
        reason = `${reason}; no retry: maxReadsPerPanel (${cap}) runs used`;
        break;
      }
      runs++;
      throwIfAborted(deps.signal);
      let runId: string | undefined;
      try {
        const outcome = await runAgent(deps, {
          kind: 'work', role: 'persona', workspaceId, round: 1, attempt, prompt, systemPrompt, model: runModel, needsBrowser: false, promptVersion: version,
          ...(offline ? { offline: true } : {}),
          onStart: (ctx) => {
            runId = ctx.agentRunId;
            asked.set(ctx.agentRunId, { personaId: persona.id, recommendationId: rec.id, stances: stancesOf(persona) });
          },
        });
        stampRead(store, outcome.agentRunId, persona.id);
        throwIfAborted(deps.signal);
        const found = readOfRun(store, outcome.agentRunId, rec.id, persona);
        if (found) {
          storeRead(store, rec, persona, outcome.agentRunId, found.input);
          report.reads++;
          return;
        }
        reason = outcome.status === 'failed' ? `run failed: ${outcome.reason ?? `exit ${outcome.exitCode}`}` : 'no submit_stakeholder_read call';
        recordHarnessDecision(
          store,
          { agentRunId: outcome.agentRunId, workspaceId, role: 'persona', model: runModel, promptVersion: version },
          'decision',
          { event: 'stakeholder_read_missing', recommendationId: rec.id, personaId: persona.id, attempt, reason, willRetry: attempt < READ_ATTEMPTS && runs < cap },
          [rec.id, persona.id],
        );
      } finally {
        if (runId) asked.delete(runId);
      }
    }
    report.missing.push({ recommendationId: rec.id, personaId: persona.id, reason });
  };

  const systemPrompts = new Map<string, string>();
  const jobs = asking.map(({ persona, rec }) => {
    let systemPrompt = systemPrompts.get(persona.id);
    if (systemPrompt === undefined) {
      systemPrompt = agentMdOf(deps, persona);
      systemPrompts.set(persona.id, systemPrompt);
    }
    return one(rec, persona, systemPrompt);
  });
  const results = await Promise.allSettled(jobs);
  const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (err) throw err.reason;
  return report;
}

/** A stored read with the user's latest reaction to it, when they reacted to this run's read. */
export type ReadWithReaction = StakeholderRead & { reaction?: 'agree' | 'disagree'; reactionReason?: string };

/**
 * The stored reads of a recommendation of the caller's tree, by open stakeholders only (a hidden one's
 * read is never returned, §7): own first, then competitors', then the reads a parked former colleague
 * made before leaving, each by slug. Each carries the user's latest reaction to it (and its reason),
 * unless a newer run has replaced the read since.
 */
export function readsOf(store: Store, workspaceId: string, recommendationId: string): ReadWithReaction[] {
  const root = rootOf(store, workspaceId);
  const rank = (p: Persona) => `${isParked(p) ? 2 : isRival(p) ? 1 : 0}:${p.slug}`;
  return stakeholderRepos(store)
    .reads.list({ recommendationId, rootWorkspaceId: root })
    .flatMap((r) => {
      const p = store.personas.get(r.personaId);
      return p && p.kind === 'stakeholder' && !isHidden(p) ? [{ r, key: rank(p) }] : [];
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ r }) => withReaction(store, r));
}

function withReaction(store: Store, read: StakeholderRead): ReadWithReaction {
  const e = latestFeedback(store, { workspaceId: read.workspaceId, kind: 'stakeholder_read_reaction', targetType: 'stakeholder_read', targetId: read.id });
  const reaction = (e?.afterJson as { reaction?: unknown } | undefined)?.reaction;
  if (!e || e.agentRunId !== read.agentRunId || (reaction !== 'agree' && reaction !== 'disagree')) return read;
  return { ...read, reaction, ...(e.reason ? { reactionReason: e.reason } : {}) };
}

/**
 * The user agrees or disagrees with a read, with an optional reason (cleaned like other reasons: at
 * most 2,000 characters, redacted). Records `stakeholder_read_reaction` on the read. 404 for an
 * unknown read, one of another tree or of a hidden stakeholder; 400 for an unknown reaction or reason.
 */
export function reactToRead(
  store: Store,
  actor: string,
  workspaceId: string,
  readId: string,
  reaction: 'agree' | 'disagree',
  reason?: string,
): FeedbackEvent {
  const read = typeof readId === 'string' ? stakeholderRepos(store).reads.get(readId) : undefined;
  const persona = read ? store.personas.get(read.personaId) : undefined;
  if (!read || read.rootWorkspaceId !== rootOf(store, workspaceId) || !persona || isHidden(persona)) {
    throw new StakeholderError(`stakeholder read '${String(readId)}' not found`, 404);
  }
  if (reaction !== 'agree' && reaction !== 'disagree') throw new StakeholderError('reaction must be agree or disagree', 400);
  let cleaned: string | undefined;
  try {
    cleaned = cleanReason(store, read.workspaceId, reason);
  } catch (e) {
    if (e instanceof FlowFeedbackError) throw new StakeholderError(e.message, 400);
    throw e;
  }
  const run = store.agentRuns.get(read.agentRunId);
  return recordFeedback(store, {
    workspaceId: read.workspaceId,
    actor,
    kind: 'stakeholder_read_reaction',
    targetType: 'stakeholder_read',
    targetId: read.id,
    afterJson: { reaction, personaId: read.personaId, personaVersion: read.personaVersion, recommendationId: read.recommendationId, stance: read.stance },
    ...(cleaned ? { reason: cleaned } : {}),
    agentRunId: read.agentRunId,
    ...(run?.promptVersion ? { promptVersion: run.promptVersion } : {}),
  });
}
