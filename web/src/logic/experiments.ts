/**
 * Learning loop WP-F hooks: reviewer audits (run now, schedules) and A/B experiments (start, compare).
 * Behaviour only; `views/Experiments.tsx` renders what these return.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, wpfApi } from './api.js';
import { useResource } from './hooks.js';
import { formatRate, formatUsd } from './usage.js';
import type { ArmResult, AuditVerdict, BifConfig, Experiment, ExperimentComparison, NewExperiment, ReviewerAudit, Task } from './types.js';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Poll interval while an audit or experiment runs (nothing on the event bus reports their end). */
export const POLL_MS = 2000;

// ---------------------------------------------------------------------------
// display helpers

const VERDICTS: Record<AuditVerdict, string> = {
  agree: 'agrees (passed)',
  miss: 'MISS: auditor failed it',
  invalid: 'auditor gave no valid review',
  skipped: 'skipped (no other model)',
};

/** Human label of an audit's state. */
export function auditLabel(a: Pick<ReviewerAudit, 'status' | 'verdict' | 'reason'>): string {
  if (a.status === 'running') return 'running…';
  if (a.status === 'failed') return `failed${a.reason ? `: ${a.reason}` : ''}`;
  return a.verdict ? VERDICTS[a.verdict] : '—';
}

export const modelLabel = (m: { provider: string; model: string } | undefined): string => (m ? `${m.provider}/${m.model}` : '—');

/** `provider/model` options of every enabled provider (for the arm model pickers). */
export function modelOptions(config: Pick<BifConfig, 'providers'> | undefined): string[] {
  const providers = (config as Partial<Pick<BifConfig, 'providers'>> | undefined)?.providers;
  if (!providers || typeof providers !== 'object') return [];
  return Object.entries(providers).flatMap(([id, p]) => (p.enabled ? p.models.map((m) => `${id}/${m}`) : []));
}

/** Parses `provider/model`; undefined for '' or anything malformed. */
export function parseModel(v: string): { provider: 'claude' | 'codex' | 'opencode'; model: string } | undefined {
  const i = v.indexOf('/');
  if (i <= 0 || i === v.length - 1) return undefined;
  const provider = v.slice(0, i);
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode') return undefined;
  return { provider, model: v.slice(i + 1) };
}

export type ArmForm = { model: string; promptVersion: string };
export type ExperimentForm = { taskId: string; name: string; repeats: string; a: ArmForm; b: ArmForm };
export const EMPTY_EXPERIMENT_FORM: ExperimentForm = { taskId: '', name: '', repeats: '1', a: { model: '', promptVersion: '' }, b: { model: '', promptVersion: '' } };

/** The request body for a form, or an error to show. An empty arm field keeps the task's model / current prompt. */
export function buildExperimentBody(f: ExperimentForm): { body: NewExperiment } | { error: string } {
  if (!f.taskId) return { error: 'pick a finished task' };
  const repeats = Number(f.repeats || '1');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) return { error: 'repeats must be 1–5' };
  const arm = (a: ArmForm, name: string) => {
    const model = a.model ? parseModel(a.model) : undefined;
    if (a.model && !model) return `arm ${name}: model must look like provider/model`;
    return { ...(model ? { model } : {}), ...(a.promptVersion.trim() ? { promptVersion: a.promptVersion.trim() } : {}) };
  };
  const a = arm(f.a, 'A');
  const b = arm(f.b, 'B');
  if (typeof a === 'string') return { error: a };
  if (typeof b === 'string') return { error: b };
  if (JSON.stringify(a) === JSON.stringify(b)) return { error: 'arms A and B are the same: change the model or prompt version of one' };
  return { body: { taskId: f.taskId, arms: [a, b], ...(repeats !== 1 ? { repeats } : {}), ...(f.name.trim() ? { name: f.name.trim() } : {}) } };
}

