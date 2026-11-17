/**
 * Builds the desktop app (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1, §4.5).
 * The same steps on macOS and on Windows; nothing here needs the other platform.
 *
 *   npm run desktop:dev        the app from this checkout, in a window (no installer)
 *   npm run test:desktop-runtime    the test suite on the runtime the app ships (Electron as Node)
 *   npm run dist:mac           the macOS installers (.dmg, Apple silicon and Intel), on macOS
 *   npm run dist:win           the Windows installer (.exe, x64), on Windows
 *   npm run dist:mac -- --arm64     that architecture alone (a quick build); other further arguments
 *                                   go to the installer builder as they are
 *
 * Each script builds the web app and the server first (`npm run build:server`, into `dist/server`),
 * then runs this file, which
 *
 * 1. checks the runtime: the Electron version in use is started as Node and opens a database with
 *    `node:sqlite`. The server runs on that runtime in the packaged app, so a build whose runtime
 *    cannot do this stops here;
 * 2. writes `dist/shell`: the shell bundled to one file (`main.js`, Electron left to the app) and a
 *    `package.json` with the name of the app and the version of the project;
 * 3. `--run`: starts Electron on `dist/shell`, with its files in `data/desktop-dev` of the checkout;
 *    `--mac` / `--win`: runs electron-builder with `desktop/electron-builder.yml`, which puts
 *    `dist/shell` and `dist/server` into the app and writes the installers to `dist/installers`.
 *
 * Signing (design §4.5): unsigned unless the signing variables are present. With none, the macOS app
 * gets an ad-hoc signature (Apple silicon runs nothing without one), no certificate of the building
 * machine is looked for, and the Windows installer is not signed. With `CSC_LINK` and
 * `CSC_KEY_PASSWORD` (a Developer ID certificate; `CSC_NAME` for one in the keychain) the macOS app
 * is signed, and with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` it is notarised;
 * with `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` the Windows installer is signed. electron-builder
 * reads these variables itself.
 *
 * Nothing is published: the installers stay in `dist/installers`.
 *
 * What a build needs, on either platform: this checkout with `npm ci` done on Node 25, and network
 * access the first time. electron-builder then downloads the Electron of the target platform and its
 * own packing tools into its caches in the user's folder, outside the checkout; later builds use the
 * caches.
 *
 * On Windows, the unsigned build needs neither "Developer Mode" nor a terminal started as
 * administrator: `npm run dist:win` was run on Windows 11 x64 (2026-11-16) with empty electron-builder
 * caches, as a normal user with Developer Mode off, and it downloaded and unpacked only Electron, the
 * icon tools, 7-Zip and NSIS. A signed build also unpacks electron-builder's signing tools
 * (winCodeSign), whose archive holds macOS symbolic links; if that stops with "A required privilege is
 * not held by the client", Developer Mode or an administrator terminal lets Windows create them. The
 * signed build was not tried on Windows.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { APP_DIR_ENV, APP_NAME } from '../src/core/runtime/paths.js';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG = 'desktop/electron-builder.yml';

type Env = Record<string, string | undefined>;
type PackageJson = { name?: string; version?: string; description?: string };

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** The `package.json` of the shell: what Electron and the installer builder read. It has no dependencies: the shell is one bundled file. */
export function shellPackage(project: PackageJson): Record<string, unknown> {
  return {
    name: project.name ?? 'business-intelligence-factory',
    productName: APP_NAME,
    version: project.version ?? '0.0.0',
    description: project.description ?? APP_NAME,
    author: APP_NAME,
    private: true,
    type: 'module',
    main: 'main.js',
  };
}

export type BuiltShell = { outDir: string; entry: string; version: string };

