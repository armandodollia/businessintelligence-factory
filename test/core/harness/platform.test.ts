import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  childEnv,
  commandFor,
  isOurProcess,
  killTreeNow,
  linkLogin,
  processStartTime,
  quoteForCmd,
  sameStart,
  signalTree,
  startTimeOf,
  stopTree,
  syncLoginBack,
  winDescendants,
  winProcesses,
  winTree,
  type PlatformDeps,
  type RunSync,
  type WinProcess,
} from '../../../src/core/harness/platform.js';

const isWin = process.platform === 'win32';

/** A Windows machine as the tests see it: files, a process table, live pids, recorded commands. */
function fakeWin(opts: { files?: Record<string, string>; rows?: WinProcess[]; alive?: Set<number>; path?: string; now?: number } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const alive = opts.alive ?? new Set<number>();
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const rowText = (rows: WinProcess[]) => rows.map((r) => `${r.pid} ${r.ppid} ${r.created}`).join('\r\n');
  const run: RunSync = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'powershell.exe') {
      const script = args.at(-1)!;
      const one = /ProcessId=(\d+)/.exec(script);
      const rows = (opts.rows ?? []).filter((r) => alive.has(r.pid) && (!one || r.pid === Number(one[1])));
      return { status: 0, stdout: rowText(rows) };
    }
    if (cmd === 'taskkill.exe') {
      const force = args.includes('/F');
      args.forEach((a, i) => {
        if (args[i - 1] === '/PID' && force) alive.delete(Number(a));
      });
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const deps: Partial<PlatformDeps> = {
    platform: 'win32',
    run,
    alive: (pid) => alive.has(pid),
    env: { Path: opts.path ?? 'C:\\tools;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: (p) => files.has(p.toLowerCase()),
    readText: (p) => {
      const t = files.get(p.toLowerCase());
      if (t === undefined) throw new Error('ENOENT');
      return t;
    },
    execPath: 'C:\\nodejs\\node.exe',
    now: () => opts.now ?? Date.parse('2026-11-16T12:00:00Z'),
    uptime: () => 3600,
  };
  return { deps, calls, alive };
}

/** cmd-shim's `.cmd` for a package script (as npm writes it). */
const NPM_CMD = (rel: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n` +
  `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;
/** cmd-shim's `.ps1`. */
const NPM_PS1 = (rel: string) =>
  `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=""\n` +
  `if (Test-Path "$basedir/node$exe") {\n  & "$basedir/node$exe"  "$basedir/${rel}" $args\n} else {\n  & "node$exe"  "$basedir/${rel}" $args\n}\n`;

describe('commandFor', () => {
  it('POSIX: the command and arguments are passed through unchanged', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(commandFor('claude', ['-p', 'a & b'], { platform })).toEqual({ cmd: 'claude', args: ['-p', 'a & b'] });
    }
  });

  it('Windows: a native executable on PATH is started directly, found with PATHEXT', () => {
    const { deps } = fakeWin({ files: { 'C:\\nodejs\\codex.exe': '' } });
    expect(commandFor('codex', ['exec', 'x'], deps)).toEqual({ cmd: 'C:\\nodejs\\codex.exe', args: ['exec', 'x'] });
    // The first PATH directory wins, as in the shell.
    const two = fakeWin({ files: { 'C:\\tools\\codex.cmd': NPM_CMD('codex.exe'), 'C:\\tools\\codex.exe': '', 'C:\\nodejs\\codex.exe': '' } });
    expect(commandFor('codex', [], two.deps).cmd).toBe('C:\\tools\\codex.exe');
  });

  it('Windows: an npm .cmd shim is resolved to node and its script, with its own node.exe when it has one', () => {
    const script = 'C:\\nodejs\\node_modules\\opencode-ai\\bin\\opencode';
    const { deps } = fakeWin({ files: { 'C:\\nodejs\\opencode.cmd': NPM_CMD('node_modules\\opencode-ai\\bin\\opencode'), [script]: '' } });
    // No node.exe beside the shim: the node on PATH is not there either, so the running node.
    expect(commandFor('opencode', ['run', 'a "quoted" & piped | prompt'], deps)).toEqual({
      cmd: 'C:\\nodejs\\node.exe', args: [script, 'run', 'a "quoted" & piped | prompt'],
    });
    const own = fakeWin({
      files: {
        'C:\\tools\\npx.cmd': NPM_CMD('node_modules\\npm\\bin\\npx-cli.js'),
        'C:\\tools\\node_modules\\npm\\bin\\npx-cli.js': '',
        'C:\\tools\\node.exe': '',
      },
    });
    expect(commandFor('npx', ['@playwright/mcp@0.0.41', '--port', '1'], own.deps)).toEqual({
      cmd: 'C:\\tools\\node.exe', args: ['C:\\tools\\node_modules\\npm\\bin\\npx-cli.js', '@playwright/mcp@0.0.41', '--port', '1'],
    });
  });

  it('Windows: a shim of a native executable starts the executable', () => {
    const exe = 'C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.exe';
    const { deps } = fakeWin({ files: { 'C:\\tools\\codex.cmd': NPM_CMD('node_modules\\@openai\\codex\\bin\\codex.exe'), [exe]: '' } });
    expect(commandFor('codex', ['exec'], deps)).toEqual({ cmd: exe, args: ['exec'] });
  });

  it('Windows: a .ps1 shim is resolved the same way; one that is not a shim is refused', () => {
    const script = 'C:\\tools\\node_modules\\x\\cli.js';
    const { deps } = fakeWin({ files: { 'C:\\tools\\x.ps1': NPM_PS1('node_modules/x/cli.js'), [script]: '' } });
    expect(commandFor('C:\\tools\\x.ps1', ['a'], deps)).toEqual({ cmd: 'C:\\nodejs\\node.exe', args: [win32.resolve(script), 'a'] });
    const plain = fakeWin({ files: { 'C:\\tools\\y.ps1': 'Write-Output $args' } });
    expect(() => commandFor('C:\\tools\\y.ps1', ['a'], plain.deps)).toThrow(/cannot start .*y\.ps1 safely/);
  });

  it('Windows: a .js / .mjs file is run by node (Windows would open it with the script host)', () => {
    const { deps } = fakeWin({ files: { 'D:\\fixtures\\fake-cli.mjs': '' } });
    expect(commandFor('D:\\fixtures\\fake-cli.mjs', ['-p', 'x'], deps)).toEqual({ cmd: 'C:\\nodejs\\node.exe', args: ['D:\\fixtures\\fake-cli.mjs', '-p', 'x'] });
  });

  it('Windows: another batch file goes through cmd.exe with every argument quoted and escaped', () => {
    const { deps } = fakeWin({ files: { 'C:\\tools\\tool.bat': '@echo %*' } });
    const launch = commandFor('tool', ['plain', 'a & calc', '%PATH%', 'say "hi"', 'x|y', ''], deps);
    expect(launch.cmd).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = launch.args[3]!;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // No metacharacter reaches cmd.exe unescaped: each is preceded by a caret.
    const inner = line.slice(1, -1);
    for (const m of inner.matchAll(/[&|%"<>]/g)) expect(inner[m.index! - 1]).toBe('^');
  });

  it('Windows: a prompt with a line break or a too long line is refused rather than passed through cmd.exe', () => {
    const { deps } = fakeWin({ files: { 'C:\\tools\\tool.cmd': '@echo %*' } });
    expect(() => commandFor('tool', ['-p', 'line one\nline two'], deps)).toThrow(/line break/);
    expect(() => commandFor('tool', ['-p', 'x'.repeat(9000)], deps)).toThrow(/too long/);
  });

  it('Windows: a command that is not found is left as it is (the spawn reports it)', () => {
    const { deps } = fakeWin();
    expect(commandFor('nope', ['a'], deps)).toEqual({ cmd: 'nope', args: ['a'] });
  });

  it('quoteForCmd escapes metacharacters twice (the batch file re-reads its arguments)', () => {
    expect(quoteForCmd('a&b')).toBe('^^^"a^^^&b^^^"');
    expect(quoteForCmd('c:\\dir\\')).toBe('^^^"c:\\dir\\\\^^^"');
  });
});

describe('childEnv: the environment of a process the server starts', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/t', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' };
  const self = '/Applications/App.app/Contents/MacOS/App';

  it('another program does not get the two variables that make the app\'s own program run as Node; the rest is kept', () => {
    expect(childEnv('/usr/local/bin/claude', base, { execPath: self, platform: 'darwin' })).toEqual({ PATH: '/usr/bin', HOME: '/home/t' });
    expect(childEnv('npx', base, { execPath: self, platform: 'linux' })).toEqual({ PATH: '/usr/bin', HOME: '/home/t' });
    // The server's own environment is not changed.
    expect(base).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' });
  });

  it('the server\'s own program (the shipped research browser, a script started with it) keeps them', () => {
    expect(childEnv(self, base, { execPath: self, platform: 'darwin' })).toEqual(base);
    // And gets none it did not have: a server on plain Node starts its children as before.
    expect(childEnv('/usr/bin/node', { PATH: '/usr/bin' }, { execPath: '/usr/bin/node', platform: 'linux' })).toEqual({ PATH: '/usr/bin' });
  });

  it('Windows: names in any case, and the program compared as Windows compares paths', () => {
    const win = { Path: 'C:\\Windows', electron_run_as_node: '1', Electron_No_Asar: '1' };
    const app = 'C:\\Program Files\\App\\App.exe';
    expect(childEnv('C:\\tools\\claude.exe', win, { execPath: app, platform: 'win32' })).toEqual({ Path: 'C:\\Windows' });
    expect(childEnv('c:\\program files\\app\\APP.EXE', win, { execPath: app, platform: 'win32' })).toEqual(win);
    // Elsewhere a name in another case is another variable.
    expect(childEnv('/bin/x', { electron_run_as_node: '1' }, { execPath: self, platform: 'linux' })).toEqual({ electron_run_as_node: '1' });
  });
});

describe('Windows process tree (injected process table)', () => {
  const T = (s: number) => new Date(Date.parse('2026-11-16T11:00:00Z') + s * 1000).toISOString();
  const rows: WinProcess[] = [
    { pid: 100, ppid: 1, created: T(0) }, // the CLI
    { pid: 101, ppid: 100, created: T(1) }, // an MCP server it started
    { pid: 102, ppid: 101, created: T(2) }, // a browser the MCP server started
    { pid: 103, ppid: 100, created: T(-60) }, // claims pid 100 as parent but is older: not ours
    { pid: 200, ppid: 9, created: T(3) }, // unrelated
  ];

  it('winDescendants follows parent ids, also after the root exited, and never adopts older processes', () => {
    expect(winDescendants(rows, 100, T(0)).map((p) => p.pid)).toEqual([101, 102]);
    expect(winTree(rows, 100, T(0))).toEqual([100, 101, 102]);
    const rootGone = rows.filter((r) => r.pid !== 100);
    expect(winTree(rootGone, 100, T(0))).toEqual([101, 102]);
  });

  it('a pid now held by another process: neither it nor its own children are ours, orphans of ours are', () => {
    const reused = [...rows.filter((r) => r.pid !== 100), { pid: 100, ppid: 1, created: T(30) }, { pid: 104, ppid: 100, created: T(31) }];
    expect(winTree(reused, 100, T(0))).toEqual([101, 102]);
  });

  it('sameStart accepts the recorded spawn time (a lower bound) and the exact creation time', () => {
    expect(sameStart(T(0.2), T(0))).toBe(true);
    expect(sameStart(T(0), T(0))).toBe(true);
    expect(sameStart(T(30), T(0))).toBe(false);
    expect(sameStart(T(-5), T(0))).toBe(false);
  });

  it('isOurProcess: start time, last boot, live or gone root', () => {
    const now = Date.parse(T(10));
    const all = new Set(rows.map((r) => r.pid));
    const live = fakeWin({ rows, alive: new Set(all), now });
    expect(isOurProcess(100, T(0), live.deps)).toEqual({ ours: true, reason: 'leader start time matches' });
    expect(isOurProcess(100, T(-40), live.deps).ours).toBe(false);
    expect(isOurProcess(100, undefined, live.deps)).toEqual({ ours: false, reason: 'no recorded start time' });
    expect(isOurProcess(100, 'garbage', live.deps).reason).toMatch(/unparseable/);
    // Uptime 3600 s: a start two hours ago is from before the last boot.
    expect(isOurProcess(100, T(-7200), live.deps)).toEqual({ ours: false, reason: 'process started before the last boot' });
    const orphaned = fakeWin({ rows, alive: new Set([101, 102, 200]), now });
    expect(isOurProcess(100, T(0), orphaned.deps)).toEqual({ ours: true, reason: 'leader gone, processes it started still alive' });
    const gone = fakeWin({ rows, alive: new Set([200]), now });
    expect(isOurProcess(100, T(0), gone.deps)).toEqual({ ours: false, reason: 'process group is gone' });
  });

  it('stopTree: taskkill /T first; after the grace, /F /T on what is left; nothing when nothing is left', async () => {
    const w = fakeWin({ rows, alive: new Set([101, 102, 200]) });
    await stopTree(100, 60, T(0), { ...w.deps, now: () => Date.now() });
    const kills = w.calls.filter((c) => c.cmd === 'taskkill.exe').map((c) => c.args.join(' '));
    expect(kills).toEqual(['/T /PID 101 /PID 102', '/F /T /PID 101 /PID 102']);
    expect([...w.alive]).toEqual([200]);
    const none = fakeWin({ rows, alive: new Set([200]) });
    await stopTree(100, 60, T(0), none.deps);
    expect(none.calls.filter((c) => c.cmd === 'taskkill.exe')).toEqual([]);
  });

  it('stopTree: when the process table cannot be read, the live root alone is stopped', async () => {
    const w = fakeWin({ alive: new Set([100]) });
    const deps = { ...w.deps, run: ((cmd, args) => (cmd === 'powershell.exe' ? { status: null, stdout: '' } : w.deps.run!(cmd, args, 0))) as RunSync };
    await stopTree(100, 60, T(0), { ...deps, now: () => Date.now() });
    expect(w.calls.map((c) => c.args.join(' '))).toEqual(['/T /PID 100', '/F /T /PID 100']);
  });

  it('signalTree and killTreeNow use taskkill (/F for SIGKILL)', () => {
    const w = fakeWin({ rows, alive: new Set([100, 101, 102]) });
    signalTree(100, 'SIGTERM', undefined, w.deps);
    signalTree(100, 'SIGKILL', undefined, w.deps);
    killTreeNow(100, T(0), fakeWin({ rows, alive: w.alive }).deps);
    expect(w.calls.filter((c) => c.cmd === 'taskkill.exe').map((c) => c.args.join(' '))).toEqual(['/T /PID 100', '/F /T /PID 100']);
  });

  it('processStartTime reads the creation time; startTimeOf records the spawn time on Windows', () => {
    const w = fakeWin({ rows, alive: new Set([100]) });
    expect(processStartTime(100, w.deps)).toBe(T(0));
    expect(processStartTime(555, w.deps)).toBeUndefined();
    expect(w.calls[0]!.args.at(-1)).toMatch(/ProcessId=100/);
    expect(startTimeOf(100, Date.parse(T(5)), w.deps)).toBe(T(5));
    expect(startTimeOf(0, Date.parse(T(5)), w.deps)).toBeUndefined();
  });
});

describe('the Codex login link', () => {
  const dirs: string[] = [];
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), 'bif-login-'));
    dirs.push(d);
    mkdirSync(join(d, 'user'));
    writeFileSync(join(d, 'user', 'auth.json'), '{"v":1}');
    return { target: join(d, 'user', 'auth.json'), path: join(d, 'home', 'auth.json') };
  };
  afterEach(() => void dirs.splice(0));

  it('Windows: a hard link to the user file on one volume; writes in place reach the user', () => {
    const { target, path } = fresh();
    linkLogin(path, target, { platform: 'win32' });
    expect(statSync(path).ino).toBe(statSync(target).ino);
    linkLogin(path, target, { platform: 'win32' }); // idempotent
    expect(statSync(target).nlink).toBe(2);
    writeFileSync(path, '{"v":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    expect(syncLoginBack(path, target, { platform: 'win32' })).toBe(false); // same file: nothing to return
  });

  it('Windows: across volumes a copy, written back after the run only when the CLI changed it', () => {
    const { target, path } = fresh();
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    const noLinks = { linkSync: () => { throw exdev; }, symlinkSync: () => { throw exdev; }, copyFileSync: (a: string, b: string) => writeFileSync(b, readFileSync(a)) } as never;
    linkLogin(path, target, { platform: 'win32' }, noLinks);
    expect(statSync(path).ino).not.toBe(statSync(target).ino);
    expect(readFileSync(path, 'utf8')).toBe('{"v":1}');
    expect(syncLoginBack(path, target, { platform: 'win32' })).toBe(false); // unchanged
    // The CLI refreshed its login: newer and different, so it goes back to the user.
    writeFileSync(path, '{"v":2}');
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(syncLoginBack(path, target, { platform: 'win32' })).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    // The user signed in again since: their newer file is never overwritten.
    writeFileSync(path, '{"v":3}');
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(path, earlier, earlier);
    expect(syncLoginBack(path, target, { platform: 'win32' })).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
  });

  it('a missing user file removes the private one; POSIX never copies back', () => {
    const { target, path } = fresh();
    linkLogin(path, target, { platform: 'win32' });
    linkLogin(path, join(target, '..', 'missing.json'), { platform: 'win32' });
    expect(existsSync(path)).toBe(false);
    expect(syncLoginBack(path, target, { platform: 'linux' })).toBe(false);
  });

  it.skipIf(isWin)('POSIX: a symlink to the user file (skipped on Windows: symlinks need administrator rights or developer mode)', async () => {
    const { lstatSync, readlinkSync } = await import('node:fs');
    const { target, path } = fresh();
    linkLogin(path, target);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(target);
  });
});

