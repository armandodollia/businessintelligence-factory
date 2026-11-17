/**
 * What an agent CLI gets as its environment. The desktop shell runs the server on the app's own
 * program as Node, with `ELECTRON_RUN_AS_NODE` and `ELECTRON_NO_ASAR` in the server's environment.
 * Those two are for that program alone: an agent CLI (a run, the OCR call, a command of the setup
 * check) does not get them, or every Electron program the agent starts would run as Node too. The
 * research browser the app ships runs on the app's program and gets them for its own process.
 *
 * Here the server's own environment is given the two variables, as the shell gives them, and real
 * processes say what they got. The stand-ins call no model.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_SHARED_BROWSER, defaultConfig } from '../../src/core/config/schema.js';
import { SharedBrowser } from '../../src/core/harness/browser.js';
import { claudeOcrReader } from '../../src/core/knowledge/ocr/haiku.js';
import { systemDoctor } from '../../src/core/setup/doctor.js';
import type { Store } from '../../src/core/store/db.js';
import { researchSetup } from './helpers/research.js';

const HANGING_CLI = join(import.meta.dirname, '../fixtures/hanging-cli.mjs');
const FAKE_SERVER = join(import.meta.dirname, '../fixtures/fake-browser-server.mjs');
const SWITCHES = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'] as const;

const opened: Store[] = [];
const cleanup: Array<() => unknown> = [];
let before: Record<string, string | undefined>;

beforeEach(() => {
  // The server's own environment, as the desktop shell sets it (`serverEnv`).
  before = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) process.env[k] = '1';
});
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const s of opened.splice(0)) s.close();
  for (const k of SWITCHES) {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, read: () => T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A command that writes the names of its environment variables to `env.json` beside itself and exits. */
function envDumper(): { command: string; names: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'bif-env-'));
  const command = join(dir, 'dump-env.mjs');
  writeFileSync(
    command,
    "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(import.meta.dirname, 'env.json'), JSON.stringify(Object.keys(process.env)));\nconsole.log('1.2.3');\n",
  );
  chmodSync(command, 0o755);
  return { command, names: () => JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as string[] };
}

const upper = (names: string[]) => names.map((n) => n.toUpperCase());

// The stand-in CLIs are scripts. On Windows a script is started with the program the server itself
// runs on (`commandFor`), which keeps the variables (`childEnv`): what is shown here needs a CLI that is
// a program of its own, as on macOS and Linux. `childEnv` has its Windows cases in platform.test.ts.
const scriptsRunAsThemselves = process.platform !== 'win32';
/** Why a test here is skipped on Windows, said in its name so a skipped line of the report explains itself. */
const ON_WINDOWS = '(skipped on Windows: a stand-in CLI that is a script runs there on the server\'s own program, which keeps the variables)';

describe('the environment of agent CLIs, with the server run as the desktop shell runs it', () => {
  it.skipIf(!scriptsRunAsThemselves)(`an agent run does not get the two variables, and keeps the rest (the PATH) ${ON_WINDOWS}`, async () => {
    const s = researchSetup(opened, { config: (c) => (c.providers.claude.command = HANGING_CLI) });
    s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '2026-11-16T10:00:00.000Z' });
    const ac = new AbortController();
    const run = s.supervisor.run({
      ctx: { workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv_1' },
      prompt: 'p', systemPrompt: 's', needsBrowser: false, signal: ac.signal,
    });
    const runs = join(s.dir, 'ws_a', 'runs');
    const cwd = await until('the agent CLI to start', () => {
      const dir = existsSync(runs) ? readdirSync(runs).map((id) => join(runs, id, 'cwd')).find((d) => existsSync(join(d, 'cli.pid'))) : undefined;
      return dir;
    });
    const names = upper(JSON.parse(readFileSync(join(cwd, 'cli.env.json'), 'utf8')) as string[]);
    ac.abort();
    expect((await run).status).toBe('failed');
    expect(names).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(names).not.toContain('ELECTRON_NO_ASAR');
    expect(names).toContain('PATH');
    // The server's own environment is not changed by starting a run.
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(process.env.ELECTRON_NO_ASAR).toBe('1');
  }, 30_000);

  it.skipIf(!scriptsRunAsThemselves)(`the OCR call does not get them ${ON_WINDOWS}`, async () => {
    const cli = envDumper();
    const reader = claudeOcrReader({ command: cli.command, model: 'haiku', timeoutMs: 20_000 });
    // The stand-in answers nothing an OCR result could be read from: only its environment matters here.
    expect((await reader.read({ target: 'image', bytes: new Uint8Array([1]), mediaType: 'image/png' })).ok).toBe(false);
    const names = upper(cli.names());
    expect(names).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(names).not.toContain('ELECTRON_NO_ASAR');
    expect(names).toContain('PATH');
  }, 30_000);

  it.skipIf(!scriptsRunAsThemselves)(`a command of the setup check does not get them ${ON_WINDOWS}`, async () => {
    const cli = envDumper();
    const out = await systemDoctor().run(cli.command, ['--version']);
    expect(out.stdout).toContain('1.2.3');
    const names = upper(cli.names());
    expect(names).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(names).not.toContain('ELECTRON_NO_ASAR');
  }, 30_000);

  const launchOf = (log: string) => JSON.parse(readFileSync(log, 'utf8').split('\n').filter(Boolean)[0]!) as { runAsNode?: string; noAsar?: string };

  it('the research browser the app ships runs on the app\'s own program and gets both, for its own process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-env-'));
    const log = join(dir, 'launches.jsonl');
    const cfg = structuredClone(defaultConfig);
    cfg.browser.profileDir = join(dir, 'profile');
    cfg.browser.shared = { ...PLAYWRIGHT_SHARED_BROWSER, env: { FAKE_BROWSER_LOG: log } };
    const browser = new SharedBrowser({ config: cfg, dataDir: join(dir, 'data'), startTimeoutMs: 10_000, shipped: { cli: FAKE_SERVER, version: PLAYWRIGHT_MCP_VERSION } });
    cleanup.push(() => browser.close());
    await browser.ensure();
    expect(launchOf(log)).toMatchObject({ runAsNode: '1', noAsar: '1' });
  }, 30_000);

  // On Windows `node` on the PATH may be the very program that runs this test, which then counts as the server's own.
  it.skipIf(process.platform === 'win32')('a research browser started with any other command does not get them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-env-'));
    const log = join(dir, 'launches.jsonl');
    const cfg = structuredClone(defaultConfig);
    cfg.browser.profileDir = join(dir, 'profile');
    // `/usr/bin/env node …`: a command of the person's own, not the server's program.
    cfg.browser.shared = { command: '/usr/bin/env', args: ['node', FAKE_SERVER, '--port', '{{port}}'], port: 0, path: '/mcp', env: { FAKE_BROWSER_LOG: log } };
    const browser = new SharedBrowser({ config: cfg, dataDir: join(dir, 'data'), startTimeoutMs: 10_000 });
    cleanup.push(() => browser.close());
    await browser.ensure();
    const launch = launchOf(log);
    expect(launch.runAsNode).toBeUndefined();
    expect(launch.noAsar).toBeUndefined();
  }, 30_000);
});
