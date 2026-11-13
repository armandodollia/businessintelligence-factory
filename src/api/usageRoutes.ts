/**
 * Learning loop WP-B routes: costs, agent runs and their events, the prompt store, per-prompt-version
 * metrics and calibration history. Mounted by `createApp` (before the `/api/*` 404 fallback).
 */
import type { Hono } from 'hono';
import { ROLES, type BifConfig } from '../core/config/schema.js';
import type { EventBus } from '../core/events.js';
import { budgetStatus } from '../core/harness/budget.js';
import { readRunEvents } from '../core/harness/runEvents.js';
import { promptVersionMetrics } from '../core/metrics/promptMetrics.js';
import { costReport, usageTotals } from '../core/metrics/usage.js';
import { getPromptText } from '../core/prompts/store.js';
import { calibrationScope } from '../core/scoring/calibration.js';
import { actorOf, calibrationHistory, revertCalibration, setCalibrationDecision } from '../core/scoring/calibrationHistory.js';
import type { Store } from '../core/store/db.js';
import { usageRepos } from '../core/store/usageRepos.js';
import { recordSystemDecision } from '../core/systemDecision.js';
import type { AgentRun, Role } from '../core/types.js';

export type UsageRouteDeps = { store: Store; config: BifConfig; events: EventBus };

/** Agent runs as served: the run token is a credential and never leaves the server. */
const publicRun = ({ token: _token, ...run }: AgentRun) => run;

const intParam = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function mountUsageRoutes(app: Hono, deps: UsageRouteDeps): void {
  const { store, config, events } = deps;
  const notFound = (what: string) => ({ error: `${what} not found` });
  const roleParam = (v: string | undefined): Role | undefined | null =>
    v === undefined || v === '' ? undefined : (ROLES as readonly string[]).includes(v) ? (v as Role) : null;

  /** Costs per workspace, task, role, model and prompt version; `?workspaceId=` adds budget status. */
  app.get('/api/costs', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (workspaceId === undefined) return c.json(costReport(store));
    if (!store.workspaces.get(workspaceId)) return c.json(notFound(`workspace '${workspaceId}'`), 404);
    return c.json({ ...costReport(store, { workspaceId }), budgets: budgetStatus(store, config, workspaceId) });
  });

  /** Agent runs of a workspace, newest first (`?limit=`, default 200), each with its usage totals. */
  app.get('/api/workspaces/:id/agent-runs', (c) => {
    const id = c.req.param('id');
    if (!store.workspaces.get(id)) return c.json(notFound(`workspace '${id}'`), 404);
    const limit = Math.min(1000, Math.max(1, intParam(c.req.query('limit'), 200)));
    const runs = store.agentRuns
      .list({ workspaceId: id })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
    return c.json(runs.map((r) => ({ ...publicRun(r), usage: usageTotals(store, { runId: r.id }) })));
  });

  app.get('/api/runs/:id', (c) => {
    const run = store.agentRuns.get(c.req.param('id'));
    if (!run) return c.json(notFound(`agent run '${c.req.param('id')}'`), 404);
    return c.json({
      run: publicRun(run),
      attempts: usageRepos(store).agentRunAttempts.list({ runId: run.id }),
      usage: usageTotals(store, { runId: run.id }),
      usageRows: usageRepos(store).agentUsage.list({ runId: run.id }),
    });
  });

  /** Paged view of the run's `events.jsonl` (`?offset=&limit=`, limit ≤ 1000). */
  app.get('/api/runs/:id/events', (c) => {
    const run = store.agentRuns.get(c.req.param('id'));
    if (!run) return c.json(notFound(`agent run '${c.req.param('id')}'`), 404);
    return c.json(
      readRunEvents(config.dataDir, run, { offset: intParam(c.req.query('offset'), 0), limit: intParam(c.req.query('limit'), 200) }),
    );
  });

  /** Full text of a prompt version. */
  app.get('/api/prompts/:hash', (c) => {
    const p = getPromptText(store, c.req.param('hash'));
    return p ? c.json(p) : c.json(notFound(`prompt version '${c.req.param('hash')}'`), 404);
  });

  /** Calibration agreement and review pass rates per (role, prompt version), oldest version first. */
  app.get('/api/workspaces/:id/metrics/prompt-versions', (c) => {
    const id = c.req.param('id');
    if (!store.workspaces.get(id)) return c.json(notFound(`workspace '${id}'`), 404);
    const role = roleParam(c.req.query('role'));
    if (role === null) return c.json({ error: `unknown role '${c.req.query('role')}'` }, 400);
    return c.json(promptVersionMetrics(store, id, role ? { role } : {}));
  });

  /** Calibration versions of the workspace's business tree (oldest first; last per role = current). */
  app.get('/api/workspaces/:id/calibration/versions', (c) => {
    const id = c.req.param('id');
    if (!store.workspaces.get(id)) return c.json(notFound(`workspace '${id}'`), 404);
    const role = roleParam(c.req.query('role'));
    if (role === null) return c.json({ error: `unknown role '${c.req.query('role')}'` }, 400);
    return c.json(calibrationHistory(store, calibrationScope(store, config.dataDir, id), role));
  });

  /** User action: restores a calibration version (logged as a `revert_calibration` Decision). */
  app.post('/api/workspaces/:id/calibration/versions/:versionId/revert', (c) => {
    const id = c.req.param('id');
    if (!store.workspaces.get(id)) return c.json(notFound(`workspace '${id}'`), 404);
    const versionId = c.req.param('versionId');
    let result;
    try {
      result = revertCalibration(store, calibrationScope(store, config.dataDir, id), versionId, actorOf(config));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
    const decision = recordSystemDecision(
      { store, events },
      {
        workspaceId: id,
        actor: 'user',
        payload: { tool: 'revert_calibration', role: result.version.role, versionId, newVersionId: result.version.id, path: result.path },
      },
    );
    setCalibrationDecision(store, result.version.id, decision.id);
    return c.json({ path: result.path, version: { ...result.version, decisionId: decision.id }, decisionId: decision.id });
  });
}
