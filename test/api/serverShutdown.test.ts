/**
 * Shutting the server down stops the agents that are running (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1), each way a shutdown is asked for: a
 * signal (a checkout stopped with Ctrl-C, or by its service), and the desktop shell's line on the
 * standard input or the end of that input. The next start continues the work.
 *
 * The server is a real process started as `npm start` starts it. Its agent CLI is
 * `test/fixtures/hanging-cli.mjs`, or `stubborn-cli.mjs` where the agent must ignore the polite stop:
 * no model is called. Where the forced stop is tested the server is started through
 * `test/fixtures/timed-server.ts`, the same entry with its two waits shortened.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { serverEnv } from '../../desktop/environment.js';
import { startServer, type ServerProcess } from './serverProcess.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HANGING_CLI = join(ROOT, 'test', 'fixtures', 'hanging-cli.mjs');
const STUBBORN_CLI = join(ROOT, 'test', 'fixtures', 'stubborn-cli.mjs');
// Node on Windows needs a file URL for `--import`.
const TSX = ['--import', pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href];
const ENTRY = [...TSX, join(ROOT, 'src', 'api', 'main.ts')];
/** The same entry with the kill grace and the shutdown limit taken from `TEST_KILL_GRACE_MS` and `TEST_SHUTDOWN_LIMIT_MS`. */
const TIMED_ENTRY = [...TSX, join(ROOT, 'test', 'fixtures', 'timed-server.ts')];

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'still running'> => Promise.race([p, sleep(ms).then(() => 'still running' as const)]);

/** Servers and agent CLIs this file started: whatever a failing test leaves behind is stopped by process id. */
const servers: ServerProcess[] = [];
const cliPids: number[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGKILL');
    await s.exited;
  }
  for (const pid of cliPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
});

type Started = { server: ServerProcess; base: string; cwd: string; env: Record<string, string | undefined> };

/**
 * A server whose agent CLI never finishes, in `cwd`. Default: a checkout, as `npm start` starts it.
 * `shell`: as the desktop shell starts it, with the environment the shell builds (`serverEnv`), `cwd`
 * as the application folder and a standard input the test writes to.
 */
async function start(cwd: string, opts: { shell?: boolean; cli?: string; killGraceMs?: number; shutdownLimitMs?: number } = {}): Promise<Started> {
  const port = await freePort();
  // On Windows a script is started through Node (`commandFor`), as an agent CLI installed with npm is.
  const provider = { command: opts.cli ?? HANGING_CLI };
  writeFileSync(join(cwd, 'bif.config.json'), JSON.stringify({ server: { port }, providers: { claude: provider, codex: provider, opencode: provider } }));
  const timed = opts.killGraceMs !== undefined || opts.shutdownLimitMs !== undefined;
  const env: Record<string, string | undefined> = {
    ...(opts.shell ? serverEnv(process.env, { appDir: cwd, version: '0.0.0-test', path: process.env.PATH ?? process.env.Path ?? '' }) : {}),
    ...(opts.killGraceMs !== undefined ? { TEST_KILL_GRACE_MS: String(opts.killGraceMs) } : {}),
    ...(opts.shutdownLimitMs !== undefined ? { TEST_SHUTDOWN_LIMIT_MS: String(opts.shutdownLimitMs) } : {}),
  };
  const server = startServer(timed ? TIMED_ENTRY : ENTRY, { cwd, env: env as Record<string, string>, ...(opts.shell ? { stdin: 'pipe' as const } : {}) });
  servers.push(server);
  // The shell's server listens on a free port of its own choosing and says which.
  const base = await server.waitFor((l) => /^\[bif\] listening on (http:\/\/127\.0\.0\.1:\d+) /.exec(l)?.[1], 30_000);
  return { server, base, cwd, env };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Starts research for a new business and resolves with the process id of the agent CLI that then runs, and the names of its environment variables. */
async function runningAgent(s: Started): Promise<{ workspaceId: string; pid: number; envNames: string[] }> {
  const ws = (await (await post(s.base, '/api/workspaces', { name: 'Test business', sector: 'software' })).json()) as { id: string };
  expect((await post(s.base, `/api/workspaces/${ws.id}/research`, { phases: ['market_research'] })).status).toBe(202);
  const runs = join(s.cwd, 'data', ws.id, 'runs');
  const deadline = Date.now() + 20_000;
  for (;;) {
    const file = existsSync(runs) ? readdirSync(runs).map((id) => join(runs, id, 'cwd', 'cli.pid')).find((f) => existsSync(f)) : undefined;
    const pid = file ? Number(readFileSync(file, 'utf8')) : 0;
    if (pid > 0) {
      cliPids.push(pid);
      const envNames = (JSON.parse(readFileSync(join(file!, '..', 'cli.env.json'), 'utf8')) as string[]).map((n) => n.toUpperCase());
      return { workspaceId: ws.id, pid, envNames };
    }
    if (Date.now() > deadline) throw new Error(`no agent CLI started:\n${s.server.lines.join('\n')}`);
    await sleep(25);
  }
}

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'bif-shutdown-')));