/** Comparison table rows: metric label, then one formatted cell per arm. */
export function comparisonRows(arms: ArmResult[]): Array<{ label: string; cells: string[] }> {
  const row = (label: string, f: (a: ArmResult) => string) => ({ label, cells: arms.map(f) });
  const num = (v: number | null) => (v === null ? '—' : String(v));
  return [
    row('Worker model', (a) => modelLabel(a.model)),
    row('Worker prompt', (a) => a.promptVersion ?? 'current'),
    row('Reviewer', (a) => a.reviewerModels.map(modelLabel).join(', ') || '—'),
    row('Finished tasks', (a) => `${a.finished}/${a.tasks.length}`),
    row('Review pass rate', (a) => formatRate(a.passRate)),
    row('First-round pass rate', (a) => formatRate(a.firstRoundPassRate)),
    row('Mean rounds', (a) => num(a.meanRounds)),
    row('Mean review score', (a) => num(a.meanReviewScore)),
    row('User ratings (agree)', (a) => (a.userRatings.count ? `${a.userRatings.count} (${formatRate(a.userRatings.agreeRate)})` : '—')),
    row('Cost', (a) => formatUsd(a.cost.costUsd)),
    row('Cost per task', (a) => formatUsd(a.costPerTask)),
  ];
}

// ---------------------------------------------------------------------------
// hooks

/** Polls `reload` every `POLL_MS` while `active`. */
function usePoll(active: boolean, reload: () => Promise<void>): void {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [active, reload]);
}

/** Reviewer audits of the workspace's business tree: list, summary, run now, schedules. */
export function useAudits(wsId: string) {
  const res = useResource(`audits:${wsId}`, () => wpfApi.getAudits(wsId));
  const running = (res.data?.summary.running ?? 0) > 0;
  usePoll(running, res.reload);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await res.reload();
      } catch (e) {
        setActionError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [res.reload],
  );
  return {
    view: res.data,
    loading: res.loading,
    error: res.error,
    running,
    busy,
    actionError,
    reload: res.reload,
    /** Audits the N most recently verified tasks not audited yet. */
    runAudit: (n: number) => act(() => wpfApi.startAudit(wsId, { n })),
    createSchedule: (cron: string, n: number) => act(() => wpfApi.createAuditSchedule(wsId, cron, n)),
    setScheduleEnabled: (id: string, enabled: boolean) => act(() => wpfApi.updateAuditSchedule(id, { enabled })),
  };
}

const FINISHED = new Set(['verified', 'unverified', 'failed']);

/** Experiments of a workspace: list, start form (finished tasks, model options), selected comparison. */
export function useExperiments(wsId: string) {
  const list = useResource(`experiments:${wsId}`, () => wpfApi.listExperiments(wsId));
  const tasks = useResource(`experiment-tasks:${wsId}`, () => api.listTasks(wsId));
  const config = useResource('config', () => api.getConfig());
  const [form, setForm] = useState<ExperimentForm>(EMPTY_EXPERIMENT_FORM);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const experiments: Experiment[] = list.data ?? [];
  usePoll(experiments.some((e) => e.status === 'running'), list.reload);

  /** Finished tasks that are not themselves experiment arms. */
  const sourceTasks: Task[] = useMemo(() => {
    const armRuns = new Set(experiments.map((e) => e.researchRunId));
    return (tasks.data ?? []).filter((t) => FINISHED.has(t.status) && !armRuns.has(t.runId));
  }, [tasks.data, experiments]);

  const start = useCallback(async () => {
    const built = buildExperimentBody(form);
    if ('error' in built) {
      setActionError(built.error);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const exp = await wpfApi.startExperiment(wsId, built.body);
      setForm(EMPTY_EXPERIMENT_FORM);
      setSelected(exp.id);
      await Promise.all([list.reload(), tasks.reload()]);
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [form, wsId, list.reload, tasks.reload]);

  return {
    experiments,
    loading: list.loading,
    error: list.error ?? tasks.error,
    sourceTasks,
    models: modelOptions(config.data),
    form,
    setForm,
    start,
    busy,
    actionError,
    selected,
    select: setSelected,
  };
}

/** One experiment's comparison, polled while it runs. */
export function useExperimentComparison(id: string | null) {
  const res = useResource<ExperimentComparison>(`experiment:${id ?? ''}`, id ? () => wpfApi.getExperiment(id) : null);
  usePoll(res.data?.experiment.status === 'running', res.reload);
  return { comparison: res.data, rows: res.data ? comparisonRows(res.data.arms) : [], loading: res.loading, error: res.error };
}
