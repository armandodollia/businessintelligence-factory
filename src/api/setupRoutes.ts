/**
 * The setup check over HTTP (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.2, §4.3).
 * Mounted by `createApp` before the `/api/*` 404 fallback.
 *
 * - `GET /api/setup` (`?refresh=1` to check again): which agent CLIs are installed and signed in and
 *   whether Chrome is there (`report`, see `core/setup/doctor.ts`), whether a configuration file
 *   exists, the app version, and where this machine keeps the data, the configuration, the logs and
 *   the research browser's profile.
 *   The check is kept between requests: asking does not start commands each time.
 * - `POST /api/setup/apply` (body `{ overwrite?: boolean }`): checks again, then writes the
 *   configuration that fits what was found (`suggestConfig`, on top of the configuration in use) and
 *   uses it at once. Only when no configuration file exists; when one exists it is refused (409)
 *   unless `overwrite` is true.
 * - `POST /api/setup/open-folder`: opens the folder shown on the Settings page in the system's file
 *   manager (the application folder of the packaged app, the data folder of a checkout). The body
 *   names no folder: the server opens only its own.
 *
 * A server without a setup check (tests; `BootOptions.setup` not given) answers `available: false`
 * and runs no command.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { parseConfig } from '../core/config/load.js';
import type { BifConfig } from '../core/config/schema.js';
import type { RuntimePaths } from '../core/runtime/paths.js';
import { suggestConfig, type SetupCheck } from '../core/setup/doctor.js';

export type SetupRouteDeps = {
  /** The configuration in use. */
  config: BifConfig;
  /** The data folder in use (absolute). */
  dataDir: string;
  /** The configuration file; nothing can be applied without one. */
  configPath?: string;
  paths: RuntimePaths;
  appVersion: string;
  setup?: SetupCheck;
  /** Opens a folder in the system's file manager. */
  openFolder?: (dir: string) => void;
  /** Replaces the configuration in use, writes the file and records the change (as `PUT /api/config`). */
  applyConfig(next: BifConfig): void;
};

const applyBody = z.strictObject({ overwrite: z.boolean().optional() });
const noBody = z.strictObject({});

async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`).join('; ');
    return { ok: false, res: c.json({ error: msg }, 400) };
  }
  return { ok: true, data: r.data };
}

const NO_CHECK = 'the setup check is not available on this server';

export function mountSetupRoutes(app: Hono, deps: SetupRouteDeps): void {
  const { config, paths, setup } = deps;
  const dataDir = resolve(deps.dataDir);
  const configExists = () => deps.configPath !== undefined && existsSync(deps.configPath);
  /** The folder the Settings page shows and opens: the application folder when packaged, else the data folder. */
  const folderToOpen = paths.appDir ?? dataDir;
  /** Where things are. The research browser's profile is the configuration's path as the server resolves it. */
  const folders = () => ({
    ...(paths.appDir ? { app: paths.appDir } : {}),
    data: dataDir,
    ...(deps.configPath ? { config: deps.configPath } : {}),
    ...(paths.logsDir ? { logs: paths.logsDir } : {}),
    browserProfile: resolve(config.browser.profileDir),
    open: folderToOpen,
  });

  app.get('/api/setup', async (c) => {
    const refresh = ['1', 'true'].includes(c.req.query('refresh') ?? '');
    const report = setup ? await setup.report({ refresh }) : null;
    return c.json({ available: setup !== undefined, report, configExists: configExists(), version: deps.appVersion, packaged: paths.packaged, folders: folders(), canOpenFolder: deps.openFolder !== undefined });
  });

  app.post('/api/setup/apply', async (c) => {
    const b = await parse(c, applyBody);
    if (!b.ok) return b.res;
    if (!setup) return c.json({ error: NO_CHECK }, 409);
    if (!deps.configPath) return c.json({ error: 'this server has no configuration file to write' }, 409);
    if (configExists() && !b.data.overwrite) {
      return c.json({ error: `a configuration already exists (${deps.configPath}): it is left as it is unless you ask to replace it`, configExists: true }, 409);
    }
    // Checked again now: what was installed or signed in a moment ago counts.
    const found = await setup.report({ refresh: true });
    deps.applyConfig(parseConfig(suggestConfig(found, config), 'POST /api/setup/apply'));
    // The report as it reads with the configuration just written (whether research can start depends on its roles).
    return c.json({ config, report: await setup.report(), configExists: configExists() });
  });

  app.post('/api/setup/open-folder', async (c) => {
    const b = await parse(c, noBody);
    if (!b.ok) return b.res;
    if (!deps.openFolder) return c.json({ error: 'this server cannot open folders' }, 409);
    deps.openFolder(folderToOpen);
    return c.json({ opened: folderToOpen });
  });
}