/** Writes the shell: `main.js` (`desktop/main.ts` and what it imports, bundled; Electron stays an import) and its `package.json`. */
export async function prepareShell(opts: { outDir?: string } = {}): Promise<BuiltShell> {
  const outDir = resolve(opts.outDir ?? join(ROOT, 'dist', 'shell'));
  const project = readJson(join(ROOT, 'package.json'));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, 'main.js');
  await build({
    entryPoints: [join(ROOT, 'desktop', 'main.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  const pkg = shellPackage(project);
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return { outDir, entry, version: String(pkg.version) };
}

/** Variables electron-builder signs and notarises with. An empty one counts as absent (a hosted build passes its unset secrets as empty text). */
const SIGNING_VARS = [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
];

export type BuilderRun = { args: string[]; env: Env; signed: boolean };

/** The arguments of electron-builder that name an architecture. */
const ARCH_FLAGS = ['--arm64', '--x64', '--ia32', '--armv7l', '--universal'];
/** What a build makes when no architecture is asked for (design §2): every architecture the app is offered for. */
const DEFAULT_ARCH_FLAGS = { mac: ['--arm64', '--x64'], win: ['--x64'] };

/**
 * The arguments and the environment electron-builder is run with. Unsigned unless a certificate is
 * given (see the head of this file); never publishing. `extra` goes to electron-builder after these.
 * The architectures are every one of the platform, unless `extra` names its own: the configuration
 * file names none, so that an argument can choose.
 */
export function builderRun(target: 'mac' | 'win', base: Env, extra: string[] = []): BuilderRun {
  const env: Env = { ...base };
  for (const name of SIGNING_VARS) if (!env[name]?.trim()) delete env[name];
  const signed = target === 'mac' ? Boolean(env.CSC_LINK || env.CSC_NAME) : Boolean(env.WIN_CSC_LINK || env.CSC_LINK);
  const args = [`--${target}`, '--config', CONFIG, '--publish', 'never'];
  if (!signed) {
    // A certificate that happens to be in the keychain of the building machine is not used.
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    // `-`: an ad-hoc signature, which needs no certificate. The hardened runtime is for signed, notarised builds.
    if (target === 'mac') args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
  }
  if (!extra.some((a) => ARCH_FLAGS.includes(a))) args.push(...DEFAULT_ARCH_FLAGS[target]);
  return { args: [...args, ...extra], env, signed };
}

/**
 * The files of the built server (`builtDir`) that are not in the app (`packedDir`) as they were built:
 * missing, or of another size. As relative paths with `/`, sorted. The installer builder leaves out a
 * `node_modules` folder unless it is named on its own, and the research browser is in one.
 */
export function notPacked(builtDir: string, packedDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(builtDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(entry.parentPath, entry.name);
    const rel = relative(builtDir, from);
    const packed = statSync(join(packedDir, rel), { throwIfNoEntry: false });
    if (!packed?.isFile() || packed.size !== statSync(from).size) out.push(rel.split(sep).join('/'));
  }
  return out.sort();
}

/** The server folder of each unpacked app the installer builder left in `installersDir` (one per platform and architecture). */
export function packedServerDirs(installersDir: string): string[] {
  if (!existsSync(installersDir)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(installersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mac = join(installersDir, entry.name, `${APP_NAME}.app`, 'Contents', 'Resources', 'server');
    const windows = join(installersDir, entry.name, 'resources', 'server');
    if (existsSync(mac)) dirs.push(mac);
    else if (existsSync(windows)) dirs.push(windows);
  }
  return dirs.sort();
}

/** The shell is one small bundled file; an archive beyond this holds something else. */
const APP_ARCHIVE_MAX_BYTES = 1024 * 1024;

/**
 * What is wrong with the app archive (`app.asar`, beside the packed server folder), if anything. It
 * must hold the shell alone: when the installer builder finds no packages in the shell's folder it
 * takes those of the whole project instead, unless the configuration excludes them.
 */
export function appArchiveProblem(packedServerDir: string): string | undefined {
  const archive = join(packedServerDir, '..', 'app.asar');
  const size = statSync(archive, { throwIfNoEntry: false })?.size;
  if (size === undefined) return `${archive}: app.asar is missing`;
  if (size > APP_ARCHIVE_MAX_BYTES) return `${archive}: app.asar is ${size} bytes, the shell is a few thousand: packages of the project were packed into the app`;
  return undefined;
}

/** Where a run from the checkout keeps its data, configuration and logs: in the checkout (`data/` is not tracked), never in the person's application folder. */
export function devAppDir(): string {
  return join(ROOT, 'data', 'desktop-dev');
}

/** The Electron program installed in this checkout (the package downloads it on first use). */
function electronProgram(): string {
  return createRequire(import.meta.url)('electron') as string;
}

/** What the runtime check prints when it works. */
type Runtime = { electron: string; node: string; sqlite: string; arch: string };

const PROBE = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('create table t (x integer)');
db.prepare('insert into t values (?)').run(42);
const row = db.prepare('select x, sqlite_version() as v from t').get();
if (row.x !== 42) throw new Error('unexpected row');
console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: row.v, arch: process.arch }));
`;

/** Starts the Electron in use as Node and has it open a database, write a row and read it back. Throws when it cannot. */
export function checkRuntime(program: string = electronProgram()): Runtime {
  const r = spawnSync(program, ['-e', PROBE], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`the Electron runtime cannot run the server (node:sqlite failed): ${r.error?.message || r.stderr.trim() || `exit code ${r.status}`}`);
  }
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Runtime;
}

/** Runs a program to its end with this terminal's input and output; resolves with its exit code. */
function run(program: string, args: string[], env: Env): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', fail);
    child.once('exit', (code) => done(code ?? 1));
  });
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  const extra = argv.slice(1);
  if (mode !== '--run' && mode !== '--mac' && mode !== '--win' && mode !== '--test') {
    console.error('usage: tsx desktop/build.ts --run | --test [arguments for vitest] | --mac | --win [arguments for electron-builder]');
    return 2;
  }
  const runtime = checkRuntime();
  console.log(`[desktop] runtime: Electron ${runtime.electron} carries Node ${runtime.node} (${runtime.arch}); node:sqlite works (SQLite ${runtime.sqlite}). The server runs on it.`);

  if (mode === '--test') {
    // The suite as `npm test` runs it, with the Electron in use as the Node that runs it: the tests,
    // and every server they start, are on the runtime the packaged app has.
    const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    // The two variables the shell gives the server (`serverEnv`).
    return run(electronProgram(), [vitest, 'run', ...extra], { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' });
  }
  if (!existsSync(join(ROOT, 'dist', 'server', 'main.js'))) throw new Error('the server is not built (dist/server/main.js is missing): run npm run build:server');
  const shell = await prepareShell();
  console.log(`[desktop] ${shell.entry} (version ${shell.version})`);

  if (mode === '--run') {
    const env: Env = { ...process.env };
    env[APP_DIR_ENV] ||= devAppDir();
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`[desktop] starting the app; its files are in ${env[APP_DIR_ENV]}`);
    return run(electronProgram(), [shell.outDir, ...extra], env);
  }

  const target = mode === '--mac' ? 'mac' : 'win';
  const needs = target === 'mac' ? 'darwin' : 'win32';
  if (process.platform !== needs) throw new Error(`npm run dist:${target} builds on ${target === 'mac' ? 'macOS' : 'Windows'}; this machine is ${process.platform}`);
  const builder = builderRun(target, process.env, extra);
  console.log(`[desktop] building the ${target === 'mac' ? 'macOS' : 'Windows'} installer${builder.signed ? ', signed with the certificate given' : ', unsigned (no signing variable is set)'}`);
  const cli = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const installers = join(ROOT, 'dist', 'installers');
  rmSync(installers, { recursive: true, force: true });
  const code = await run(process.execPath, [cli, ...builder.args], builder.env);
  if (code !== 0) return code;

  // The app must hold the server exactly as it was built, the research browser included, and the shell alone beside it.
  const packed = packedServerDirs(installers);
  if (!packed.length) throw new Error(`no unpacked app was found in ${installers}: what is in it could not be checked`);
  for (const dir of packed) {
    const missing = notPacked(join(ROOT, 'dist', 'server'), dir);
    if (missing.length) throw new Error(`${missing.length} files of the server are not in ${dir} as they were built, the first: ${missing.slice(0, 5).join(', ')}`);
    const archive = appArchiveProblem(dir);
    if (archive) throw new Error(archive);
    console.log(`[desktop] checked ${dir}: the whole server is in the app, and the app archive holds the shell alone`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[desktop] failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
