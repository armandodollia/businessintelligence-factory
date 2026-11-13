/**
 * Export-exclusion ruling (design §12): the export response carries its summary — how many judgments
 * the default exclusion left out, by cause, and that `includeUploads` includes them — as a header on
 * the JSONL download and as JSON from `/export/summary` (what the web export UI shows).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { ingestorFor } from '../../src/core/knowledge/ingest.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { ks4, T0 } from '../core/knowledge/ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

async function setup() {
  const t = ks4(opened);
  uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential board memo: churn rose to 14 percent.'), mime: 'text/plain' }, t);
  await ingestorFor(t).idle();
  const task = t.store.tasks.insert({
    id: newId('tsk'), workspaceId: 'ws_a', runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
  });
  const c = t.ctx('ws_a', 'worker', { taskId: task.id });
  t.store.agentRuns.insert({ id: c.agentRunId, workspaceId: 'ws_a', role: 'worker', model: c.model, token: c.agentRunId, status: 'done', startedAt: T0, promptVersion: 'pv', taskId: task.id });
  await t.call(c, 'search', { query: 'churn', kinds: ['passage'] });
  await t.call(c, 'log_decision', { what: 'Plan', why: 'board priorities', confidence: 0.6, refs: [] });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: {} as never });
  return { t, app };
}

type Summary = {
  includeUploads: boolean;
  excludedJudgments: { total: number; byCause: Array<{ cause: string; label: string; count: number }> };
  excludedOtherLines: { total: number };
  note: string;
};

describe('export summary in the API', () => {
  it('the JSONL download carries the summary header; /export/summary returns the same as JSON', async () => {
    const { app } = await setup();
    const res = await app.request('/api/workspaces/ws_a/export');
    expect(res.status).toBe(200);
    const header = JSON.parse(decodeURIComponent(res.headers.get('x-bif-export-summary')!)) as Summary;
    expect(header.includeUploads).toBe(false);
    expect(header.excludedJudgments.byCause.find((c) => c.cause === 'exposed_run')).toMatchObject({ label: 'exposed run', count: 1 });
    expect(header.note).toMatch(/includeUploads/);
    const json = (await (await app.request('/api/workspaces/ws_a/export/summary')).json()) as Summary;
    expect(json).toEqual(header);

    const inc = (await (await app.request('/api/workspaces/ws_a/export/summary?includeUploads=1')).json()) as Summary;
    expect(inc.includeUploads).toBe(true);
    expect(inc.excludedJudgments.total).toBe(0);
    expect((await app.request('/api/workspaces/ws_nope/export/summary')).status).toBe(404);
  });
});
