/**
 * Where things are (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1, §4.2). The one
 * place that answers two questions:
 *
 * - **Resources** (read only): the prompts, the price table, the built web app, the package version
 *   and the shipped research browser. In a checkout they are in the source tree, exactly where they
 *   always were. When the server is shipped they are in one resources directory: the one named by
 *   `BIF_RESOURCES_DIR`, else, for the bundled server (`npm run build:server`), the directory of the
 *   bundle itself. Never the working directory.
 * - **Data, configuration and logs** (written): in a checkout the working directory, as today
 *   (`./bif.config.json`, and the configuration's own `dataDir`, default `./data`). In the packaged
 *   app the application folder the shell names with `BIF_APP_DIR`.
 *
 * The two are independent: resources say where the code's files are, the application folder says
 * where the person's files go. Every path is built with `node:path`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';

/** The application's name: the name of its per-user folder (design §4.2). */
export const APP_NAME = 'Business Intelligence Factory';

/** Environment variables the shell sets for the server it starts. */
export const RESOURCES_ENV = 'BIF_RESOURCES_DIR';
export const APP_DIR_ENV = 'BIF_APP_DIR';
export const APP_VERSION_ENV = 'BIF_APP_VERSION';

/** Set to `true` by `scripts/build-server.ts` in the bundled server; not defined when run from source. */
declare const __BIF_BUNDLED__: boolean | undefined;

export type Env = Record<string, string | undefined>;

export type ResourcePaths = {
  /** True when the resources are a shipped directory, false when they are the source tree. */
  shipped: boolean;
  /** The prompt templates (`<name>.md`). */
  promptsDir: string;
  /** The price table. */
  pricingPath: string;
  /** The built web app. */
  webDist: string;
  /** The `package.json` that holds the app version. */
  packageJson: string;
  /**
   * Where the research browser's command line is when it is shipped (`@playwright/mcp`). Absent in a
   * checkout, which starts the browser as it always did. The file may not exist: the caller checks.
   */
  shippedBrowserCli?: string;
};

export type RuntimePaths = {
  /** True when an application folder was given: data, configuration and logs go there. */
  packaged: boolean;
  resources: ResourcePaths;
  /** The application folder (packaged only). */
  appDir?: string;
  /** The configuration file: `<appDir>/bif.config.json`, or `./bif.config.json` in a checkout. */
  configPath: string;
  /** The data folder: `<appDir>/data` when packaged. Absent in a checkout: the configuration's `dataDir` applies. */
  dataDir?: string;
  /** Where the shell writes the server's output: `<appDir>/logs` (packaged only; a checkout prints to the terminal). */
  logsDir?: string;
};

export type RuntimePathsOptions = {
  env?: Env;
  /** The directory of this module (tests name another). */
  here?: string;
  /** Whether this is the bundled server (tests say so; the build defines it). */
  bundled?: boolean;
  /** The working directory relative paths are resolved against. */
  cwd?: string;
};

const isBundled = (): boolean => typeof __BIF_BUNDLED__ !== 'undefined' && __BIF_BUNDLED__ === true;

export function runtimePaths(opts: RuntimePathsOptions = {}): RuntimePaths {
  const env = opts.env ?? process.env;
  const here = opts.here ?? import.meta.dirname;
  const cwd = opts.cwd ?? process.cwd();
  const bundled = opts.bundled ?? isBundled();

  const named = env[RESOURCES_ENV];
  const shippedRoot = named ? resolve(cwd, named) : bundled ? here : undefined;
  // From source this module is `src/core/runtime/paths.ts`: `src/core` is one level up, the checkout three.
  const core = join(here, '..');
  const repo = join(here, '..', '..', '..');
  const resources: ResourcePaths = shippedRoot
    ? {
        shipped: true,
        promptsDir: join(shippedRoot, 'prompts'),
        pricingPath: join(shippedRoot, 'pricing.json'),
        webDist: join(shippedRoot, 'web'),
        packageJson: join(shippedRoot, 'package.json'),
        shippedBrowserCli: join(shippedRoot, 'node_modules', '@playwright', 'mcp', 'cli.js'),
      }
    : {
        shipped: false,
        promptsDir: join(core, 'prompts'),
        pricingPath: join(core, 'harness', 'pricing.json'),
        webDist: join(repo, 'web', 'dist'),
        packageJson: join(repo, 'package.json'),
      };

  const app = env[APP_DIR_ENV];
  if (!app) return { packaged: false, resources, configPath: resolve(cwd, 'bif.config.json') };
  const appDir = resolve(cwd, app);
  return {
    packaged: true,
    resources,
    appDir,
    configPath: join(appDir, 'bif.config.json'),
    dataDir: join(appDir, 'data'),
    logsDir: join(appDir, 'logs'),
  };
}

/**
 * The per-user application folder of a platform (design §4.2): what the shell passes as
 * `BIF_APP_DIR`. macOS `~/Library/Application Support/<name>`, Windows `%APPDATA%\<name>`,
 * elsewhere `$XDG_CONFIG_HOME/<name>` or `~/.config/<name>`.
 */
export function defaultAppDir(platform: NodeJS.Platform = process.platform, env: Env = process.env, home: string = homedir()): string {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_NAME);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), APP_NAME);
}

/**
 * The app version: what the shell passes (`BIF_APP_VERSION`, the packaged app's version), else the
 * version of the `package.json` in the resources (the checkout's own, or the one the build wrote next
 * to the bundle); `unknown` when neither can be read.
 */
export function appVersion(paths: RuntimePaths = runtimePaths(), env: Env = process.env): string {
  const passed = env[APP_VERSION_ENV]?.trim();
  if (passed) return passed;
  try {
    const pkg = JSON.parse(readFileSync(paths.resources.packageJson, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
