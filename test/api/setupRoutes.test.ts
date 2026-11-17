/**
 * The setup check over HTTP (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.2, §4.3):
 * `GET /api/health`, `GET /api/setup`, `POST /api/setup/apply`, `POST /api/setup/open-folder`, and the
 * agent CLIs in the feedback bundle's manifest. The check is a fake: no command is run.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/routes.js';
import { decodeBundle } from '../../src/core/feedbackBundle/bundle.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { cliNotices, noteCliChange } from '../../src/core/harness/cliNotices.js';
import { defaultPricing } from '../../src/core/harness/pricing.js';
import { loadPrompt } from '../../src/core/prompts/index.js';
import { runtimePaths } from '../../src/core/runtime/paths.js';
import { BETA_BUDGETS, cachedSetupCheck, serverSetupCheck, type CliCheck, type DoctorSystem, type SetupReport } from '../../src/core/setup/doctor.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const cliCheck = (id: CliCheck['id'], found: boolean, more: Partial<CliCheck> = {}): CliCheck => ({
  id, name: id, command: id, found, runs: found, signedIn: found ? 'yes' : 'unknown', signedInDetail: '', howTo: found ? '' : `Install ${id}`, ready: found,
  ...(found ? { path: `/opt/tools/${id}`, onPath: true, version: '1.2.3' } : {}),
  ...more,
});

const reportOf = (found: Array<CliCheck['id']>, more: Partial<Record<CliCheck['id'], Partial<CliCheck>>> = {}): SetupReport => ({
  checkedAt: '2026-11-16T10:00:00.000Z',
  platform: 'darwin',
  clis: (['claude', 'codex', 'opencode'] as const).map((id) => cliCheck(id, found.includes(id), more[id])),
  chrome: { found: true, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', howTo: '' },
  canResearch: found.length > 0,
  summary: found.length ? 'Research can start.' : 'No agent CLI was found, so research cannot start.',
});

/**
 * A machine for the check the real server builds (`serverSetupCheck`): the agent CLIs in `found` are
 * installed in `/t` and signed in, Chrome is there, and nothing else answers. No command is run.
 */
