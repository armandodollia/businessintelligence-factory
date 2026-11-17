/**
 * A guard of the test suite: no test starts a real research browser server.
 *
 * The default shared browser command is `npx -y @playwright/mcp@<pinned>`. Started from a test it
 * downloads from the network, keeps running after the test (its own process group), and holds a
 * browser profile. A supervisor or runtime built with the default `browser` configuration starts it
 * as soon as a real CLI run asks for a browser, so a test can do this without naming a browser at all.
 *
 * `installRealBrowserGuard` (called by `test/setup.ts` for every test file) replaces every function
 * of `node:child_process` that starts a process (`spawn`, `spawnSync`, `execFile`, `execFileSync`,
 * `exec`, `execSync`, `fork`, and the promisified forms of `execFile` and `exec`) with one that
 * refuses such a command: it throws, naming the test, and records the attempt. Each is guarded by
 * itself: inside Node one calls the next without going through the module's exports. A command given
 * as one line for a shell (`exec`, or `shell: true`) is read as the shell would split it
 * (`isRealBrowserLine`). The harness may swallow the throw (a failed run is a result, not an error),
 * so the setup file also fails the test afterwards when an attempt was recorded.
 *
 * A test that needs a shared browser gives its configuration a stand-in server
 * (`test/fixtures/fake-browser-server.mjs`), `per_run` mode, or the `t3` backend.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

type GuardState = {
  /** The test that is running, as `file > name`; undefined between tests. */
  current: string | undefined;
  /** Refused commands since the last `takeRealBrowserAttempts`. */
  attempts: string[];
  installed: boolean;
};

// One state per process: a worker that runs several test files loads this module anew for each,
// while the patched `spawn` stays.
const KEY = Symbol.for('bif.test.realBrowserGuard');
const holder = globalThis as unknown as Record<symbol, GuardState | undefined>;
const state: GuardState = (holder[KEY] ??= { current: undefined, attempts: [], installed: false });

const baseName = (file: string) => file.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/, '');
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx']);
const isBrowserPackage = (arg: string) => arg.startsWith('@playwright/mcp');

/**
 * True when `command` with `args` would start a real research browser server: a package runner
 * (`npx` and the like) asked for `@playwright/mcp`, the package's own command line script run by
 * Node, or (Windows) either of those through `cmd.exe`. A command that only mentions the package
 * inside another argument (a configuration handed to a fake CLI) is not one.
 */
export function isRealBrowserCommand(command: string, args: readonly string[]): boolean {
  const name = baseName(command);
  if (PACKAGE_RUNNERS.has(name)) return args.some(isBrowserPackage);
  // Windows: `cmd.exe /d /s /c "<path to npx.cmd> <quoted arguments>"` (`commandFor`).
  if (name === 'cmd') {
    // The batch file is the first word of the line; `^` escapes the character after it.
    const line = (args.at(-1) ?? '').replace(/^"/, '');
    const first = /^(?:\^.|[^\s^])*/.exec(line)![0];
    return PACKAGE_RUNNERS.has(baseName(first.replace(/\^(.)/g, '$1'))) && line.slice(first.length).includes('@playwright/mcp');
  }
  const script = (args[0] ?? '').replace(/\\/g, '/');
  // The package's script run by Node (the shipped research browser), or npm's own `npx-cli.js`.
  if (/\/@playwright\/mcp\/cli\.js$/.test(script)) return true;
  if (/\/(npx|npm)-cli\.js$/.test(script)) return args.slice(1).some(isBrowserPackage);
  return false;
}

/** The words of a shell line, quotes taken off; a `;`, `&&`, `||`, `|` or `&` between commands is a word of its own. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  const re = /(&&|\|\||[;|&])|((?:[^\s'"`;|&]+|"[^"]*"|'[^']*')+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) words.push(m[1] ?? m[2]!.replace(/"([^"]*)"|'([^']*)'/g, (_all, a?: string, b?: string) => a ?? b ?? ''));
  return words;
}
const SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/**
 * True when a command line handed to a shell would start a real research browser server: one of its
 * commands (the line may hold several, and a command may follow `NAME=value` settings) is one
 * `isRealBrowserCommand` knows. A quoted argument that only mentions the package is not one.
 */
export function isRealBrowserLine(line: string): boolean {
  const words = shellWords(line);
  let start = 0;
  for (let i = 0; i <= words.length; i++) {
    if (i < words.length && !SEPARATORS.has(words[i]!)) continue;
    const command = words.slice(start, i).filter((w, n, all) => !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && all.slice(0, n).every((p) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(p))));
    if (command.length && isRealBrowserCommand(command[0]!, command.slice(1))) return true;
    start = i + 1;
  }
  return false;
}

