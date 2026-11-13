/**
 * React hooks — the only interface views use. All fetching, SSE handling and business state
 * live here; views render what these return and call the returned actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, artifactUrl, exportUrl } from './api.js';
import { subscribe } from './sse.js';
import {
  COMPETITOR_CRITERIA,
  FINDING_CRITERIA,
  PATCH_ROLES,
  WEIGHT_KEYS,
  type AppliedPromptPatch,
  type ChangeEntry,
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
  return { busy, error, run };
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

  return {
    runs: runs.data ?? [],
    tasks: tasks.data ?? [],
    selectedRunId: runId,
    selectRun: setSelected,
    start,
    starting: action.busy,
    liveEvents,
    clearLiveEvents: () => setLiveEvents([]),
    loading: runs.loading || tasks.loading,
    error: action.error ?? runs.error ?? tasks.error,
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
    empty:
      newFindings.length === 0 && removedSubjects.length === 0 && changedArtifacts.length === 0 &&
      replaced.length === 0 && retracted.length === 0 && confirmed === 0,
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
  return { config: res.data ?? null, save, saving: action.busy, savedAt, loading: res.loading, error: res.error ?? action.error };
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
