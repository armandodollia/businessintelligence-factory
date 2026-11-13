import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Competitor, CompetitorComparison, Decision } from '../types.js';

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
 * must be artifacts of this business tree. A replay with unchanged values logs nothing new.
 */
export const saveCompetitorHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'save_competitor'>;
  const { store, artifacts, events } = deps;
  const missing = artifacts.exists(ctx.workspaceId, input.evidence);
  if (missing.length) {
    return { ok: false, error: `evidence references unknown artifacts (not in this workspace's business tree): ${missing.join(', ')}` };
  }
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const taskId = task && task.workspaceId === ctx.workspaceId ? task.id : undefined;
  const now = new Date().toISOString();
  const values = { threat: input.threat, directness: input.directness, comparison: input.comparison };

  const result = store.transaction(() => {
    const prior = findCompetitor(store, ctx.workspaceId, input.name);
    if (prior) {
      const evidence = [...new Set([...prior.evidence, ...input.evidence])];
      const same =
        JSON.stringify({ threat: prior.threat, directness: prior.directness, comparison: prior.comparison }) === JSON.stringify(values) &&
        (input.site ?? prior.site) === prior.site;
      if (same && evidence.length === prior.evidence.length) return { competitor: prior, decision: undefined, duplicate: true };
      const patch: Partial<Competitor> = { ...values, evidence, updatedAt: now };
      if (input.site !== undefined) patch.site = input.site;
      if (taskId) patch.taskId = taskId;
      const competitor = store.competitors.update(prior.id, patch);
      const decision = same ? undefined : record(store, ctx, competitor, input.evidence, { revision: true, previous: { threat: prior.threat, directness: prior.directness, comparison: prior.comparison } });
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
    };
    if (input.site !== undefined) competitor.site = input.site;
    if (taskId) competitor.taskId = taskId;
    store.competitors.insert(competitor);
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
): Decision {
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind: 'score',
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
