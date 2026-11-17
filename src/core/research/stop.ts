import type { Store } from '../store/db.js';
import type { ResearchDeps } from './deps.js';

/**
 * Stopping the research of one business. Research is aborted through `ResearchDeps.signal`, which is
 * one signal for everything started with the same deps. So that one business can be stopped alone,
 * the work of a business runs with deps of its own, whose signal also aborts when that business is
 * stopped: `runStoppable` gives them, `abortStoppable` aborts them and waits for the work to end.
 *
 * In-process only, and keyed by store, like the pipeline lock (`lock.ts`).
 */
type Scope = { controller: AbortController; work: Set<Promise<unknown>> };

/**
 * The answer written on a request to the person that "Stop research" closed: the agent that asked is
 * stopped, so nobody waits for the answer any more. Such a request is `denied` with this response; it
 * is the tool's doing, not a denial by the person (the policy events do not record it as one).
 */
export const STOPPED_REQUEST_RESPONSE = 'research was stopped';

const scopes = new WeakMap<Store, Map<string, Scope>>();

function scopeOf(store: Store, workspaceId: string): Scope {
  let byWorkspace = scopes.get(store);
  if (!byWorkspace) scopes.set(store, (byWorkspace = new Map()));
  let scope = byWorkspace.get(workspaceId);
  if (!scope) byWorkspace.set(workspaceId, (scope = { controller: new AbortController(), work: new Set() }));
  return scope;
}

/**
 * Runs `work` for `workspaceId` with deps whose signal aborts when `deps.signal` does or when the
 * research of that business is stopped. The work counts as in flight until its promise settles.
 */
export function runStoppable<T>(deps: ResearchDeps, workspaceId: string, work: (deps: ResearchDeps) => Promise<T>): Promise<T> {
  const scope = scopeOf(deps.store, workspaceId);
  const signal = deps.signal ? AbortSignal.any([deps.signal, scope.controller.signal]) : scope.controller.signal;
  const promise = (async () => work({ ...deps, signal }))();
  const tracked: Promise<unknown> = promise.then(
    () => scope.work.delete(tracked),
    () => scope.work.delete(tracked),
  );
  scope.work.add(tracked);
  return promise;
}

/** True while work of `workspaceId` started with `runStoppable` is in flight. */
export function hasStoppableWork(store: Store, workspaceId: string): boolean {
  return (scopes.get(store)?.get(workspaceId)?.work.size ?? 0) > 0;
}

/**
 * Aborts the work of `workspaceId` that is in flight and resolves when all of it has ended (each
 * agent run is stopped by the supervisor first). Work started afterwards gets a new signal.
 */
export async function abortStoppable(store: Store, workspaceId: string): Promise<void> {
  const byWorkspace = scopes.get(store);
  const scope = byWorkspace?.get(workspaceId);
  if (!scope) return;
  byWorkspace!.delete(workspaceId);
  scope.controller.abort();
  await Promise.all([...scope.work]);
}
