import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { dirname, resolve, win32 } from 'node:path';

/**
 * Process and file operations that differ between POSIX and Windows (design 2026-11-16 §5). Each
 * function switches on the platform; the POSIX branches are the code the harness used before this
 * module existed, moved here unchanged. Every Windows branch takes its platform, command runner and
 * file checks from `PlatformDeps`, so tests drive it on any OS.
 */

/** Runs a command to completion: exit status (null when it could not run or timed out) and stdout. */
export type RunSync = (cmd: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string };

export type PlatformDeps = {
  platform: NodeJS.Platform;
  run: RunSync;
  /** True while a process with this pid exists. */
  alive: (pid: number) => boolean;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  readText: (path: string) => string;
  /** Node executable used for `.js` commands and npm shims without their own `node.exe`. */
  execPath: string;
  now: () => number;
  /** Seconds since boot. */
  uptime: () => number;
};

const runSync: RunSync = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const defaultDeps: PlatformDeps = {
  platform: process.platform,
  run: runSync,
  alive: pidAlive,
  env: process.env,
  exists: existsSync,
  readText: (p) => readFileSync(p, 'utf8'),
  execPath: process.execPath,
  now: () => Date.now(),
  uptime,
};

const depsOf = (d?: Partial<PlatformDeps>): PlatformDeps => (d ? { ...defaultDeps, ...d } : defaultDeps);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Windows process information ---------------------------------------------------------------------

/** One row of the Windows process table. `created` is an ISO-8601 UTC time with sub-second digits. */
export type WinProcess = { pid: number; ppid: number; created: string };

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const ROW = "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }";

function parseRows(stdout: string): WinProcess[] {
  const rows: WinProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\S+)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3]! });
  }
  return rows;
}

/** Every process on the machine (Win32_Process), or `[]` when the table cannot be read. */
export function winProcesses(d?: Partial<PlatformDeps>): WinProcess[] {
  const { run } = depsOf(d);
  const r = run('powershell.exe', [...PS, `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ${ROW}`], 15_000);
  return r.status === 0 ? parseRows(r.stdout) : [];
}

/**
 * Processes started by `rootPid` (started at `rootStartedAt`), directly or further down, that are
 * still running, even when `rootPid` itself has exited (Windows keeps the parent id of an orphan).
 * A child counts only when it started after its parent, so a recycled pid never adopts strangers.
 */
export function winDescendants(rows: WinProcess[], rootPid: number, rootStartedAt: string, rootReusedAt = Infinity): WinProcess[] {
  const out: WinProcess[] = [];
  const queue: Array<{ pid: number; created: string }> = [{ pid: rootPid, created: rootStartedAt }];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const parent = queue.shift()!;
    const since = Date.parse(parent.created);
    // Children of a process that now holds the root's pid started after it took the pid.
    const until = parent.pid === rootPid ? rootReusedAt : Infinity;
    for (const p of rows) {
      const created = Date.parse(p.created);
      if (p.ppid !== parent.pid || seen.has(p.pid) || !(created >= since) || !(created < until)) continue;
      seen.add(p.pid);
      out.push(p);
      queue.push(p);
    }
  }
  return out;
}

/**
 * Windows: true when a process created at `created` is the one recorded as started at `startedAt`.
 * The recorded time is either its creation time (`processStartTime`) or the time taken just before it
 * was spawned (`startTimeOf`), so a creation time from just before it to a few seconds after matches.
 */
export function sameStart(created: string, startedAt: string): boolean {
  const c = Date.parse(created);
  const s = Date.parse(startedAt);
  return c >= s - 1000 && c <= s + 5000;
}

/**
 * The pids of `pid`'s tree to stop: `pid` itself when it is the process started at `startedAt` (or,
 * without `startedAt`, whatever runs under that pid), and what it started that still runs.
 */
export function winTree(rows: WinProcess[], pid: number, startedAt?: string): number[] {
  const self = rows.find((p) => p.pid === pid);
  const since = startedAt ?? self?.created;
  if (!since) return [];
  const selfOurs = !!self && sameStart(self.created, since);
  const reusedAt = self && !selfOurs ? Date.parse(self.created) : Infinity;
  return [...(selfOurs ? [pid] : []), ...winDescendants(rows, pid, since, reusedAt).map((p) => p.pid)];
}