// --- the real thing on Windows -------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

/**
 * Starts node → (child, detached grandchild) and returns the pids once all three run. The detached one
 * is outside the parent's job object, so it outlives the parent like a CLI's helper processes do.
 */
async function startTree(dir: string) {
  const pidsFile = join(dir, 'pids.json');
  const code = `
    const { spawn } = require('node:child_process');
    const keep = ['-e', 'setInterval(() => {}, 1 << 30)'];
    const a = spawn(process.execPath, keep, { stdio: 'ignore' });
    const b = spawn(process.execPath, keep, { stdio: 'ignore', detached: true, windowsHide: true });
    b.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([a.pid, b.pid]));
    setInterval(() => {}, 1 << 30);`;
  const spawnedAt = Date.now();
  const root = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
  await waitFor(() => existsSync(pidsFile));
  const kids = JSON.parse(readFileSync(pidsFile, 'utf8')) as number[];
  return { root, kids, startedAt: startTimeOf(root.pid!, spawnedAt)! };
}

describe.runIf(isWin)('Windows, for real', () => {
  const left: number[] = [];
  afterEach(() => {
    for (const pid of left.splice(0)) if (alive(pid)) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)]);
  });

  it('stopTree stops a running process tree and leaves nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-tree-'));
    const { root, kids, startedAt } = await startTree(dir);
    left.push(root.pid!, ...kids);
    // The tree also holds the console host Windows starts for a console process (conhost.exe).
    expect(winTree(winProcesses(), root.pid!, startedAt)).toEqual(expect.arrayContaining([root.pid!, ...kids]));
    expect(isOurProcess(root.pid!, startedAt).ours).toBe(true);
    await stopTree(root.pid, 500, startedAt);
    expect(await waitFor(() => ![root.pid!, ...kids].some(alive), 5000)).toBe(true);
  }, 30_000);

  it('after the root exited, stopTree finds what it started by parent id and stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-tree-'));
    const { root, kids, startedAt } = await startTree(dir);
    left.push(...kids);
    spawnSync('taskkill.exe', ['/F', '/PID', String(root.pid)]); // the root alone
    expect(await waitFor(() => !alive(root.pid!))).toBe(true);
    const [, detached] = kids as [number, number];
    expect(alive(detached)).toBe(true); // outlived its parent
    expect(isOurProcess(root.pid!, startedAt)).toMatchObject({ ours: true, reason: 'leader gone, processes it started still alive' });
    await stopTree(root.pid, 300, startedAt);
    expect(await waitFor(() => !kids.some(alive), 5000)).toBe(true);
    expect(isOurProcess(root.pid!, startedAt)).toEqual({ ours: false, reason: 'process group is gone' });
  }, 30_000);

  it('killTreeNow stops the tree at once; processStartTime matches the recorded spawn time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-tree-'));
    const { root, kids, startedAt } = await startTree(dir);
    left.push(root.pid!, ...kids);
    const created = processStartTime(root.pid!)!;
    expect(sameStart(created, startedAt)).toBe(true);
    expect(isOurProcess(root.pid!, created).ours).toBe(true);
    killTreeNow(root.pid!, startedAt);
    expect(await waitFor(() => ![root.pid!, ...kids].some(alive), 5000)).toBe(true);
  }, 30_000);

  it('a batch file started through cmd.exe receives every argument exactly, metacharacters included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-bat-'));
    writeFileSync(join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(join(dir, 'tool.bat'), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const args = ['plain', 'two words', 'a & echo INJECTED', 'x | y', '%PATH%', '!x!', 'say "hi"', 'back\\slash\\', '<in>', '^caret', '(paren)', ''];
    const launch = commandFor(join(dir, 'tool.bat'), args);
    expect(launch.cmd.toLowerCase()).toMatch(/cmd\.exe$/);
    const r = spawnSync(launch.cmd, launch.args, { encoding: 'utf8', windowsVerbatimArguments: launch.windowsVerbatimArguments, windowsHide: true });
    expect(JSON.parse(r.stdout)).toEqual(args);
    expect(r.stdout).not.toMatch(/^INJECTED/m);
  });

  it('an npm shim is started as node and its script, with the arguments untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-shim-'));
    mkdirSync(join(dir, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'tool', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(join(dir, 'tool.cmd'), NPM_CMD('node_modules\\tool\\cli.js'));
    const prompt = 'line one\n- line two & "quoted" | %PATH%';
    const launch = commandFor('tool', ['-p', prompt], { env: { ...process.env, PATH: `${dir};${process.env.PATH ?? ''}` } });
    expect(launch.args[0]).toBe(join(dir, 'node_modules', 'tool', 'cli.js'));
    const r = spawnSync(launch.cmd, launch.args, { encoding: 'utf8', windowsHide: true });
    expect(JSON.parse(r.stdout)).toEqual(['-p', prompt]);
  });

  it('linkLogin makes a hard link on this volume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-login-'));
    writeFileSync(join(dir, 'auth.json'), '{}');
    linkLogin(join(dir, 'home', 'auth.json'), join(dir, 'auth.json'));
    expect(statSync(join(dir, 'auth.json')).nlink).toBe(2);
    expect(() => linkSync(join(dir, 'auth.json'), join(dir, 'home', 'auth.json'))).toThrow(/EEXIST/);
  });
});