function machine(found: () => Array<CliCheck['id']>, ran: () => void): DoctorSystem {
  const answers: Record<string, string> = {
    '/t/claude --version': '2.1.325 (Claude Code)', '/t/claude auth status --json': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    '/t/codex --version': 'codex-cli 0.169.0', '/t/codex login status': 'Logged in using ChatGPT',
    '/t/opencode --version': '1.2.27', '/t/opencode auth list': '\n●  Provider oauth\n│\n└  1 credentials\n',
  };
  const files = () => [...found().map((id) => `/t/${id}`), '/Users/tester/.codex/auth.json', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return {
    platform: 'darwin', home: '/Users/tester', env: { PATH: '/t' },
    isFile: (p) => files().includes(p) && !p.endsWith('.json'),
    exists: (p) => files().includes(p),
    listDir: () => [],
    run: async (file, args) => {
      if (args[0] === '--version') ran();
      const out = answers[[file, ...args].join(' ')];
      return out === undefined ? { code: null, stdout: '', stderr: '', error: 'no answer' } : { code: 0, stdout: out, stderr: '' };
    },
  };
}

function setup(opts: { found?: Array<CliCheck['id']>; noCheck?: boolean; deps?: Partial<AppDeps>; configFile?: string; judged?: boolean } = {}) {
  const t = researchSetup(opened, { config: (c) => void (c.user = { id: 'erin' }) });
  const dir = mkdtempSync(join(tmpdir(), 'bif-setup-'));
  const configPath = join(dir, 'bif.config.json');
  if (opts.configFile !== undefined) writeFileSync(configPath, opts.configFile);
  const state = { found: opts.found ?? ['claude', 'codex'], runs: 0, opened: [] as string[] };
  // `judged`: the check the real server builds (`src/api/main.ts` calls the same function), on a machine
  // of this test: whether research can start is read from the configuration in use each time.
  const setupCheck = opts.judged
    ? serverSetupCheck(t.config, machine(() => state.found, () => state.runs++))
    : cachedSetupCheck(async () => {
        state.runs++;
        return reportOf(state.found);
      });
  const app = createApp({
    store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps, configPath,
    ...(opts.noCheck ? {} : { setup: setupCheck, openFolder: (d: string) => void state.opened.push(d) }),
    ...opts.deps,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...t, app, call, configPath, dir, state };
}

describe('GET /api/health', () => {
  it('answers the version and the resources the server found', async () => {
    const t = setup({ deps: { appVersion: '7.8.9' } });
    const res = await t.call('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '7.8.9', resources: { promptVersion: loadPrompt('worker').version, priceTable: defaultPricing().version, web: false } });
  });

  it('uses the package version of the checkout when none is given', async () => {
    const version = (JSON.parse(readFileSync(runtimePaths().resources.packageJson, 'utf8')) as { version: string }).version;
    expect((await setup().call('GET', '/api/health')).body.version).toBe(version);
  });
});

describe('GET /api/setup', () => {
  it('answers the check, where the data and the configuration are, and whether a configuration exists', async () => {
    const t = setup({ deps: { appVersion: '7.8.9' } });
    const res = await t.call('GET', '/api/setup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      version: '7.8.9',
      packaged: false,
      configExists: false,
      folders: { data: t.artifacts.dataDir, config: t.configPath },
      report: { canResearch: true, clis: [{ id: 'claude', found: true, version: '1.2.3' }, { id: 'codex', found: true }, { id: 'opencode', found: false }] },
    });
    expect(res.body.folders.open).toBe(t.artifacts.dataDir);
    // Where the research browser keeps its profile: the configuration's path, made absolute.
    expect(res.body.folders.browserProfile).toBe(resolve(t.config.browser.profileDir));
  });

  it('keeps the check until it is asked again', async () => {
    const t = setup();
    await t.call('GET', '/api/setup');
    await t.call('GET', '/api/setup');
    expect(t.state.runs).toBe(1);
    t.state.found = [];
    const again = await t.call('GET', '/api/setup?refresh=1');
    expect(t.state.runs).toBe(2);
    expect(again.body.report.canResearch).toBe(false);
  });

  it('in the packaged app: the application folder is the folder shown, with its logs', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'bif-appdir-'));
    const paths = runtimePaths({ env: { BIF_APP_DIR: appDir } });
    const t = setup({ deps: { paths } });
    const res = await t.call('GET', '/api/setup');
    expect(res.body).toMatchObject({ packaged: true, folders: { app: appDir, logs: join(appDir, 'logs'), open: appDir } });
  });

  it('shows the changes of an agent CLI noticed by this server start (a built-in tool BIF has not sorted)', async () => {
    const t = setup();
    expect((await t.call('GET', '/api/setup')).body.cliNotices).toEqual(cliNotices());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noteCliChange('Claude Code 0.0.1-setup-test offers built-in tools BIF has not sorted: Teleport');
    } finally {
      warn.mockRestore();
    }
    expect((await t.call('GET', '/api/setup')).body.cliNotices).toContain('Claude Code 0.0.1-setup-test offers built-in tools BIF has not sorted: Teleport');
  });

  it('without a check (a server started by a test): says so, runs nothing, still shows the folders', async () => {
    const t = setup({ noCheck: true });
    const res = await t.call('GET', '/api/setup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, report: null, folders: { data: t.artifacts.dataDir } });
    expect((await t.call('POST', '/api/setup/apply', {})).status).toBe(409);
    expect((await t.call('POST', '/api/setup/open-folder', {})).status).toBe(409);
    expect(existsSync(t.configPath)).toBe(false);
  });
});

