import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config/load.js';
import { defaultConfig, type BifConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import {
  browserConfigured,
  browserOutputDir,
  browserPromptNote,
  browserStartupWarnings,
  effectiveMaxBrowserRuns,
  SharedBrowser,
  withheldBrowserTools,
} from '../../src/core/harness/browser.js';
import { Supervisor } from '../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';

const FAKE_SERVER = join(import.meta.dirname, '../fixtures/fake-browser-server.mjs');
const FAKE_CLI = join(import.meta.dirname, '../fixtures/fake-cli.mjs');

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function fakeShared(extraArgs: string[] = []): { cfg: BifConfig; dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bif-browser-'));
  const log = join(dir, 'launches.jsonl');
  const cfg = structuredClone(defaultConfig);
  cfg.browser.profileDir = join(dir, 'profile');
  cfg.browser.shared = {
    command: process.execPath,
    args: [FAKE_SERVER, '--port', '{{port}}', '--user-data-dir', '{{profileDir}}', '--output-dir', '{{outputDir}}', ...extraArgs],
    port: 0,
    path: '/mcp',
    env: { FAKE_BROWSER_LOG: log },
  };
  return { cfg, dir, log };
}

const launches = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; args: string[]; cwd: string }) : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('browser config', () => {
  it('ships a pinned Playwright MCP shared on the research profile as the default', () => {
    const cfg = loadConfig();
    expect(cfg.browser.backend).toBe('mcp');
    expect(cfg.browser.mode).toBe('shared');
    const shared = cfg.browser.shared!;
    expect(shared.command).toBe('npx');
    expect(shared.args.find((a) => a.startsWith('@playwright/mcp@'))).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+$/);
    for (const flag of ['--port', '--user-data-dir', '--shared-browser-context', '--output-dir']) expect(shared.args).toContain(flag);
    expect(shared.args[shared.args.indexOf('--user-data-dir') + 1]).toBe('{{profileDir}}');
    expect(shared.args[shared.args.indexOf('--port') + 1]).toBe('{{port}}');
    expect(browserConfigured(cfg)).toBe(true);
    expect(browserStartupWarnings(cfg)).toEqual([]);
    expect(effectiveMaxBrowserRuns(cfg)).toBe(2);
    const example = loadConfig(join(import.meta.dirname, '../../bif.config.example.json'));
    expect(example.browser.mode).toBe('shared');
    expect(example.browser.shared).toBeDefined();
  });

  it('per_run mode caps concurrent browser runs at 1 and warns; no browser configured warns too', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.browser.mode = 'per_run';
    cfg.browser.mcpServers = { pw: { command: 'npx', args: ['@playwright/mcp@0.0.85', '--user-data-dir', '{{profileDir}}'] } };
    expect(effectiveMaxBrowserRuns(cfg)).toBe(1);
    expect(browserStartupWarnings(cfg).join('\n')).toMatch(/maxBrowserRuns 2 is reduced to 1/);
    cfg.browser.mcpServers = {};
    expect(browserConfigured(cfg)).toBe(false);
    expect(browserStartupWarnings(cfg).join('\n')).toMatch(/mcpServers is empty/);
    const noShared = structuredClone(defaultConfig);
    delete noShared.browser.shared;
    expect(browserConfigured(noShared)).toBe(false);
    expect(browserStartupWarnings(noShared).join('\n')).toMatch(/browser\.shared is not set/);
    const t3 = structuredClone(noShared);
    t3.browser.backend = 't3';
    expect(browserConfigured(t3)).toBe(true);
    expect(effectiveMaxBrowserRuns({ ...t3, browser: { ...t3.browser, mode: 'per_run' } })).toBe(2);
  });

  it('prompt note tells agents to work in their own tab and close it', () => {
    const note = browserPromptNote(defaultConfig);
    expect(note).toMatch(/open a NEW tab/);
    expect(note).toMatch(/save_artifact/);
  });

  it('shared mode: the note says how to close your own tab (browser_tabs "close"), and that the browser itself stays open', () => {
    const note = browserPromptNote(defaultConfig);
    expect(defaultConfig.browser.mode).toBe('shared');
    expect(note).toContain('`browser_tabs` with action "close" and the index of each tab you opened');
    expect(note).toContain('Do not close the browser itself');
    // per-run mode: the run's own browser; the general rule stays as it was.
    const perRun = structuredClone(defaultConfig);
    perRun.browser.mode = 'per_run';
    expect(browserPromptNote(perRun)).toMatch(/close your tabs when you are done/);
    expect(browserPromptNote(perRun)).not.toContain('browser_tabs');
  });

  it('withheldBrowserTools: browser_close only in shared mode (it always fails there)', () => {
    expect(withheldBrowserTools(defaultConfig)).toEqual({ browser: ['browser_close'] });
    const perRun = structuredClone(defaultConfig);
    perRun.browser.mode = 'per_run';
    expect(withheldBrowserTools(perRun)).toEqual({});
    const t3 = structuredClone(defaultConfig);
    t3.browser.backend = 't3';
    expect(withheldBrowserTools(t3)).toEqual({});
  });
});

