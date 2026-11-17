/**
 * Feedback bundle routes (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.1):
 * `POST /api/feedback-bundle/preview` and `POST /api/feedback-bundle`. The server hands the bytes to
 * the caller; it writes no file and sends nothing.
 */
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { BUNDLE_FORMAT, decodeBundle } from '../../src/core/feedbackBundle/bundle.js';
import type { TreeBlock } from '../../src/core/feedbackBundle/sections.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { config: (c) => void (c.user = { id: 'some.person' }) });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const root = createWorkspace(t.store, { name: 'Harborlight Books', sector: 'retail' });
  const run = (id: string, startedAt: string, failureReason?: string) =>
    t.store.agentRuns.insert({
      id, workspaceId: root.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: `tok_${id}`, status: failureReason ? 'failed' : 'done', startedAt,
      promptVersion: 'aaaa', ...(failureReason ? { failureReason } : {}),
    });
  run('r1', '2026-11-02T10:00:00.000Z');
  run('r2', '2026-11-10T10:00:00.000Z', 'spawn failed for Harborlight Books');
  return { ...t, app, post, root };
}

describe('POST /api/feedback-bundle/preview', () => {
  it('answers with each section, its rows and size, the size of the file and its name; standard level and every period by default', async () => {
    const t = setup();
    const res = await t.post('/api/feedback-bundle/preview', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.level).toBe('standard');
    expect(body.fileName).toMatch(/^bif-feedback-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.json\.gz$/);
    expect(body.sections.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['manifest', 'configuration', 'runs', 'metrics']));
    expect(body.sections.map((s: { name: string }) => s.name)).not.toContain('texts');
    expect(body.sections.find((s: { name: string }) => s.name === 'runs')).toMatchObject({ rows: 2, bytes: expect.any(Number) });
    expect(body.totalBytes).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('firstRows');
  });

  it('gives the first rows of a section on request, redacted like the file', async () => {
    const t = setup();
    const res = await t.post('/api/feedback-bundle/preview', { rows: { section: 'runs', limit: 5 } });
    const body = (await res.json()) as any;
    expect(body.firstRows.section).toBe('runs');
    expect(body.firstRows.rows).toHaveLength(2);
    expect(body.firstRows.rows[1]).toMatchObject({ tree: t.root.id, table: 'runs', row: { id: 'r2', failureReason: `spawn failed for ${t.root.id}` } });
    const manifest = (await (await t.post('/api/feedback-bundle/preview', { rows: { section: 'manifest' } })).json()) as any;
    expect(manifest.firstRows.rows[0]).toMatchObject({ format: BUNDLE_FORMAT, level: 'standard' });
  });

  it('takes the level, the period and the note', async () => {
    const t = setup();
    const res = await t.post('/api/feedback-bundle/preview', { level: 'with_texts', since: '2026-11-09', until: '2026-11-30', note: 'hello', rows: { section: 'manifest' } });
    const body = (await res.json()) as any;
    expect(body.level).toBe('with_texts');
    expect(body.sections.map((s: { name: string }) => s.name)).toContain('texts');
    expect(body.sections.find((s: { name: string }) => s.name === 'runs').rows).toBe(1);
    expect(body.firstRows.rows[0]).toMatchObject({ note: 'hello', period: { since: '2026-11-09T00:00:00.000Z', until: '2026-11-30T23:59:59.999Z' } });
  });

  it('400 on a malformed body or an unknown section', async () => {
    const t = setup();
    for (const body of [{ level: 'everything' }, { since: 'yesterday' }, { until: '2026-13-45' }, { note: 5 }, { rows: { section: 'nope' } }, { rows: { section: 'runs', limit: 0 } }, { since: '2026-11-10', until: '2026-11-01' }, { unknown: 1 }]) {
      expect((await t.post('/api/feedback-bundle/preview', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('POST /api/feedback-bundle', () => {
  it('answers with the file: gzip, a download name, and what the configuration says of the machine', async () => {
    const t = setup();
    const res = await t.post('/api/feedback-bundle', { note: 'a note from Harborlight Books' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    const name = /^attachment; filename="(bif-feedback-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.json\.gz)"$/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    expect(name).toBeDefined();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const file = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(file.length);
    const bundle = decodeBundle(file);
    expect(name).toContain(bundle.id);
    expect(bundle.manifest).toMatchObject({
      format: BUNDLE_FORMAT, level: 'standard', note: `a note from ${t.root.id}`, platform: { os: process.platform, arch: process.arch, node: process.versions.node },
      // The agent CLIs as the configuration names them: no command is run to ask for a version.
      clis: [{ name: 'claude' }, { name: 'codex' }],
    });
    expect(bundle.manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect((bundle.sections.runs as TreeBlock[])[0]!.tables.runs).toHaveLength(2);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('Harborlight');
    expect(text).not.toContain('some.person');
    expect(text).not.toContain(t.dir);
  });

  it('writes no file on the server', async () => {
    const t = setup();
    const files = () => readdirSync(t.dir, { recursive: true }).map(String).sort();
    const before = files();
    await t.post('/api/feedback-bundle/preview', {});
    await (await t.post('/api/feedback-bundle', { level: 'with_texts' })).arrayBuffer();
    expect(files()).toEqual(before);
  });

  it('400 on a malformed body; rows is a preview option only', async () => {
    const t = setup();
    expect((await t.post('/api/feedback-bundle', { level: 'x' })).status).toBe(400);
    expect((await t.post('/api/feedback-bundle', { rows: { section: 'runs' } })).status).toBe(400);
  });
});
