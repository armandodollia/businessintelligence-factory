import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ServerProcess = {
  child: ChildProcess;
  /** Everything printed so far, by line. */
  lines: string[];
  /** Resolves with the first line `pick` answers for; rejects when the server exits or the time is up. */
  waitFor<T>(pick: (line: string) => T | undefined, ms?: number): Promise<T>;
  /** Stops the server (SIGTERM) and resolves with its exit code. */
  stop(): Promise<number | null>;
  /** Resolves with the exit code once the server has exited, however that came about. */
  exited: Promise<number | null>;
};

/**
 * Starts a server entry as its own process, as `npm start` or the desktop shell does. The
 * environment is the test's without any `BIF_*` or `PORT` variable, plus `env`. `stdin: 'pipe'`
 * gives the server a standard input the test writes to (`child.stdin`), as the desktop shell does.
 */
export function startServer(args: string[], opts: { cwd: string; env?: Record<string, string>; stdin?: 'pipe' }): ServerProcess {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BIF_') && k !== 'PORT'));
  const child = spawn(process.execPath, args, { cwd: opts.cwd, env: { ...base, NODE_NO_WARNINGS: '1', ...opts.env }, stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const watchers = new Set<() => void>();
  let pending = '';
  const take = (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    lines.push(...parts);
    for (const w of watchers) w();
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  const exited = new Promise<number | null>((ok) => child.once('exit', (code) => ok(code)));
  void exited.then(() => {
    for (const w of watchers) w();
  });
  return {
    child,
    lines,
    exited,
    waitFor<T>(pick: (line: string) => T | undefined, ms = 20_000): Promise<T> {
      return new Promise<T>((ok, fail) => {
        let seen = 0;
        const done = (f: () => void) => {
          clearTimeout(timer);
          watchers.delete(check);
          f();
        };
        const check = () => {
          for (; seen < lines.length; seen++) {
            const hit = pick(lines[seen]!);
            if (hit !== undefined) return done(() => ok(hit));
          }
          if (child.exitCode !== null || child.signalCode !== null) done(() => fail(new Error(`the server exited before the line came:\n${lines.join('\n')}`)));
        };
        const timer = setTimeout(() => done(() => fail(new Error(`no such line within ${ms} ms:\n${lines.join('\n')}`))), ms);
        watchers.add(check);
        check();
      });
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

/** Every file and folder under `dir`, as sorted relative paths. */
export function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

/** Every file under `dir` with its size and the time it was last written: equal before and after means nothing was written. */
export function fingerprint(dir: string): string[] {
  return listing(dir).map((p) => {
    const s = statSync(join(dir, p));
    return s.isDirectory() ? `${p}/` : `${p} ${s.size} ${s.mtimeMs}`;
  });
}