describe('SharedBrowser', () => {
  it('starts once (lazily, even under concurrent ensure), substitutes placeholders, restarts after close', async () => {
    const { cfg, dir, log } = fakeShared();
    const browser = new SharedBrowser({ config: cfg, dataDir: join(dir, 'data'), startTimeoutMs: 10_000 });
    cleanup.push(() => browser.close());
    expect(launches(log)).toHaveLength(0);
    const [a, b] = await Promise.all([browser.ensure(), browser.ensure()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await fetch(a)).status).toBe(405);
    expect(await browser.servers()).toEqual({ browser: { type: 'http', url: a } });
    const [first] = launches(log);
    expect(launches(log)).toHaveLength(1);
    expect(first!.args[first!.args.indexOf('--port') + 1]).toBe(new URL(a).port);
    expect(first!.args[first!.args.indexOf('--user-data-dir') + 1]).toBe(resolve(cfg.browser.profileDir));
    expect(first!.args[first!.args.indexOf('--output-dir') + 1]).toBe(browserOutputDir());
    // Relative screenshot names resolve against the server cwd: keep it in the accepted temp dir.
    expect(first!.cwd).toBe(realpathSync(browserOutputDir()));
    expect(existsSync(join(dir, 'data', 'browser', 'shared-server.pid'))).toBe(true);

    await browser.close();
    expect(alive(first!.pid)).toBe(false);
    expect(existsSync(join(dir, 'data', 'browser', 'shared-server.pid'))).toBe(false);
    await browser.ensure();
    expect(launches(log)).toHaveLength(2);
  });

  it('restarts a server that died; a server that will not start rejects with its log path', async () => {
    const { cfg, dir, log } = fakeShared();
    const browser = new SharedBrowser({ config: cfg, dataDir: join(dir, 'data'), startTimeoutMs: 10_000 });
    cleanup.push(() => browser.close());
    await browser.ensure();
    const pid = launches(log)[0]!.pid;
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    await browser.ensure();
    expect(launches(log)).toHaveLength(2);

    const broken = fakeShared(['--exit-now']);
    const bad = new SharedBrowser({ config: broken.cfg, dataDir: join(broken.dir, 'data'), startTimeoutMs: 10_000 });
    await expect(bad.ensure()).rejects.toThrow(/shared browser server exited.*shared-server\.log/);
  });

  it('kills a server left behind by a crashed harness before starting a new one', async () => {
    const { cfg, dir, log } = fakeShared();
    const dataDir = join(dir, 'data');
    const crashed = new SharedBrowser({ config: cfg, dataDir, startTimeoutMs: 10_000 });
    await crashed.ensure();
    const orphan = launches(log)[0]!.pid;
    // A new harness process: new SharedBrowser instance, same data dir, pid file still there.
    const next = new SharedBrowser({ config: cfg, dataDir, startTimeoutMs: 10_000 });
    cleanup.push(() => next.close(), () => crashed.close());
    await next.ensure();
    for (let i = 0; i < 100 && alive(orphan); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(orphan)).toBe(false);
  });
});

