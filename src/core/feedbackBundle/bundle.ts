/**
 * The feedback bundle (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3): one file a
 * tester saves and sends by their own means. It holds every figure and signal the retro, the lessons
 * engine and the metrics view read (sections.ts, sources.ts), what is needed to read them (versions,
 * the configuration without secrets), and nothing of the tester's research content at the standard
 * level (redact.ts).
 *
 * The file is gzip-compressed JSON: `{ id, manifest, sections }`. `manifest.format` is the format
 * version; a reader refuses a version it does not know (`decodeBundle`). Nothing here writes a file or
 * sends anything: the caller is handed the bytes.
 */
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BifConfig } from '../config/schema.js';
import type { Store } from '../store/db.js';
import { redactBundle } from './redact.js';
import { buildSections, sectionContext, sectionRows, treeRoots, type BundleLevel, type Queries } from './sections.js';

export type { BundleLevel } from './sections.js';

/** Version of the file's shape. Raised when a reader of the earlier shape would misread the file. */
export const BUNDLE_FORMAT = 1;

/** Longest note carried (the page says so). */
export const NOTE_CHARS = 4000;

export type BundleOptions = {
  level: BundleLevel;
  /** Inclusive ISO bounds on the time of the rows (default: everything). */
  since?: string;
  until?: string;
  /** The tester's own words, carried as typed after the bundle's redaction. */
  note?: string;
  appVersion: string;
  platform: { os: string; arch: string; node: string };
  /** The agent CLIs as detected (name, and version when known). */
  clis?: Array<{ name: string; version?: string }>;
};

export type Bundle = { id: string; manifest: Record<string, unknown>; sections: Record<string, unknown> };

export type BundlePreview = { id: string; sections: Array<{ name: string; rows: number; bytes: number }>; totalBytes: number };

/**
 * Builds the bundle of everything in the store, per business tree, at `opts.level` and within the
 * period. Reads only. The redaction of the whole bundle is applied last (`redactBundle`), so no section
 * can leave it out. `queries`: the query functions (tests pass wrapped ones to see the calls).
 */
export function buildBundle(deps: { store: Store; config: BifConfig }, opts: BundleOptions, queries?: Queries): Bundle {
  const id = randomBytes(4).toString('hex');
  const ctx = sectionContext(deps, opts, queries);
  const sections = buildSections(ctx);
  const note = opts.note?.trim().slice(0, NOTE_CHARS);
  const manifest: Record<string, unknown> = {
    format: BUNDLE_FORMAT,
    id,
    createdAt: new Date().toISOString(),
    appVersion: opts.appVersion,
    schemaVersion: deps.store.schemaVersion(),
    platform: { os: opts.platform.os, arch: opts.platform.arch, node: opts.platform.node },
    clis: (opts.clis ?? []).map((c) => ({ name: c.name, ...(c.version ? { version: c.version } : {}) })),
    period: { since: opts.since ?? null, until: opts.until ?? null },
    level: opts.level,
    trees: treeRoots(deps.store).length,
    ...(note ? { note } : {}),
    rows: Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, sectionRows(s)])),
  };
  return redactBundle(deps, { id, manifest, sections }, ctx.redaction);
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

/**
 * What the tester is shown before saving: the manifest and each section with its row count and its
 * size as JSON, and `totalBytes`, the size of the file that would be saved (compressed).
 */
export function previewBundle(bundle: Bundle): BundlePreview {
  return {
    id: bundle.id,
    sections: [
      { name: 'manifest', rows: 1, bytes: bytesOf(bundle.manifest) },
      ...Object.entries(bundle.sections).map(([name, s]) => ({ name, rows: sectionRows(s), bytes: bytesOf(s) })),
    ],
    totalBytes: encodeBundle(bundle).length,
  };
}

/** The file: gzip of the bundle as JSON. */
export function encodeBundle(bundle: Bundle): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ id: bundle.id, manifest: bundle.manifest, sections: bundle.sections }), 'utf8'));
}

/**
 * Reads a bundle file. Throws when the file is not a feedback bundle, and when its format version is
 * not `BUNDLE_FORMAT` (the message names the version found), so a reader never misreads a later shape.
 */
export function decodeBundle(file: Buffer): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(file).toString('utf8'));
  } catch {
    throw new Error('not a feedback bundle: the file is not gzip-compressed JSON');
  }
  const b = parsed as Partial<Bundle> | null;
  const format = (b?.manifest as { format?: unknown } | undefined)?.format;
  if (format !== BUNDLE_FORMAT) {
    throw new Error(`unknown feedback bundle format version ${format === undefined ? '(none)' : String(format)}: this reader knows version ${BUNDLE_FORMAT}`);
  }
  if (typeof b?.id !== 'string' || !b.manifest || !b.sections || typeof b.sections !== 'object') throw new Error('not a feedback bundle: id, manifest or sections is missing');
  return { id: b.id, manifest: b.manifest, sections: b.sections };
}

/** `bif-feedback-<date>-<short id>.json.gz`. */
export function bundleFileName(bundle: Pick<Bundle, 'id' | 'manifest'>): string {
  const date = typeof bundle.manifest.createdAt === 'string' ? bundle.manifest.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `bif-feedback-${date}-${bundle.id}.json.gz`;
}
