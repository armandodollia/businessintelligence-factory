/**
 * The environment the desktop shell gives the server it starts (design 2026-11-16 §4.1). An app
 * started from Finder or the Start menu has a short PATH: the server, the setup check and the agent
 * runs get the PATH the person's terminal would have. No command of the machine is run here: where a
 * process is needed (a shell that does not answer) it is a script of this file.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandWindowsVars, fallbackDirs, loginShellCommand, mergePath, parseLoginShellPath, parseRegistryPath, serverEnv, systemPaths, terminalPath,
  type PathSystem,
} from '../../desktop/environment.js';

type Call = { file: string; args: string[] };

/** A machine for the test: what exists, and what each command prints. */
function machine(over: Partial<PathSystem> & { answers?: (call: Call) => string | undefined; dirs?: string[] } = {}): PathSystem & { calls: Call[] } {
  const calls: Call[] = [];
  const dirs = new Set(over.dirs ?? []);
  return {
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/Users/t' },
    home: '/Users/t',
    exists: (d) => dirs.has(d),
    listDir: () => [],
    run: async (file, args) => {
      calls.push({ file, args });
      // What the command printed; nothing when it failed or took too long.
      return over.answers?.({ file, args }) ?? '';
    },
    ...over,
    calls,
  };
}

describe('the PATH of the login shell (macOS, Linux)', () => {
  it('is asked for once, from the shell the person uses, as an interactive login shell', async () => {
    const m = machine({ answers: () => 'Welcome back!\n__BIF_PATH__/Users/t/.local/bin:/opt/homebrew/bin:/usr/bin:/bin__BIF_PATH__\n' });
    const got = await terminalPath(m);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.file).toBe('/bin/zsh');
    expect(m.calls[0]!.args.slice(0, 1)).toEqual(['-ilc']);
    expect(m.calls[0]).toEqual(loginShellCommand('/bin/zsh'));
    expect(got).toEqual({ path: '/Users/t/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', source: 'login shell' });
  });

  it('keeps what the app itself was started with, after the shell\'s folders', async () => {
    const m = machine({ env: { PATH: '/usr/bin:/custom/bin', SHELL: '/bin/bash' }, answers: () => '__BIF_PATH__/opt/homebrew/bin:/usr/bin__BIF_PATH__' });
    expect((await terminalPath(m)).path).toBe('/opt/homebrew/bin:/usr/bin:/custom/bin');
  });

  it('is read between its marks only: what a profile prints around it is not part of it', () => {
    expect(parseLoginShellPath('__BIF_PATH__/a:/b__BIF_PATH__')).toBe('/a:/b');
    expect(parseLoginShellPath('motd line\n\u001b[32mprompt\u001b[0m __BIF_PATH__/a:/b c/d__BIF_PATH__ trailing')).toBe('/a:/b c/d');
    for (const none of ['', '/a:/b', '__BIF_PATH__/a:/b', '__BIF_PATH____BIF_PATH__', '__BIF_PATH__  __BIF_PATH__']) {
      expect(parseLoginShellPath(none), JSON.stringify(none)).toBeUndefined();
    }
  });

  it('falls back to the usual install folders that exist when the shell does not answer', async () => {
    const m = machine({
      dirs: ['/opt/homebrew/bin', '/Users/t/.local/bin', '/Users/t/.nvm/versions/node/v25.8.1/bin', '/Users/t/.volta/bin'],
      listDir: (d) => (d === '/Users/t/.nvm/versions/node' ? ['v22.1.0', 'v25.8.1'] : []),
      answers: () => undefined, // timed out, or the shell failed
    });
    const got = await terminalPath(m);
    expect(got.source).toBe('usual folders');
    // The app's own PATH first, then each usual folder that is there: none that is not.
    expect(got.path).toBe('/usr/bin:/bin:/Users/t/.local/bin:/opt/homebrew/bin:/Users/t/.volta/bin:/Users/t/.nvm/versions/node/v25.8.1/bin');
  });

  it('falls back as well when the shell answers without a PATH', async () => {
    const m = machine({ dirs: ['/usr/local/bin'], answers: () => 'tcsh: Unknown option\n' });
    expect(await terminalPath(m)).toEqual({ path: '/usr/bin:/bin:/usr/local/bin', source: 'usual folders' });
  });

  it('names the folders of the version managers: nvm, fnm, volta and asdf', () => {
    const m = machine({ listDir: (d) => (d === '/Users/t/.nvm/versions/node' ? ['v20.0.0', 'v25.8.1', 'v9.0.0'] : []) });
    const dirs = fallbackDirs(m);
    for (const d of [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/t/.local/bin',
      '/Users/t/.volta/bin',
      '/Users/t/.asdf/shims',
      '/Users/t/.local/share/fnm/aliases/default/bin',
      '/Users/t/Library/Application Support/fnm/aliases/default/bin',
    ]) {
      expect(dirs, d).toContain(d);
    }
    // nvm: every installed version, newest first.
    expect(dirs.filter((d) => d.includes('.nvm'))).toEqual(['/Users/t/.nvm/versions/node/v25.8.1/bin', '/Users/t/.nvm/versions/node/v20.0.0/bin', '/Users/t/.nvm/versions/node/v9.0.0/bin']);
  });

  it('uses a default shell when none is named', async () => {
    const m = machine({ env: { PATH: '/usr/bin' }, answers: () => '__BIF_PATH__/x__BIF_PATH__' });
    await terminalPath(m);
    expect(m.calls[0]!.file).toBe('/bin/zsh');
    const linux = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, answers: () => '__BIF_PATH__/x__BIF_PATH__' });
    await terminalPath(linux);
    expect(linux.calls[0]!.file).toBe('/bin/sh');
  });
});