describe('Supervisor + browser', () => {
  const opened: Store[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
  });

  function sup(cfg: BifConfig, dir: string) {
    const store = openStore(join(dir, 'bif.db'));
    opened.push(store);
    cfg.providers.claude.command = FAKE_CLI;
    cfg.providers.codex.command = FAKE_CLI;
    const events = new EventBus();
    const tokens = new TokenRegistry(store);
    const handle = createToolHandlers({ store, artifacts: new ArtifactStore(store, dir), config: cfg, events });
    const s = new Supervisor({
      store, config: cfg, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://127.0.0.1:4317', killGraceMs: 150,
    });
    cleanup.push(() => s.close());
    return { store, s };
  }
  const ctx = (provider: 'claude' | 'codex' = 'claude') => ({
    workspaceId: 'ws_a', role: 'worker' as const, model: { provider, model: provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol' }, promptVersion: 'pv',
  });

  it('shared mode: browser runs get the one shared server over HTTP; other runs get none', async () => {
    const { cfg, dir, log } = fakeShared();
    const { s } = sup(cfg, dir);
    const script = JSON.stringify({ lines: ['{"type":"result","subtype":"success","is_error":false}'] });
    const runs = await Promise.all([1, 2].map(() => s.run({ ctx: ctx(), prompt: script, systemPrompt: 's', needsBrowser: true })));
    const plain = await s.run({ ctx: ctx(), prompt: script, systemPrompt: 's', needsBrowser: false });
    const mcpOf = (id: string) =>
      JSON.parse(readFileSync(join(dir, 'ws_a', 'runs', id, 'cwd', '.bif-mcp.json'), 'utf8')).mcpServers as Record<string, { type: string; url: string }>;
    const [m1, m2] = runs.map((r) => mcpOf(r.agentRunId));
    expect(m1!.browser).toEqual({ type: 'http', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) });
    expect(m2!.browser).toEqual(m1!.browser);
    expect(Object.keys(mcpOf(plain.agentRunId))).toEqual(['bif']);
    // The failing browser_close is not offered to browser runs; other runs get no such flag.
    const argvOf = (id: string) => JSON.parse(readFileSync(join(dir, 'ws_a', 'runs', id, 'cwd', 'argv.json'), 'utf8')) as string[];
    for (const r of runs) {
      const argv = argvOf(r.agentRunId);
      expect(argv[argv.indexOf('--disallowedTools') + 1]!.split(',')).toContain('mcp__browser__browser_close');
    }
    const plainArgv = argvOf(plain.agentRunId);
    expect(plainArgv[plainArgv.indexOf('--disallowedTools') + 1]!.split(',')).not.toContain('mcp__browser__browser_close');
    expect(launches(log)).toHaveLength(1);
    // The run's process-group reaping does not kill the shared server.
    expect(alive(launches(log)[0]!.pid)).toBe(true);
  });

  it('a shared server that cannot start fails the run with the reason', async () => {
    const { cfg, dir } = fakeShared(['--exit-now']);
    const { store, s } = sup(cfg, dir);
    const out = await s.run({ ctx: ctx(), prompt: '{}', systemPrompt: 's', needsBrowser: true });
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/shared browser server exited/);
    expect(store.agentRuns.get(out.agentRunId)!.status).toBe('failed');
  });

  it('codex runs get an isolated CODEX_HOME with auth.json linked to the user home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-codex-home-'));
    const userHome = join(dir, 'user-codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(userHome);
    writeFileSync(join(userHome, 'auth.json'), '{"auth_mode":"test"}');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = userHome;
    cleanup.push(() => (prev === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = prev)));
    const cfg = structuredClone(defaultConfig);
    const { s } = sup(cfg, dir);
    // The fake CLI cannot parse codex argv and exits 1; the home is prepared before the spawn.
    await s.run({ ctx: ctx('codex'), prompt: '{}', systemPrompt: 's', needsBrowser: false });
    await s.run({ ctx: ctx('codex'), prompt: '{}', systemPrompt: 's', needsBrowser: false });
    const home = join(dir, 'cli-state', 'codex-home');
    if (process.platform === 'win32') {
      // Windows: a hard link (one volume here), so it is the user's file itself.
      const [linked, user] = [statSync(join(home, 'auth.json')), statSync(join(userHome, 'auth.json'))];
      expect([linked.dev, linked.ino]).toEqual([user.dev, user.ino]);
      expect(user.nlink).toBe(2);
    } else {
      expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, 'auth.json'))).toBe(join(userHome, 'auth.json'));
    }
    expect(readFileSync(join(userHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"test"}');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/^# Generated/);
  });
});

describe('propose_tasks without a browser', () => {
  it('rejects needs_browser tasks when backend mcp has no browser configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-nobrowser-'));
    const store = openStore(join(dir, 'bif.db'));
    cleanup.push(() => store.close());
    const config = structuredClone(defaultConfig);
    delete config.browser.shared;
    const calls: unknown[] = [];
    const handle = createToolHandlers({
      store, artifacts: new ArtifactStore(store, dir), config, events: new EventBus(),
      extraHandlers: {
        propose_tasks: async (_c, input) => {
          calls.push(input);
          return { ok: true, data: { accepted: [], rejected: [] } };
        },
      },
    });
    const orch = { agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'orchestrator' as const, model: { provider: 'claude' as const, model: 'opus' }, promptVersion: 'pv' };
    const task = (needs_browser: boolean) => ({
      type: 'news_scan', brief: 'b', model: { provider: 'claude', model: 'sonnet' }, needs_browser, acceptance_criteria: ['x'],
    });
    const r = await handle(orch, 'propose_tasks', { tasks: [task(false), task(true)] });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/needs_browser.*no browser is configured/) });
    expect(calls).toHaveLength(0);
    expect((await handle(orch, 'propose_tasks', { tasks: [task(false)] })).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
