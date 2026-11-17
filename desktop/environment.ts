/**
 * The environment the desktop shell gives the server it starts (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1).
 *
 * An app started from Finder or the Start menu has a short `PATH`: the folders the person's terminal
 * adds (Homebrew, `~/.local/bin`, a Node version manager) are missing, so an agent CLI that is a
 * script would be found and still not run. The shell therefore gives the server the `PATH` a
 * terminal would have. The server passes its environment on to the setup check and to the agent
 * runs, so all three see the same `PATH`.
 *
 * - macOS, Linux: the `PATH` of the person's login shell, asked for once with a time limit.
 * - Windows: the machine `PATH` and the user `PATH` from the registry, as a new process gets them.
 * - Either failing: the app's own `PATH` plus the usual install folders that exist.
 *
 * Nothing here imports Electron.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { killTreeNow } from '../src/core/harness/platform.js';
import { APP_DIR_ENV, APP_VERSION_ENV, RESOURCES_ENV, type Env } from '../src/core/runtime/paths.js';
import { STDIN_SHUTDOWN_ENV } from '../src/core/runtime/shutdownLine.js';
import { usualDirs } from '../src/core/setup/usualDirs.js';

/** What reading the `PATH` needs from the machine (tests give their own). */
export type PathSystem = {
  platform: NodeJS.Platform;
  env: Env;
  home: string;
  /** True when the folder exists. */
  exists(dir: string): boolean;
  /** The names in a folder; empty when it cannot be read. */
  listDir(dir: string): string[];
  /**
   * Runs a command with fixed arguments and resolves with what it printed, at the latest when
   * `timeoutMs` is over: the command is then stopped by force with everything it started. Nothing
   * when it could not be started. Never rejects.
   */
  run(file: string, args: string[], timeoutMs: number): Promise<string>;
};

/** Where the `PATH` came from. */
export type PathSource = 'login shell' | 'registry' | 'usual folders';

/** A login shell with a slow profile still answers; one that hangs does not hold the app up for longer (`run` stops it by force). */
const SHELL_TIMEOUT_MS = 8000;
const REGISTRY_TIMEOUT_MS = 5000;

/** More than any `PATH` with what a profile prints around it; what comes after is dropped. */
const MAX_OUTPUT_CHARS = 1024 * 1024;

/** Around the `PATH` in the shell's output: a profile may print lines of its own before and after. */
const MARK = '__BIF_PATH__';