/** `winTree` from the live process table; when the table cannot be read, `pid` alone if it runs. */
function winTargets(pid: number, startedAt: string | undefined, deps: PlatformDeps): number[] {
  const rows = winProcesses(deps);
  if (rows.length) return winTree(rows, pid, startedAt);
  return deps.alive(pid) ? [pid] : [];
}

// --- start time and ownership --------------------------------------------------------------------------

/**
 * Start time of a live process, or `undefined` when the process does not exist or it cannot be read.
 * POSIX: as printed by `ps -o lstart=` (e.g. `Thu Nov 12 22:00:36 2026`). Windows: its creation time
 * from Win32_Process as ISO-8601 UTC (e.g. `2026-11-16T20:59:52.1171790Z`).
 */
export function processStartTime(pid: number, d?: Partial<PlatformDeps>): string | undefined {
  const deps = depsOf(d);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (deps.platform === 'win32') {
    const r = deps.run('powershell.exe', [...PS, `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ${ROW}`], 15_000);
    if (r.status !== 0) return undefined;
    return parseRows(r.stdout).find((p) => p.pid === pid)?.created;
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      // Fixed locale: the recorded and the re-read start time must use the same format.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out ? out.replace(/\s+/g, ' ') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The start time to record for process `pid`, spawned just after `spawnedAt` (`Date.now()` taken right
 * before the spawn). POSIX: `processStartTime(pid)`. Windows: `spawnedAt` as ISO-8601, a lower bound of
 * its creation time: reading the real one starts PowerShell (about 300 ms), by when a short-lived CLI may
 * be gone, and it would block the server meanwhile. `isOurProcess` and `stopTree` accept it (`sameStart`).
 */
export function startTimeOf(pid: number, spawnedAt: number, d?: Partial<PlatformDeps>): string | undefined {
  const deps = depsOf(d);
  if (deps.platform === 'win32') return Number.isInteger(pid) && pid > 0 ? new Date(spawnedAt).toISOString() : undefined;
  return processStartTime(pid, deps);
}

/** POSIX: true while any process in group `pgid` exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Decides whether `pid` is still the CLI we spawned (started at `startedAt`), with what it started:
 * - the start time must be known and after the last boot (a reboot recycles pids);
 * - POSIX: if the group leader is alive, its start time must match; if the leader is gone but the
 *   group lives on, the pgid cannot have been reused (a pid is not reassigned while a process group
 *   with that id exists), so the group is ours;
 * - Windows: if the process is alive, its creation time must match (`sameStart`); if it is gone,
 *   processes it started (parent id = pid, started after `startedAt`) that still run are ours.
 * A reason of exactly 'process group is gone' means there is nothing left to stop.
 */
export function isOurProcess(pid: number, startedAt: string | undefined, d?: Partial<PlatformDeps>): { ours: boolean; reason: string } {
  const deps = depsOf(d);
  if (!startedAt) return { ours: false, reason: 'no recorded start time' };
  const started = Date.parse(startedAt);
  const bootedAt = deps.now() - deps.uptime() * 1000;
  if (!Number.isFinite(started)) return { ours: false, reason: `unparseable start time '${startedAt}'` };
  // lstart has 1 s resolution; allow a little slack against the boot estimate.
  if (started < bootedAt - 5000) return { ours: false, reason: 'process started before the last boot' };
  if (deps.platform === 'win32') {
    const rows = winProcesses(deps);
    const self = rows.find((p) => p.pid === pid);
    if (self) {
      if (!sameStart(self.created, startedAt)) return { ours: false, reason: `pid ${pid} now belongs to another process (started ${self.created})` };
      return { ours: true, reason: 'leader start time matches' };
    }
    if (winDescendants(rows, pid, startedAt).length) return { ours: true, reason: 'leader gone, processes it started still alive' };
    return { ours: false, reason: 'process group is gone' };
  }
  if (!groupAlive(pid)) return { ours: false, reason: 'process group is gone' };
  const leader = processStartTime(pid);
  if (leader !== undefined && leader !== startedAt) {
    return { ours: false, reason: `pid ${pid} now belongs to another process (started ${leader})` };
  }
  return { ours: true, reason: leader ? 'leader start time matches' : 'leader gone, group still alive' };
}

// --- stopping a process and everything it started --------------------------------------------------

/** `taskkill` over a set of pids, each with its tree; `/F` forces. */
function taskkill(pids: number[], force: boolean, deps: PlatformDeps): void {
  if (!pids.length) return;
  deps.run('taskkill.exe', [...(force ? ['/F'] : []), '/T', ...pids.flatMap((p) => ['/PID', String(p)])], 15_000);
}

/**
 * Sends `sig` to the process tree of `pid`. POSIX: to its process group (the CLI is spawned as a group
 * leader). Windows: `taskkill /T`, with `/F` for SIGKILL. Without a pid, signals `child` alone.
 * Never throws.
 */
export function signalTree(
  pid: number | undefined,
  sig: NodeJS.Signals,
  child?: { kill(sig: NodeJS.Signals): boolean },
  d?: Partial<PlatformDeps>,
): void {
  const deps = depsOf(d);
  if (pid !== undefined && deps.platform === 'win32') {
    taskkill([pid], sig === 'SIGKILL', deps);
    return;
  }
  try {
    if (pid !== undefined && deps.platform !== 'win32') process.kill(-pid, sig);
    else child?.kill(sig);
  } catch {
    // already gone
  }
}

/**
 * Kills the tree of `pid` at once (SIGKILL), synchronously, so it can run in an exit handler.
 * POSIX: `process.kill(-pid, 'SIGKILL')`, throwing as `process.kill` does (callers tell ESRCH apart).
 * Windows: `taskkill /F /T` on `pid` (when it is still the process started at `startedAt`) and on
 * what it started that outlived it.
 */
export function killTreeNow(pid: number, startedAt?: string, d?: Partial<PlatformDeps>): void {
  const deps = depsOf(d);
  if (deps.platform !== 'win32') {
    process.kill(-pid, 'SIGKILL');
    return;
  }
  taskkill(winTargets(pid, startedAt, deps), true, deps);
}

async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

async function waitPidsGone(pids: number[], ms: number, deps: PlatformDeps): Promise<boolean> {
  const deadline = deps.now() + ms;
  for (;;) {
    if (!pids.some((p) => deps.alive(p))) return true;
    if (deps.now() >= deadline) return false;
    await sleep(50);
  }
}

/**
 * Terminates every remaining process of the CLI's tree, politely first: stop, wait up to `graceMs`,
 * then force and confirm. POSIX: only if the process group still exists (avoids signalling a recycled
 * pgid); SIGTERM, then SIGKILL. Windows: the process and what it started (found by parent id and start
 * time, also after it exited; `startedAt` is its recorded start time), `taskkill /T`, then `/F /T`.
 */
export async function stopTree(pid: number | undefined, graceMs: number, startedAt?: string, d?: Partial<PlatformDeps>): Promise<void> {
  const deps = depsOf(d);
  if (pid === undefined) return;
  if (deps.platform === 'win32') {
    const pids = winTargets(pid, startedAt, deps);
    if (!pids.length) return;
    taskkill(pids, false, deps);
    if (await waitPidsGone(pids, graceMs, deps)) return;
    taskkill(pids.filter((p) => deps.alive(p)), true, deps);
    if (!(await waitPidsGone(pids, 5000, deps))) console.warn(`[bif] processes of ${pid} still present after taskkill /F`);
    return;
  }
  if (!groupAlive(pid)) return;
  signalTree(pid, 'SIGTERM', undefined, deps);
  if (await waitGroupGone(pid, graceMs)) return;
  signalTree(pid, 'SIGKILL', undefined, deps);
  if (!(await waitGroupGone(pid, 5000))) {
    console.warn(`[bif] process group ${pid} still present after SIGKILL`);
  }
}

// --- the Codex login link ------------------------------------------------------------------------------

export type LinkFs = {
  linkSync: typeof linkSync;
  symlinkSync: typeof symlinkSync;
  copyFileSync: typeof copyFileSync;
};
const realLinkFs: LinkFs = { linkSync, symlinkSync, copyFileSync };

const sameFile = (a: string, b: string): boolean => {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
};

/**
 * Points `path` at the user's `target` (the Codex `auth.json`), so a CLI that refreshes credentials
 * in place writes them to the user's own file. A missing target removes `path`. The link (or copy) is
 * made under a temp name and renamed into place, so concurrent runs never write through an existing
 * link onto the target.
 * POSIX: a symlink; a copy when symlinks are unavailable.
 * Windows: a hard link (symlinks need administrator rights or developer mode), which works when both
 * are on one volume; else a copy, which `syncLoginBack` returns to the user after the run.
 */
export function linkLogin(path: string, target: string, d?: Partial<PlatformDeps>, fs: LinkFs = realLinkFs): void {
  const deps = depsOf(d);
  mkdirSync(dirname(path), { recursive: true });
  if (deps.platform === 'win32') {
    if (!existsSync(target)) {
      rmSync(path, { force: true });
      return;
    }
    if (sameFile(path, target)) return;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.linkSync(target, tmp);
    } catch {
      fs.copyFileSync(target, tmp);
    }
    try {
      renameSync(tmp, path);
    } catch {
      // `path` is open in a running CLI (Windows refuses to replace it): write the login in place.
      rmSync(tmp, { force: true });
      fs.copyFileSync(target, path);
    }
    return;
  }
  let current: string | null | undefined; // link target, null = regular file, undefined = absent
  try {
    current = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    current = undefined;
  }
  if (!existsSync(target)) {
    if (current !== undefined) rmSync(path, { force: true });
    return;
  }
  if (current === target) return;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.symlinkSync(target, tmp);
  } catch {
    fs.copyFileSync(target, tmp);
  }
  renameSync(tmp, path);
}

