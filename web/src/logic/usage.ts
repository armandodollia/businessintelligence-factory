/**
 * Learning loop WP-B hooks: costs and budgets, agent runs with a paged event viewer, prompt text,
 * per-prompt-version metrics, calibration history with revert. Views use only these.
 */
import { useCallback, useState } from 'react';
import { usageApi } from './api.js';
import { useBusEvents, useResource } from './hooks.js';
import type { AgentRunView, CalibrationVersion, PromptVersionRecord, RevertedCalibration, RunEvent } from './types.js';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// display helpers

/** `$0.0123` (4 decimals below $1, else 2). */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v !== 0 && Math.abs(v) < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** `1.2k`, `3.4M` tokens. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** `62%`, or `—` for null. */
export function formatRate(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;
}

/** One-line summary of a run event for the event viewer. */
export function describeRunEvent(e: RunEvent): string {
  switch (e.t) {
    case 'message':
      return e.text;
    case 'tool_call':
      return `→ ${e.name} ${JSON.stringify(e.input)}`;
    case 'tool_result':
      return `← ${e.name} ${e.ok ? 'ok' : 'FAILED'}`;
    case 'usage':
      return `usage: in ${e.inputTokens ?? 0} (cache read ${e.cacheReadTokens ?? 0}, write ${e.cacheWriteTokens ?? 0}), out ${e.outputTokens ?? 0}${
        e.costUsd !== undefined ? `, CLI cost ${formatUsd(e.costUsd)}` : ''
      }`;
    case 'error':
      return `error${e.rateLimited ? ' (rate limited)' : ''}: ${e.message}`;
    case 'done':
      return `done (exit ${e.exitCode})`;
  }
}

// ---------------------------------------------------------------------------
// costs, runs

/** Live-refreshing on run completion (a finished run has its final usage). */
function useRunFinishedRefresh(wsId: string | null | undefined, reload: () => Promise<void>) {
  useBusEvents(wsId, (e) => {
    if (e.type === 'run_status' && e.status !== 'running') void reload();
  });
}

/** Costs of the workspace (totals, groups, budget status). */
export function useCosts(wsId: string | null | undefined) {
  const res = useResource(`costs:${wsId ?? ''}`, wsId ? () => usageApi.getCosts(wsId) : null);
  useRunFinishedRefresh(wsId, res.reload);
  return { report: res.data ?? null, loading: res.loading, error: res.error, reload: res.reload };
}

/** The workspace's agent runs, newest first, each with its usage. */
export function useAgentRuns(wsId: string | null | undefined) {
  const res = useResource(`agent-runs:${wsId ?? ''}`, wsId ? () => usageApi.listAgentRuns(wsId) : null);
  useRunFinishedRefresh(wsId, res.reload);
  return { runs: (res.data ?? []) as AgentRunView[], loading: res.loading, error: res.error, reload: res.reload };
}

export const RUN_EVENTS_PAGE = 100;

/** Paged event viewer for one run (`runId = null`: nothing selected). */
export function useRunEvents(runId: string | null) {
  const [offset, setOffset] = useState(0);
  const [shownFor, setShownFor] = useState(runId);
  // A different run starts at its first page.
  if (shownFor !== runId) {
    setShownFor(runId);
    setOffset(0);
  }
  const page = useResource(`run-events:${runId ?? ''}:${offset}`, runId ? () => usageApi.getRunEvents(runId, offset, RUN_EVENTS_PAGE) : null);
  const detail = useResource(`run:${runId ?? ''}`, runId ? () => usageApi.getRun(runId) : null);
  const total = page.data?.total ?? 0;
  return {
    detail: detail.data ?? null,
    events: page.data?.events ?? [],
    total,
    offset,
    from: total ? offset + 1 : 0,
    to: Math.min(total, offset + RUN_EVENTS_PAGE),
    canPrev: offset > 0,
    canNext: offset + RUN_EVENTS_PAGE < total,
    prev: () => setOffset((o) => Math.max(0, o - RUN_EVENTS_PAGE)),
    next: () => setOffset((o) => (o + RUN_EVENTS_PAGE < total ? o + RUN_EVENTS_PAGE : o)),
    loading: page.loading || detail.loading,
    error: page.error ?? detail.error,
    reload: page.reload,
  };
}

/** Text of a prompt version, loaded when `hash` is set. */
export function usePromptText(hash: string | null) {
  const res = useResource(`prompt:${hash ?? ''}`, hash ? () => usageApi.getPrompt(hash) : null);
  return { prompt: (res.data ?? null) as PromptVersionRecord | null, loading: res.loading, error: res.error };
}

/** Calibration agreement and review pass rates per (role, prompt version). */
export function usePromptVersionMetrics(wsId: string | null | undefined) {
  const res = useResource(`prompt-metrics:${wsId ?? ''}`, wsId ? () => usageApi.getPromptVersionMetrics(wsId) : null);
  return { rows: res.data ?? [], loading: res.loading, error: res.error, reload: res.reload };
}

// ---------------------------------------------------------------------------
// calibration history

export type CalibrationRoleHistory = { role: CalibrationVersion['role']; versions: CalibrationVersion[]; current: CalibrationVersion };

/** Groups versions by role (oldest first within a role); the last one is current. */
export function groupCalibrationVersions(versions: CalibrationVersion[]): CalibrationRoleHistory[] {
  const by = new Map<string, CalibrationVersion[]>();
  for (const v of versions) by.set(v.role, [...(by.get(v.role) ?? []), v]);
  return [...by.entries()]
    .map(([role, vs]) => ({ role: role as CalibrationVersion['role'], versions: vs, current: vs.at(-1)! }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** Calibration history of the workspace's business tree, with revert (explicit user action only). */
export function useCalibrationHistory(wsId: string | null | undefined) {
  const res = useResource(`calibration-versions:${wsId ?? ''}`, wsId ? () => usageApi.listCalibrationVersions(wsId) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ wsId: string; message: string } | null>(null);
  const [reverted, setReverted] = useState<{ wsId: string; result: RevertedCalibration } | null>(null);
  const revert = useCallback(
    async (versionId: string) => {
      if (!wsId) return;
      const owner = wsId;
      setBusy(true);
      setError(null);
      try {
        const result = await usageApi.revertCalibration(owner, versionId);
        setReverted({ wsId: owner, result });
        await res.reload();
      } catch (e) {
        setError({ wsId: owner, message: errMsg(e) });
      } finally {
        setBusy(false);
      }
    },
    [wsId, res.reload],
  );
  return {
    roles: groupCalibrationVersions(res.data ?? []),
    revert,
    busy,
    reverted: reverted && reverted.wsId === wsId ? reverted.result : null,
    loading: res.loading,
    error: (error && error.wsId === wsId ? error.message : null) ?? res.error,
    reload: res.reload,
  };
}