// A shell is a POSIX matter: on Windows the PATH comes from the registry, read by a program that ends.
describe.skipIf(process.platform === 'win32')('a login shell that does not answer (skipped on Windows: the PATH is read from the registry there)', () => {
  const started: number[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  afterEach(() => {
    // Whatever a failing test left: by process id.
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
  });

  /**
   * A stand-in for an interactive shell whose profile hangs: it ignores the polite stop, as an
   * interactive shell does, starts a program of its own that holds the output open, and never ends.
   * `prints`: what it prints first.
   */
  function hangingShell(prints: string): { file: string; pids: () => Promise<number[]> } {
    const dir = mkdtempSync(join(tmpdir(), 'bif-shell-'));
    const file = join(dir, 'shell.mjs');
    const pidFile = join(dir, 'pids');
    writeFileSync(
      file,
      `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => {});
const child = spawn(process.execPath, ['-e', "for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => {}); setInterval(() => {}, 1 << 30)"], { stdio: 'inherit' });
process.stdout.write(${JSON.stringify(prints)});
writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);
setInterval(() => {}, 1 << 30);
`,
    );
    chmodSync(file, 0o755);
    return {
      file,
      /** The process ids of the shell and of the program it started, once both run. Recorded for the cleanup at once. */
      async pids() {
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').split(' ').length < 2) {
          if (Date.now() > deadline) throw new Error('the stand-in shell did not start');
          await sleep(20);
        }
        const pids = readFileSync(pidFile, 'utf8').split(' ').map(Number);
        started.push(...pids);
        return pids;
      },
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('is given up on at the time limit, with everything it started stopped, and the usual folders are used', async () => {
    const shell = hangingShell('no path here');
    const sys: PathSystem = { ...systemPaths(), env: { PATH: '/usr/bin:/bin', SHELL: shell.file } };
    const began = Date.now();
    // The limit of the app is eight seconds; the run itself is what is tested, with a short one.
    const running = sys.run(shell.file, ['-ilc', 'true'], 1500);
    const pids = await shell.pids();
    expect(pids.map(alive)).toEqual([true, true]);
    const printed = await running;
    expect(Date.now() - began).toBeLessThan(6000);
    expect(printed).toBe('no path here');
    await sleep(200);
    expect(pids.map(alive)).toEqual([false, false]);
    // And with no PATH in what it printed, the PATH is the app's own plus the usual folders.
    const found = await terminalPath({ ...sys, run: async () => printed });
    expect(found.source).toBe('usual folders');
    expect(found.path.split(':').slice(0, 2)).toEqual(['/usr/bin', '/bin']);
  }, 20_000);

  it('still gives its PATH when it printed one before it hung', async () => {
    const shell = hangingShell('__BIF_PATH__/opt/tools/bin:/usr/bin__BIF_PATH__');
    const sys: PathSystem = { ...systemPaths(), env: { PATH: '/usr/bin', SHELL: shell.file } };
    const running = sys.run(shell.file, ['-ilc', 'true'], 1500);
    const pids = await shell.pids();
    expect(parseLoginShellPath(await running)).toBe('/opt/tools/bin:/usr/bin');
    await sleep(200);
    expect(pids.map(alive)).toEqual([false, false]);
  }, 20_000);

  it('a command that ends in time is not waited for any longer, and one that cannot be started answers nothing', async () => {
    const sys = systemPaths();
    const began = Date.now();
    expect(await sys.run(process.execPath, ['-e', "process.stdout.write('quick')"], 10_000)).toBe('quick');
    expect(Date.now() - began).toBeLessThan(5000);
    expect(await sys.run(join(tmpdir(), 'bif-no-such-program'), [], 1000)).toBe('');
  });
});

describe('the PATH of a new process (Windows)', () => {
  const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
  const USER_KEY = 'HKCU\\Environment';
  const reg = (key: string, type: string, value: string) => `\r\n${key}\r\n    Path    ${type}    ${value}\r\n\r\n`;
  const winEnv = { Path: 'C:\\Windows\\system32;C:\\Started\\With', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' };

  it('is the machine PATH then the user PATH from the registry, with their variables filled in', async () => {
    const m = machine({
      platform: 'win32',
      home: 'C:\\Users\\t',
      env: winEnv,
      answers: ({ args }) =>
        args[1] === MACHINE_KEY
          ? reg('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'REG_EXPAND_SZ', '%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs\\')
          : reg('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', '%USERPROFILE%\\.local\\bin;%APPDATA%\\npm'),
    });
    const got = await terminalPath(m);
    expect(m.calls.map((c) => c.file)).toEqual(['C:\\Windows\\System32\\reg.exe', 'C:\\Windows\\System32\\reg.exe']);
    expect(m.calls.map((c) => c.args)).toEqual([['query', MACHINE_KEY, '/v', 'Path'], ['query', USER_KEY, '/v', 'Path']]);
    expect(got.source).toBe('registry');
    // Then what the app was started with that the registry did not name. `C:\Windows\system32` is there once.
    expect(got.path).toBe('C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\t\\.local\\bin;C:\\Users\\t\\AppData\\Roaming\\npm;C:\\Started\\With');
  });

  it('works with one of the two: a user without a PATH of their own', async () => {
    const m = machine({ platform: 'win32', home: 'C:\\Users\\t', env: winEnv, answers: ({ args }) => (args[1] === MACHINE_KEY ? reg('HKEY_LOCAL_MACHINE\\…', 'REG_SZ', 'C:\\Tools') : undefined) });
    expect(await terminalPath(m)).toEqual({ path: 'C:\\Tools;C:\\Windows\\system32;C:\\Started\\With', source: 'registry' });
  });

  it('falls back to the usual install folders that exist when the registry cannot be read', async () => {
    const m = machine({ platform: 'win32', home: 'C:\\Users\\t', env: winEnv, dirs: ['C:\\Users\\t\\AppData\\Roaming\\npm', 'C:\\Users\\t\\.local\\bin'], answers: () => undefined });
    expect(await terminalPath(m)).toEqual({ path: 'C:\\Windows\\system32;C:\\Started\\With;C:\\Users\\t\\.local\\bin;C:\\Users\\t\\AppData\\Roaming\\npm', source: 'usual folders' });
  });

  it('reads the value of a registry answer, spaces and all', () => {
    expect(parseRegistryPath(reg('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', 'C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin'))).toBe('C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin');
    expect(parseRegistryPath(reg('HKEY_CURRENT_USER\\Environment', 'REG_SZ', 'C:\\a'))).toBe('C:\\a');
    expect(parseRegistryPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    PATH    REG_SZ    C:\\b\r\n')).toBe('C:\\b');
    expect(parseRegistryPath('ERROR: The system was unable to find the specified registry key or value.\r\n')).toBeUndefined();
    expect(parseRegistryPath('')).toBeUndefined();
  });

  it('fills in %NAME% whatever the case of the name, and leaves an unknown name as it is', () => {
    const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\t' };
    expect(expandWindowsVars('%SYSTEMROOT%\\system32;%userprofile%\\bin;%NoSuchName%\\x;100%', env)).toBe('C:\\Windows\\system32;C:\\Users\\t\\bin;%NoSuchName%\\x;100%');
  });
});

describe('mergePath', () => {
  it('keeps the first of each folder, in order, and drops empty entries', () => {
    expect(mergePath(['/a:/b::/c', undefined, '/b:/d', ''], 'darwin')).toBe('/a:/b:/c:/d');
  });

  it('on Windows compares folders without regard to case or a closing back-slash', () => {
    expect(mergePath(['C:\\Tools;C:\\Windows\\', 'c:\\tools\\;C:\\WINDOWS;D:\\x'], 'win32')).toBe('C:\\Tools;C:\\Windows\\;D:\\x');
  });
});

describe('the environment of the server', () => {
  const opts = { appDir: '/Users/t/Library/Application Support/Business Intelligence Factory', version: '1.2.3', path: '/opt/homebrew/bin:/usr/bin', platform: 'darwin' as const };

  it('names the application folder and the version, switches on the shutdown line, and runs the app as plain Node', () => {
    const env = serverEnv({ HOME: '/Users/t', LANG: 'en_US.UTF-8', PATH: '/usr/bin' }, opts);
    expect(env).toEqual({
      HOME: '/Users/t',
      LANG: 'en_US.UTF-8',
      PATH: '/opt/homebrew/bin:/usr/bin',
      BIF_APP_DIR: opts.appDir,
      BIF_APP_VERSION: '1.2.3',
      BIF_SHUTDOWN_ON_STDIN: '1',
      ELECTRON_RUN_AS_NODE: '1',
      // Without it Electron's file functions take any path with `.asar` in it for an app archive.
      ELECTRON_NO_ASAR: '1',
    });
  });

  it('does not pass on variables that would steer the packaged server elsewhere', () => {
    const env = serverEnv({ PORT: '3000', BIF_CONFIG: '/x/c.json', BIF_DATA_DIR: '/x/data', BIF_RESOURCES_DIR: '/x/res', BIF_APP_DIR: '/old', BIF_APP_VERSION: '0.0.0', KEEP: 'yes' }, opts);
    expect(env.PORT).toBeUndefined();
    expect(env.BIF_CONFIG).toBeUndefined();
    expect(env.BIF_DATA_DIR).toBeUndefined();
    expect(env.BIF_RESOURCES_DIR).toBeUndefined();
    expect(env.BIF_APP_DIR).toBe(opts.appDir);
    expect(env.BIF_APP_VERSION).toBe('1.2.3');
    expect(env.KEEP).toBe('yes');
  });

  it('on Windows a variable is the same under any case of its name: none of them is passed on', () => {
    const env = serverEnv(
      { Port: '3000', port: '3001', Bif_Config: 'C:\\x\\c.json', bif_data_dir: 'C:\\x\\data', Bif_Resources_Dir: 'C:\\x\\res', KEEP: 'yes' },
      { ...opts, platform: 'win32', path: 'C:\\new' },
    );
    expect(Object.keys(env).filter((k) => ['PORT', 'BIF_CONFIG', 'BIF_DATA_DIR', 'BIF_RESOURCES_DIR'].includes(k.toUpperCase()))).toEqual([]);
    expect(env.KEEP).toBe('yes');
    // Elsewhere the case is part of the name: `Port` is another variable than `PORT`.
    expect(serverEnv({ Port: '3000', PORT: '3001' }, opts)).toMatchObject({ Port: '3000' });
    expect(serverEnv({ Port: '3000', PORT: '3001' }, opts).PORT).toBeUndefined();
  });

  it('on Windows replaces the PATH under whatever case it has, so there is one', () => {
    const env = serverEnv({ Path: 'C:\\old', path: 'C:\\older', USERPROFILE: 'C:\\Users\\t' }, { ...opts, platform: 'win32', path: 'C:\\new' });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(env.Path).toBe('C:\\new');
  });

  it('does not change the environment it was given', () => {
    const base = { PATH: '/usr/bin', PORT: '3000' };
    serverEnv(base, opts);
    expect(base).toEqual({ PATH: '/usr/bin', PORT: '3000' });
  });
});