/**
 * After a run, Windows only: when `path` is no longer the user's `target` (a copy across volumes, or a
 * CLI that replaced the file instead of writing it in place) and the CLI changed it after the user's
 * file was last written, its content is written back to `target`, so a refreshed login is not lost.
 * Returns whether it copied. POSIX: nothing (the symlink is the user's file).
 */
export function syncLoginBack(path: string, target: string, d?: Partial<PlatformDeps>): boolean {
  if (depsOf(d).platform !== 'win32') return false;
  try {
    if (!existsSync(path) || !existsSync(target) || sameFile(path, target)) return false;
    if (statSync(path).mtimeMs <= statSync(target).mtimeMs) return false;
    const ours = readFileSync(path);
    if (ours.equals(readFileSync(target))) return false;
    copyFileSync(path, target);
    return true;
  } catch (e) {
    console.warn(`[bif] could not return the refreshed login to ${target}: ${(e as Error).message}`);
    return false;
  }
}

// --- starting a command -------------------------------------------------------------------------------

/** How to start a command: executable, arguments and the spawn options that go with them. */
export type Launch = { cmd: string; args: string[]; windowsVerbatimArguments?: boolean };

const envGet = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

/** Windows: the file `name` names, searched on PATH with PATHEXT like the shell does; undefined if none. */
export function resolveWinCommand(name: string, deps: PlatformDeps): string | undefined {
  const exts = (envGet(deps.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasExt = win32.extname(name) !== '';
  const candidates = (base: string) => [...(hasExt ? [base] : []), ...exts.map((e) => base + e)];
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) return candidates(win32.resolve(name)).find((p) => deps.exists(p));
  const dirs = (envGet(deps.env, 'PATH') ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(win32.join(dir.replace(/^"(.*)"$/, '$1'), name)).find((p) => deps.exists(p));
    if (hit) return hit;
  }
  return undefined;
}

const SCRIPT = /\.(?:c|m)?js$/i;

/**
 * The program an npm-style shim (`.cmd` or `.ps1`, written by cmd-shim) starts: a script run by
 * node, or a native executable. Undefined when the file is not such a shim.
 */
export function shimTarget(shimPath: string, deps: PlatformDeps): Launch | undefined {
  let text: string;
  try {
    text = deps.readText(shimPath);
  } catch {
    return undefined;
  }
  const dir = win32.dirname(shimPath);
  const isPs1 = /\.ps1$/i.test(shimPath);
  // Only cmd-shim's own forms: `"%dp0%\<path>"` in a .cmd, `"$basedir/<path>"` in a .ps1.
  const quoted = isPs1 ? /"\$basedir\/([^"$]+)"/g : /"%dp0%\\([^"%]+)"/g;
  const targets = [...text.matchAll(quoted)].map((m) => m[1]!).filter((t) => !/^node(?:\.exe)?$/i.test(t));
  const rel = targets.at(-1);
  if (!rel) return undefined;
  const target = win32.resolve(dir, rel);
  if (!deps.exists(target)) return undefined;
  if (/\.(?:exe|com)$/i.test(target)) return { cmd: target, args: [] };
  if (!SCRIPT.test(target) && win32.extname(target) !== '') return undefined;
  const ownNode = win32.join(dir, 'node.exe');
  const node = deps.exists(ownNode) ? ownNode : (resolveWinCommand('node', deps) ?? deps.execPath);
  return { cmd: node, args: [target] };
}

/** cmd.exe metacharacters (as escaped by cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for `cmd.exe /d /s /c "…"` running a batch file (metacharacters escaped twice). */
export function quoteForCmd(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** cmd.exe stops a command line at a line break and refuses lines over 8191 characters. */
const CMD_LINE_MAX = 8000;

/**
 * How to start CLI `name` with `args` without a shell interpreting either.
 * POSIX: unchanged. Windows (where the CLIs are often `.cmd` / `.ps1` shims, which cannot be started
 * directly): a native executable as is; an npm shim resolved to the program it starts (node and the
 * script, or the executable); a `.js` / `.mjs` / `.cjs` file run by node; any other batch file
 * through `cmd.exe` with every argument quoted and escaped, refused when an argument holds a line
 * break or the line would be too long (prompts never go through a shell); anything else unchanged.
 */
export function commandFor(name: string, args: string[], d?: Partial<PlatformDeps>): Launch {
  const deps = depsOf(d);
  if (deps.platform !== 'win32') return { cmd: name, args };
  const file = resolveWinCommand(name, deps);
  if (!file) return { cmd: name, args };
  const ext = win32.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { cmd: file, args };
  if (SCRIPT.test(file)) return { cmd: deps.execPath, args: [file, ...args] };
  if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
    const shim = shimTarget(file, deps);
    if (shim) return { cmd: shim.cmd, args: [...shim.args, ...args] };
    if (ext === '.ps1') throw new Error(`cannot start ${file} safely: point the command at the program it runs`);
    if (args.some((a) => /[\r\n\0]/.test(a))) {
      throw new Error(`cannot start ${file} through cmd.exe: an argument contains a line break; point the command at the program it runs`);
    }
    const line = [file.replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ');
    if (line.length > CMD_LINE_MAX) throw new Error(`cannot start ${file} through cmd.exe: the command line is too long`);
    return { cmd: envGet(deps.env, 'COMSPEC') ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { cmd: file, args };
}

// --- the environment of a started command -------------------------------------------------------------

/**
 * The variables that make the desktop app's own program run as plain Node. The desktop shell sets
 * them for the server (`desktop/environment.ts`); they mean something to that program only.
 */
export const RUN_AS_NODE_VARS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'] as const;

/**
 * The environment for a process the server starts with `cmd` (the program actually started: `Launch.cmd`).
 * It is the server's own (`base`) without `RUN_AS_NODE_VARS`, so an agent CLI, and every Electron
 * program an agent starts, runs as itself and not as Node. One exception: when `cmd` is the program
 * the server itself runs on, the variables stay as the server has them, because that program needs
 * them to run a script at all (the research browser the app ships; on Windows also a CLI that is a
 * script and has no Node of its own, see `commandFor`). A server on plain Node (a checkout) has
 * neither variable, and its children get what they always got. `base` is not changed.
 */
export function childEnv(
  cmd: string,
  base: NodeJS.ProcessEnv = process.env,
  d?: Partial<Pick<PlatformDeps, 'execPath' | 'platform'>>,
): NodeJS.ProcessEnv {
  const { execPath, platform } = depsOf(d);
  const isWin = platform === 'win32';
  const same = isWin ? win32.resolve(cmd).toLowerCase() === win32.resolve(execPath).toLowerCase() : resolve(cmd) === resolve(execPath);
  if (same) return { ...base };
  const dropped: readonly string[] = RUN_AS_NODE_VARS;
  // Windows: a variable's name is the same in any case.
  return Object.fromEntries(Object.entries(base).filter(([name]) => !dropped.includes(isWin ? name.toUpperCase() : name)));
}
