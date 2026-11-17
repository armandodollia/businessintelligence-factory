/**
 * React hooks — the only interface views use. All fetching, SSE handling and business state
 * live here; views render what these return and call the returned actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, artifactUrl, exportUrl, flowsApi, personaLearningApi, stakeholdersApi, userPersonaApi } from './api.js';
import { plural } from './flows.js';
import { exportSummaryView } from './exportSummary.js';
import { asPersonaLearningView, pendingProposals } from './personaLearning.js';
import { subscribe } from './sse.js';
import { asUserPersonaView } from './userPersona.js';
import {
  answersToSend,
  asStakeholdersView,
  isFormerColleague,
  isHiddenView,
  isOpenView,
  newPositionDraft,
  placesOf,
  positionInput,
  publicLayerNotes,
  withChange,
  type PositionDraft,
} from './stakeholders.js';
import {
  COMPETITOR_CRITERIA,
  FINDING_CRITERIA,
  PATCH_ROLES,
  WEIGHT_KEYS,
  type AppliedPromptPatch,
  type ChangeEntry,
  type FlowChanges,
  type OutputStatus,
  type PatchRole,
  type PromptPatch,
  type TreeFindingView,
  type WeightKey,
  type WhatChangedPayload,
} from './types.js';
import type {
  Artifact,
  BifConfig,
  CheckAnswer,
  ChecklistDecisionInput,
  ChecklistEditInput,
  FlowReaction,
  FlowTypeDecisionInput,
  PersonaAdjustment,
  PersonaProposal,
  PersonaSignal,
  OpenStakeholderView,
  RealDecision,
  StakeholderPlaces,
  StakeholderQuestionGroup,
  BusEvent,
  CreateWorkspaceInput,
  Criteria,
  Decision,
  EvidenceGroups,
  EvidenceItem,
  Finding,
  InterviewState,
  InterviewTurn,
  NewSchedule,
  ResearchPhase,
  Rating,
  RatingInput,
  RatingTargetType,
  ReviewQueueItem,
  Rollup,
  SchedulePatch,
  TreeNode,
  UnitProposal,
  UnitProposalEdits,
  UserInteraction,
  UserRequest,
  WorkspaceNode,
} from './types.js';

/** URL builders views may use for links and images. */
export { artifactUrl, exportUrl };

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// generic building blocks

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Local update of loaded data (optimistic changes). */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Loads `load()` whenever `key` changes; `load = null` means "nothing to load". */
export function useResource<T>(key: string, load: (() => Promise<T>) | null): Resource<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>(
    { data: undefined, error: null, loading: load !== null },
  );
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    const n = ++seq.current;
    if (!fn) {
      setState({ data: undefined, error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (n === seq.current) setState((s) => ({ ...s, error: errMsg(e), loading: false }));
    }
  }, []);

  useEffect(() => {
    setState({ data: undefined, error: null, loading: loadRef.current !== null });
    void reload();
  }, [key, reload]);

  const mutate = useCallback((fn: (prev: T | undefined) => T | undefined) => {
    setState((s) => ({ ...s, data: fn(s.data) }));
  }, []);

  return { ...state, reload, mutate };
}

/**
 * Reloads an output list (findings, recommendations, personas, competitors) whenever a task of the
 * workspace finishes its review loop (`task_status`), so review statuses update live.
 */
function useTaskStatusRefresh(workspaceId: string | null | undefined, reload: () => Promise<void>): void {
  useBusEvents(workspaceId, (e) => {
    if (e.type === 'task_status') void reload();
  });
}

/** Subscribes to a workspace's `BusEvent` stream for the component's lifetime. */
export function useBusEvents(workspaceId: string | null | undefined, onEvent: (e: BusEvent) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    if (!workspaceId) return;
    return subscribe(workspaceId, (e) => {
      if (e.workspaceId && e.workspaceId !== workspaceId) return;
      ref.current(e);
    });
  }, [workspaceId]);
}

/** Plain form state, so views don't hold their own. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const initialRef = useRef(initial);
  const [values, setValues] = useState<T>(initial);
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);
  const reset = useCallback(() => setValues(initialRef.current), []);
  return { values, set, reset, setValues };
}

/** Runs an async action, exposing `busy` and `error`. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <R>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errMsg(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  /** Forgets the error of the last action (a form that is opened again starts without it). */
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}

// ---------------------------------------------------------------------------
// workspaces & business map

export function useWorkspaces() {
  const res = useResource('workspaces', api.listWorkspaces);
  const action = useAction();
  const create = useCallback(
    async (input: CreateWorkspaceInput) => {
      const created = await action.run(() => api.createWorkspace(input));
      await res.reload();
      return created;
    },
    [action.run, res.reload],
  );
  return {
    workspaces: res.data ?? [],
    loading: res.loading,
    error: res.error ?? action.error,
    creating: action.busy,
    create,
    reload: res.reload,
  };
}

export function useWorkspace(id: string | null | undefined) {
  const res = useResource(id ?? '', id
    ? async () => {
        const [list, profile] = await Promise.all([
          api.listWorkspaces(),
          api.getProfile(id).catch(() => null),
        ]);
        const p = profile && typeof profile === 'object' && 'data' in profile && typeof profile.data === 'object'
          ? (profile.data as Record<string, unknown>)
          : ((profile as Record<string, unknown> | null) ?? {});
        return { workspace: list.find((w) => w.id === id) ?? null, profile: p, all: list };
      }
    : null);
  const parent = res.data?.workspace?.parentWorkspaceId
    ? (res.data.all.find((w) => w.id === res.data?.workspace?.parentWorkspaceId) ?? null)
    : null;
  return {
    workspace: res.data?.workspace ?? null,
    parent,
    profile: res.data?.profile ?? {},
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

function isWorkspaceLike(x: unknown): x is WorkspaceNode {
  return !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string';
}

/**
 * Normalizes `GET /tree` into a `TreeNode`. Accepts `{ workspace, children }` nesting,
 * workspaces carrying a `children` array, or a flat list linked by `parentWorkspaceId`.
 */
export function normalizeTree(raw: unknown): TreeNode | null {
  if (Array.isArray(raw)) {
    const list = raw.filter(isWorkspaceLike);
    if (list.length === 0) return null;
    const ids = new Set(list.map((w) => w.id));
    const byParent = new Map<string, WorkspaceNode[]>();
    for (const w of list) {
      const p = w.parentWorkspaceId;
      if (p && ids.has(p)) byParent.set(p, [...(byParent.get(p) ?? []), w]);
    }
    const seen = new Set<string>();
    const build = (w: WorkspaceNode): TreeNode => {
      seen.add(w.id);
      const kids = (byParent.get(w.id) ?? []).filter((c) => !seen.has(c.id));
      return { workspace: w, children: kids.map(build) };
    };
    const root = list.find((w) => !w.parentWorkspaceId || !ids.has(w.parentWorkspaceId)) ?? list[0]!;
    return build(root);
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (isWorkspaceLike(obj.workspace)) {
    const kids = Array.isArray(obj.children) ? obj.children : [];
    return {
      workspace: obj.workspace,
      children: kids.map(normalizeTree).filter((n): n is TreeNode => n !== null),
    };
  }
  if (isWorkspaceLike(obj)) {
    const { children, ...workspace } = obj as WorkspaceNode & { children?: unknown };
    const kids = Array.isArray(children) ? children : [];
    return {
      workspace: workspace as WorkspaceNode,
      children: kids.map(normalizeTree).filter((n): n is TreeNode => n !== null),
    };
  }
  return null;
}

export function flattenTree(node: TreeNode | null): WorkspaceNode[] {
  if (!node) return [];
  return [node.workspace, ...node.children.flatMap(flattenTree)];
}

export function useBusinessMap(rootId: string | null | undefined) {
  const res = useResource(rootId ?? '', rootId
    ? async () => {
        const [tree, rollup] = await Promise.all([
          api.getTree(rootId).then(normalizeTree),
          api.getRollup(rootId).catch((): Rollup | null => null),
        ]);
        const ids = tree ? flattenTree(tree).map((w) => w.id) : [rootId];
        const proposals = (
          await Promise.all(ids.map((id) => api.listUnitProposals(id).catch((): UnitProposal[] => [])))
        ).flat();
        return { tree, rollup, proposals };
      }
    : null);
  const action = useAction();

  const accept = useCallback(
    async (id: string, edits?: UnitProposalEdits) => {
      await action.run(() =>
        api.resolveUnitProposal(id, edits ? { action: 'accept', edits } : { action: 'accept' }),
      );
      await res.reload();
    },
    [action.run, res.reload],
  );
  const reject = useCallback(
    async (id: string, reason?: string) => {
      await action.run(() =>
        api.resolveUnitProposal(id, reason ? { action: 'reject', reason } : { action: 'reject' }),
      );
      await res.reload();
    },
    [action.run, res.reload],
  );

  const tree = res.data?.tree ?? null;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of flattenTree(tree)) m.set(w.id, w.scope?.name || w.name);
    return m;
  }, [tree]);

  return {
    tree,
    proposals: res.data?.proposals ?? [],
    rollup: res.data?.rollup ?? null,
    crossCutting: res.data?.rollup?.crossCutting ?? [],
    /** Display name for a source-workspace tag. */
    workspaceName: (id: string) => names.get(id) ?? id,
    accept,
    reject,
    busy: action.busy,
    loading: res.loading,
    error: res.error ?? action.error,
    reload: res.reload,
  };
}

