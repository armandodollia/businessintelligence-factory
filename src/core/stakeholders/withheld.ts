/**
 * Withheld research (stakeholder design §7, fix round of task 6, final review item 1): while own-stakeholder
 * research runs, and while its node has a hidden stakeholder, the raw agent activity of that research is
 * not served, so nothing the research found can colour the user's answers.
 *
 * - A task is withheld when its type is `own_stakeholders` and it has not finished (any status but
 *   `verified`, `unverified` and `failed`: before its first save the node has no hidden stakeholder yet)
 *   or its node still has at least one hidden stakeholder persona. Every run of a withheld task (worker,
 *   reviewer, escalation, audit) is withheld.
 * - Served views: a withheld task keeps id, node, run, phase, type, status, step, round, model and times
 *   (`withheld: true`); a withheld run loses its failure reason; a Decision of a withheld run keeps its
 *   kind, ids and times but its payload becomes `{ tool?, withheld: true }` and its refs empty. The
 *   `save_stakeholder` Decision (label, type and confidences only, by design) keeps its payload, and
 *   its refs hold only the persona id while that persona is hidden. Bus events: a run event of a
 *   withheld run is dropped, its tool call and status events lose their error / reason text; an audit
 *   of a withheld task loses its issues and reason; a user request of a withheld task or run (older
 *   data: such runs can no longer ask) loses its details, options, site and answer.
 * - Page copies (own research may use the web, user ruling 2026-11-15): an artifact captured only by
 *   runs of withheld tasks is withheld too, on every read path (knowledge reads through
 *   `artifactVisibleSql` / `artifactVisible`, the artifact routes, the export): it answers as unknown.
 *   Runs of the capturing task itself still read it by id. An upload, or an artifact another task
 *   also captured, is never withheld; a capture by withheld research is still never listed or used on a
 *   read path (`captureServedSql`, `captureWithheld`), and what such a capture would have written onto a
 *   shared artifact row never gets there (`ArtifactStore.persist`).
 * - Everything is served normally again once the task has finished and no stakeholder of the node is hidden.
 *
 * One `withholding(store)` per request: it caches per node and per run for the lifetime of the object.
 */
import type { BusEvent } from '../events.js';
import type { StoredBusEvent } from '../telemetry/busEvents.js';
import type { Store } from '../store/db.js';
import type { AgentRun, Decision, Task, UserRequest } from '../types.js';
import { isHidden, stakeholderPersonas } from './personas.js';

/** What a withheld task shows. */
export type WithheldTask = Pick<Task, 'id' | 'workspaceId' | 'runId' | 'phase' | 'type' | 'status' | 'round' | 'model' | 'createdAt'> &
  Partial<Pick<Task, 'step' | 'submittedRound'>> & { withheld: true };

export type Withholding = {
  /** Whether the artifact is withheld (captured only by withheld research): it answers as unknown. */
  artifact(artifactId: string): boolean;
  /** Whether the node has at least one hidden stakeholder persona. */
  nodeHasHidden(workspaceId: string): boolean;
  /** Whether the task is withheld (own-stakeholder research not finished, or of a node with a hidden stakeholder). */
  task(task: Pick<Task, 'type' | 'workspaceId' | 'status'> | undefined): boolean;
  /** Whether the agent run is a run of a withheld task. */
  run(runId: string | undefined): boolean;
  servedTask(task: Task): Task | WithheldTask;
  servedRun<R extends Pick<AgentRun, 'id' | 'failureReason'>>(run: R): R;
  servedAttempt<A extends { runId: string; failureReason?: string }>(attempt: A): A;
  servedDecision(d: Decision): Decision;
  /** A live bus event as served (SSE); `undefined`: not sent. */
  servedBusEvent(e: BusEvent): BusEvent | undefined;
  servedStoredBusEvent(e: StoredBusEvent): StoredBusEvent;
  /** A user request of a withheld task or run, without its text, options or answer (older data: such runs can no longer ask). */
  servedRequest(r: UserRequest): UserRequest;
  servedAudit<A extends { taskId: string; auditIssues?: unknown[]; reason?: string }>(a: A): A;
  servedAuditMiss<A extends { taskId: string; issues: unknown[]; classes: unknown[] }>(a: A): A;
};

