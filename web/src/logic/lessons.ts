/**
 * Learning loop WP-E: the lessons page's logic. Pending proposals (engine rules and retro edits) the
 * user accepts or rejects one by one, active and past rules with their effect per prompt version, and
 * recent retros. Views render what `useLessons` returns and call its actions; nothing here renders.
 */
import { useCallback, useState } from 'react';
import { lessonsApi } from './api.js';
import { useBusEvents, useResource } from './hooks.js';
import type { LessonAction, LessonProposal, LessonRule, RetroRecord } from '../../../src/core/learning/lessons/types.js';

export type { LessonAction, LessonEvidence, LessonProposal, LessonRule, RetroRecord } from '../../../src/core/learning/lessons/types.js';

export type VersionEffect = {
  promptVersion: string;
  ruleVersion?: number;
  firstSeen: string;
  tasks: number;
  hits: number;
  rate: number | null;
  passRate: number | null;
  agreeRate: number | null;
  costUsd: number;
};
export type RuleEffect = {
  ruleId: string;
  marker: string;
  version: number;
  withRule: number;
  withRuleHits: number;
  rateWithRule: number | null;
  anyVersion: number;
  beforeRule: number;
  beforeRuleHits: number;
  rateBeforeRule: number | null;
  cleanStreak: number;
  versions: VersionEffect[];
};
export type LessonsPage = {
  rootWorkspaceId: string;
  settings: {
    enabled: boolean; minTasks: number; retireAfterCleanTasks: number; minEffectTasks: number; maxRulesPerRole: number;
    retro: { enabled: boolean; cron: string; windowDays: number; maxProposals: number; nextAt: string | null };
  };
  roles: Array<{ role: string; active: number; pending: number; cap: number }>;
  proposals: LessonProposal[];
  rules: Array<{ rule: LessonRule; effect: RuleEffect }>;
  retros: RetroRecord[];
};

export const ACTION_LABELS: Record<LessonAction, string> = {
  add: 'New rule',
  strengthen: 'Strengthen rule',
  retire: 'Retire rule',
  revert: 'Revert rule',
  prompt_edit: 'Retro: prompt rule',
  calibration_edit: 'Retro: calibration note',
};

/** What accepting a proposal does, in one sentence (shown next to the buttons). */
export function acceptEffect(p: Pick<LessonProposal, 'action' | 'role'>): string {
  switch (p.action) {
    case 'add':
    case 'prompt_edit':
      return `Appends this rule to the ${p.role} prompt (new prompt version).`;
    case 'strengthen':
      return `Replaces the rule with this stronger text in the ${p.role} prompt (new rule version).`;
    case 'retire':
    case 'revert':
      return `Takes the rule out of the ${p.role} prompt (new prompt version).`;
    case 'calibration_edit':
      return `Adds this note to the ${p.role} calibration (new prompt version; revertible in Usage & prompts).`;
  }
}

/** A rate as a percentage, `—` when there is no data. */
export function pctText(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/** Plain-words verdict on a rule's effect so far. */
export function effectVerdict(e: Pick<RuleEffect, 'withRule' | 'rateWithRule' | 'rateBeforeRule'>, minTasks = 5): string {
  if (e.withRule < minTasks) return `too early (${e.withRule} of ${minTasks} tasks under this version)`;
  if (e.rateBeforeRule === null || e.rateWithRule === null) return 'no baseline';
  if (e.rateWithRule < e.rateBeforeRule) return `working: ${pctText(e.rateBeforeRule)} → ${pctText(e.rateWithRule)}`;
  return `not working: ${pctText(e.rateBeforeRule)} → ${pctText(e.rateWithRule)}`;
}

/** The page payload, or null for anything not shaped like one (e.g. an older server). */
export function asLessonsPage(data: unknown): LessonsPage | null {
  const p = data as Partial<LessonsPage> | null | undefined;
  return p && Array.isArray(p.proposals) && Array.isArray(p.rules) && Array.isArray(p.retros) ? (p as LessonsPage) : null;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The lessons page of a workspace's business tree, with the user's actions. */
export function useLessons(wsId: string) {
  const res = useResource(`lessons:${wsId}`, () => lessonsApi.page(wsId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status' || e.type === 'decision') void res.reload();
  });

  const act = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(done);
        await res.reload();
        return true;
      } catch (e) {
        setError(errMsg(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [res],
  );

  const page = asLessonsPage(res.data);
  const pending = page?.proposals.filter((p) => p.status === 'pending') ?? [];
  const decided = page?.proposals.filter((p) => p.status !== 'pending') ?? [];
  const active = page?.rules.filter((r) => r.rule.status === 'active') ?? [];
  const past = page?.rules.filter((r) => r.rule.status !== 'active') ?? [];
  const reasonOf = (id: string) => reasons[id]?.trim() || undefined;

  return {
    page, pending, decided, active, past, busy, error, notice, loading: res.loading, loadError: res.error,
    reason: (id: string) => reasons[id] ?? '',
    setReason: (id: string, v: string) => setReasons((r) => ({ ...r, [id]: v })),
    accept: (id: string) => act(() => lessonsApi.accept(wsId, id, reasonOf(id)), 'Accepted.'),
    reject: (id: string) => act(() => lessonsApi.reject(wsId, id, reasonOf(id)), 'Rejected.'),
    proposeRetire: (ruleId: string) => act(() => lessonsApi.proposeRetire(wsId, ruleId), 'Retirement proposed: accept it below to take the rule out.'),
    evaluate: () => act(() => lessonsApi.evaluate(wsId), 'Signals checked.'),
    startRetro: () => act(() => lessonsApi.startRetro(wsId), 'Retro started; its proposals appear here when it ends.'),
    reload: res.reload,
  };
}
