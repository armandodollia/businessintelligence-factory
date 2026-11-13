// @vitest-environment jsdom
/**
 * Export-exclusion ruling (design §12, "visible cost"): the decision log's export shows how many
 * judgments the default exclusion leaves out, by cause, and that including uploads includes them.
 * Ruling R6 (wave 2): it is computed only when the user asks (a button), never on page load.
 * Behaviour in web/src/logic (formatting, the hook), markup in the view, no fetch in views.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportSummaryView } from '../../web/src/logic/exportSummary.js';
import { App } from '../../web/src/views/App.js';

const SUMMARY = {
  includeUploads: false,
  excludedJudgments: {
    total: 6,
    byCause: [
      { cause: 'cites_upload', label: 'cites an upload', count: 1 },
      { cause: 'exposed_run', label: 'exposed run', count: 3 },
      { cause: 'exposed_task', label: 'task of an exposed run', count: 2 },
      { cause: 'exposed_output', label: 'references an output of such a task', count: 0 },
    ],
  },
  excludedOtherLines: { total: 4, byCause: [] },
  note: 'Left out by default: 6 judgment(s) and 4 other line(s). Export with includeUploads to include them.',
};

let summary: unknown = SUMMARY;
const paths: string[] = [];

class NoopEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  paths.length = 0;
  summary = SUMMARY;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      paths.push(url.pathname + url.search);
      const body = url.pathname.endsWith('/export/summary') ? summary : url.pathname.endsWith('/calibration') ? { byCriterion: [] } : [];
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', NoopEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('export summary (logic)', () => {
  it('formats the counts by cause in the API order, and says how to include them', () => {
    const v = exportSummaryView(SUMMARY)!;
    expect(v.headline).toBe('The export leaves out 6 judgment(s) by default (and 4 other line(s)).');
    expect(v.causes).toEqual([
      { cause: 'cites_upload', text: 'cites an upload: 1' },
      { cause: 'exposed_run', text: 'exposed run: 3' },
      { cause: 'exposed_task', text: 'task of an exposed run: 2' },
      { cause: 'exposed_output', text: 'references an output of such a task: 0' },
    ]);
    expect(v.includeHint).toMatch(/includeUploads/);
    expect(exportSummaryView({ ...SUMMARY, excludedJudgments: { total: 0, byCause: [] }, excludedOtherLines: { total: 0, byCause: [] } })!.headline).toBe(
      'The export leaves nothing out for uploads.',
    );
    expect(exportSummaryView([])).toBeNull();
    expect(exportSummaryView(null)).toBeNull();
  });
});

describe('export summary (view)', () => {
  it('the decision log computes the summary only on demand (ruling R6), next to the download links, with an includeUploads link', async () => {
    window.location.hash = '#/w/ws_1/decisions';
    render(<App />);
    // Opening the page never runs the export.
    const button = await screen.findByRole('button', { name: 'Compute export exclusions' });
    await new Promise((r) => setTimeout(r, 20));
    expect(paths.filter((p) => p.includes('/export/summary'))).toEqual([]);
    expect(screen.queryByText(/The export leaves out/)).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText('The export leaves out 6 judgment(s) by default (and 4 other line(s)).')).toBeTruthy();
    expect(paths.filter((p) => p.includes('/export/summary'))).toHaveLength(1);
    for (const t of ['cites an upload: 1', 'exposed run: 3', 'task of an exposed run: 2', 'references an output of such a task: 0']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    const include = screen.getByRole('link', { name: 'Export including uploads (JSONL)' }) as HTMLAnchorElement;
    expect(include.getAttribute('href')).toBe('/api/workspaces/ws_1/export?includeUploads=1');
    expect(paths).toContain('/api/workspaces/ws_1/export/summary');
  });

  it('the view never calls fetch and never imports the API client', () => {
    const src = readFileSync(join(import.meta.dirname, '../../web/src/views/DecisionLog.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/logic\/api/);
  });
});
