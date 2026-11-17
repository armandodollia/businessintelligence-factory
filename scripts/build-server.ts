/**
 * Builds the server that is shipped inside the desktop app (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1, §4.4).
 *
 *   npm run build:server            (builds the web app first, then this)
 *
 * Writes `dist/server/`:
 *
 * - `main.js`: the server entry (`src/api/main.ts`) and everything it imports, bundled to one
 *   JavaScript file. No `tsx` and no `node_modules` of the checkout are needed to run it:
 *   `node dist/server/main.js`, from any working directory.
 * - the resources the server reads, which it finds next to itself (`runtimePaths`): `prompts/*.md`
 *   and `pricing.json` copied byte for byte, `web/` (the built web app) and `package.json` (name,
 *   version, `"type": "module"`).
 * - `node_modules/`: the pinned research browser (`@playwright/mcp`) with the packages it needs, so
 *   the packaged app starts it with its own Node runtime instead of `npx`.
 *
 * The server never writes into this directory.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PLAYWRIGHT_MCP_VERSION } from '../src/core/config/schema.js';

const ROOT = resolve(import.meta.dirname, '..');
const BROWSER_PACKAGE = '@playwright/mcp';

export type BuildServerOptions = {
  /** Where the build goes (default `<checkout>/dist/server`). Emptied first. */
  outDir?: string;
  /** The built web app to ship (default `<checkout>/web/dist`). */
  webDist?: string;
  /** Ship the research browser (default true). */
  browser?: boolean;
};

export type BuiltServer = { outDir: string; entry: string; version: string; prompts: number; browserPackages: string[] };

type PackageJson = { name?: string; version?: string; dependencies?: Record<string, string> };

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** The directory of an installed package, looked up as Node does: from `from` upwards. */
function packageDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`package '${name}' is not installed (looked up from ${from}): run npm install`);
  }
}

/** `name` and every package it depends on (its `dependencies`, not the optional ones), each with its directory. */
function closure(name: string, from: string, seen = new Map<string, string>()): Map<string, string> {
  const dir = packageDir(name, from);
  const known = seen.get(name);
  if (known !== undefined) {
    // One copy of each package is shipped: two versions of one name cannot both go to the flat folder.
    if (known !== dir) throw new Error(`two copies of '${name}' are installed (${known}, ${dir}): the build ships one`);
    return seen;
  }
  seen.set(name, dir);
  for (const dep of Object.keys(readJson(join(dir, 'package.json')).dependencies ?? {})) closure(dep, dir, seen);
  return seen;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<BuiltServer> {
  const outDir = resolve(opts.outDir ?? join(ROOT, 'dist', 'server'));
  const webDist = resolve(opts.webDist ?? join(ROOT, 'web', 'dist'));
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`the web app is not built (${join(webDist, 'index.html')} is missing): run npm run build:web`);
  const pkg = readJson(join(ROOT, 'package.json'));
  const version = pkg.version ?? 'unknown';

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const entry = join(outDir, 'main.js');
  await build({
    entryPoints: [join(ROOT, 'src', 'api', 'main.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node25',
    // Every package is bundled; `node:` built-ins (among them `node:sqlite`) stay imports of the runtime.
    packages: 'bundle',
    // Tells `runtimePaths` that its resources are next to the bundle.
    define: { __BIF_BUNDLED__: 'true' },
    // Bundled CommonJS packages call `require` for Node built-ins; an ES module has none of its own.
    banner: { js: "import { createRequire as __bifCreateRequire } from 'node:module';\nconst require = __bifCreateRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });

  // Resources, copied byte for byte: a prompt's version is a hash of its text.
  const promptsFrom = join(ROOT, 'src', 'core', 'prompts');
  const prompts = readdirSync(promptsFrom).filter((f) => f.endsWith('.md'));
  mkdirSync(join(outDir, 'prompts'));
  for (const f of prompts) cpSync(join(promptsFrom, f), join(outDir, 'prompts', f));
  cpSync(join(ROOT, 'src', 'core', 'harness', 'pricing.json'), join(outDir, 'pricing.json'));
  cpSync(webDist, join(outDir, 'web'), { recursive: true });
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ name: pkg.name, version, private: true, type: 'module' }, null, 2)}\n`);

  const browserPackages: string[] = [];
  if (opts.browser ?? true) {
    const packages = closure(BROWSER_PACKAGE, ROOT);
    const shipped = readJson(join(packages.get(BROWSER_PACKAGE)!, 'package.json')).version;
    if (shipped !== PLAYWRIGHT_MCP_VERSION) {
      throw new Error(`installed ${BROWSER_PACKAGE} is ${shipped}, the configuration pins ${PLAYWRIGHT_MCP_VERSION}: run npm install`);
    }
    for (const [name, dir] of packages) {
      // `dereference`: a linked package is shipped as files. Nested `node_modules` are not copied: the closure is flat.
      cpSync(dir, join(outDir, 'node_modules', ...name.split('/')), { recursive: true, dereference: true, filter: (src) => !src.slice(dir.length).split(/[\\/]/).includes('node_modules') });
      browserPackages.push(name);
    }
  }
  return { outDir, entry, version, prompts: prompts.length, browserPackages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildServer()
    .then((b) => {
      console.log(`[build:server] ${b.entry} (version ${b.version}, ${b.prompts} prompts${b.browserPackages.length ? `, research browser: ${b.browserPackages.join(', ')}` : ''})`);
    })
    .catch((e) => {
      console.error(`[build:server] failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
