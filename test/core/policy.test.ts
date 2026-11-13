import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { browserMcpServers, browserPromptNote } from '../../src/core/harness/browser.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { CatchallEmailProvider, createEmailProvider, MailTmProvider, type EmailProvider } from '../../src/core/identity/email.js';
import { IDENTITY_NAMES, normalizeSite, REDACTED } from '../../src/core/identity/identities.js';
import { policyPrompt } from '../../src/core/policy/actionPolicy.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../../src/core/research/systemPrompts.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(provider: EmailProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-policy-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const events = new EventBus();
  const handle = createToolHandlers({
    store, artifacts: new ArtifactStore(store, dir), config: defaultConfig, events,
    extraHandlers: researchToolHandlers({ emailProvider: provider }),
  });
  return { store, handle };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker',
  model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

class CountingProvider implements EmailProvider {
  n = 0;
  async createInbox() {
    this.n++;
    return { address: `box${this.n}@inbox.test`, password: `inboxpw-${this.n}-secret` };
  }
  async latest() {
    return [];
  }
}

describe('action policy', () => {
  it('policy prompt lists approval-required actions verbatim', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.actionPolicy.approvalRequired.push('post a public review');
    const text = policyPrompt(cfg);
    for (const a of cfg.actionPolicy.approvalRequired) expect(text).toContain(`- ${a}`);
    for (const a of cfg.actionPolicy.allowed) expect(text).toContain(`- ${a}`);
    for (const a of cfg.actionPolicy.never) expect(text).toContain(`- ${a}`);
    expect(text).toMatch(/request_approval/);
    // Appended to every worker system prompt (and the reviewer's).
    for (const sys of [workerSystemPrompt(cfg), workerSystemPrompt(cfg, 'synthesizer', true), reviewerSystemPrompt(cfg)]) {
      for (const a of cfg.actionPolicy.approvalRequired) expect(sys).toContain(a);
    }
  });
});

describe('browser config', () => {
  it('mcp backend passes servers with the dedicated profile dir substituted', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.browser.mcpServers = { pw: { command: 'npx', args: ['@playwright/mcp', '--user-data-dir', '{{profileDir}}'] } };
    const servers = browserMcpServers(cfg) as { pw: { args: string[] } };
    expect(servers.pw.args[2]).toBe(resolve(cfg.browser.profileDir));
    expect(browserPromptNote(cfg)).toMatch(/browser MCP tools/);
  });

  it('t3 backend returns no MCP servers and a note to use the T3 browser tools', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.browser.backend = 't3';
    cfg.browser.mcpServers = { pw: { command: 'x' } };
    expect(browserMcpServers(cfg)).toEqual({});
    expect(browserPromptNote(cfg)).toMatch(/T3 Code browser tools/);
    expect(workerSystemPrompt(cfg, 'worker', true)).toMatch(/T3 Code browser tools/);
    expect(workerSystemPrompt(cfg, 'worker', false)).not.toMatch(/T3 Code browser tools/);
  });
});

