/**
 * The reader of feedback bundles (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.4).
 *
 *   npm run feedback:report -- <files or folders> [--out report.md]
 *
 * Reads the bundle files given (a folder: every `*.json.gz` in it and below it) and writes one Markdown
 * report: per tester (one bundle is one tester) and combined. For each: runs and failures by class,
 * pass rate and rounds to pass, cost and tokens by role and by model, the most frequent lesson-signal
 * categories, rating agreement, the council and persona panel figures, requests to the person and how
 * long they waited; and for every bundle its versions and platform.
 *
 * A file whose format version this reader does not know is refused: it is named in the report and on
 * the error output with the reason, the other files are still read, and the exit code is 1.
 * The report goes to the standard output unless `--out` names a file.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeBundle, type Bundle } from '../src/core/feedbackBundle/bundle.js';
import type { TreeBlock } from '../src/core/feedbackBundle/sections.js';

export type ReadBundle = { file: string; bundle: Bundle };
export type RefusedFile = { file: string; reason: string };

const isBundleName = (name: string): boolean => name.endsWith('.json.gz');

/** The bundle files under `path`: the file itself, or every `*.json.gz` in the folder and below it. */
function filesOf(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true })
    .map((p) => join(path, String(p)))
    .filter((p) => isBundleName(p) && statSync(p).isFile())
    .sort();
}

/** Reads every bundle named by `paths` (files or folders), once each; what cannot be read is refused with the reason. */
export function readBundles(paths: string[]): { bundles: ReadBundle[]; refused: RefusedFile[] } {
  const bundles: ReadBundle[] = [];
  const refused: RefusedFile[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    let files: string[];
    try {
      files = filesOf(path);
    } catch (e) {
      refused.push({ file: path, reason: `cannot be read: ${(e as Error).message}` });
      continue;
    }
    for (const file of files) {
      if (seen.has(resolve(file))) continue;
      seen.add(resolve(file));
      try {
        const bundle = decodeBundle(readFileSync(file));
        if (!bundles.some((b) => b.bundle.id === bundle.id)) bundles.push({ file, bundle });
      } catch (e) {
        refused.push({ file, reason: (e as Error).message });
      }
    }
  }
  return { bundles, refused };
}

// ---------------------------------------------------------------------------
// figures

type Row = Record<string, unknown>;

/** The rows of one table of a section, over every business tree of the bundles given. */
function rows(bundles: Bundle[], section: string, table: string): Row[] {
  return bundles.flatMap((b) => {
    const s = b.sections[section];
    return Array.isArray(s) ? (s as TreeBlock[]).flatMap((block) => (block.tables?.[table] ?? []) as Row[]) : [];
  });
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, none = '(none)'): string => (typeof v === 'string' && v ? v : none);
/** A number with at most two decimals. */
const fmt = (v: number | null): string => (v === null ? '—' : String(Math.round(v * 100) / 100));
const pct = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : '—');
const usd = (v: number): string => v.toFixed(4);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** A wait as people say it: minutes below an hour, hours below two days, days above. */
export function formatWait(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = ms / 60_000;
  if (minutes < 60) return `${fmt(minutes)} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${fmt(hours)} h` : `${fmt(hours / 24)} d`;
}

