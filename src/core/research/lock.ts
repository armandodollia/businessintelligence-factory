import type { Store } from '../store/db.js';

/**
 * Per-workspace pipeline lock shared by everything that runs research (API, scheduler, resume).
 * It is held for the whole pipeline, including the gaps between phases when no ResearchRun is
 * `running`, so a manual start and a scheduled job can never interleave. In-process only (one
 * server per data dir); keyed by store so separate stores (tests) never share locks.
 */
const locks = new WeakMap<Store, Set<string>>();

function held(store: Store): Set<string> {
  let s = locks.get(store);
  if (!s) {
    s = new Set();
    locks.set(store, s);
  }
  return s;
}

export class PipelineBusyError extends Error {
  constructor(readonly workspaceId: string) {
    super(`workspace '${workspaceId}' already has a research pipeline running`);
    this.name = 'PipelineBusyError';
  }
}

export function isPipelineLocked(store: Store, workspaceId: string): boolean {
  return held(store).has(workspaceId);
}

/** Takes the lock synchronously; returns the release function, or `null` when already held. */
export function tryLockPipeline(store: Store, workspaceId: string): (() => void) | null {
  const set = held(store);
  if (set.has(workspaceId)) return null;
  set.add(workspaceId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    set.delete(workspaceId);
  };
}