// ---------------------------------------------------------------------------
// interview

let localSeq = 0;

export function useInterview(wsId: string | null | undefined) {
  const res = useResource<InterviewState>(wsId ?? '', wsId ? () => api.getInterview(wsId) : null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sends one user message. Resolves `true` when the server stored it (even if the interviewer then
   * failed: a 502 carries the stored turns + coverage, which are applied), `false` when it was not
   * stored, so the caller can put the text back in the composer.
   */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!wsId || !trimmed) return false;
      setSending(true);
      setError(null);
      const local: InterviewTurn = {
        id: `local_${++localSeq}`,
        workspaceId: wsId,
        role: 'user',
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      res.mutate((s) => ({ turns: [...(s?.turns ?? []), local], coverage: s?.coverage ?? {} }));
      try {
        const reply = await api.sendInterview(wsId, trimmed);
        if (reply && typeof reply === 'object' && 'turns' in reply) {
          res.mutate(() => reply);
        } else if (reply && typeof reply === 'object' && 'role' in reply) {
          res.mutate((s) => ({ turns: [...(s?.turns ?? []), reply], coverage: s?.coverage ?? {} }));
        }
        await res.reload();
        return true;
      } catch (e) {
        setError(errMsg(e));
        const body = e instanceof ApiError ? e.body : undefined;
        if (body && typeof body === 'object' && Array.isArray((body as InterviewState).turns)) {
          const state = body as InterviewState;
          res.mutate(() => ({ turns: state.turns, coverage: state.coverage ?? {} }));
          return state.turns.some((t) => t.role === 'user' && t.text === trimmed);
        }
        res.mutate((s) => (s ? { ...s, turns: s.turns.filter((t) => t.id !== local.id) } : s));
        return false;
      } finally {
        setSending(false);
      }
    },
    [wsId, res.mutate, res.reload],
  );

  const upload = useCallback(
    async (file: File) => {
      if (!wsId) return;
      setUploading(true);
      setError(null);
      try {
        const artifact = await api.upload(wsId, file);
        setUploads((u) => [...u, artifact]);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setUploading(false);
      }
    },
    [wsId],
  );

  return {
    turns: res.data?.turns ?? [],
    coverage: res.data?.coverage ?? {},
    send,
    upload,
    uploads,
    sending,
    uploading,
    loading: res.loading,
    error: error ?? res.error,
  };
}

// ---------------------------------------------------------------------------
// research

const MAX_LIVE_EVENTS = 500;

export function useResearch(wsId: string | null | undefined) {
  const runs = useResource(`runs:${wsId ?? ''}`, wsId ? () => api.listRuns(wsId) : null);
  const [selected, setSelected] = useState<string | null>(null);
  const latestRunId = useMemo(() => {
    const list = [...(runs.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return list[0]?.id ?? null;
  }, [runs.data]);
  const runId = selected ?? latestRunId;
  const tasks = useResource(
    `tasks:${wsId ?? ''}:${runId ?? ''}`,
    wsId && runId ? () => api.listTasks(wsId, runId) : null,
  );
  const [liveEvents, setLiveEvents] = useState<BusEvent[]>([]);
  const action = useAction();
  const stopAction = useAction();

  useEffect(() => {
    setLiveEvents([]);
    setSelected(null);
  }, [wsId]);

  // Coalesce refreshes triggered by status changes.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRuns = runs.reload;
  const reloadTasks = tasks.reload;
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useBusEvents(wsId, (e) => {
    if (e.type === 'user_request' || e.type === 'user_request_resolved') return;
    setLiveEvents((prev) => {
      const next = [...prev, e];
      return next.length > MAX_LIVE_EVENTS ? next.slice(next.length - MAX_LIVE_EVENTS) : next;
    });
    if (e.type === 'run_status' || e.type === 'decision') {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void reloadRuns();
        void reloadTasks();
      }, 500);
    }
  });

  const start = useCallback(
    async (phases?: ResearchPhase[]) => {
      if (!wsId) return;
      await action.run(() => api.startResearch(wsId, phases));
      setSelected(null);
      await reloadRuns();
    },
    [wsId, action.run, reloadRuns],
  );

  /** Stops the research of this business (its running agents too), then reads the runs and tasks again. */
  const stop = useCallback(async () => {
    if (!wsId) return;
    await stopAction.run(() => api.stopResearch(wsId));
    await Promise.all([reloadRuns(), reloadTasks()]);
  }, [wsId, stopAction.run, reloadRuns, reloadTasks]);

  return {
    runs: runs.data ?? [],
    tasks: tasks.data ?? [],
    selectedRunId: runId,
    selectRun: setSelected,
    start,
    starting: action.busy,
    stop,
    stopping: stopAction.busy,
    liveEvents,
    clearLiveEvents: () => setLiveEvents([]),
    loading: runs.loading || tasks.loading,
    error: action.error ?? stopAction.error ?? runs.error ?? tasks.error,
    reload: async () => {
      await Promise.all([reloadRuns(), reloadTasks()]);
    },
  };
}

// ---------------------------------------------------------------------------
// findings & evidence

/**
 * Mirrors `isSynthesisEligible` in src/core/evidence/synthesis.ts: verified findings feed
 * recommendation synthesis unless the user overrides per finding (`includeInSynthesis`);
 * superseded findings never do.
 */
export function usedInSynthesis(f: Pick<Finding, 'status' | 'includeInSynthesis'>): boolean {
  if (f.status === 'superseded') return false;
  return f.includeInSynthesis ?? f.status === 'verified';
}

type ReviewedOutput = { status?: OutputStatus | undefined; includeOverride?: boolean | undefined };

/**
 * Mirrors `isOutputUsable` in src/core/research/outputs.ts: recommendations / personas go to the
 * persona panel when verified, unless the user overrides; superseded ones never do.
 */
export function usedInPanel(x: ReviewedOutput): boolean {
  if (x.status === 'superseded') return false;
  return x.includeOverride ?? (x.status ?? 'pending') === 'verified';
}

/**
 * Mirrors `isRecommendationShown`: Strategy hides superseded recommendations, and failed ones unless
 * the user included them.
 */
export function shownInStrategy(r: ReviewedOutput): boolean {
  if (r.status === 'superseded') return false;
  return r.status !== 'failed' || r.includeOverride === true;
}

/** True when an output's review did not pass (shown flagged with the last reviewer's objections). */
export function needsReviewFlag(x: ReviewedOutput): boolean {
  return x.status !== undefined && x.status !== 'verified';
}

export function useFindings(wsId: string | null | undefined) {
  const findings = useResource(`findings:${wsId ?? ''}`, wsId ? () => api.listFindings(wsId) : null);
  const symptoms = useResource(`symptoms:${wsId ?? ''}`, wsId ? () => api.listSymptoms(wsId) : null);
  useTaskStatusRefresh(wsId, findings.reload);
  const action = useAction();
  /** `null` resets the override to the default (verified findings only). */
  const setIncludeInSynthesis = useCallback(
    async (findingId: string, include: boolean | null) => {
      await action.run(() => api.setFindingInclude(findingId, include));
      await findings.reload();
    },
    [action.run, findings.reload],
  );
  return {
    findings: findings.data ?? [],
    /** Spec §7.2: verified findings feed synthesis unless the user overrides per finding. */
    usedInSynthesis,
    setIncludeInSynthesis,
    saving: action.busy,
    actionError: action.error,
    symptoms: (symptoms.data ?? []).filter((s) => s.kind === 'symptom'),
    strengths: (symptoms.data ?? []).filter((s) => s.kind === 'strength'),
    loading: findings.loading || symptoms.loading,
    error: findings.error ?? symptoms.error,
    reload: async () => {
      await Promise.all([findings.reload(), symptoms.reload()]);
    },
  };
}

/**
 * Findings of the workspace's business tree by id, for recommendation → findings → artifacts
 * traversal (spec §7.3; recommendations may cite findings of other nodes of the same tree).
 * `resolve(ids)` returns the findings in citation order plus ids that could not be found.
 */
export function useFindingIndex(wsId: string | null | undefined) {
  const res = useResource(`tree-findings:${wsId ?? ''}`, wsId ? () => api.listFindings(wsId, { tree: true }) : null);
  useTaskStatusRefresh(wsId, res.reload);
  const byId = useMemo(() => new Map((res.data ?? []).map((f) => [f.id, f])), [res.data]);
  const resolve = useCallback(
    (ids: string[]) => {
      const found: TreeFindingView[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const f = byId.get(id);
        if (f) found.push(f);
        else missing.push(id);
      }
      return { found, missing };
    },
    [byId],
  );
  return { resolve, loading: res.loading, error: res.error };
}

/** Screenshots grouped per flow ordered by step; everything else as links. */
export function groupEvidence(items: EvidenceItem[]): EvidenceGroups {
  const flows = new Map<string, EvidenceItem[]>();
  const links: EvidenceItem[] = [];
  for (const item of items) {
    const a = item.artifact;
    const isImage = a ? a.kind === 'screenshot' || a.mime.startsWith('image/') : false;
    if (a && isImage) {
      const flow = a.flow ?? 'screenshots';
      flows.set(flow, [...(flows.get(flow) ?? []), item]);
    } else {
      links.push(item);
    }
  }
  return {
    flows: [...flows.entries()].map(([flow, list]) => ({
      flow,
      items: [...list].sort(
        (x, y) =>
          (x.artifact?.step ?? Number.MAX_SAFE_INTEGER) - (y.artifact?.step ?? Number.MAX_SAFE_INTEGER) ||
          (x.artifact?.capturedAt ?? '').localeCompare(y.artifact?.capturedAt ?? ''),
      ),
    })),
    links,
  };
}