const cell = (v: unknown): string => String(v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function table(head: string[], body: unknown[][]): string {
  if (!body.length) return '_Nothing recorded._';
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Counts of `key` over `list`, most frequent first. */
function countBy<T>(list: T[], key: (x: T) => string): Array<[string, T[]]> {
  const by = new Map<string, T[]>();
  for (const x of list) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

const FINISHED = new Set(['verified', 'unverified', 'failed']);
/** Lesson-signal categories shown. */
const TOP_CATEGORIES = 10;

/** The blocks of the design for one bundle or for several together. */
function blocks(bundles: Bundle[]): string {
  const out: string[] = [];
  const block = (title: string, ...parts: string[]) => out.push(`### ${title}`, ...parts);

  const runs = rows(bundles, 'runs', 'runs');
  const failed = runs.filter((r) => r.status === 'failed');
  block(
    'Runs and failures',
    table(['Runs', 'Failed', 'Failure rate'], [[runs.length, failed.length, pct(failed.length, runs.length)]]),
    ...(failed.length ? ['Failures by class:', table(['Class', 'Runs'], countBy(failed, (r) => str(r.failureClass, '(no class)')).map(([k, v]) => [k, v.length]))] : []),
  );

  const tasks = rows(bundles, 'tasks', 'tasks').filter((t) => FINISHED.has(String(t.status)));
  const verified = tasks.filter((t) => t.status === 'verified');
  block(
    'Review: pass rate and rounds',
    table(
      ['Finished tasks', 'Verified', 'Pass rate', 'First-round pass rate', 'Mean rounds to pass'],
      [[tasks.length, verified.length, pct(verified.length, tasks.length), pct(verified.filter((t) => t.round === 1).length, tasks.length), fmt(mean(verified.map((t) => num(t.round))))]],
    ),
  );

  const usage = (key: (r: Row) => string) =>
    countBy(runs, key)
      .map(([k, rs]) => ({
        key: k,
        runs: rs.length,
        tokens: rs.reduce((n, r) => n + num((r.usage as Row | undefined)?.totalTokens), 0),
        cost: rs.reduce((n, r) => n + num((r.usage as Row | undefined)?.costUsd), 0),
      }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key))
      .map((g) => [g.key, g.runs, g.tokens, usd(g.cost)]);
  block('Cost and tokens by role', table(['Role', 'Runs', 'Tokens', 'Cost (USD)'], usage((r) => str(r.role))));
  block('Cost and tokens by model', table(['Model', 'Runs', 'Tokens', 'Cost (USD)'], usage((r) => `${str(r.provider)}/${str(r.model)}`)));

  const signals = rows(bundles, 'lessonSignals', 'signals');
  block(
    'Most frequent lesson-signal categories',
    table(
      ['Category', 'Role', 'Signals', 'Tasks'],
      countBy(signals, (s) => `${str(s.category)}\u0000${str(s.role)}`)
        .slice(0, TOP_CATEGORIES)
        .map(([k, v]) => [...k.split('\u0000'), v.length, new Set(v.map((s) => s.unit)).size]),
    ),
  );

  const ratings = rows(bundles, 'feedback', 'ratings');
  const agree = ratings.filter((r) => r.verdict === 'agree').length;
  block('Rating agreement', table(['Ratings', 'Agree', 'Agreement'], [[ratings.length, agree, pct(agree, ratings.length)]]));

  const council = rows(bundles, 'reviewRounds', 'councilRounds');
  const sum = (list: Row[], k: string) => list.reduce((n, r) => n + num(r[k]), 0);
  const unavailable = council.reduce((n, r) => n + ((r.members as Row[] | undefined) ?? []).filter((m) => m.state !== 'reviewed').length, 0);
  block(
    'Review council',
    table(
      ['Rounds', 'Passed', 'Mean score', 'Upheld', 'Advisory', 'Dropped', 'Questions', 'Members unavailable'],
      council.length
        ? [[council.length, council.filter((r) => r.pass === true).length, fmt(mean(council.map((r) => num(r.score)))), sum(council, 'upheld'), sum(council, 'advisory'), sum(council, 'dropped'), sum(council, 'questions'), unavailable]]
        : [],
    ),
  );

  const panel = rows(bundles, 'personas', 'panel');
  block(
    'Persona panel',
    table(
      ['Recommendations', 'Reactions', 'Marked same as baseline', 'Unavailable', 'Highest round'],
      panel.length ? [[panel.length, sum(panel, 'reactions'), sum(panel, 'markedSameAsBaseline'), sum(panel, 'unavailable'), Math.max(...panel.map((p) => num(p.maxRound)))]] : [],
    ),
  );

  const requests = rows(bundles, 'requests', 'requests');
  const stopped = (r: Row): boolean => r.closedBy === 'stop';
  block(
    'Requests to the person',
    table(
      ['Kind', 'Asked', 'Answered', 'Denied', 'Closed by a stop', 'Pending', 'Median wait'],
      countBy(requests, (r) => str(r.kind)).map(([kind, rs]) => [
        kind,
        rs.length,
        rs.filter((r) => r.status === 'resolved').length,
        // A request that "Stop research" closed is stored as denied; the person denied nothing.
        rs.filter((r) => r.status === 'denied' && !stopped(r)).length,
        rs.filter(stopped).length,
        rs.filter((r) => r.status === 'pending').length,
        // How long the person took: a request the stop closed was not answered.
        formatWait(median(rs.flatMap((r) => (typeof r.waitedMs === 'number' && !stopped(r) ? [r.waitedMs] : [])))),
      ]),
    ),
  );
  return out.join('\n\n');
}

const LEVELS: Record<string, string> = { standard: 'standard', with_texts: 'with review texts' };

/** One line of the versions table for a bundle. */
function versionRow(b: Bundle): unknown[] {
  const m = b.manifest as {
    createdAt?: string; appVersion?: string; schemaVersion?: number; platform?: { os?: string; arch?: string; node?: string };
    clis?: Array<{ name: string; version?: string }>; level?: string; period?: { since?: string | null; until?: string | null }; trees?: number;
  };
  const period = m.period?.since || m.period?.until ? `${m.period.since?.slice(0, 10) ?? 'start'} to ${m.period.until?.slice(0, 10) ?? 'now'}` : 'everything';
  return [
    b.id, str(m.createdAt, '?').slice(0, 10), str(m.appVersion, '?'), m.schemaVersion ?? '?', `${str(m.platform?.os, '?')} ${str(m.platform?.arch, '?')}`, str(m.platform?.node, '?'),
    (m.clis ?? []).map((c) => (c.version ? `${c.name} ${c.version}` : c.name)).join(', ') || '(none)', LEVELS[String(m.level)] ?? str(m.level, '?'), period, m.trees ?? '?',
  ];
}

/** The Markdown report of the bundles read, with the files that were refused. */
export function feedbackReport(read: ReadBundle[], refused: RefusedFile[] = []): string {
  const bundles = read.map((r) => r.bundle);
  const out: string[] = ['# BIF feedback report'];
  out.push(
    bundles.length
      ? `${bundles.length} bundle${bundles.length === 1 ? '' : 's'} read${refused.length ? `, ${refused.length} file${refused.length === 1 ? '' : 's'} refused` : ''}. Every figure comes from the bundles as they were saved; a tester is one bundle.`
      : 'No bundle was read.',
  );
  if (refused.length) out.push('## Refused files', refused.map((r) => `- \`${basename(r.file)}\`: ${r.reason}`).join('\n'));
  if (!bundles.length) return `${out.join('\n\n')}\n`;
  out.push(
    '## Versions and platforms',
    table(['Bundle', 'Saved', 'App', 'Schema', 'Platform', 'Node', 'Agent CLIs', 'Level', 'Period', 'Business trees'], bundles.map(versionRow)),
  );
  out.push(`## Combined (${bundles.length} bundle${bundles.length === 1 ? '' : 's'})`, blocks(bundles));
  for (const b of bundles) {
    out.push(`## Tester ${b.id}`);
    const note = (b.manifest as { note?: unknown }).note;
    if (typeof note === 'string' && note.trim()) out.push(`The tester's note:\n\n${note.trim().split('\n').map((l) => `> ${l}`).join('\n')}`);
    out.push(blocks([b]));
  }
  return `${out.join('\n\n')}\n`;
}

const USAGE = 'Usage: npm run feedback:report -- <bundle files or folders> [--out report.md]';

/** The command: reads, writes the report, and answers the exit code (1 when a file was refused or nothing was given). */
export function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(`${s}\n`) }): number {
  const paths: string[] = [];
  let outFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outFile = argv[++i];
    else paths.push(argv[i]!);
  }
  if (!paths.length || (argv.includes('--out') && !outFile)) {
    io.err(USAGE);
    return 1;
  }
  const { bundles, refused } = readBundles(paths);
  for (const r of refused) io.err(`refused ${r.file}: ${r.reason}`);
  const report = feedbackReport(bundles, refused);
  if (outFile) writeFileSync(outFile, report);
  else io.out(report);
  return refused.length || !bundles.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
