/**
 * Per-run lessons switch (learning loop WP-E; for WP-F experiments: "lessons off during experiments").
 *
 * Every prompt assembled inside `withLessons('off', fn)` — across awaits, for every run `fn` starts —
 * leaves the accepted lesson rules out (`lessonsMode()` is read by the appendix when a prompt is
 * built). The run's prompt version then differs from a run with lessons, and its stored prompt text
 * carries no tracking marker, so per-version metrics keep the two apart. Outside any context lessons
 * are on.
 *
 * Note: the mode is not persisted. Work resumed after a restart (`resumeInterrupted`) runs outside the
 * caller's context, so a caller that must keep lessons off across restarts wraps its resume too.
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
