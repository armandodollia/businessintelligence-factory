/**
 * Feedback bundle routes (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.1). Mounted by
 * `createApp` before the `/api/*` 404 fallback.
 *
 * - `POST /api/feedback-bundle/preview`: what the file would hold. Body: `level` (`standard`, the
 *   default, or `with_texts`), `since` / `until` (a day `YYYY-MM-DD`, taken whole, or an ISO time),
 *   `note`, and `rows: { section, limit? }` to also get the first rows of one section. Answers the
 *   bundle id, the level, the file name, each section with its rows and size, and the file's size.
 * - `POST /api/feedback-bundle`: the file itself (`application/gzip`, with a download file name). Same
 *   body, without `rows`.
 *
 * Both build the bundle in memory and hand it to the caller. No route writes a file on the server's
 * disk, and nothing is sent anywhere: where the file is saved is the tester's choice (the browser's
 * download; in the desktop app, its save dialog).
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { NOTE_CHARS, buildBundle, bundleFileName, encodeBundle, previewBundle, type BundleOptions } from '../core/feedbackBundle/bundle.js';
import { firstRows } from '../core/feedbackBundle/sections.js';
import { SECTION_NAMES } from '../core/feedbackBundle/sources.js';
import { appVersion as runtimeAppVersion } from '../core/runtime/paths.js';
import type { SetupCheck } from '../core/setup/doctor.js';
import type { Store } from '../core/store/db.js';

export type FeedbackBundleRouteDeps = {
  store: Store;
  config: BifConfig;
  /**
   * The app version written in the manifest (default: `appVersion()` of `core/runtime/paths.ts`: the
   * packaged app's version when the shell passes one, else the package version).
   */
  appVersion?: string;
  /**
   * The setup check. With it the manifest names the agent CLIs it found, with their versions; the
   * check's kept report is used, so a bundle starts no command when a check has already run, and
   * never a model. Without it (tests) the manifest names the enabled providers and runs nothing.
   */
  setup?: SetupCheck;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const time = z.string().refine((v) => ISO.test(v) && !Number.isNaN(Date.parse(v)), 'must be a day (YYYY-MM-DD) or an ISO time');

const optionsShape = {
  level: z.enum(['standard', 'with_texts']).optional(),
  since: time.optional(),
  until: time.optional(),
  note: z.string().max(NOTE_CHARS).optional(),
};
const fileBody = z.strictObject(optionsShape);
const previewBody = z.strictObject({
  ...optionsShape,
  rows: z.strictObject({ section: z.enum(['manifest', ...SECTION_NAMES]), limit: z.number().int().min(1).max(50).optional() }).optional(),
});

/** Rows shown when the page asks for the first rows of a section without saying how many. */
const DEFAULT_ROWS = 5;

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

export function mountFeedbackBundleRoutes(app: Hono, deps: FeedbackBundleRouteDeps): void {
  const { store, config } = deps;
  const appVersion = deps.appVersion ?? runtimeAppVersion();

  /** The agent CLIs for the manifest: what the setup check found, else the enabled providers by name. */
  const clisOf = async (): Promise<NonNullable<BundleOptions['clis']>> => {
    if (!deps.setup) return Object.entries(config.providers).filter(([, p]) => p.enabled).map(([name]) => ({ name }));
    const report = await deps.setup.report();
    return report.clis.filter((c) => c.found).map((c) => ({ name: c.id, ...(c.version ? { version: c.version } : {}) }));
  };

  /** The request's choices as bundle options, or the 400 message. A day is taken whole (UTC). */
  const optionsOf = async (body: z.infer<typeof fileBody>): Promise<BundleOptions | string> => {
    const since = body.since === undefined ? undefined : DAY.test(body.since) ? `${body.since}T00:00:00.000Z` : new Date(body.since).toISOString();
    const until = body.until === undefined ? undefined : DAY.test(body.until) ? `${body.until}T23:59:59.999Z` : new Date(body.until).toISOString();
    if (since !== undefined && until !== undefined && since > until) return 'since must not be after until';
    return {
      level: body.level ?? 'standard',
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(body.note?.trim() ? { note: body.note } : {}),
      appVersion,
      platform: { os: process.platform, arch: process.arch, node: process.versions.node },
      clis: await clisOf(),
    };
  };

  app.post('/api/feedback-bundle/preview', async (c) => {
    const b = await parse(c, previewBody);
    if (!b.ok) return b.res;
    const { rows, ...choices } = b.data;
    const opts = await optionsOf(choices);
    if (typeof opts === 'string') return c.json({ error: opts }, 400);
    const bundle = buildBundle({ store, config }, opts);
    if (rows && rows.section !== 'manifest' && !(rows.section in bundle.sections)) {
      return c.json({ error: `section '${rows.section}' is not in a bundle of level '${opts.level}'` }, 400);
    }
    const first = rows
      ? { section: rows.section, rows: rows.section === 'manifest' ? [bundle.manifest] : firstRows(bundle.sections[rows.section], rows.limit ?? DEFAULT_ROWS) }
      : undefined;
    return c.json({ ...previewBundle(bundle), level: opts.level, fileName: bundleFileName(bundle), ...(first ? { firstRows: first } : {}) });
  });

  app.post('/api/feedback-bundle', async (c) => {
    const b = await parse(c, fileBody);
    if (!b.ok) return b.res;
    const opts = await optionsOf(b.data);
    if (typeof opts === 'string') return c.json({ error: opts }, 400);
    const bundle = buildBundle({ store, config }, opts);
    const file = encodeBundle(bundle);
    return c.body(new Uint8Array(file), 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${bundleFileName(bundle)}"`,
      'content-length': String(file.length),
      'cache-control': 'no-store',
    });
  });
}