type Options = { shell?: unknown } | undefined;
const optionsOf = (rest: unknown[]): Options => rest.find((a): a is { shell?: unknown } => !!a && typeof a === 'object' && !Array.isArray(a));
const argsOf = (rest: unknown[]): string[] => (Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : []);

/** Throws, and records the attempt, when what a function of `node:child_process` was asked to start is a real research browser server. */
function refuseRealBrowser(line: string | undefined): void {
  if (line === undefined) return;
  state.attempts.push(line);
  throw new Error(
    `test "${state.current ?? '(outside a test)'}" tried to start a real research browser server (${line}). ` +
      'Tests must not start one or need the network: give the configuration a stand-in browser (see test/realBrowserGuard.ts).',
  );
}

/** How each kind of function names what it starts: the line when it is a real research browser server, else undefined. */
const READERS = {
  /** `spawn`, `spawnSync`, `execFile`, `execFileSync`: a command with arguments, or with a shell one line. */
  command(command: unknown, rest: unknown[]): string | undefined {
    if (typeof command !== 'string') return undefined;
    const args = argsOf(rest);
    const line = [command, ...args].join(' ');
    if (isRealBrowserCommand(command, args)) return line;
    return optionsOf(rest)?.shell ? (isRealBrowserLine(line) ? line : undefined) : undefined;
  },
  /** `exec`, `execSync`: always a line for a shell. */
  line(command: unknown): string | undefined {
    return typeof command === 'string' && isRealBrowserLine(command) ? command : undefined;
  },
  /** `fork`: a script run by this Node. */
  script(script: unknown, rest: unknown[]): string | undefined {
    if (typeof script !== 'string') return undefined;
    const args = argsOf(rest);
    return isRealBrowserCommand(process.execPath, [script, ...args]) ? [process.execPath, script, ...args].join(' ') : undefined;
  },
};

const GUARDED: Array<[keyof typeof childProcess, keyof typeof READERS]> = [
  ['spawn', 'command'], ['spawnSync', 'command'], ['execFile', 'command'], ['execFileSync', 'command'], ['exec', 'line'], ['execSync', 'line'], ['fork', 'script'],
];

/** Replaces the functions of `node:child_process` that start a process, for this process (once). */
export function installRealBrowserGuard(): void {
  if (state.installed) return;
  state.installed = true;
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const [name, reader] of GUARDED) {
    const real = cp[name]!;
    const read = READERS[reader];
    const guarded = function (this: unknown, first: unknown, ...rest: unknown[]) {
      refuseRealBrowser(read(first, rest));
      return Reflect.apply(real, this, [first, ...rest]);
    };
    // `util.promisify` takes the form a function names for itself: Node's calls its own unguarded
    // function, so the guarded one names a guarded form.
    const realPromisified = (real as { [promisify.custom]?: (...args: unknown[]) => unknown })[promisify.custom];
    if (realPromisified) {
      Object.defineProperty(guarded, promisify.custom, {
        value: function (this: unknown, first: unknown, ...rest: unknown[]) {
          refuseRealBrowser(read(first, rest));
          return Reflect.apply(realPromisified, this, [first, ...rest]);
        },
      });
    }
    cp[name] = guarded;
  }
  // `import { spawn } from 'node:child_process'` in the code under test now gets the guarded one.
  syncBuiltinESMExports();
}

/** Says which test runs now (`undefined`: none). */
export function setGuardedTest(name: string | undefined): void {
  state.current = name;
}

/** The refused commands since the last call, and forgets them. */
export function takeRealBrowserAttempts(): string[] {
  return state.attempts.splice(0);
}