const OWN_RESEARCH = 'own_stakeholders';
/** Task statuses after which a task's runs no longer change. */
const FINISHED: ReadonlySet<Task['status']> = new Set(['verified', 'unverified', 'failed']);

/** SQL (0/1): task row `t` is withheld (the same rule as `Withholding.task`). */
const taskWithheldSql = (t: string): string =>
  `(${t}.type = '${OWN_RESEARCH}' AND (${t}.status NOT IN (${[...FINISHED].map((x) => `'${x}'`).join(', ')}) OR EXISTS (SELECT 1 FROM personas whp
     WHERE whp.workspace_id = ${t}.workspace_id AND whp.kind = 'stakeholder' AND whp.disclosure = 'hidden')))`;

/**
 * SQL (0/1): artifact row `a` is withheld — not an upload, captured by a run of a withheld task, and by
 * nothing else (a capture with no task, e.g. an upload, or by a task that is not withheld keeps it
 * served). The one rule every knowledge read applies (`artifactVisibleSql`); no parameters.
 */
export const artifactWithheldSql = (a: string): string =>
  `(${a}.kind <> 'upload'
     AND EXISTS (SELECT 1 FROM artifact_captures wac JOIN tasks wat ON wat.id = wac.task_id WHERE wac.artifact_id = ${a}.id AND ${taskWithheldSql('wat')})
     AND NOT EXISTS (SELECT 1 FROM artifact_captures woc LEFT JOIN tasks wot ON wot.id = woc.task_id
       WHERE woc.artifact_id = ${a}.id AND (wot.id IS NULL OR NOT ${taskWithheldSql('wot')})))`;

/**
 * SQL (0/1): capture row `c` (`artifact_captures`) may be served — it has no task, or its task is not
 * withheld. A withheld capture is never listed or used on a read path, even when its artifact is
 * served through another capture or an upload.
 */
export const captureServedSql = (c: string): string =>
  `(${c}.task_id IS NULL OR NOT EXISTS (SELECT 1 FROM tasks wct WHERE wct.id = ${c}.task_id AND ${taskWithheldSql('wct')}))`;

