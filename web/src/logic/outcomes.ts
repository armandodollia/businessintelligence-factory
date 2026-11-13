/**
 * Learning loop WP-C: decision outcomes report (labels per role / task type / prompt version).
 * Behaviour only; `views/Outcomes.tsx` renders it.
 */
import { useState } from 'react';
import { outcomesApi } from './api.js';
import { useBusEvents, useResource } from './hooks.js';
import type { OutcomeLabel, OutcomeReport } from './types.js';

/** The report, or `null` for anything not shaped like one (e.g. a server without the route). */
export function asOutcomeReport(data: unknown): OutcomeReport | null {
  const r = data as Partial<OutcomeReport> | null | undefined;
  return r && Array.isArray(r.labels) && Array.isArray(r.rows) ? (r as OutcomeReport) : null;
}

/** Label columns to show: the report's label order, only labels with at least one outcome. */
export function outcomeColumns(report: OutcomeReport | null | undefined): OutcomeLabel[] {
  const rep = asOutcomeReport(report);
  if (!rep) return [];
  return rep.labels.filter((l) => rep.rows.some((r) => (r.counts[l] ?? 0) > 0));
}

/** The outcomes report of a workspace (or its whole business tree), reloaded when a task finishes. */
export function useOutcomes(wsId: string | null | undefined) {
  const [tree, setTree] = useState(false);
  const res = useResource(`outcomes:${wsId ?? ''}:${tree ? 'tree' : 'own'}`, wsId ? () => outcomesApi.getOutcomes(wsId, { tree }) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status') void res.reload();
  });
  const report = asOutcomeReport(res.data);
  return { report, columns: outcomeColumns(report), tree, setTree, loading: res.loading, error: res.error, reload: res.reload };
}
