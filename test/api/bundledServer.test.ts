/**
 * The server as it is shipped and as it is started in a checkout, each as a real process
 * (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1, §4.2; plan Review Focus 3 and 4).
 * No agent CLI is started: the stores are empty, and where the setup check is asked for, the providers'
 * commands are names that do not exist on any machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type BuiltServer } from '../../scripts/build-server.js';
import { entryOptions } from '../../src/api/main.js';
import { defaultConfig, PLAYWRIGHT_MCP_VERSION } from '../../src/core/config/schema.js';
import { defaultPricing } from '../../src/core/harness/pricing.js';
import { loadPrompt } from '../../src/core/prompts/index.js';
import { runtimePaths } from '../../src/core/runtime/paths.js';
import { parsePortLine } from '../../src/core/runtime/portLine.js';
import { fingerprint, listing, startServer, type ServerProcess } from './serverProcess.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `bif-${name}-`)));

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

const WEB_PAGE = '<!doctype html><title>BIF test page</title><div id="root"></div>';
const ABSENT = (name: string) => `bif-test-no-such-command-${name}`;

describe('the bundled server, started from a directory that is not the checkout', () => {
  let built: BuiltServer;
  let server: ServerProcess;
  let port: number;
  let resourcesBefore: string[];
  const work = tmp('bundle');
  const elsewhere = join(work, 'started here');
  const appDir = join(work, 'Application Support', 'Business Intelligence Factory');

  beforeAll(async () => {
    const web = join(work, 'web-dist');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), WEB_PAGE);
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log("bif test asset");');
    mkdirSync(elsewhere);
    // The tester's configuration: commands no machine has, so the setup check finds nothing and starts nothing.
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'bif.config.json'), JSON.stringify({ providers: { claude: { command: ABSENT('claude') }, codex: { command: ABSENT('codex') }, opencode: { command: ABSENT('opencode') } } }));
    built = await buildServer({ outDir: join(work, 'dist', 'server'), webDist: web });
    resourcesBefore = fingerprint(built.outDir);
    // The shell passes the application folder; the bundle finds its resources next to itself.
    server = startServer([built.entry], { cwd: elsewhere, env: { BIF_APP_DIR: appDir } });
    port = await server.waitFor(parsePortLine);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    // The build holds the research browser (about 30 MB): do not leave one per test run behind.
    rmSync(work, { recursive: true, force: true });
  });

  it('ships the entry, the resources and the pinned research browser', () => {
    expect(existsSync(built.entry)).toBe(true);
    expect(built.prompts).toBeGreaterThan(20);
    expect(JSON.parse(readFileSync(join(built.outDir, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', version: built.version });
    expect(JSON.parse(readFileSync(join(built.outDir, 'node_modules', '@playwright', 'mcp', 'package.json'), 'utf8'))).toMatchObject({ version: PLAYWRIGHT_MCP_VERSION });
    expect(built.browserPackages).toEqual(['@playwright/mcp', 'playwright', 'playwright-core']);
    for (const name of built.browserPackages) expect(existsSync(join(built.outDir, 'node_modules', ...name.split('/'), 'package.json')), name).toBe(true);
    // Prompts are copied byte for byte: their versions are hashes of their text.
    expect(readFileSync(join(built.outDir, 'prompts', 'worker.md')).equals(readFileSync(join(ROOT, 'src', 'core', 'prompts', 'worker.md')))).toBe(true);
    expect(existsSync(join(built.outDir, 'prompts', 'calibration'))).toBe(false);
  });

  it('listens on a free port and says which in one line', () => {
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(defaultConfig.server.port);
    expect(server.lines.filter((l) => parsePortLine(l) !== undefined)).toHaveLength(1);
  });

  it('serves the health route: the version, and the prompts and the price table it found', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: built.version,
      // The same prompt text and price table as the checkout's, read from the shipped copies.
      resources: { promptVersion: loadPrompt('worker').version, priceTable: defaultPricing().version, web: true },
    });
  });

  it('serves the pages and the API', async () => {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toBe(WEB_PAGE);
    expect(await (await fetch(`http://127.0.0.1:${port}/assets/app.js`)).text()).toContain('bif test asset');
    // A page address of the web app (answered with the app itself).
    expect(await (await fetch(`http://127.0.0.1:${port}/some/page`)).text()).toBe(WEB_PAGE);
    const api = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual([]);
  });

  it('keeps its data and its configuration in the application folder', async () => {
    expect(existsSync(join(appDir, 'data', 'bif.db'))).toBe(true);
    const config = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as typeof defaultConfig;
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
    expect(res.status).toBe(200);
    expect(existsSync(join(appDir, 'bif.config.json'))).toBe(true);
    // The file keeps the configuration's own values, not this machine's folder or the port of this start.
    const file = JSON.parse(readFileSync(join(appDir, 'bif.config.json'), 'utf8')) as typeof defaultConfig;
    expect(file.dataDir).toBe(defaultConfig.dataDir);
    expect(file.server.port).toBe(defaultConfig.server.port);
  });

  it('every folder it names is in the application folder, the research browser profile too', async () => {
    const setup = (await (await fetch(`http://127.0.0.1:${port}/api/setup`)).json()) as { packaged: boolean; folders: Record<string, string>; report: { canResearch: boolean; clis: Array<{ found: boolean }> } };
    expect(setup.packaged).toBe(true);
    expect(setup.folders).toEqual({
      app: appDir,
      data: join(appDir, 'data'),
      config: join(appDir, 'bif.config.json'),
      logs: join(appDir, 'logs'),
      // A relative path of the configuration (`data/browser-profile`) lands in the application folder.
      browserProfile: join(appDir, 'data', 'browser-profile'),
      open: appDir,
    });
    // With no agent CLI found the server still runs, and says that research cannot start (design §4.3).
    expect(setup.report.clis.map((c) => c.found)).toEqual([false, false, false]);
    expect(setup.report.canResearch).toBe(false);
  });

  it('writes nothing outside the application folder: not where it was started, not into its own resources', () => {
    expect(listing(elsewhere)).toEqual([]);
    expect(fingerprint(built.outDir)).toEqual(resourcesBefore);
    expect(listing(appDir).filter((p) => !p.startsWith('data') && p !== 'bif.config.json')).toEqual([]);
  });

  // The desktop shell's way to stop the server, on every platform (Windows has no SIGTERM): a line on
  // the server's standard input, or the end of that input when the shell itself is gone.
  describe('started as the desktop shell starts it', () => {
    const start = (name: string, env: Record<string, string> = { BIF_SHUTDOWN_ON_STDIN: '1' }) => {
      const dir = join(work, name);
      mkdirSync(dir);
      return startServer([built.entry], { cwd: elsewhere, env: { BIF_APP_DIR: dir, ...env }, stdin: 'pipe' });
    };
    const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'still running'> => Promise.race([p, new Promise<'still running'>((r) => setTimeout(() => r('still running'), ms))]);

    it('shuts down when the shell writes the shutdown line, and exits with code 0', async () => {
      const s = start('asked');
      try {
        await s.waitFor(parsePortLine);
        s.child.stdin!.write('BIF_SHUTDOWN\n');
        expect(await within(s.exited, 10_000)).toBe(0);
        expect(s.lines).toContain('[bif] shutting down');
      } finally {
        await s.stop();
      }
    }, 30_000);

    it('shuts down when its standard input ends: the shell is gone', async () => {
      const s = start('shell gone');
      try {
        await s.waitFor(parsePortLine);
        s.child.stdin!.end();
        expect(await within(s.exited, 10_000)).toBe(0);
        expect(s.lines).toContain('[bif] shutting down');
      } finally {
        await s.stop();
      }
    }, 30_000);

    it('does neither unless the shell switched it on', async () => {
      const s = start('not switched on', {});
      try {
        const p = await s.waitFor(parsePortLine);
        s.child.stdin!.end('BIF_SHUTDOWN\n');
        expect(await within(s.exited, 1500)).toBe('still running');
        expect((await fetch(`http://127.0.0.1:${p}/api/health`)).status).toBe(200);
      } finally {
        await s.stop();
      }
    }, 30_000);
  });

  // Windows has no SIGTERM: a process stopped there ends at once. Stopping the server on Windows is the shell's job.
  it.skipIf(process.platform === 'win32')('stops when it is told to', async () => {
    expect(await server.stop()).toBe(0);
    expect(server.lines).toContain('[bif] shutting down');
  });
});

describe('a checkout started as `npm start` does', () => {
  it('uses ./bif.config.json and ./data of the working directory, the configured port, and prints no port line', async () => {
    const cwd = tmp('checkout');
    const port = await freePort();
    // Only the port is set, so the test does not need the default port to be free on this machine.
    writeFileSync(join(cwd, 'bif.config.json'), JSON.stringify({ server: { port } }));
    const server = startServer(['--import', pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(ROOT, 'src', 'api', 'main.ts')], { cwd });
    try {
      const listening = await server.waitFor((l) => (l.startsWith('[bif] listening on ') ? l : undefined));
      expect(listening).toBe(`[bif] listening on http://127.0.0.1:${port} (data: ${join(cwd, 'data')})`);
      expect(existsSync(join(cwd, 'data', 'bif.db'))).toBe(true);
      const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean; version: string };
      expect(health).toMatchObject({ ok: true, version: (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version });
      expect(server.lines.some((l) => parsePortLine(l) !== undefined)).toBe(false);
    } finally {
      await server.stop();
    }
  }, 60_000);

  it("starts with today's options when nothing is set: no configuration path, data folder or port is passed", () => {
    const paths = runtimePaths({ env: {}, cwd: ROOT });
    expect(entryOptions({}, paths)).toEqual({ ocrReader: 'claude-cli', setup: 'system', openFolder: 'system' });
    expect(paths.configPath).toBe(join(ROOT, 'bif.config.json'));
    expect(defaultConfig.dataDir).toBe('data');
    expect(defaultConfig.server.port).toBe(4317);
  });

  it('takes BIF_CONFIG, BIF_DATA_DIR and PORT as before, and now PORT=0 for a free port', () => {
    const paths = runtimePaths({ env: {}, cwd: ROOT });
    expect(entryOptions({ BIF_CONFIG: '/c/x.json', BIF_DATA_DIR: '/d', PORT: '5000' }, paths)).toMatchObject({ configPath: '/c/x.json', dataDir: '/d', port: 5000 });
    expect(entryOptions({ PORT: '0' }, paths)).toMatchObject({ port: 0 });
    for (const bad of ['', ' ', 'abc', '1.5']) expect(entryOptions({ PORT: bad }, paths), bad).not.toHaveProperty('port');
  });

  it('in the packaged app: the application folder, a free port, and the same overrides on top', () => {
    const app = join(tmpdir(), 'bif-app');
    const paths = runtimePaths({ env: { BIF_APP_DIR: app }, cwd: ROOT });
    expect(entryOptions({ BIF_APP_DIR: app }, paths)).toEqual({
      configPath: join(app, 'bif.config.json'), dataDir: join(app, 'data'), port: 0, ocrReader: 'claude-cli', setup: 'system', openFolder: 'system',
    });
    expect(entryOptions({ BIF_APP_DIR: app, PORT: '4400' }, paths)).toMatchObject({ port: 4400, dataDir: join(app, 'data') });
  });
});