/** Whether a capture of `taskId` is withheld for a reader (runs of that task itself read it). */
export function captureWithheld(store: Store, taskId: string | undefined, readerTaskId?: string): boolean {
  if (!taskId || taskId === readerTaskId) return false;
  return store.db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${taskWithheldSql('t')}`).get(taskId) !== undefined;
}

/**
 * Whether `artifactId` is withheld for a reader. `readerTaskId`: the task of the reading agent run — a
 * run of a task that captured the artifact reads it (worker, reviewer). Unknown ids are not withheld.
 */
export function artifactWithheld(store: Store, artifactId: string, readerTaskId?: string): boolean {
  const row = store.db.prepare(`SELECT ${artifactWithheldSql('a')} AS w FROM artifacts a WHERE a.id = ?`).get(artifactId) as { w: number } | undefined;
  if (!row?.w) return false;
  if (!readerTaskId) return true;
  return store.db.prepare('SELECT 1 FROM artifact_captures WHERE artifact_id = ? AND task_id = ? LIMIT 1').get(artifactId, readerTaskId) === undefined;
}

export function withholding(store: Store): Withholding {
  const nodes = new Map<string, boolean>();
  const runs = new Map<string, boolean>();
  const artifacts = new Map<string, boolean>();

  const nodeHasHidden = (workspaceId: string): boolean => {
    let v = nodes.get(workspaceId);
    if (v === undefined) {
      v = stakeholderPersonas(store, workspaceId).some(isHidden);
      nodes.set(workspaceId, v);
    }
    return v;
  };
  const task = (t: Pick<Task, 'type' | 'workspaceId' | 'status'> | undefined): boolean =>
    !!t && t.type === OWN_RESEARCH && (!FINISHED.has(t.status) || nodeHasHidden(t.workspaceId));
  const run = (runId: string | undefined): boolean => {
    if (!runId) return false;
    let v = runs.get(runId);
    if (v === undefined) {
      const r = store.agentRuns.get(runId);
      const t = r?.taskId ? store.tasks.get(r.taskId) : undefined;
      // A run whose task row is gone counts as research that may still be running.
      v = t ? task(t) : !!r && r.taskType === OWN_RESEARCH && (r.status === 'running' || nodeHasHidden(r.workspaceId));
      runs.set(runId, v);
    }
    return v;
  };
  const hiddenPersona = (id: unknown): boolean => {
    const p = typeof id === 'string' ? store.personas.get(id) : undefined;
    return !!p && isHidden(p);
  };

  const servedDecision = (d: Decision): Decision => {
    const p = (d.payload ?? {}) as { tool?: unknown; personaId?: unknown };
    if (p.tool === 'save_stakeholder') {
      return hiddenPersona(p.personaId) ? { ...d, refs: [String(p.personaId)] } : d;
    }
    if (!run(d.agentRunId)) return d;
    return { ...d, payload: { ...(typeof p.tool === 'string' ? { tool: p.tool } : {}), withheld: true }, refs: [] };
  };

  const servedRequest = (r: UserRequest): UserRequest => {
    if (!run(r.agentRunId) && !task(r.taskId ? store.tasks.get(r.taskId) : undefined)) return r;
    const { optionsJson: _options, response: _response, site: _site, ...rest } = r;
    return { ...rest, details: '', withheld: true } as UserRequest;
  };

  return {
    artifact(artifactId) {
      let v = artifacts.get(artifactId);
      if (v === undefined) {
        v = artifactWithheld(store, artifactId);
        artifacts.set(artifactId, v);
      }
      return v;
    },
    nodeHasHidden,
    task,
    run,
    servedTask(t) {
      if (!task(t)) return t;
      return {
        id: t.id, workspaceId: t.workspaceId, runId: t.runId, phase: t.phase, type: t.type, status: t.status, round: t.round, model: t.model,
        createdAt: t.createdAt, ...(t.step !== undefined ? { step: t.step } : {}), ...(t.submittedRound !== undefined ? { submittedRound: t.submittedRound } : {}),
        withheld: true,
      };
    },
    servedRun(r) {
      if (!run(r.id)) return r;
      const { failureReason: _reason, ...rest } = r;
      return { ...rest, withheld: true } as unknown as typeof r;
    },
    servedAttempt(a) {
      if (!run(a.runId)) return a;
      const { failureReason: _reason, ...rest } = a;
      return rest as typeof a;
    },
    servedDecision,
    servedBusEvent(e) {
      switch (e.type) {
        case 'run_event':
          return run(e.agentRunId) ? undefined : e;
        case 'decision':
          return { ...e, decision: servedDecision(e.decision) };
        case 'user_request':
        case 'user_request_resolved':
          return { ...e, request: servedRequest(e.request) };
        case 'tool_call': {
          if (!run(e.agentRunId)) return e;
          const { error: _error, ...rest } = e;
          return rest;
        }
        case 'run_status': {
          if (!run(e.agentRunId)) return e;
          const { reason: _reason, ...rest } = e;
          return rest;
        }
        default:
          return e;
      }
    },
    servedStoredBusEvent(e) {
      if (!run(e.agentRunId ?? undefined)) return e;
      const { error: _error, reason: _reason, ...payload } = e.payload as Record<string, unknown>;
      return { ...e, payload: { ...payload, withheld: true } };
    },
    servedRequest,
    servedAudit(a) {
      if (!task(store.tasks.get(a.taskId))) return a;
      const { reason: _reason, ...rest } = a;
      return { ...rest, auditIssues: [], withheld: true } as unknown as typeof a;
    },
    servedAuditMiss(a) {
      if (!task(store.tasks.get(a.taskId))) return a;
      return { ...a, issues: [], classes: [], withheld: true };
    },
  };
}
