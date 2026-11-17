/**
 * How the desktop shell starts and stops the server (design 2026-11-16 §4.1): it reads the port from
 * the server's one port line, keeps the server's output, and stops it by asking first. Each test runs
 * a small stand-in for the server as a real process; none is left running.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../desktop/server.js';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'bif-shell-')));

/** A stand-in server: a script run by this Node. */
function script(name: string, body: string): string {
  const file = join(work, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

/** Stops when asked on its standard input, as the real server does; says which port and what it was given. */
const POLITE = script(
  'polite',
  `import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
console.log('[bif] starting');
console.log('BIF_PORT=45123');
console.log('[bif] listening on http://127.0.0.1:45123 startedInItsFolder=' + existsSync('polite.mjs') + ' marker=' + process.env.BIF_TEST_MARKER);
console.error('a warning on the error output');
const lines = createInterface({ input: process.stdin });
lines.on('line', (l) => { if (l === 'BIF_SHUTDOWN') { console.log('[bif] shutting down'); process.exit(0); } });
lines.on('close', () => process.exit(7));
`,
);

/** Never reads its standard input and ignores a polite signal: only force stops it. */
const DEAF = script(
  'deaf',
  `process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
console.log('BIF_PORT=45124');
setInterval(() => {}, 1000);
`,
);

/** Ends before it says a port. */
const BROKEN = script('broken', `console.error('[bif] failed to start: the database is locked'); process.exit(1);\n`);

/** Runs, and never says a port. */
const SILENT = script('silent', `console.log('[bif] thinking'); setInterval(() => {}, 1000);\n`);

/** Says a port in two pieces, with a Windows line ending. */
const SLOW_LINE = script(
  'slow-line',
  `process.stdout.write('BIF_PO');
setTimeout(() => process.stdout.write('RT=45125\\r\\n'), 100);
process.stdin.on('data', () => process.exit(0));
`,
);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the server child of the desktop shell', () => {
  const started: RunningServer[] = [];
  const start = (file: string, over: { log?: (text: string) => void; portTimeoutMs?: number; env?: Record<string, string | undefined> } = {}) => {
    const s = startServer({ command: process.execPath, args: [file], env: { ...process.env, ...over.env }, cwd: work, ...over });
    started.push(s);
    // A test that expects the port to fail awaits it itself; no other test may trip over the rejection.
    s.port.catch(() => {});
    return s;
  };

  afterEach(async () => {
    for (const s of started.splice(0)) await s.stop({ waitMs: 200, graceMs: 200 });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('reads the port from the port line, and starts the server in the folder and with the environment it is given', async () => {
    const out: string[] = [];
    const s = start(POLITE, { log: (t) => out.push(t), env: { BIF_TEST_MARKER: 'from the shell' } });
    expect(await s.port).toBe(45123);
    expect(s.pid).toBeGreaterThan(0);
    await s.stop();
    const text = out.join('');
    // The stand-in looked for its own file in the folder it was started in.
    expect(text).toContain('startedInItsFolder=true marker=from the shell');
  });

  it("keeps everything the server prints, the error output too, for the log", async () => {
    const out: string[] = [];
    const s = start(POLITE, { log: (t) => out.push(t) });
    await s.port;
    await s.stop();
    const lines = out.join('').split('\n');
    expect(lines).toContain('[bif] starting');
    expect(lines).toContain('BIF_PORT=45123');
    expect(lines).toContain('a warning on the error output');
    expect(lines).toContain('[bif] shutting down');
  });

  it('reads a port line that comes in pieces, with either line ending', async () => {
    const s = start(SLOW_LINE);
    expect(await s.port).toBe(45125);
  });

  it('stops the server by asking: the shutdown line on its standard input, then waits for it to exit', async () => {
    const s = start(POLITE);
    await s.port;
    expect(await s.stop()).toBe('asked');
    // Exit code 0 is the stand-in's answer to the line; 7 would be the end of its input alone.
    expect(await s.exited).toEqual({ code: 0, signal: null });
    expect(alive(s.pid!)).toBe(false);
  });

  it('stops the process tree only after the server did not exit in time', async () => {
    const s = start(DEAF);
    await s.port;
    const t0 = Date.now();
    expect(await s.stop({ waitMs: 400, graceMs: 300 })).toBe('forced');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(alive(s.pid!)).toBe(false);
    const end = await s.exited;
    // Not an exit of its own making.
    expect(end.code === 0 && end.signal === null).toBe(false);
  }, 30_000);

  it('does nothing when the server has already exited', async () => {
    const s = start(POLITE);
    await s.port;
    await s.stop();
    expect(await s.stop()).toBe('already stopped');
  });

  it('asks once, however often stop is called while it waits', async () => {
    const s = start(POLITE);
    await s.port;
    const [a, b] = await Promise.all([s.stop(), s.stop()]);
    expect([a, b]).toEqual(['asked', 'asked']);
  });

  it('fails the port when the server exits before it says one, with what the server printed', async () => {
    const s = start(BROKEN);
    await expect(s.port).rejects.toThrow(/exited \(code 1\) before it was ready[\s\S]*the database is locked/);
    expect(await s.stop()).toBe('already stopped');
  });

  it('fails the port when none comes in time; the server can still be stopped', async () => {
    const s = start(SILENT, { portTimeoutMs: 300 });
    await expect(s.port).rejects.toThrow(/did not say which port it listens on within 300 ms[\s\S]*thinking/);
    expect(alive(s.pid!)).toBe(true);
    // This stand-in does not read its input: it takes force.
    expect(await s.stop({ waitMs: 300, graceMs: 300 })).toBe('forced');
    expect(alive(s.pid!)).toBe(false);
  }, 30_000);

  it('fails the port when the program cannot be started at all', async () => {
    const s = startServer({ command: join(work, 'no-such-program'), args: [], env: process.env, cwd: work });
    started.push(s);
    await expect(s.port).rejects.toThrow(/could not be started/);
    expect(await s.stop()).toBe('already stopped');
  });
});
