import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent } from './adapter.js';
import { runDirOf } from './paths.js';

export const MAX_EVENTS_PAGE = 1000;

export type RunEventsPage = { runId: string; total: number; offset: number; limit: number; events: RunEvent[] };

/**
 * A page of a run's `events.jsonl` (learning loop WP-B): events `[offset, offset + limit)` in order,
 * plus the total count. `limit` is clamped to 1..MAX_EVENTS_PAGE; unparsable lines are skipped; a
 * run without an event log yields an empty page.
 */
export function readRunEvents(
  dataDir: string,
  run: { id: string; workspaceId: string },
  opts: { offset?: number; limit?: number } = {},
): RunEventsPage {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(opts.limit ?? 200)));
  const path = join(runDirOf(dataDir, run.workspaceId, run.id), 'events.jsonl');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()) : [];
  const events: RunEvent[] = [];
  for (const line of lines.slice(offset, offset + limit)) {
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // skip a torn line (e.g. a crash mid-write)
    }
  }
  return { runId: run.id, total: lines.length, offset, limit, events };
}