describe('a server shutdown stops the running agents', () => {
  // Windows has no SIGTERM: a process stopped there ends at once. There the shell's line is the way.
  it.skipIf(process.platform === 'win32')('on a signal (a checkout stopped with Ctrl-C), and the next start continues the work', async () => {
    const cwd = tmp();
    const first = await start(cwd);
    const { workspaceId, pid } = await runningAgent(first);
    expect(alive(pid)).toBe(true);

    first.server.child.kill('SIGINT');
    expect(await within(first.server.exited, 15_000)).toBe(0);
    expect(first.server.lines).toContain('[bif] shutting down');
    expect(alive(pid)).toBe(false);

    // The next start: the interrupted run is closed out and its research run goes on to its end.
    const second = await start(cwd);
    await second.server.waitFor((l) => (l.includes('1 interrupted agent runs failed') && l.includes('1 research runs') ? l : undefined));
    const deadline = Date.now() + 20_000;
    for (;;) {
      const runs = (await (await fetch(`${second.base}/api/workspaces/${workspaceId}/runs`)).json()) as Array<{ status: string }>;
      if (runs.length === 1 && runs[0]!.status !== 'running') break;
      if (Date.now() > deadline) throw new Error(`the research run did not end: ${JSON.stringify(runs)}`);
      await sleep(50);
    }
    expect(await second.server.stop()).toBe(0);
  }, 90_000);

  it('when the desktop shell writes the shutdown line', async () => {
    const s = await start(tmp(), { shell: true });
    const { pid } = await runningAgent(s);
    s.server.child.stdin!.write('BIF_SHUTDOWN\n');
    expect(await within(s.server.exited, 15_000)).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('when its standard input ends: the shell is gone', async () => {
    const s = await start(tmp(), { shell: true });
    const { pid } = await runningAgent(s);
    s.server.child.stdin!.end();
    expect(await within(s.server.exited, 15_000)).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});

describe('the agent CLI of a server the desktop shell started', () => {
  // On Windows the stand-in CLI, a script, is started with the program the server runs on, which keeps
  // the variables (`childEnv`); this needs a CLI that is a program of its own, as on macOS and Linux.
  it.skipIf(process.platform === 'win32')('does not get the variables that make the app\'s own program run as Node, and gets the PATH the shell gave', async () => {
    const s = await start(tmp(), { shell: true });
    // The environment the shell built for the server has both, and the application folder.
    expect(s.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', BIF_APP_DIR: s.cwd, BIF_SHUTDOWN_ON_STDIN: '1' });
    const { pid, envNames } = await runningAgent(s);
    expect(envNames).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(envNames).not.toContain('ELECTRON_NO_ASAR');
    expect(envNames).toContain('PATH');
    s.server.child.stdin!.end('BIF_SHUTDOWN\n');
    expect(await within(s.server.exited, 15_000)).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});

// Signals: Windows has none of these (there the shell's line is the way, and a stop ends a process at once).
describe.skipIf(process.platform === 'win32')('an agent that ignores the polite stop (skipped on Windows: it has no such signals)', () => {
  it('is stopped by force after the grace, and the server then exits by itself', async () => {
    const s = await start(tmp(), { cli: STUBBORN_CLI, killGraceMs: 400, shutdownLimitMs: 20_000 });
    const { pid } = await runningAgent(s);
    const asked = Date.now();
    s.server.child.kill('SIGTERM');
    expect(await within(s.server.exited, 10_000)).toBe(0);
    // Not before the grace was over (the polite stop did nothing), and long before the limit.
    expect(Date.now() - asked).toBeGreaterThanOrEqual(400);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('is stopped by force when the shutdown reaches its limit, and the server exits then', async () => {
    // The grace is far longer than the limit: only the limit can end this shutdown.
    const s = await start(tmp(), { cli: STUBBORN_CLI, killGraceMs: 60_000, shutdownLimitMs: 500 });
    const { pid } = await runningAgent(s);
    const asked = Date.now();
    s.server.child.kill('SIGTERM');
    expect(await within(s.server.exited, 10_000)).toBe(0);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(500);
    await sleep(100); // the forced stop is a signal: the process is gone a moment later
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('a second signal does not cut the shutdown short: the forced stop still happens', async () => {
    for (const second of ['SIGTERM', 'SIGINT'] as const) {
      const s = await start(tmp(), { cli: STUBBORN_CLI, killGraceMs: 600, shutdownLimitMs: 20_000 });
      const { pid } = await runningAgent(s);
      s.server.child.kill('SIGINT');
      await sleep(100);
      s.server.child.kill(second);
      await sleep(100);
      // Still shutting down: the agent has its grace, and the server waits for it.
      expect(s.server.child.exitCode, `after SIGINT then ${second}`).toBeNull();
      expect(s.server.child.signalCode, `after SIGINT then ${second}`).toBeNull();
      expect(await within(s.server.exited, 10_000), `after SIGINT then ${second}`).toBe(0);
      expect(alive(pid), `after SIGINT then ${second}`).toBe(false);
      expect(s.server.lines.filter((l) => l === '[bif] shutting down')).toHaveLength(1);
    }
  }, 90_000);

  it('the shutdown line after a signal waits for the same shutdown', async () => {
    const s = await start(tmp(), { shell: true, cli: STUBBORN_CLI, killGraceMs: 600, shutdownLimitMs: 20_000 });
    const { pid } = await runningAgent(s);
    s.server.child.kill('SIGTERM');
    await sleep(100);
    s.server.child.stdin!.end('BIF_SHUTDOWN\n');
    await sleep(100);
    expect(s.server.child.exitCode).toBeNull();
    expect(await within(s.server.exited, 10_000)).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('a server whose shell was killed still stops its agents: nobody reads what it prints any more', async () => {
    const s = await start(tmp(), { shell: true, cli: STUBBORN_CLI, killGraceMs: 400, shutdownLimitMs: 20_000 });
    const { pid } = await runningAgent(s);
    // The shell is gone: the pipes it read the server's output from are closed, and so is the server's input.
    s.server.child.stdout!.destroy();
    s.server.child.stderr!.destroy();
    s.server.child.stdin!.end();
    expect(await within(s.server.exited, 10_000)).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});