describe('identities', () => {
  it('get_identity reuses identity per site', async () => {
    const provider = new CountingProvider();
    const { store, handle } = setup(provider);
    const a = await handle(ctx(), 'get_identity', { site: 'https://www.Acme.com/signup' });
    const b = await handle(ctx(), 'get_identity', { site: 'acme.com' });
    const c = await handle(ctx(), 'get_identity', { site: 'rival.io' });
    const d = await handle(ctx({ workspaceId: 'ws_b' }), 'get_identity', { site: 'acme.com' });
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('get_identity failed');
    const da = a.data as { email: string; name: string; password: string; site: string; created: boolean };
    expect(da).toMatchObject({ site: 'acme.com', email: 'box1@inbox.test', created: true });
    expect(IDENTITY_NAMES).toContain(da.name);
    expect(da.password.length).toBeGreaterThan(10);
    expect(b.data).toEqual({ ...da, created: false });
    expect((c.data as { email: string }).email).toBe('box2@inbox.test');
    expect((d.data as { email: string }).email).toBe('box3@inbox.test');
    expect(provider.n).toBe(3);
    expect(store.identities.list({ workspaceId: 'ws_a' })).toHaveLength(2);
    expect(store.identities.list({ workspaceId: 'ws_a', site: 'acme.com' })[0]!.emailPassword).toBe('inboxpw-1-secret');
  });

  it('identity password redacted in decision payloads', async () => {
    const { store, handle } = setup(new CountingProvider());
    const c = ctx();
    const r = await handle(c, 'get_identity', { site: 'acme.com' });
    if (!r.ok) throw new Error(r.error);
    const { password } = r.data as { password: string };
    // The agent carelessly logs the credentials.
    await handle(c, 'log_decision', {
      what: `signed up with password ${password}`, why: 'inbox pw inboxpw-1-secret', confidence: 0.9,
      alternatives: [`try ${password} again`],
    });
    const decisions = store.decisions.list({ agentRunId: c.agentRunId });
    expect(decisions).toHaveLength(2);
    const all = JSON.stringify(decisions);
    expect(all).not.toContain(password);
    expect(all).not.toContain('inboxpw-1-secret');
    expect(decisions[0]!.payload).toMatchObject({ tool: 'get_identity', password: REDACTED, site: 'acme.com' });
    expect(decisions[1]!.payload).toMatchObject({ what: `signed up with password ${REDACTED}` });
  });

  it('normalizeSite', () => {
    expect(normalizeSite('HTTPS://www.Example.com:443/a?b')).toBe('example.com');
    expect(normalizeSite('app.example.com')).toBe('app.example.com');
  });

  it('mailtm provider createInbox parses API response', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/domains')) {
        return new Response(JSON.stringify({ 'hydra:member': [{ id: '1', domain: 'inactive.tm', isActive: false }, { id: '2', domain: 'mail.tm.test', isActive: true }] }), { status: 200 });
      }
      if (url.endsWith('/accounts')) {
        const body = JSON.parse(String(init!.body)) as { address: string; password: string };
        return new Response(JSON.stringify({ id: 'acc1', address: body.address, quota: 40000000 }), { status: 201 });
      }
      if (url.endsWith('/token')) return new Response(JSON.stringify({ token: 'jwt1', id: 'acc1' }), { status: 200 });
      if (url.endsWith('/messages')) return new Response(JSON.stringify([{ id: 'm1', subject: 'Verify', intro: 'Your code' }]), { status: 200 });
      if (url.endsWith('/messages/m1')) return new Response(JSON.stringify({ id: 'm1', subject: 'Verify', text: 'Your code is 123456' }), { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const p = new MailTmProvider({ fetch, baseUrl: 'https://mail.example/' });
    const inbox = await p.createInbox();
    expect(inbox.address).toMatch(/^bif[0-9a-f]{12}@mail\.tm\.test$/);
    expect(inbox.password.length).toBeGreaterThan(10);
    const accountCall = calls.find((c) => c.url === 'https://mail.example/accounts')!;
    expect(accountCall.init!.method).toBe('POST');
    expect(JSON.parse(String(accountCall.init!.body))).toEqual({ address: inbox.address, password: inbox.password });

    expect(await p.latest(inbox.address)).toEqual([{ subject: 'Verify', body: 'Your code is 123456' }]);
    const msgCall = calls.find((c) => c.url.endsWith('/messages'))!;
    expect((msgCall.init!.headers as Record<string, string>).authorization).toBe('Bearer jwt1');

    const failing = new MailTmProvider({ fetch: async () => new Response('down', { status: 503 }) });
    await expect(failing.createInbox()).rejects.toThrow(/HTTP 503/);
  });

  it('catchall provider and factory', async () => {
    const p = new CatchallEmailProvider('Example.org');
    expect((await p.createInbox()).address).toMatch(/^bif[0-9a-f]{12}@example\.org$/);
    expect(await p.latest()).toEqual([]);
    expect(createEmailProvider({ identity: { emailProvider: 'mailtm' } })).toBeInstanceOf(MailTmProvider);
    expect(createEmailProvider({ identity: { emailProvider: 'catchall', catchallDomain: 'x.dev' } })).toBeInstanceOf(CatchallEmailProvider);
  });
});
