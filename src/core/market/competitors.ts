import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Competitor, CompetitorComparison, Decision } from '../types.js';
// knowledge store KS-3
import { linkCompetitor } from '../knowledge/entityLinks.js';

/** Competitor of a workspace by normalized name (case / whitespace insensitive). */
export function findCompetitor(store: Store, workspaceId: string, name: string): Competitor | undefined {
  const key = titleKey(name);
  return store.competitors.list({ workspaceId }).find((c) => titleKey(c.name) === key);
}

/** The agent's value of one competitor criterion (`threat`, `directness`, or a comparison area). */
export function competitorValue(c: Competitor, criterion: string): number | undefined {
  if (criterion === 'threat') return c.threat;
  if (criterion === 'directness') return c.directness;
  return Object.hasOwn(c.comparison, criterion) ? c.comparison[criterion as keyof CompetitorComparison] : undefined;
}

/** Ratable values of a competitor, keyed by criterion (spec §9). */
export function competitorCriteria(c: Competitor): Record<string, number> {
  return { threat: c.threat, directness: c.directness, ...c.comparison };
}

/**
 * `save_competitor` (worker; spec §9): creates or updates (same workspace + normalized name) a rated
 * competitor and logs a `score` Decision (`competitorId`, ratings, evidence) atomically. Evidence
 * must be artifacts of this business tree. An unchanged re-save logs no new judgment: by the owning
 * task it just marks the round (superseded tracking); when the competitor stays with another task
 * (verified there) or the run has no task, a `decision`-kind reuse record (`reused: true`, once per
 * run + competitor) ties the run to it for provenance / export filtering only.
 */
export const saveCompetitorHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'save_competitor'>;
  const { store, artifacts, events } = deps;
  const missing = artifacts.exists(ctx.workspaceId, input.evidence);
  if (missing.length) {
    return { ok: false, error: `evidence references unknown artifacts (not in this workspace's business tree): ${missing.join(', ')}` };
  }
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const owner = task && task.workspaceId === ctx.workspaceId ? task : undefined;
  const taskId = owner?.id;
  // Review tracking (migration 13): pending until the saving task's review loop ends; the round marks
  // it as (re-)submitted in that round (superseded tracking). Without an owning task nothing will
  // ever review it: `unverified`.
  const tracking: Pick<Competitor, 'status' | 'taskRound'> = owner
    ? { status: 'pending', taskRound: owner.round }
    : { status: 'unverified', taskRound: undefined };
  const now = new Date().toISOString();
  const values = { threat: input.threat, directness: input.directness, comparison: input.comparison };

  const result = store.transaction(() => {
    const prior = findCompetitor(store, ctx.workspaceId, input.name);
    if (prior) {
      const evidence = [...new Set([...prior.evidence, ...input.evidence])];
      const same =
        JSON.stringify({ threat: prior.threat, directness: prior.directness, comparison: prior.comparison }) === JSON.stringify(values) &&
        (input.site ?? prior.site) === prior.site;
      if (same && evidence.length === prior.evidence.length) {
        // Unchanged content already verified by another task (or re-saved without a task): keep its
        // owner and status. Otherwise it is re-submitted, current for this task's round.
        const keep = !owner || (prior.taskId !== owner.id && prior.status === 'verified');
        const competitor = keep ? prior : store.competitors.update(prior.id, { ...tracking, taskId: owner.id });
        // Reuse record: ties this run (and its task) to the competitor for provenance / export
        // filtering even when ownership stays with another task.
        const recorded = store.decisions
          .list({ agentRunId: ctx.agentRunId })
          .some((d) => {
            const p = d.payload as { tool?: string; competitorId?: string; reused?: boolean } | null;
            return p?.tool === 'save_competitor' && p.competitorId === prior.id && p.reused === true;
          });
        const reuse = keep && !recorded ? record(store, ctx, prior, input.evidence, { reused: true, unchanged: true }, 'decision') : undefined;
        linkCompetitor(store, competitor, { agentRunId: ctx.agentRunId }); // knowledge store KS-3
        return { competitor, decision: reuse, duplicate: true };
      }
      const patch: Partial<Competitor> = { ...values, evidence, updatedAt: now, ...tracking };
      if (input.site !== undefined) patch.site = input.site;
      patch.taskId = taskId; // a change without a task clears the owner (it is unverified)
      const competitor = store.competitors.update(prior.id, patch);
      const decision = same ? undefined : record(store, ctx, competitor, input.evidence, { revision: true, previous: { threat: prior.threat, directness: prior.directness, comparison: prior.comparison } });
      linkCompetitor(store, competitor, { agentRunId: ctx.agentRunId }); // knowledge store KS-3
      return { competitor, decision, duplicate: false };
    }
    const competitor: Competitor = {
      id: newId('cmp'),
      workspaceId: ctx.workspaceId,
      name: input.name.trim(),
      ...values,
      evidence: [...new Set(input.evidence)],
      createdAt: now,
      updatedAt: now,
      ...tracking,
    };
    if (input.site !== undefined) competitor.site = input.site;
    if (taskId) competitor.taskId = taskId;
    store.competitors.insert(competitor);
    linkCompetitor(store, competitor, { agentRunId: ctx.agentRunId }); // knowledge store KS-3: entity + competes_with
    return { competitor, decision: record(store, ctx, competitor, input.evidence, {}), duplicate: false };
  });
  if (result.decision) events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: result.decision });
  return { ok: true, data: { competitorId: result.competitor.id, ...(result.duplicate ? { duplicate: true } : {}) } };
};

function record(
  store: Store,
  ctx: Parameters<ExtraToolHandler>[0],
  c: Competitor,
  evidence: string[],
  extra: Record<string, unknown>,
  kind: Decision['kind'] = 'score',
): Decision {
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind,
    payload: {
      tool: 'save_competitor', competitorId: c.id, name: c.name, threat: c.threat, directness: c.directness, comparison: c.comparison,
      ...extra,
    },
    refs: [...new Set([c.id, ...evidence])],
    promptVersion: ctx.promptVersion,
    createdAt: new Date().toISOString(),
  };
  store.decisions.insert(decision);
  return decision;
}