describe('POST /api/setup/apply', () => {
  it('answers the check as it reads with the configuration it wrote: the roles moved, so research can start', async () => {
    // Only Claude Code is there; the defaults give the reviewer to Codex.
    const t = setup({ found: ['claude'], judged: true });
    const before = await t.call('GET', '/api/setup');
    expect(before.body.report).toMatchObject({ canResearch: false, summary: expect.stringContaining('Codex, which was not found') });
    const res = await t.call('POST', '/api/setup/apply', {});
    expect(res.status).toBe(200);
    expect(res.body.config.roles.reviewer.provider).toBe('claude');
    expect(res.body.report).toMatchObject({ canResearch: true, summary: 'Research can start with Claude Code.' });
    // Read again without a new check: the kept report is judged with the roles as they are now.
    const ran = t.state.runs;
    expect((await t.call('GET', '/api/setup')).body.report).toMatchObject({ canResearch: true, summary: 'Research can start with Claude Code.' });
    // The person gives a role back to a program this machine does not have: the same kept check says so.
    t.config.roles.reviewer = { provider: 'codex', model: 'gpt-6.1-sol' };
    expect((await t.call('GET', '/api/setup')).body.report).toMatchObject({ canResearch: false, summary: expect.stringContaining('Codex, which was not found') });
    expect(t.state.runs).toBe(ran);
  });

  it('writes the configuration that fits what was found when none exists, and uses it at once', async () => {
    const t = setup({ found: ['claude'] });
    const res = await t.call('POST', '/api/setup/apply', {});
    expect(res.status).toBe(200);
    const file = JSON.parse(readFileSync(t.configPath, 'utf8'));
    expect(file.providers).toMatchObject({ claude: { enabled: true }, codex: { enabled: false }, opencode: { enabled: false } });
    expect(file.roles.reviewer).toEqual({ provider: 'claude', model: 'opus' });
    expect(file.budgets).toEqual(BETA_BUDGETS);
    // The running server uses it: the shared configuration object was replaced in place.
    expect(t.config.providers.codex.enabled).toBe(false);
    expect(t.config.budgets).toEqual(BETA_BUDGETS);
    expect(res.body.config.providers.codex.enabled).toBe(false);
    expect(res.body.report.clis[0]).toMatchObject({ id: 'claude', found: true });
    expect((await t.call('GET', '/api/setup')).body.configExists).toBe(true);
  });

  it('checks again before it writes, so a CLI installed a moment ago counts', async () => {
    const t = setup({ found: [] });
    await t.call('GET', '/api/setup');
    t.state.found = ['codex'];
    await t.call('POST', '/api/setup/apply', {});
    expect(t.config.providers).toMatchObject({ claude: { enabled: false }, codex: { enabled: true } });
    expect(t.config.roles.orchestrator).toEqual({ provider: 'codex', model: t.config.providers.codex.models[0] });
  });

  it('leaves an existing configuration alone unless it is asked explicitly', async () => {
    const mine = `${JSON.stringify({ limits: { maxParallelWorkers: 1 } })}\n`;
    const t = setup({ found: ['claude'], configFile: mine });
    const refused = await t.call('POST', '/api/setup/apply', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/already exists/);
    expect(readFileSync(t.configPath, 'utf8')).toBe(mine);
    expect(t.config.providers.codex.enabled).toBe(true);

    t.config.limits.maxParallelWorkers = 1; // as the server would have loaded it from the file
    const asked = await t.call('POST', '/api/setup/apply', { overwrite: true });
    expect(asked.status).toBe(200);
    const file = JSON.parse(readFileSync(t.configPath, 'utf8'));
    expect(file.providers.codex.enabled).toBe(false);
    // What the configuration already said is kept.
    expect(file.limits.maxParallelWorkers).toBe(1);
    expect(file.user).toEqual({ id: 'erin' });
  });

  it('records who changed the configuration (the configured actor, never the body)', async () => {
    const t = setup({ found: ['claude'] });
    const root = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
    expect((await t.call('POST', '/api/setup/apply', { actor: 'mallory' })).status).toBe(400);
    expect((await t.call('POST', '/api/setup/apply', {})).status).toBe(200);
    const [ev] = listFeedback(t.store, { kind: 'user_action' });
    expect(ev).toMatchObject({ actor: 'erin', workspaceId: root.id, afterJson: { action: 'config_change' } });
    expect((ev!.afterJson as { changedKeys: string[] }).changedKeys.sort()).toEqual(['budgets', 'providers', 'roles']);
  });

  it('with no agent CLI found: still writes a configuration that loads, and says research cannot start', async () => {
    const t = setup({ found: [] });
    const res = await t.call('POST', '/api/setup/apply', {});
    expect(res.status).toBe(200);
    expect(res.body.report.canResearch).toBe(false);
    expect(JSON.parse(readFileSync(t.configPath, 'utf8')).budgets).toEqual(BETA_BUDGETS);
  });
});

describe('POST /api/setup/open-folder', () => {
  it('opens the data folder of a checkout, the application folder of the packaged app; the body names no folder', async () => {
    const t = setup();
    const res = await t.call('POST', '/api/setup/open-folder', {});
    expect(res.status).toBe(200);
    expect(t.state.opened).toEqual([t.artifacts.dataDir]);
    expect((await t.call('POST', '/api/setup/open-folder', { dir: '/etc' })).status).toBe(400);
    expect(t.state.opened).toEqual([t.artifacts.dataDir]);

    const appDir = mkdtempSync(join(tmpdir(), 'bif-appdir-'));
    const packaged = setup({ deps: { paths: runtimePaths({ env: { BIF_APP_DIR: appDir } }) } });
    await packaged.call('POST', '/api/setup/open-folder', {});
    expect(packaged.state.opened).toEqual([appDir]);
  });
});

describe('the feedback bundle manifest', () => {
  const manifestOf = async (t: ReturnType<typeof setup>) => {
    const res = await t.app.request('/api/feedback-bundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return decodeBundle(Buffer.from(await res.arrayBuffer())).manifest as { appVersion: string; clis: unknown };
  };

  it('carries the app version the server was given', async () => {
    expect((await manifestOf(setup({ deps: { appVersion: '7.8.9' } }))).appVersion).toBe('7.8.9');
  });

  it('carries the agent CLIs the setup check found, with their versions; the check runs once', async () => {
    const t = setup({ found: ['claude', 'opencode'] });
    expect((await manifestOf(t)).clis).toEqual([{ name: 'claude', version: '1.2.3' }, { name: 'opencode', version: '1.2.3' }]);
    await manifestOf(t);
    await t.call('POST', '/api/feedback-bundle/preview', {});
    expect(t.state.runs).toBe(1);
  });

  it('without a check: the enabled providers by name, as before', async () => {
    expect((await manifestOf(setup({ noCheck: true }))).clis).toEqual([{ name: 'claude' }, { name: 'codex' }]);
  });
});