/** A variable of `env` by name; on Windows whatever the case of the name. */
function envGet(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The command that prints the `PATH` of a login shell: an interactive login shell (`-il`), so the
 * profile files a terminal reads are read, running one `printf`. The text is fixed: nothing from
 * outside is put into the command.
 */
export function loginShellCommand(shell: string): { file: string; args: string[] } {
  return { file: shell, args: ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`] };
}

/** The `PATH` between the marks of the shell's output; undefined when there is none. */
export function parseLoginShellPath(stdout: string): string | undefined {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout);
  const path = m?.[1]?.trim();
  return path ? path : undefined;
}

/** The value of `Path` in the output of `reg query <key> /v Path`; undefined when the key has none. */
export function parseRegistryPath(stdout: string): string | undefined {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(stdout);
  return m?.[1] ? m[1] : undefined;
}

/** Fills in `%NAME%` from `env`, whatever the case of the name, as Windows does for a `REG_EXPAND_SZ` value. An unknown name stays. */
export function expandWindowsVars(value: string, env: Env): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => envGet(env, name, 'win32') ?? whole);
}

/** The folders agent CLIs and Node are usually installed in, beyond `PATH`: those of the setup check, and the Node version managers'. */
export function fallbackDirs(sys: Pick<PathSystem, 'platform' | 'env' | 'home' | 'listDir'>): string[] {
  const { home, env } = sys;
  if (sys.platform === 'win32') {
    const appData = envGet(env, 'APPDATA', 'win32') || win32.join(home, 'AppData', 'Roaming');
    const local = envGet(env, 'LOCALAPPDATA', 'win32') || win32.join(home, 'AppData', 'Local');
    return [...usualDirs(sys), win32.join(local, 'Volta', 'bin'), win32.join(appData, 'fnm', 'aliases', 'default')];
  }
  return [
    ...usualDirs(sys), // among them Homebrew, /usr/local/bin, ~/.local/bin, volta and every nvm version
    posix.join(home, '.asdf', 'shims'),
    posix.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    posix.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
  ];
}

/** One `PATH` from several, in order: the first of each folder is kept, empty entries are dropped. */
export function mergePath(lists: Array<string | undefined>, platform: NodeJS.Platform): string {
  const delimiter = platform === 'win32' ? win32.delimiter : posix.delimiter;
  // Windows: `C:\Tools` and `c:\tools\` are one folder.
  const keyOf = (dir: string) => (platform === 'win32' ? dir.replace(/\\+$/, '').toLowerCase() : dir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of lists.flatMap((l) => (l ?? '').split(delimiter))) {
    const d = dir.trim();
    if (!d || seen.has(keyOf(d))) continue;
    seen.add(keyOf(d));
    out.push(d);
  }
  return out.join(delimiter);
}

/** Windows: the machine `PATH` then the user `PATH`, each read from the registry with its variables filled in. */
async function registryPath(sys: PathSystem): Promise<string | undefined> {
  const reg = win32.join(envGet(sys.env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'reg.exe');
  const read = async (key: string) => {
    const value = parseRegistryPath(await sys.run(reg, ['query', key, '/v', 'Path'], REGISTRY_TIMEOUT_MS));
    return value === undefined ? undefined : expandWindowsVars(value, sys.env);
  };
  const machine = await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = await read('HKCU\\Environment');
  return machine === undefined && user === undefined ? undefined : mergePath([machine, user], 'win32');
}

/** macOS, Linux: the `PATH` of the person's login shell. */
async function loginShellPath(sys: PathSystem): Promise<string | undefined> {
  const shell = sys.env.SHELL || (sys.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const { file, args } = loginShellCommand(shell);
  return parseLoginShellPath(await sys.run(file, args, SHELL_TIMEOUT_MS));
}

/**
 * The `PATH` the person's terminal would have. What the app itself was started with is kept after
 * it, so nothing the launcher added is lost.
 */
export async function terminalPath(sys: PathSystem = systemPaths()): Promise<{ path: string; source: PathSource }> {
  const own = envGet(sys.env, 'PATH', sys.platform);
  const read = sys.platform === 'win32' ? await registryPath(sys) : await loginShellPath(sys);
  if (read !== undefined) return { path: mergePath([read, own], sys.platform), source: sys.platform === 'win32' ? 'registry' : 'login shell' };
  const usual = fallbackDirs(sys).filter((d) => sys.exists(d));
  return { path: mergePath([own, ...usual], sys.platform), source: 'usual folders' };
}

/** This machine. */
export function systemPaths(): PathSystem {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (dir) => existsSync(dir),
    listDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    run(file, args, timeoutMs) {
      return new Promise<string>((done) => {
        // POSIX: a process group of its own, so the time limit can stop the command with what it started.
        const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
        let printed = '';
        let settled = false;
        // What was printed counts even when the command ended with an error or had to be stopped: a
        // profile whose last line fails, or hangs, still printed the PATH.
        const settle = (text: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(limit);
          done(text);
        };
        // A hard limit. An interactive shell ignores the polite stop, and a program its profile started
        // can hold the output open after the shell is gone: so the whole tree is stopped by force, by
        // process id, and the answer is not waited for any longer.
        const limit = setTimeout(() => {
          if (child.pid !== undefined) {
            try {
              killTreeNow(child.pid);
            } catch {
              // already gone
            }
          }
          child.stdout.destroy();
          settle(printed);
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (printed.length < MAX_OUTPUT_CHARS) printed += chunk;
        });
        child.once('error', () => settle(''));
        // `close`, not `exit`: by then everything it printed has been read.
        child.once('close', () => settle(printed));
        child.stdin.on('error', () => {});
        child.stdin.end();
      });
    },
  };
}

/** Variables that steer where the server keeps its files or listens: the packaged server takes those from the shell alone. */
const NOT_PASSED_ON = ['PORT', 'BIF_CONFIG', 'BIF_DATA_DIR', RESOURCES_ENV];

/** True when `key` names one of `NOT_PASSED_ON`. On Windows the case of a variable's name does not matter (`Port` is `PORT`). */
const notPassedOn = (key: string, platform: NodeJS.Platform): boolean => NOT_PASSED_ON.includes(platform === 'win32' ? key.toUpperCase() : key);

export type ServerEnvOptions = {
  /** The application folder: data, configuration and logs. */
  appDir: string;
  /** The app version. */
  version: string;
  /** The `PATH` of `terminalPath`. */
  path: string;
  platform?: NodeJS.Platform;
};

/**
 * The environment of the server child: the shell's own, with the terminal's `PATH`, the application
 * folder, the app version, the shutdown line switched on, and `ELECTRON_RUN_AS_NODE` so the app's
 * own program runs the server as Node. The server needs that variable to stay set: it starts the
 * shipped research browser with the same program. `ELECTRON_NO_ASAR` makes that Node a plain one:
 * without it Electron's file functions take any path with `.asar` in it for an app archive, and a
 * file of that name could not be written.
 *
 * The server does not pass these two on to the agent CLIs it starts (`childEnv` in
 * `src/core/harness/platform.ts`): they would make every Electron program an agent starts run as Node.
 */
export function serverEnv(base: Env, opts: ServerEnvOptions): Env {
  const platform = opts.platform ?? process.platform;
  const env: Env = {};
  for (const [key, value] of Object.entries(base)) {
    if (notPassedOn(key, platform)) continue;
    // One PATH: on Windows the name can come in any case (`Path`, `PATH`).
    if (platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH') continue;
    env[key] = value;
  }
  env[platform === 'win32' ? 'Path' : 'PATH'] = opts.path;
  env[APP_DIR_ENV] = opts.appDir;
  env[APP_VERSION_ENV] = opts.version;
  env[STDIN_SHUTDOWN_ENV] = '1';
  env.ELECTRON_RUN_AS_NODE = '1';
  env.ELECTRON_NO_ASAR = '1';
  return env;
}
