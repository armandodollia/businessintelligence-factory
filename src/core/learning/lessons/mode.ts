/**
 * Per-run lessons switch (learning loop WP-E; for WP-F experiments: "lessons off during experiments").
 *
 * The authority is the STORED flag (wave-2 integration): `agent_runs.lessons_off` and the experiment
 * tag of a task, read by prompt assembly through `lessonsOff` / `lessonsOffFor`, so a run keeps
 * lessons off after a restart or resume. `withLessons('off', fn)` is a convenience on top: every run
 * `fn` starts (across awaits) is stored with `lessons_off = 1` by `runAgent`, and a prompt built in
 * the context leaves the rules out (the first prompt of a task is built before any run, so before a
 * flag, exists). After that the task's stored flag keeps lessons off with no context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LessonsMode = 'on' | 'off';

const context = new AsyncLocalStorage<LessonsMode>();

/** Runs `fn` (and everything it starts) with lessons `mode`. */
export function withLessons<T>(mode: LessonsMode, fn: () => T): T {
  return context.run(mode, fn);
}

/** The lessons mode of the current async context (default `on`). */
export function lessonsMode(): LessonsMode {
  return context.getStore() ?? 'on';
}
