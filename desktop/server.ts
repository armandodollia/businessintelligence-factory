/**
 * The server child of the desktop shell (design 2026-11-16-desktop-app-and-feedback-bundle-design.md
 * §4.1): start it, read the port it chose from its port line, keep what it prints, and stop it.
 *
 * Stopping never relies on a signal alone. On Windows stopping a process ends it at once, without the
 * server's own shutdown, which is what stops the running agents and the research browser. So the
 * shell asks: it writes the shutdown line to the server's standard input and closes it, waits for
 * the server to exit, and only when that takes too long stops the process tree it started
 * (`stopTree`: by process id, never by name).
 *
 * Nothing here imports Electron.
 */
import { spawn } from 'node:child_process';
import { stopTree } from '../src/core/harness/platform.js';
import type { Env } from '../src/core/runtime/paths.js';
import { parsePortLine } from '../src/core/runtime/portLine.js';
import { SHUTDOWN_LINE } from '../src/core/runtime/shutdownLine.js';

export type ServerStart = {
  /** The program that runs the server (the app's own program, run as Node). */
  command: string;
  /** Its arguments: the server entry. */
  args: string[];
  /** The whole environment of the server (`serverEnv`). */
  env: Env;
  /** The folder it starts in. */
  cwd: string;
  /** Receives everything the server prints, as it comes (the shell writes it to the log file). */
  log?: (text: string) => void;
  /** How long the port line may take. */
  portTimeoutMs?: number;
};

/** How a stop ended: the server exited after being asked, the process tree had to be stopped, or there was nothing to stop. */
export type StopResult = 'asked' | 'forced' | 'already stopped';

export type StopOptions = {
  /** How long the server gets to exit after being asked. */
  waitMs?: number;
  /** How long the process tree gets between the polite stop and the forced one. */
  graceMs?: number;
};

export type RunningServer = {
  /** The process id; undefined when the program could not be started. */
  pid: number | undefined;
  /** The port the server listens on. Rejects when the server exits first or the port line does not come in time. */
  port: Promise<number>;
  /** Resolves when the server has exited, with how. Never rejects. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Stops the server: asks, waits, and stops the process tree only when it did not exit in time. Never rejects. */
  stop(opts?: StopOptions): Promise<StopResult>;
};

/** The first start creates the database: generous, and still an end to waiting. */
const PORT_TIMEOUT_MS = 60_000;
/**
 * The server's own shutdown stops the running agents and the research browser, and ends after at
 * most twelve seconds (`SHUTDOWN_LIMIT_MS` of the server entry); the shell waits a little longer
 * before it uses force.
 */
const STOP_WAIT_MS = 15_000;
const STOP_GRACE_MS = 3000;
/** How much of the server's last output an error message carries. */
const TAIL_LINES = 15;

export function startServer(opts: ServerStart): RunningServer {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: its own process group, so `stopTree` can stop it with what it started. Windows finds the tree by parent id.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const tail: string[] = [];
  const remember = (line: string) => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  const lastOutput = () => (tail.length ? `\n${tail.join('\n')}` : '');

  let ended = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => {
      ended = true;
      done({ code, signal });
    });
    // The program could not be started: there is no process, and no exit event will come.
    child.once('error', () => {
      if (child.pid !== undefined) return;
      ended = true;
      done({ code: null, signal: null });
    });
  });

  const port = new Promise<number>((found, fail) => {
    const timeoutMs = opts.portTimeoutMs ?? PORT_TIMEOUT_MS;
    const timer = setTimeout(() => fail(new Error(`the server did not say which port it listens on within ${timeoutMs} ms${lastOutput()}`)), timeoutMs);
    const settle = (f: () => void) => {
      clearTimeout(timer);
      f();
    };
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        remember(line);
        const p = parsePortLine(line);
        if (p !== undefined) settle(() => found(p));
      }
    });
    let pendingErr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      pendingErr += chunk.toString('utf8');
      const lines = pendingErr.split('\n');
      pendingErr = lines.pop() ?? '';
      for (const line of lines) remember(line);
    });
    child.once('error', (e) => settle(() => fail(new Error(`the server could not be started: ${e.message}`))));
    // `close`, not `exit`: by then everything it printed has been read.
    child.once('close', (code, signal) => settle(() => fail(new Error(`the server exited (${signal ? `signal ${signal}` : `code ${code}`}) before it was ready${lastOutput()}`))));
  });

  if (opts.log) {
    const log = opts.log;
    child.stdout.on('data', (chunk: Buffer) => log(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => log(chunk.toString('utf8')));
  }
  // The server may be gone when the shutdown line is written: that is not an error of the shell.
  child.stdin.on('error', () => {});

  const within = (ms: number): Promise<boolean> =>
    new Promise((done) => {
      const timer = setTimeout(() => done(false), ms);
      void exited.then(() => {
        clearTimeout(timer);
        done(true);
      });
    });

  let stopping: Promise<StopResult> | undefined;
  const stop = (o: StopOptions = {}): Promise<StopResult> => {
    if (ended) return Promise.resolve('already stopped');
    stopping ??= (async (): Promise<StopResult> => {
      // The line asks; the end of the input says the same to a server that missed the line.
      child.stdin.end(`${SHUTDOWN_LINE}\n`);
      if (await within(o.waitMs ?? STOP_WAIT_MS)) return 'asked';
      await stopTree(child.pid, o.graceMs ?? STOP_GRACE_MS);
      await within(5000);
      return 'forced';
    })();
    return stopping;
  };

  return { pid: child.pid, port, exited, stop };
}
