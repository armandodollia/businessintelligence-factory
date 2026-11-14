/**
 * Totals of OCR pass 2 from its call log (`ocr_runs`, written by `ocr/worker.ts`). Read-only.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { Store } from '../../store/db.js';

export type OcrTotals = {
  /** Model calls. */
  calls: number;
  failed: number;
  rateLimited: number;
  pagesRead: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Σ effective cost (computed from the price table, else the CLI's own figure). */
  costUsd: number;
};

export type OcrTotalsFilter = {
  /** Only calls for artifacts of these workspaces. */
  workspaceIds?: readonly string[];
  /** Calls made at or after / at or before these ISO times. */
  since?: string | null;
  until?: string | null;
};

/** Totals of the model calls of OCR pass 2. */
export function ocrTotals(store: Store, filter: OcrTotalsFilter = {}): OcrTotals {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.workspaceIds) {
    parts.push('workspace_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(filter.workspaceIds));
  }
  if (filter.since) {
    parts.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    parts.push('created_at <= ?');
    params.push(filter.until);
  }
  const r = store.db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(status = 'rate_limited'), 0) AS rateLimited,
              COALESCE(SUM(pages_read), 0) AS pagesRead,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(COALESCE(cost_usd, cli_reported_cost_usd)), 0) AS costUsd
       FROM ocr_runs ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''}`,
    )
    .get(...params) as Record<keyof OcrTotals, number>;
  return {
    calls: Number(r.calls),
    failed: Number(r.failed),
    rateLimited: Number(r.rateLimited),
    pagesRead: Number(r.pagesRead),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    costUsd: Number(r.costUsd),
  };
}

/** Artifacts of `workspaceIds` by OCR state (states with something for a model to read). */
export function ocrArtifactStates(store: Store, workspaceIds: readonly string[]): { pending: number; done: number; failed: number; skipped: number } {
  const out = { pending: 0, done: 0, failed: 0, skipped: 0 };
  const rows = store.db
    .prepare(
      `SELECT ocr_status AS s, COUNT(*) AS n FROM artifact_texts
       WHERE ocr_status IN ('pending', 'done', 'failed', 'skipped') AND workspace_id IN (SELECT value FROM json_each(?))
       GROUP BY ocr_status`,
    )
    .all(JSON.stringify(workspaceIds)) as Array<{ s: keyof typeof out; n: number }>;
  for (const r of rows) out[r.s] = Number(r.n);
  return out;
}
