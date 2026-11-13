import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { isLocalHost, isLocalOrigin } from '../../src/api/routes.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { tryLockPipeline } from '../../src/core/research/lock.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  const tokens = new TokenRegistry(t.store);
  const app = createApp({
    store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps,
    mcp: { tokens, handle: async () => ({ ok: true, data: null }) },
  });
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  return { ...t, app, ws };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('artifact responses', () => {
  it('are sandboxed and nosniff; active documents are downloads', async () => {
    const t = setup();
    const html = t.artifacts.save({
      workspaceId: t.ws.id, kind: 'page_snapshot', mime: 'text/html', title: 'Pricing', bytes: new TextEncoder().encode('<script>alert(1)</script>'),
    });
    const svg = t.artifacts.save({
      workspaceId: t.ws.id, kind: 'upload', mime: 'image/svg+xml', title: 'logo.svg', bytes: new TextEncoder().encode('<svg onload="x()"/>'),
    });
    const png = t.artifacts.save({ workspaceId: t.ws.id, kind: 'screenshot', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 1]) });
    for (const a of [html, svg, png]) {
      const res = await t.app.request(`/api/artifacts/${a.id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await t.app.request(`/api/artifacts/${html.id}`)).headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''Pricing/);
    expect((await t.app.request(`/api/artifacts/${svg.id}`)).headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await t.app.request(`/api/artifacts/${png.id}`)).headers.get('content-disposition')).toBeNull();
  });

  it('PDFs open inline without the CSP sandbox (the viewer refuses sandboxed PDFs); nosniff kept', async () => {
    const t = setup();
    const pdf = t.artifacts.save({
      workspaceId: t.ws.id, kind: 'document', mime: 'application/pdf', title: '10-K 2025.pdf', bytes: new TextEncoder().encode('%PDF-1.7\n'),
    });
    const res = await t.app.request(`/api/artifacts/${pdf.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''10-K%202025\.pdf/);
    // A mime parameter does not smuggle an active type past the PDF exemption.
    const fake = t.artifacts.save({
      workspaceId: t.ws.id, kind: 'document', mime: 'text/html; x=application/pdf', bytes: new TextEncoder().encode('<b>x</b>'),
    });
    const r2 = await t.app.request(`/api/artifacts/${fake.id}`);
    expect(r2.headers.get('content-security-policy')).toBe('sandbox');
    expect(r2.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('host / origin guard', () => {
  it('local host check', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:4317', 'localhost', 'LOCALHOST:5173', '[::1]:4317']) expect(isLocalHost(h)).toBe(true);
    for (const h of ['evil.example', 'evil.example:4317', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined]) {
      expect(isLocalHost(h)).toBe(false);
    }
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('https://evil.example')).toBe(false);
    expect(isLocalOrigin('null')).toBe(false);
  });

  it('rejects a non-local Host header on any route (DNS rebinding)', async () => {
    const t = setup();
    const bad = await t.app.request('http://evil.example:4317/api/workspaces', { headers: { host: 'evil.example:4317' } });
    expect(bad.status).toBe(403);
    expect((await t.app.request('/api/workspaces', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await t.app.request('/api/workspaces', { headers: { host: '127.0.0.1:4317' } })).status).toBe(200);
    expect((await t.app.request('/mcp/tok_x', { method: 'POST', body: '{}', headers: { ...JSON_HEADERS, host: 'evil.example' } })).status).toBe(403);
  });

  it('mutating requests need JSON and a local Origin when one is sent', async () => {
    const t = setup();
    const body = JSON.stringify({ name: 'B', sector: 's' });
    // Simple cross-site form/text POSTs (no preflight) are refused.
    expect((await t.app.request('/api/workspaces', { method: 'POST', body, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await t.app.request('/api/workspaces', { method: 'POST', body })).status).toBe(415);
    expect(
      (await t.app.request('/api/workspaces', { method: 'POST', body, headers: { ...JSON_HEADERS, origin: 'https://evil.example' } })).status,
    ).toBe(403);
    expect(
      (await t.app.request('/api/workspaces', { method: 'POST', body, headers: { ...JSON_HEADERS, origin: 'http://localhost:5173' } })).status,
    ).toBe(201);
    expect((await t.app.request('/api/workspaces', { method: 'POST', body, headers: JSON_HEADERS })).status).toBe(201);
    // Uploads must be multipart (not text/plain form posts).
    expect(
      (await t.app.request(`/api/workspaces/${t.ws.id}/uploads`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status,
    ).toBe(415);
  });

  it('MCP keeps working for CLIs (JSON, no Origin)', async () => {
    const t = setup();
    const res = await t.app.request('/mcp/tok_bogus', { method: 'POST', body: '{}', headers: JSON_HEADERS });
    expect(res.status).toBe(401); // reached the MCP handler: unknown token
  });
});

describe('validation and locking', () => {
  it('workspace create rejects an empty audiences list', async () => {
    const t = setup();
    const res = await t.app.request('/api/workspaces', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'B', sector: 's', audiences: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('research start is refused while another pipeline holds the workspace lock', async () => {
    const t = setup();
    const release = tryLockPipeline(t.store, t.ws.id)!;
    const res = await t.app.request(`/api/workspaces/${t.ws.id}/research`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ phases: ['scoring'] }) });
    expect(res.status).toBe(409);
    expect(tryLockPipeline(t.store, t.ws.id)).toBeNull();
    release();
    expect(tryLockPipeline(t.store, t.ws.id)).not.toBeNull();
  });
});