export function evidenceLabel(item: EvidenceItem): string {
  const a = item.artifact;
  if (!a) return item.id;
  return a.title || a.sourceUrl || `${a.kind} ${a.id}`;
}

export function useEvidence(artifactIds: string[]) {
  const key = artifactIds.join(',');
  const res = useResource(`evidence:${key}`, artifactIds.length
    ? () =>
        Promise.all(
          artifactIds.map(async (id): Promise<EvidenceItem> => {
            const artifact = await api.getArtifactMeta(id).catch(() => undefined);
            return artifact ? { id, url: artifactUrl(id), artifact } : { id, url: artifactUrl(id) };
          }),
        )
    : null);
  const items = res.data ?? [];
  return { items, groups: groupEvidence(items), loading: res.loading };
}

// ---------------------------------------------------------------------------
// personas, recommendations, decisions

/**
 * Ratable criteria keys of a finding: only the finding criteria (`FINDING_CRITERIA`), in that
 * order. Competitor keys an agent may have put on a finding (threat, pricing, ...) are not offered:
 * they are rated on the competitor itself (Competitors page).
 */
export function findingCriteriaKeys(criteria: Criteria): string[] {
  return FINDING_CRITERIA.filter((k) => criteria[k] !== undefined);
}

/**
 * Rated competitors (spec §9), highest threat first, each with its ratable criteria in a fixed order.
 * `competitors`: usable ones (verified, or included by the user). `notUsed`: the others that are not
 * superseded (pending, unverified, failed, or excluded), listed with their last review and the
 * include toggle.
 */
