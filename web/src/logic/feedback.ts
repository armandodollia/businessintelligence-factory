/**
 * Learning loop WP-A hooks: the feedback log (who / when / what / why of every human action) and
 * symptom hypotheses (include override + the user's correction). Views render what these return.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, feedbackApi } from './api.js';
import { useBusEvents, useResource } from './hooks.js';
import type { FeedbackEvent, FeedbackKind, HypothesisCorrection, OutputStatus, SymptomHypothesis } from './types.js';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Human-readable action names of feedback kinds. */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  include_override: 'include override',
  profile_edit: 'profile edit',
  proposal_accept: 'proposal accepted',
  proposal_edit: 'proposal accepted with edits',
  proposal_reject: 'proposal rejected',
  hypothesis_correction: 'hypothesis corrected',
  request_answer: 'request answered',
  weights_change: 'weights changed',
  prompt_patch_apply: 'prompt patch applied',
  prompt_patch_revert: 'prompt calibration reverted',
  // knowledge store KS-2
  fact_scope_change: 'fact scope changed',
  fact_retract: 'fact retracted',
  fact_replacement_accept: 'fact update accepted',
  // knowledge store KS-3
  entity_merge: 'entities merged',
  entity_rename: 'entity renamed',
  // knowledge store KS-7
  artifact_prune: 'stored file pruned',
};

const short = (v: unknown, max = 80): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const includeLabel = (v: unknown) => (v === true ? 'include' : v === false ? 'exclude' : 'default');

/** One-line "before → after" of a feedback event. */
export function feedbackChange(e: Pick<FeedbackEvent, 'kind' | 'beforeJson' | 'afterJson'>): string {
  const before = (e.beforeJson ?? {}) as Record<string, unknown>;
  const after = (e.afterJson ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'include_override':
      return `${includeLabel(before.include)} → ${includeLabel(after.include)}${typeof before.status === 'string' ? ` (was ${before.status})` : ''}`;
    case 'request_answer':
      return `${String(after.status ?? '')}${after.response !== undefined ? `: ${short(after.response)}` : ''}`;
    case 'prompt_patch_apply':
    case 'prompt_patch_revert':
      return `prompt ${String(before.promptVersion ?? '?')} → ${String(after.promptVersion ?? '?')}`;
    case 'proposal_accept':
    case 'proposal_reject':
      return String(after.status ?? e.kind);
    default: {
      const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      return keys.map((k) => `${k}: ${short(before[k], 40)} → ${short(after[k], 40)}`).join('; ') || '—';
    }
  }
}

/** Feedback events of a workspace, newest first; reloads after any decision (user actions log one). */
export function useFeedbackLog(wsId: string | null | undefined) {
  const res = useResource(`feedback:${wsId ?? ''}`, wsId ? () => feedbackApi.listFeedback(wsId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'decision' || e.type === 'user_request_resolved') void res.reload();
  });
  const events = useMemo(
    () => [...(res.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [res.data],
  );
  return { events, loading: res.loading, error: res.error, reload: res.reload };
}

/**
 * Mirrors `isOutputUsable` (src/core/research/outputs.ts): a hypothesis feeds the interviewer's
 * drill-down when verified unless the user overrides; superseded ones never do.
 */
export function hypothesisUsed(h: { status?: OutputStatus | undefined; includeOverride?: boolean | undefined }): boolean {
  if (h.status === 'superseded') return false;
  return h.includeOverride ?? (h.status ?? 'pending') === 'verified';
}

export type HypothesisView = SymptomHypothesis & { symptomTitle: string };

/** Symptom hypotheses with their symptom titles, the include override and the user's correction. */
export function useHypotheses(wsId: string | null | undefined) {
  const res = useResource(`hypotheses:${wsId ?? ''}`, wsId ? () => feedbackApi.listHypotheses(wsId) : null);
  const symptoms = useResource(`hyp-symptoms:${wsId ?? ''}`, wsId ? () => api.listSymptoms(wsId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status') void res.reload();
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await res.reload();
        return true;
      } catch (e) {
        setActionError(errMsg(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [res.reload],
  );
  const titles = useMemo(() => new Map((symptoms.data ?? []).map((s) => [s.id, s.title])), [symptoms.data]);
  const hypotheses: HypothesisView[] = useMemo(
    () =>
      (res.data ?? [])
        .filter((h) => h.status !== 'superseded')
        .map((h) => ({ ...h, symptomTitle: titles.get(h.symptomId) ?? h.symptomId })),
    [res.data, titles],
  );
  /** `null` resets to the default (verified only). */
  const setInclude = useCallback((id: string, include: boolean | null) => run(() => feedbackApi.setHypothesisInclude(id, include)), [run]);
  /** The user's correction; resolves `true` when saved. */
  const correct = useCallback((id: string, body: HypothesisCorrection) => run(() => feedbackApi.correctHypothesis(id, body)), [run]);
  return {
    hypotheses,
    used: hypothesisUsed,
    setInclude,
    correct,
    busy,
    actionError,
    loading: res.loading,
    error: res.error ?? symptoms.error,
  };
}

/** Builds a correction from form values: only changed fields; `undefined` when nothing changed or invalid. */
export function hypothesisCorrection(
  h: Pick<SymptomHypothesis, 'hypothesis' | 'confidence'>,
  form: { hypothesis: string; confidence: string; reason: string },
): HypothesisCorrection | undefined {
  const out: HypothesisCorrection = {};
  const text = form.hypothesis.trim();
  if (text && text !== h.hypothesis) out.hypothesis = text;
  if (form.confidence.trim() !== '') {
    const n = Number(form.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
    if (n !== h.confidence) out.confidence = n;
  }
  if (out.hypothesis === undefined && out.confidence === undefined) return undefined;
  if (form.reason.trim()) out.reason = form.reason.trim();
  return out;
}