export function useCompetitors(wsId: string | null | undefined) {
  const res = useResource(`competitors:${wsId ?? ''}`, wsId ? () => api.listCompetitors(wsId) : null);
  const action = useAction();
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status') void res.reload();
    if (e.type === 'decision' && (e.decision.payload as { tool?: string } | null)?.tool === 'save_competitor') void res.reload();
  });
  const all = useMemo(
    () => [...(res.data ?? [])].sort((a, b) => b.threat - a.threat || a.name.localeCompare(b.name)),
    [res.data],
  );
  const competitors = useMemo(() => all.filter(usedInPanel), [all]);
  const notUsed = useMemo(() => all.filter((c) => c.status !== 'superseded' && !usedInPanel(c)), [all]);
  /** Include override; `null` resets to the default (verified competitors only). */
  const setInclude = useCallback(
    async (id: string, include: boolean | null) => {
      await action.run(() => api.setCompetitorInclude(id, include));
      await res.reload();
    },
    [action.run, res.reload],
  );
  return {
    competitors,
    notUsed,
    criteriaKeys: COMPETITOR_CRITERIA as readonly string[],
    setInclude,
    saving: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

export function usePersonas(wsId: string | null | undefined) {
  const res = useResource(`personas:${wsId ?? ''}`, wsId ? () => api.listPersonas(wsId) : null);
  useTaskStatusRefresh(wsId, res.reload);
  const action = useAction();
  /** Persona-panel override; `null` resets to the default (verified personas only). */
  const setInclude = useCallback(
    async (personaId: string, include: boolean | null) => {
      await action.run(() => api.setPersonaInclude(personaId, include));
      await res.reload();
    },
    [action.run, res.reload],
  );
  return {
    personas: res.data ?? [],
    usedInPanel,
    needsReviewFlag,
    setInclude,
    saving: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/**
 * Recommendations for Strategy, by priority. Superseded ones are never listed; failed ones only when
 * the user included them (`hiddenCount` counts the rest). Unverified ones are listed and flagged.
 */
export function useRecommendations(wsId: string | null | undefined) {
  const res = useResource(`recs:${wsId ?? ''}`, wsId ? () => api.listRecommendations(wsId) : null);
  useTaskStatusRefresh(wsId, res.reload);
  const action = useAction();
  const all = useMemo(() => [...(res.data ?? [])].sort((a, b) => b.priority - a.priority), [res.data]);
  const recommendations = useMemo(() => all.filter(shownInStrategy), [all]);
  /** Persona-panel / Strategy override; `null` resets to the default (verified only). */
  const setInclude = useCallback(
    async (recId: string, include: boolean | null) => {
      await action.run(() => api.setRecommendationInclude(recId, include));
      await res.reload();
    },
    [action.run, res.reload],
  );
  /** Failed recommendations (not superseded) the user has not included: behind the "show hidden" switch. */
  const hiddenFailed = useMemo(() => all.filter((r) => r.status === 'failed' && !shownInStrategy(r)), [all]);
  const [showHidden, setShowHidden] = useState(false);
  return {
    recommendations,
    hiddenCount: all.length - recommendations.length,
    hiddenFailed,
    showHidden,
    setShowHidden,
    usedInPanel,
    needsReviewFlag,
    setInclude,
    saving: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

export function useDecisions(wsId: string | null | undefined, kind?: Decision['kind']) {
  const res = useResource(
    `decisions:${wsId ?? ''}:${kind ?? ''}`,
    wsId ? () => api.listDecisions(wsId, kind) : null,
  );
  useBusEvents(wsId, (e) => {
    if (e.type !== 'decision') return;
    if (kind && e.decision.kind !== kind) return;
    res.mutate((list) => (list?.some((d) => d.id === e.decision.id) ? list : [...(list ?? []), e.decision]));
  });
  const decisions = useMemo(
    () => [...(res.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [res.data],
  );
  return {
    decisions,
    exportUrl: wsId ? exportUrl(wsId) : null,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

// --- knowledge store integration (design §12 ruling): the export's visible cost ---
/**
 * The export summary (what the default exclusion leaves out, by cause) and the include-uploads link.
 * Ruling R6 (wave 2): fetched ONLY on `compute()` — the route runs the whole export, so neither the
 * Decision log nor the Metrics page loads it on open.
 */
export function useExportSummary(wsId: string | null | undefined) {
  const [state, setState] = useState<{ wsId: string; data: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ wsId: string; message: string } | null>(null);
  const compute = useCallback(async () => {
    if (!wsId) return;
    const owner = wsId;
    setBusy(true);
    setError(null);
    try {
      setState({ wsId: owner, data: await api.exportSummary(owner) });
    } catch (e) {
      setError({ wsId: owner, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [wsId]);
  const data = state && state.wsId === wsId ? state.data : undefined;
  const view = useMemo(() => (data === undefined ? null : exportSummaryView(data)), [data]);
  return {
    view, compute, busy, error: error && error.wsId === wsId ? error.message : null,
    includeUploadsUrl: wsId ? exportUrl(wsId, true) : null,
  };
}
// --- end export summary ---

export function useCalibration(wsId: string | null | undefined) {
  const res = useResource(`calibration:${wsId ?? ''}`, wsId ? () => api.getCalibration(wsId) : null);
  return { report: res.data ?? null, loading: res.loading, error: res.error, reload: res.reload };
}

/**
 * Prompt calibration patch: propose one for a role from the user's disagreements, let the user
 * edit the text, and apply it only on explicit approval.
 */
export function usePromptPatch(wsId: string | null | undefined) {
  const [role, setRoleState] = useState<PatchRole>('worker');
  // Every piece of state is tagged with the workspace it belongs to; state of another workspace
  // (after switching, or a response that arrives after switching) is never shown or applied.
  const [draft, setDraft] = useState<{ wsId: string; patch: PromptPatch; text: string } | null>(null);
  const [appliedState, setAppliedState] = useState<{ wsId: string; result: AppliedPromptPatch } | null>(null);
  const action = useAction();

  const current = draft && draft.wsId === wsId ? draft : null;
  const proposal = current?.patch ?? null;
  const text = current?.text ?? '';
  const applied = appliedState && appliedState.wsId === wsId ? appliedState.result : null;

  const setText = useCallback(
    (t: string) => setDraft((d) => (d && d.wsId === wsId ? { ...d, text: t } : d)),
    [wsId],
  );

  const setRole = useCallback((r: PatchRole) => {
    setRoleState(r);
    setDraft(null);
    setAppliedState(null);
  }, []);

  const propose = useCallback(async () => {
    if (!wsId) return;
    const owner = wsId;
    setAppliedState(null);
    const p = await action.run(() => api.proposePromptPatch(owner, role));
    if (p) setDraft({ wsId: owner, patch: p, text: p.patchText });
  }, [wsId, role, action.run]);

  const apply = useCallback(async () => {
    if (!wsId || !current) return;
    const owner = current.wsId;
    const r = await action.run(() => api.applyPromptPatch(owner, { ...current.patch, patchText: current.text }));
    if (r) {
      setAppliedState({ wsId: owner, result: r });
      setDraft(null);
    }
  }, [wsId, current, action.run]);

  const discard = useCallback(() => setDraft(null), []);

  return {
    roles: PATCH_ROLES,
    role,
    setRole,
    proposal,
    text,
    setText,
    edited: proposal !== null && text !== proposal.patchText,
    canApply: proposal !== null && text.trim().length > 0 && !action.busy,
    propose,
    apply,
    discard,
    applied,
    busy: action.busy,
    error: action.error,
  };
}

/** Parses a weight input; returns undefined when it is not a finite number ≥ 0. */
export function parseWeight(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Editor for the global priority weights (shared by all workspaces; logged as a Decision). */
export function useScoringWeights(wsId: string | null | undefined) {
  const res = useResource(`scoring-weights:${wsId ?? ''}`, wsId ? () => api.getScoringWeights(wsId) : null);
  const action = useAction();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [savedDecisionId, setSavedDecisionId] = useState<string | null>(null);

  const current = res.data;
  const fromServer = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of WEIGHT_KEYS) out[k] = String(current?.weights?.[k] ?? 1);
    out.personaWeight = String(current?.personaWeight ?? 0);
    return out;
  }, [current]);
  const values = draft ?? fromServer;
  const invalid = Object.keys(values).filter((k) => parseWeight(values[k] ?? '') === undefined);

  const set = useCallback(
    (key: WeightKey | 'personaWeight', raw: string) => setDraft((d) => ({ ...(d ?? fromServer), [key]: raw })),
    [fromServer],
  );
  const adoptProposed = useCallback(() => {
    const proposed = current?.proposedWeights;
    if (!proposed) return;
    setDraft((d) => {
      const next = { ...(d ?? fromServer) };
      for (const k of WEIGHT_KEYS) if (proposed[k] !== undefined) next[k] = String(proposed[k]);
      return next;
    });
  }, [current, fromServer]);

  /** Resolves `true` only when the server saved (and rescored) the weights. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!wsId || invalid.length > 0) return false;
    const weights: Record<string, number> = {};
    for (const k of WEIGHT_KEYS) weights[k] = parseWeight(values[k] ?? '') as number;
    const personaWeight = parseWeight(values.personaWeight ?? '') as number;
    const saved = await action.run(() => api.putScoringWeights(wsId, { weights, personaWeight }));
    if (!saved) return false;
    res.mutate((prev) => ({ ...saved, proposedWeights: prev?.proposedWeights }));
    setSavedDecisionId(saved.decisionId ?? null);
    setDraft(null);
    return true;
  }, [wsId, invalid.length, values, action.run, res.mutate]);

  const proposed = current?.proposedWeights;
  const hasProposal =
    !!proposed && WEIGHT_KEYS.some((k) => proposed[k] !== undefined && proposed[k] !== (current?.weights?.[k] ?? 1));

  return {
    keys: WEIGHT_KEYS,
    values,
    set,
    invalid,
    dirty: draft !== null,
    proposed: proposed ?? null,
    hasProposal,
    adoptProposed,
    save,
    revert: () => setDraft(null),
    savedDecisionId,
    saving: action.busy,
    loading: res.loading,
    error: res.error ?? action.error,
  };
}

/** Maps a scheduler "what changed" Decision to a display entry (null when it is not one). */
export function toChangeEntry(d: Decision): ChangeEntry | null {
  const p = d.payload as WhatChangedPayload | null;
  if (!p || p.event !== 'what_changed') return null;
  const newFindings = p.newFindings ?? [];
  const removedSubjects = p.removedSubjects ?? [];
  const changedArtifacts = p.changedArtifacts ?? [];
  const replaced = p.replaced ?? []; // KS-5
  const retracted = p.retracted ?? []; // KS-5
  const confirmed = p.confirmed ?? 0; // KS-5
  const flows: FlowChanges = {
    newFlows: p.flows?.newFlows ?? [], newVersions: p.flows?.newVersions ?? [], confirmed: p.flows?.confirmed ?? 0, rankMoves: p.flows?.rankMoves ?? [],
  };
  const flowsEmpty = flows.newFlows.length === 0 && flows.newVersions.length === 0 && flows.confirmed === 0 && flows.rankMoves.length === 0;
  return {
    id: d.id,
    createdAt: d.createdAt,
    scheduleName: p.scheduleName ?? p.scheduleId ?? 'schedule',
    phase: p.phase ?? '',
    newFindings,
    removedSubjects,
    changedArtifacts,
    replaced,
    retracted,
    confirmed,
    flows,
    empty:
      newFindings.length === 0 && removedSubjects.length === 0 && changedArtifacts.length === 0 &&
      replaced.length === 0 && retracted.length === 0 && confirmed === 0 && flowsEmpty,
  };
}

/** "What changed" between consecutive scheduled runs, newest first, updated live. */
export function useChanges(wsId: string | null | undefined) {
  const res = useResource(`changes:${wsId ?? ''}`, wsId ? () => api.listChanges(wsId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type !== 'decision' || !toChangeEntry(e.decision)) return;
    res.mutate((list) => (list?.some((d) => d.id === e.decision.id) ? list : [...(list ?? []), e.decision]));
  });
  const changes = useMemo(
    () =>
      (res.data ?? [])
        .map(toChangeEntry)
        .filter((c): c is ChangeEntry => c !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [res.data],
  );
  return { changes, loading: res.loading, error: res.error, reload: res.reload };
}

// ---------------------------------------------------------------------------
// ratings & review queue

export const ratingKey = (targetType: RatingTargetType, targetId: string, criterion: string) =>
  `${targetType}:${targetId}:${criterion}`;

// Shared per-workspace index of the user's current ratings (latest per target + criterion), so
// every CriterionRating shows existing state without one request per control.
type RatingIndex = { ratings: Map<string, Rating>; loaded: boolean; listeners: Set<() => void>; loading?: Promise<void> | undefined };
const ratingIndexes = new Map<string, RatingIndex>();

function ratingIndex(wsId: string): RatingIndex {
  let idx = ratingIndexes.get(wsId);
  if (!idx) {
    idx = { ratings: new Map(), loaded: false, listeners: new Set() };
    ratingIndexes.set(wsId, idx);
  }
  return idx;
}

function notifyRatings(idx: RatingIndex) {
  for (const fn of idx.listeners) fn();
}

/** Records a rating the user just made in the shared index. */
export function rememberRating(r: Rating): void {
  const idx = ratingIndex(r.workspaceId);
  idx.ratings.set(ratingKey(r.targetType, r.targetId, r.criterion), r);
  notifyRatings(idx);
}

/** Drops cached rating indexes (tests). */
export function resetRatingIndexes(): void {
  ratingIndexes.clear();
}

/** The user's current rating of one criterion, loaded once per workspace. */
export function useExistingRating(wsId: string, targetType: RatingTargetType, targetId: string, criterion: string) {
  const idx = ratingIndex(wsId);
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    // First subscriber after every control unmounted (page change / remount): ratings may have
    // changed elsewhere (review queue, another tab), so refetch instead of trusting the cache.
    if (idx.listeners.size === 0 && !idx.loading) idx.loaded = false;
    idx.listeners.add(fn);
    if (!idx.loaded && !idx.loading) {
      idx.loading = api
        .listRatings(wsId)
        .then((list) => {
          for (const r of list) {
            const k = ratingKey(r.targetType, r.targetId, r.criterion);
            const prev = idx.ratings.get(k);
            if (!prev || prev.createdAt <= r.createdAt) idx.ratings.set(k, r);
          }
          idx.loaded = true;
        })
        .catch(() => {
          // Without the index the controls simply start unrated.
        })
        .finally(() => {
          idx.loading = undefined;
          notifyRatings(idx);
        });
    }
    return () => {
      idx.listeners.delete(fn);
    };
  }, [idx, wsId]);
  return idx.ratings.get(ratingKey(targetType, targetId, criterion));
}

export function useRatings() {
  const [rated, setRated] = useState<Record<string, Rating>>({});
  const action = useAction();
  const rate = useCallback(
    async (input: RatingInput): Promise<Rating | undefined> => {
      const rating = await action.run(() => api.rate(input));
      if (rating) {
        setRated((r) => ({ ...r, [ratingKey(input.targetType, input.targetId, input.criterion)]: rating }));
        rememberRating(rating);
      }
      return rating;
    },
    [action.run],
  );
  return { rate, rated, saving: action.busy, error: action.error };
}

export interface CriterionTarget {
  workspaceId: string;
  targetType: RatingTargetType;
  targetId: string;
  criterion: string;
  agentValue: number | string | null | undefined;
}

/** Same verdict and value as the existing rating, so submitting again would only add a duplicate row. */
function sameRating(existing: Rating | undefined, input: RatingInput): boolean {
  if (!existing || existing.verdict !== input.verdict) return false;
  if (input.verdict === 'agree') return true;
  return String(existing.userValue) === String(input.userValue) && (existing.reason ?? '') === (input.reason ?? '');
}

/**
 * State machine behind `CriterionRating`: agree, or disagree → own value + optional reason.
 * Starts from the user's existing rating (shown as done). Ratings are append-only history: a
 * changed rating adds a row and the latest wins; re-submitting the same rating sends nothing.
 */
export function useCriterionRating(target: CriterionTarget, onRated?: (r: Rating) => void) {
  const { rate, saving, error } = useRatings();
  const existing = useExistingRating(target.workspaceId, target.targetType, target.targetId, target.criterion);
  const [mode, setMode] = useState<'idle' | 'disagreeing' | 'done' | null>(null);
  const [verdict, setVerdict] = useState<Rating['verdict'] | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  // Until the user acts, the state mirrors the existing rating.
  const shownMode = mode ?? (existing ? 'done' : 'idle');
  const shownVerdict = verdict ?? existing?.verdict ?? null;
  const shownValue = mode === null && existing?.verdict === 'disagree' ? String(existing.userValue ?? '') : value;

  const submit = async (v: Rating['verdict']) => {
    const input: RatingInput = {
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId: target.targetId,
      criterion: target.criterion,
      verdict: v,
    };
    if (v === 'disagree') {
      const raw = value.trim();
      const asNum = Number(raw);
      input.userValue = typeof target.agentValue === 'number' && raw !== '' && Number.isFinite(asNum) ? asNum : raw;
      if (reason.trim()) input.reason = reason.trim();
    }
    if (sameRating(existing, input)) {
      setVerdict(v);
      setMode('done');
      return;
    }
    const rating = await rate(input);
    if (rating) {
      setVerdict(v);
      setMode('done');
      onRated?.(rating);
    }
  };

  return {
    mode: shownMode,
    verdict: shownVerdict,
    value: shownValue,
    reason,
    existing: existing ?? null,
    setValue,
    setReason,
    saving,
    error,
    canSubmitDisagree: value.trim() !== '',
    agree: () => submit('agree'),
    startDisagree: () => {
      const from = existing?.verdict === 'disagree' ? existing.userValue : target.agentValue;
      setValue(from == null ? '' : String(from));
      setReason(existing?.verdict === 'disagree' ? (existing.reason ?? '') : '');
      setMode('disagreeing');
    },
    cancel: () => setMode(shownVerdict ? 'done' : 'idle'),
    submitDisagree: () => submit('disagree'),
    change: () => {
      if (mode === null) setValue(shownValue);
      setVerdict(shownVerdict);
      setMode('idle');
    },
  };
}

export function useReviewQueue(wsId: string | null | undefined) {
  const res = useResource<ReviewQueueItem[]>(`queue:${wsId ?? ''}`, wsId ? () => api.getReviewQueue(wsId) : null);
  const markRated = useCallback(
    (targetType: RatingTargetType, targetId: string, criterion: string) => {
      res.mutate((items) =>
        (items ?? [])
          .map((it) =>
            it.targetType === targetType && it.targetId === targetId
              ? { ...it, unrated: it.unrated.filter((c) => c !== criterion) }
              : it,
          )
          .filter((it) => it.unrated.length > 0),
      );
    },
    [res.mutate],
  );
  return { items: res.data ?? [], markRated, loading: res.loading, error: res.error, reload: res.reload };
}

// ---------------------------------------------------------------------------
// user requests (register / login / captcha / approval)

export function useRequests(wsId: string | null | undefined) {
  const res = useResource<UserRequest[]>(`requests:${wsId ?? ''}`, wsId ? () => api.listPendingRequests(wsId) : null);
  const action = useAction();

  useBusEvents(wsId, (e) => {
    if (e.type === 'user_request' && e.request.status === 'pending') {
      res.mutate((list) => (list?.some((r) => r.id === e.request.id) ? list : [...(list ?? []), e.request]));
    } else if (e.type === 'user_request_resolved' || (e.type === 'user_request' && e.request.status !== 'pending')) {
      res.mutate((list) => list?.filter((r) => r.id !== e.request.id));
    }
  });

  const resolve = useCallback(
    async (id: string, status: 'resolved' | 'denied', response?: string) => {
      try {
        await api.resolveRequest(id, status, response);
        res.mutate((list) => list?.filter((r) => r.id !== id));
      } catch (e) {
        // 404 (gone) / 409 (already decided, e.g. in another tab): it is no longer pending here.
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          res.mutate((list) => list?.filter((r) => r.id !== id));
          await res.reload();
          return;
        }
        await action.run(() => Promise.reject(e));
      }
    },
    [action.run, res.mutate, res.reload],
  );

  // WP-D: answer an escalation question with an option index and an optional note.
  const answerEscalation = useCallback(
    async (id: string, choice: number, note?: string) => {
      try {
        await api.answerEscalation(id, choice, note);
        res.mutate((list) => list?.filter((r) => r.id !== id));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          res.mutate((list) => list?.filter((r) => r.id !== id));
          await res.reload();
          return;
        }
        await action.run(() => Promise.reject(e));
      }
    },
    [action.run, res.mutate, res.reload],
  );

  return {
    pending: res.data ?? [],
    resolve,
    answerEscalation, // WP-D
    resolving: action.busy,
    loading: res.loading,
    error: res.error ?? action.error,
    reload: res.reload,
  };
}

// ---------------------------------------------------------------------------
// schedules & config

export function useSchedules(wsId: string | null | undefined) {
  const res = useResource(`schedules:${wsId ?? ''}`, wsId ? () => api.listSchedules(wsId) : null);
  const action = useAction();
  /** Resolves `true` when the schedule was created; on failure `error` is set and it resolves `false`. */
  const create = useCallback(
    async (input: NewSchedule): Promise<boolean> => {
      if (!wsId) return false;
      const created = await action.run(() => api.createSchedule(wsId, input));
      await res.reload();
      return created !== undefined;
    },
    [wsId, action.run, res.reload],
  );
  const update = useCallback(
    async (id: string, patch: SchedulePatch): Promise<boolean> => {
      if (!wsId) return false;
      const updated = await action.run(() => api.updateSchedule(wsId, id, patch));
      await res.reload();
      return updated !== undefined;
    },
    [wsId, action.run, res.reload],
  );
  return {
    schedules: res.data ?? [],
    create,
    update,
    saving: action.busy,
    loading: res.loading,
    error: res.error ?? action.error,
  };
}

export function useConfig() {
  const res = useResource('config', api.getConfig);
  const action = useAction();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** Resolves `true` when the server accepted the config; on failure `error` is set and it resolves `false`. */
  const save = useCallback(
    async (config: BifConfig): Promise<boolean> => {
      const saved = await action.run(() => api.putConfig(config));
      if (saved === undefined) return false;
      res.mutate(() => saved ?? config);
      setSavedAt(new Date().toISOString());
      return true;
    },
    [action.run, res.mutate],
  );
  return { config: res.data ?? null, save, saving: action.busy, savedAt, loading: res.loading, error: res.error ?? action.error, reload: res.reload };
}

/** JSON text editor over `useConfig` for the Settings page. */
export function useConfigEditor() {
  const cfg = useConfig();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (cfg.config ? JSON.stringify(cfg.config, null, 2) : '');
  let parseError: string | null = null;
  let parsed: BifConfig | null = null;
  if (shown) {
    try {
      parsed = JSON.parse(shown) as BifConfig;
    } catch (e) {
      parseError = errMsg(e);
    }
  }
  return {
    ...cfg,
    text: shown,
    setText,
    parseError,
    dirty: text !== null,
    /** Keeps the draft when the save fails (the error is in `error`). */
    save: async (): Promise<boolean> => {
      if (!parsed) return false;
      const ok = await cfg.save(parsed);
      if (ok) setText(null);
      return ok;
    },
    revert: () => setText(null),
  };
}

// ---------------------------------------------------------------------------
// flow records and flow ranking: the Flows page (design 2026-11-14 §10.5, §11, §12.2)

const TYPE_TOOLS = new Set(['save_flow', 'propose_flow_type', 'propose_checklist']);
const RANKING_TOOLS = new Set(['save_flow', 'submit_flow_verdicts']);
const FLOW_TOOLS = new Set(['save_flow', 'submit_flow_verdicts', 'save_flow_checks', 'save_review_mentions']);

/** Reloads on `task_status` and on decisions of the given tools. */
function useFlowRefresh(wsId: string | null | undefined, tools: Set<string>, reload: () => Promise<void>): void {
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status') void reload();
    else if (e.type === 'decision' && tools.has((e.decision.payload as { tool?: string } | null)?.tool ?? '')) void reload();
  });
}

/** An action of the Flows page: `busy`, the server's error message as is, and a plain-words notice on success. */
function useFlowAction() {
  const action = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(
    async <R>(fn: () => Promise<R>, done: (r: R) => string): Promise<R | undefined> => {
      setNotice(null);
      const r = await action.run(fn);
      if (r !== undefined) setNotice(done(r));
      return r;
    },
    [action.run],
  );
  return { busy: action.busy, error: action.error, notice, run };
}

const TYPE_DONE: Record<FlowTypeDecisionInput['action'], string> = {
  accept: 'Flow type accepted.',
  reject: 'Flow type rejected.',
  merge: 'Flow type merged.',
  edit: 'Flow type changed.',
};

/** The node's flow types with their flow counts, and the proposals waiting on the user (accept / edit / reject / merge). */
export function useFlowTypes(wsId: string | null | undefined) {
  const res = useResource(`flowTypes:${wsId ?? ''}`, wsId ? () => flowsApi.types(wsId) : null);
  useFlowRefresh(wsId, TYPE_TOOLS, res.reload);
  const act = useFlowAction();
  const decideType = useCallback(
    async (typeId: string, decision: FlowTypeDecisionInput, reason?: string): Promise<boolean> => {
      if (!wsId) return false;
      const r = await act.run(() => flowsApi.decideFlowType(wsId, typeId, decision, reason), () => TYPE_DONE[decision.action]);
      if (r !== undefined) await res.reload();
      return r !== undefined;
    },
    [wsId, act.run, res.reload],
  );
  /** Accepting tells how many flows need a re-walk to answer the new checks. */
  const decideChecklist = useCallback(
    async (checklistId: string, decision: ChecklistDecisionInput, reason?: string): Promise<boolean> => {
      if (!wsId) return false;
      const r = await act.run(
        () => flowsApi.decideChecklist(wsId, checklistId, decision, reason),
        (out) => {
          if (decision.action === 'reject') return 'Checklist rejected.';
          const n = out.needRewalk.length;
          return n === 0
            ? 'Checklist accepted. No flow needs a re-walk.'
            : `Checklist accepted. ${plural(n, 'flow')} need${n === 1 ? 's' : ''} a re-walk to answer its new checks.`;
        },
      );
      if (r !== undefined) await res.reload();
      return r !== undefined;
    },
    [wsId, act.run, res.reload],
  );
  const types = useMemo(() => res.data?.flowTypes ?? [], [res.data]);
  return {
    types,
    proposals: res.data?.proposals ?? { flowTypes: [], checklists: [] },
    decideType,
    decideChecklist,
    busy: act.busy,
    actionError: act.error,
    notice: act.notice,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/**
 * The node's ranking of one flow type (`personaId`: one persona's verdicts only; `allVariants`: the
 * subjects' other variants too), with the user's reactions and rulings. Reloads when a task ends and
 * when a flow is saved or persona verdicts are submitted.
 */
export function useFlowRanking(
  wsId: string | null | undefined,
  flowTypeId: string | null | undefined,
  opts: { personaId?: string; allVariants?: boolean } = {},
) {
  const { personaId, allVariants } = opts;
  const res = useResource(
    `flowRanking:${wsId ?? ''}:${flowTypeId ?? ''}:${personaId ?? ''}:${allVariants ? 'all' : ''}`,
    wsId && flowTypeId ? () => flowsApi.ranking(wsId, flowTypeId, { ...(personaId ? { personaId } : {}), allVariants: allVariants === true }) : null,
  );
  useFlowRefresh(wsId, RANKING_TOOLS, res.reload);
  const act = useFlowAction();
  const after = useCallback(
    async <R>(fn: () => Promise<R>, done: string, reload = true): Promise<boolean> => {
      const r = await act.run(fn, () => done);
      if (r !== undefined && reload) await res.reload();
      return r !== undefined;
    },
    [act.run, res.reload],
  );
  /** Agree or disagree with a position; the ranking itself does not change. */
  const react = useCallback(
    async (flowId: string, reaction: FlowReaction, reason?: string) =>
      !!wsId &&
      !!flowTypeId &&
      after(
        () => flowsApi.reactToPosition(wsId, flowId, flowTypeId, reaction, reason),
        reaction === 'agree' ? 'Recorded: you agree with this position.' : 'Recorded: you disagree with this position.',
        false,
      ),
    [wsId, flowTypeId, after],
  );
  /** "This one is better than that one": a hard rule on the ranking. A new ruling on the same pair replaces the earlier one. */
  const override = useCallback(
    async (winnerFlowId: string, loserFlowId: string, reason?: string) =>
      !!wsId &&
      !!flowTypeId &&
      after(() => flowsApi.override(wsId, flowTypeId, winnerFlowId, loserFlowId, reason), 'Your ruling is saved; the ranking follows it.'),
    [wsId, flowTypeId, after],
  );
  const revokeOverride = useCallback(
    async (overrideId: string, reason?: string) => !!wsId && after(() => flowsApi.revokeOverride(wsId, overrideId, reason), 'Ruling removed.'),
    [wsId, after],
  );
  const confirmOverride = useCallback(
    async (overrideId: string, keep: boolean, reason?: string) =>
      !!wsId &&
      after(() => flowsApi.confirmOverride(wsId, overrideId, keep, reason), keep ? 'Ruling kept for the new version.' : 'Ruling dropped.'),
    [wsId, after],
  );
  return {
    ranking: res.data,
    rows: res.data?.ranked ?? [],
    react,
    override,
    revokeOverride,
    confirmOverride,
    busy: act.busy,
    actionError: act.error,
    notice: act.notice,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/**
 * One flow and everything behind its position: steps, checks, reviews, the persona verdicts
 * (simulated; `counted` ones first, the others apart as not part of the score) and the rulings.
 */
export function useFlow(wsId: string | null | undefined, flowId: string | null | undefined) {
  const res = useResource(`flow:${wsId ?? ''}:${flowId ?? ''}`, wsId && flowId ? () => flowsApi.flow(wsId, flowId) : null);
  useFlowRefresh(wsId, FLOW_TOOLS, res.reload);
  const act = useFlowAction();
  const after = useCallback(
    async <R>(fn: () => Promise<R>, done: string, reload = true): Promise<boolean> => {
      const r = await act.run(fn, () => done);
      if (r !== undefined && reload) await res.reload();
      return r !== undefined;
    },
    [act.run, res.reload],
  );
  const reactToVerdict = useCallback(
    async (verdictId: string, reaction: FlowReaction, reason?: string) =>
      !!wsId &&
      after(
        () => flowsApi.reactToVerdict(wsId, verdictId, reaction, reason),
        reaction === 'agree'
          ? 'Recorded: you agree with this simulated verdict.'
          : 'Recorded: you disagree with this simulated verdict. The persona looks at this pair again in the next ranking round.',
        false,
      ),
    [wsId, after],
  );
  const correctCheck = useCallback(
    async (input: { checklistId: string; itemKey: string; answer: CheckAnswer; note?: string }, reason?: string) =>
      !!wsId && !!flowId && after(() => flowsApi.correctCheck(wsId, flowId, input, reason), 'Answer corrected; the checklist score is updated.'),
    [wsId, flowId, after],
  );
  /** Correct what a review is about (not this flow, another check, another flow type); the detail reloads. */
  const correctAttribution = useCallback(
    async (mentionId: string, input: { flowTypeKey?: string; checkKey?: string }, reason?: string) =>
      !!wsId && after(() => flowsApi.correctAttribution(wsId, mentionId, input, reason), 'Saved: the review is filed where you said.'),
    [wsId, after],
  );
  const revokeOverride = useCallback(
    async (overrideId: string, reason?: string) => !!wsId && after(() => flowsApi.revokeOverride(wsId, overrideId, reason), 'Ruling removed.'),
    [wsId, after],
  );
  const confirmOverride = useCallback(
    async (overrideId: string, keep: boolean, reason?: string) =>
      !!wsId &&
      after(() => flowsApi.confirmOverride(wsId, overrideId, keep, reason), keep ? 'Ruling kept for the new version.' : 'Ruling dropped.'),
    [wsId, after],
  );
  const verdicts = useMemo(() => res.data?.verdicts ?? [], [res.data]);
  return {
    detail: res.data,
    counted: useMemo(() => verdicts.filter((v) => v.counted), [verdicts]),
    uncounted: useMemo(() => verdicts.filter((v) => !v.counted), [verdicts]),
    reactToVerdict,
    correctCheck,
    correctAttribution,
    revokeOverride,
    confirmOverride,
    busy: act.busy,
    actionError: act.error,
    notice: act.notice,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/**
 * The active checklists for a flow type (the general one and the type's own) and the user's edit of
 * one of them (coverage, item weights and questions, removals), which saves a new version and tells
 * how many flows need a re-walk. Reloads when a checklist is proposed or a task ends.
 */
export function useFlowChecklists(wsId: string | null | undefined, flowTypeId: string | null | undefined) {
  const res = useResource(
    `flowChecklists:${wsId ?? ''}:${flowTypeId ?? ''}`,
    wsId && flowTypeId ? () => flowsApi.checklists(wsId, flowTypeId) : null,
  );
  useFlowRefresh(wsId, TYPE_TOOLS, res.reload);
  const act = useFlowAction();
  const edit = useCallback(
    async (checklistId: string, input: ChecklistEditInput, reason?: string): Promise<boolean> => {
      if (!wsId) return false;
      const r = await act.run(
        () => flowsApi.editChecklist(wsId, checklistId, input, reason),
        (out) => {
          const n = out.needRewalk.length;
          return n === 0
            ? 'Checklist saved. No flow needs a re-walk.'
            : `Checklist saved. ${plural(n, 'flow')} need${n === 1 ? 's' : ''} a re-walk to answer all its checks.`;
        },
      );
      if (r !== undefined) await res.reload();
      return r !== undefined;
    },
    [wsId, act.run, res.reload],
  );
  return {
    checklists: res.data,
    edit,
    busy: act.busy,
    actionError: act.error,
    notice: act.notice,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/** Two flows of one type side by side, step by step. */
export function useFlowCompare(wsId: string | null | undefined, a: string | null | undefined, b: string | null | undefined) {
  const res = useResource(`flowCompare:${wsId ?? ''}:${a ?? ''}:${b ?? ''}`, wsId && a && b ? () => flowsApi.compare(wsId, a, b) : null);
  return { compare: res.data, loading: res.loading, error: res.error };
}

// ---------------------------------------------------------------------------
// persona learning: "What the tool has learned" on each persona card

/**
 * The node's persona learning block: per persona, the gate, active adjustments, proposals and last
 * run; the user's accept (optionally with edited text) / reject / retire, each with an optional
 * reason; and a persona's signals, loaded when the user asks to see them (and fetched again after a
 * decision on that persona, which changes them). Reloads when a task ends or a decision is recorded
 * (the retro records its proposals with a Decision).
 */
export function usePersonaLearning(wsId: string | null | undefined) {
  const res = useResource(`personaLearning:${wsId ?? ''}`, wsId ? () => personaLearningApi.view(wsId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status' || e.type === 'decision') void res.reload();
  });
  const action = useAction();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [signals, setSignals] = useState<Record<string, PersonaSignal[]>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [signalError, setSignalError] = useState<string | null>(null);
  const view = asPersonaLearningView(res.data);
  const reasonOf = (id: string) => reasons[id]?.trim() || undefined;

  /** Fetches a persona's signals again when they are loaded; on a failure drops them, so "show" loads them anew. */
  const refreshSignals = useCallback(
    async (personaId: string) => {
      if (!wsId || !signals[personaId]) return;
      try {
        const out = await personaLearningApi.signals(wsId, personaId);
        setSignals((s) => ({ ...s, [personaId]: out.signals }));
      } catch (e) {
        setSignalError(errMsg(e));
        setSignals(({ [personaId]: _, ...rest }) => rest);
        setShown((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(`${personaId}:`))));
      }
    },
    [wsId, signals],
  );

  const decide = useCallback(
    async (fn: () => Promise<unknown>, id: string, personaId: string) => {
      const ok = (await action.run(async () => (await fn(), true))) === true;
      if (ok) {
        setReasons((r) => ({ ...r, [id]: '' }));
        setEdits(({ [id]: _, ...rest }) => rest);
        await Promise.all([res.reload(), refreshSignals(personaId)]);
      }
      return ok;
    },
    [action.run, res.reload, refreshSignals],
  );

  /** Shows or hides a persona's signals; the first show loads them. */
  const toggleSignals = useCallback(
    async (key: string, personaId: string) => {
      const open = !shown[key];
      setShown((s) => ({ ...s, [key]: open }));
      if (!open || !wsId || signals[personaId]) return;
      setSignalError(null);
      try {
        const out = await personaLearningApi.signals(wsId, personaId);
        setSignals((s) => ({ ...s, [personaId]: out.signals }));
      } catch (e) {
        setSignalError(errMsg(e));
        setShown((s) => ({ ...s, [key]: false }));
      }
    },
    [wsId, shown, signals],
  );

  return {
    view,
    entryOf: (personaId: string) => view?.personas.find((p) => p.personaId === personaId),
    pending: pendingProposals(view),
    /** Of `pending`, the proposals about the person using the tool (the You page). */
    pendingUser: view?.pendingUser ?? 0,
    reason: (id: string) => reasons[id] ?? '',
    setReason: (id: string, v: string) => setReasons((r) => ({ ...r, [id]: v })),
    /** The user's edit of a proposal's text; `undefined` when not editing. */
    edit: (id: string): string | undefined => edits[id],
    startEdit: (p: PersonaProposal) => setEdits((e) => ({ ...e, [p.id]: e[p.id] ?? p.text })),
    setEdit: (id: string, v: string) => setEdits((e) => ({ ...e, [id]: v })),
    /** False while the edit box is open but empty or only spaces (Accept is disabled rather than sending the original). */
    canAccept: (id: string) => edits[id] === undefined || edits[id].trim() !== '',
    accept: (p: PersonaProposal) => {
      const edited = edits[p.id]?.trim();
      if (edited === '') return Promise.resolve(false);
      const reason = reasonOf(p.id);
      return wsId
        ? decide(() => personaLearningApi.accept(wsId, p.id, { ...(edited && edited !== p.text ? { text: edited } : {}), ...(reason ? { reason } : {}) }), p.id, p.personaId)
        : Promise.resolve(false);
    },
    reject: (p: Pick<PersonaProposal, 'id' | 'personaId'>) =>
      wsId ? decide(() => personaLearningApi.reject(wsId, p.id, reasonOf(p.id)), p.id, p.personaId) : Promise.resolve(false),
    retire: (a: Pick<PersonaAdjustment, 'id' | 'personaId'>) =>
      wsId ? decide(() => personaLearningApi.retire(wsId, a.id, reasonOf(a.id)), a.id, a.personaId) : Promise.resolve(false),
    signalsOf: (personaId: string): PersonaSignal[] | undefined => signals[personaId],
    signalsShown: (key: string) => shown[key] === true,
    toggleSignals,
    signalError,
    busy: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

// ---------------------------------------------------------------------------
// user persona: the You page

/** A user persona line as the evidence cache keys it (a replace bumps the version). */
type LineRef = { id: string; version: number };
const lineKey = (line: LineRef) => `${line.id}:${line.version}`;

/**
 * The You page: how the tool sees the person using it (their user persona of this business tree), the
 * user's accept (optionally with edited text) / reject / retire with an optional reason (through the
 * persona learning routes), and the interactions a line rests on, loaded when the user asks to see them.
 * A reason or edit stays in its box until the request succeeds. Reloads when a decision is recorded.
 */
export function useUserPersona(wsId: string | null | undefined) {
  const res = useResource(`userPersona:${wsId ?? ''}`, wsId ? () => userPersonaApi.view(wsId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'decision') void res.reload();
  });
  const action = useAction();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, UserInteraction[]>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const view = asUserPersonaView(res.data);
  const reasonOf = (id: string) => reasons[id]?.trim() || undefined;

  const decide = useCallback(
    async (fn: () => Promise<unknown>, id: string) => {
      const ok = (await action.run(async () => (await fn(), true))) === true;
      if (ok) {
        setReasons((r) => ({ ...r, [id]: '' }));
        setEdits(({ [id]: _, ...rest }) => rest);
        await res.reload();
      }
      return ok;
    },
    [action.run, res.reload],
  );

  /**
   * Shows or hides the interactions a line rests on; the first show loads them. Keyed by line id and
   * version, so a replaced line (a new version, new evidence) loads its own.
   */
  const toggleEvidence = useCallback(
    async (line: LineRef) => {
      const key = lineKey(line);
      const open = !shown[key];
      setShown((s) => ({ ...s, [key]: open }));
      if (!open || !wsId || evidence[key]) return;
      setEvidenceError(null);
      try {
        const out = await userPersonaApi.lineInteractions(wsId, line.id);
        setEvidence((s) => ({ ...s, [key]: out.interactions }));
      } catch (e) {
        setEvidenceError(errMsg(e));
        setShown((s) => ({ ...s, [key]: false }));
      }
    },
    [wsId, shown, evidence],
  );

  return {
    view,
    reason: (id: string) => reasons[id] ?? '',
    setReason: (id: string, v: string) => setReasons((r) => ({ ...r, [id]: v })),
    edit: (id: string): string | undefined => edits[id],
    startEdit: (p: Pick<PersonaProposal, 'id' | 'text'>) => setEdits((e) => ({ ...e, [p.id]: e[p.id] ?? p.text })),
    setEdit: (id: string, v: string) => setEdits((e) => ({ ...e, [id]: v })),
    canAccept: (id: string) => edits[id] === undefined || edits[id].trim() !== '',
    accept: (p: Pick<PersonaProposal, 'id' | 'text'>) => {
      const edited = edits[p.id]?.trim();
      if (edited === '') return Promise.resolve(false);
      const reason = reasonOf(p.id);
      return wsId
        ? decide(() => personaLearningApi.accept(wsId, p.id, { ...(edited && edited !== p.text ? { text: edited } : {}), ...(reason ? { reason } : {}) }), p.id)
        : Promise.resolve(false);
    },
    reject: (p: Pick<PersonaProposal, 'id'>) => (wsId ? decide(() => personaLearningApi.reject(wsId, p.id, reasonOf(p.id)), p.id) : Promise.resolve(false)),
    retire: (a: { id: string }) => (wsId ? decide(() => personaLearningApi.retire(wsId, a.id, reasonOf(a.id)), a.id) : Promise.resolve(false)),
    evidenceOf: (line: LineRef): UserInteraction[] | undefined => evidence[lineKey(line)],
    evidenceShown: (line: LineRef) => shown[lineKey(line)] === true,
    toggleEvidence,
    evidenceError,
    busy: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

// ---------------------------------------------------------------------------
// stakeholder personas: the Stakeholders page and the reads on a recommendation

/**
 * The node's stakeholders (`view` null until loaded); `ownOpen`: own stakeholders that are open (who can
 * record a real decision). `own` holds only those that have not left: a former colleague is in its
 * competitor's group or, parked, under `former`. `places`: the competitors and nodes of the tree.
 */
export function useStakeholderList(wsId: string | null | undefined) {
  const res = useResource(`stakeholders:${wsId ?? ''}`, wsId ? () => stakeholdersApi.list(wsId) : null);
  useTaskStatusRefresh(wsId, res.reload);
  const view = asStakeholdersView(res.data);
  return {
    view,
    own: view?.own ?? [],
    ownOpen: (view?.own ?? []).filter(isOpenView),
    competitors: view?.competitors ?? [],
    former: (view?.former ?? []).filter(isOpenView),
    places: placesOf(view),
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/**
 * The Stakeholders page: the stakeholders, the open question round and the user's drafts. `send`
 * posts only the non-empty answers (a stakeholder left blank stays in the round); `skip`, `skipAll`
 * and `reveal` ("Show what the tool found") post at once. After each change both lists are reloaded and
 * `onChange` is called (a change can open stakeholders, whose learning block then loads).
 */
export function useStakeholders(wsId: string | null | undefined, onChange?: () => void) {
  const list = useStakeholderList(wsId);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const qs = useResource(`stakeholderQuestions:${wsId ?? ''}`, wsId ? () => stakeholdersApi.questions(wsId) : null);
  useTaskStatusRefresh(wsId, qs.reload);
  const action = useAction();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const groups: StakeholderQuestionGroup[] = Array.isArray(qs.data?.groups) ? qs.data.groups : [];
  const toSend = answersToSend(groups, drafts);
  const listReload = list.reload;
  const qsReload = qs.reload;

  /** After a change (also one made elsewhere on the page: a position change): both lists again, then `onChange`. */
  const reload = useCallback(async () => {
    await Promise.all([listReload(), qsReload()]);
    onChangeRef.current?.();
  }, [listReload, qsReload]);

  const change = useCallback(
    async (fn: () => Promise<unknown>) => {
      const ok = (await action.run(async () => (await fn(), true))) === true;
      if (ok) await reload();
      return ok;
    },
    [action.run, reload],
  );

  const send = async () => {
    if (!wsId || toSend.length === 0) return false;
    const ok = await change(() => stakeholdersApi.answer(wsId, { answers: toSend }));
    if (ok) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !toSend.some((a) => a.questionId === id))));
    return ok;
  };

  return {
    view: list.view,
    groups,
    hidden: list.own.filter(isHiddenView),
    open: list.ownOpen,
    competitors: list.competitors,
    /** Parked former colleagues (open ones: a stakeholder cannot leave while hidden). */
    former: list.former,
    places: list.places,
    reload,
    hasHidden: list.own.some(isHiddenView),
    draft: (questionId: string) => drafts[questionId] ?? '',
    setDraft: (questionId: string, v: string) => setDrafts((d) => ({ ...d, [questionId]: v })),
    canSend: toSend.length > 0,
    send,
    skip: (personaId: string) => (wsId ? change(() => stakeholdersApi.answer(wsId, { answers: [], skip: [personaId] })) : Promise.resolve(false)),
    skipAll: () => (wsId ? change(() => stakeholdersApi.answer(wsId, { answers: [], skipAll: true })) : Promise.resolve(false)),
    reveal: (personaId: string) => (wsId ? change(() => stakeholdersApi.reveal(wsId, personaId)) : Promise.resolve(false)),
    /** "Use for reads and learning" (the persona include override); `null` resets to the default (verified only). */
    setInclude: (personaId: string, include: boolean | null) => change(() => api.setPersonaInclude(personaId, include)),
    busy: action.busy,
    actionError: action.error,
    loading: list.loading || qs.loading,
    error: list.error ?? qs.error,
  };
}

/** The user's statements about one stakeholder (newest first) and the "Add a note" box. */
export function useStakeholderStatements(wsId: string | null | undefined, personaId: string) {
  const res = useResource(`stakeholderStatements:${wsId ?? ''}:${personaId}`, wsId ? () => stakeholdersApi.statements(wsId, personaId) : null);
  const action = useAction();
  const [note, setNote] = useState('');
  const addNote = async () => {
    const text = note.trim();
    if (!wsId || !text) return false;
    const ok = (await action.run(async () => (await stakeholdersApi.addNote(wsId, personaId, text), true))) === true;
    if (ok) {
      setNote('');
      await res.reload();
    }
    return ok;
  };
  return {
    statements: Array.isArray(res.data?.statements) ? res.data.statements : [],
    note,
    setNote,
    canAdd: note.trim() !== '',
    addNote,
    busy: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
  };
}

/**
 * The position of one open stakeholder (positions design §10): its history and, for a former colleague,
 * the two layers ("What we knew", "What is public"); and the form of a change (`draft`, null while
 * closed). The form of a former colleague who moved on offers every competitor but the one it is at
 * (`atCompetitorId`: the competitor whose group the page lists it in, so the form does not wait for the
 * history to know it; the server refuses the place a person is at already).
 * Nothing is loaded for a competitor's stakeholder that never worked here: it has no history.
 * A saved change closes the form, loads the history again and calls `onChanged` (the page's lists); a
 * refused one keeps the form and shows why (`actionError`, the server's message).
 */
export function useStakeholderPosition(
  wsId: string | null | undefined,
  v: OpenStakeholderView,
  places: StakeholderPlaces,
  onChanged: () => Promise<void> | void,
  atCompetitorId?: string,
) {
  const tracked = v.subjectKind !== 'competitor' || isFormerColleague(v);
  const res = useResource(`stakeholderPositions:${wsId ?? ''}:${v.id}`, wsId && tracked ? () => stakeholdersApi.positions(wsId, v.id) : null);
  const action = useAction();
  const [draft, setDraft] = useState<PositionDraft | null>(null);
  const otherNodes = places.nodes.filter((n) => n.workspaceId !== wsId);
  const input = draft ? positionInput(draft) : null;
  const positions = Array.isArray(res.data?.positions) ? res.data.positions : [];
  /** Where a person can go: every competitor of the tree, but for a former colleague never the one it is at. */
  const competitorsFor = (form: PositionDraft['form']) =>
    form === 'movedOn' ? places.competitors.filter((c) => c.competitorId !== atCompetitorId) : places.competitors;

  const save = async () => {
    if (!wsId || !input) return false;
    const ok = (await action.run(async () => (await stakeholdersApi.changePosition(wsId, v.id, input), true))) === true;
    if (ok) {
      setDraft(null);
      await Promise.all([res.reload(), onChanged()]);
    }
    return ok;
  };

  return {
    positions,
    internalProfile: res.data?.internalProfile,
    publicProfile: res.data?.publicProfile,
    /** What to say about the public layer: not used, used although not verified, not combined yet. */
    publicNotes: res.data ? publicLayerNotes(res.data) : [],
    /** The competitors the open form offers. */
    competitors: draft ? competitorsFor(draft.form) : places.competitors,
    /** The history and the layers have been loaded. */
    loaded: Array.isArray(res.data?.positions),
    otherNodes,
    draft,
    open: (form: PositionDraft['form']) => {
      action.clearError();
      setDraft(newPositionDraft(form, v, wsId ?? '', { ...places, competitors: competitorsFor(form) }));
    },
    close: () => setDraft(null),
    set: (patch: Partial<Omit<PositionDraft, 'form' | 'change' | 'currentType'>>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    setChange: (change: PositionDraft['change']) => setDraft((d) => (d ? withChange(d, change, otherNodes) : d)),
    canSave: input !== null,
    save,
    busy: action.busy,
    actionError: action.error,
    error: res.error,
  };
}

/**
 * The simulated stakeholder reads of one recommendation, the user's agree / disagree (with an optional
 * reason) and the "Record the real decision" form (an own, open stakeholder, the decision, the reasoning).
 */
export function useStakeholderReads(wsId: string | null | undefined, recId: string) {
  const res = useResource(`stakeholderReads:${wsId ?? ''}:${recId}`, wsId ? () => stakeholdersApi.reads(wsId, recId) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'task_status') void res.reload();
  });
  const action = useAction();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** Reactions made on this page since the reads loaded (the served reads carry the earlier ones). */
  const [reacted, setReacted] = useState<Record<string, { reaction: FlowReaction; reason?: string }>>({});
  const [form, setForm] = useState<{ personaId: string; decision: RealDecision; reasoning: string } | null>(null);
  const [recorded, setRecorded] = useState<{ label: string; decision: RealDecision } | null>(null);

  const react = async (readId: string, reaction: FlowReaction) => {
    if (!wsId) return false;
    const reason = reasons[readId]?.trim() || undefined;
    const ok = (await action.run(async () => (await stakeholdersApi.react(wsId, readId, reaction, reason), true))) === true;
    if (ok) {
      setReacted((r) => ({ ...r, [readId]: { reaction, ...(reason ? { reason } : {}) } }));
      setReasons((r) => ({ ...r, [readId]: '' }));
    }
    return ok;
  };

  const record = async (labelOf: (personaId: string) => string) => {
    if (!wsId || !form || !form.personaId || !form.reasoning.trim()) return false;
    const input = { personaId: form.personaId, decision: form.decision, reasoning: form.reasoning.trim() };
    const ok = (await action.run(async () => (await stakeholdersApi.recordDecision(wsId, recId, input), true))) === true;
    if (ok) {
      setRecorded({ label: labelOf(input.personaId), decision: input.decision });
      setForm(null);
    }
    return ok;
  };

  const reads = Array.isArray(res.data?.reads) ? res.data.reads : [];

  return {
    reads,
    reason: (readId: string) => reasons[readId] ?? '',
    setReason: (readId: string, v: string) => setReasons((r) => ({ ...r, [readId]: v })),
    /** The user's latest reaction to a read: made on this page, else the one the server holds. */
    reacted: (readId: string): { reaction: FlowReaction; reason?: string } | undefined => {
      if (reacted[readId]) return reacted[readId];
      const served = reads.find((x) => x.id === readId);
      return served?.reaction ? { reaction: served.reaction, ...(served.reactionReason ? { reason: served.reactionReason } : {}) } : undefined;
    },
    react,
    form,
    openForm: (personaId: string) => {
      setRecorded(null);
      setForm({ personaId, decision: 'approved', reasoning: '' });
    },
    setForm: (patch: Partial<{ personaId: string; decision: RealDecision; reasoning: string }>) => setForm((f) => (f ? { ...f, ...patch } : f)),
    closeForm: () => setForm(null),
    canRecord: !!form && !!form.personaId && form.reasoning.trim() !== '',
    record,
    recorded,
    busy: action.busy,
    actionError: action.error,
    loading: res.loading,
    error: res.error,
  };
}
