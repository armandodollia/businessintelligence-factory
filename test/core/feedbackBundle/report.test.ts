/**
 * The reader of feedback bundles (design §3.4): `npm run feedback:report -- <files or folders>` turns
 * one or many bundles into one Markdown report, per tester and combined, and refuses a file whose
 * format version it does not know.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedbackReport, main, readBundles } from '../../../scripts/feedback-report.js';
import { BUNDLE_FORMAT, buildBundle, bundleFileName, encodeBundle, type Bundle } from '../../../src/core/feedbackBundle/bundle.js';
import type { Store } from '../../../src/core/store/db.js';
import { NAMES, seedWorld, USER } from './seed.js';

const opened: Store[] = [];
let dir: string;
let first: Bundle;
let second: Bundle;

beforeAll(async () => {
  const a = await seedWorld(opened);
  const b = await seedWorld(opened);
  // The second tester ran more: one more failed run, and a pending request.
  b.store.agentRuns.insert({
    id: 'arun_extra', workspaceId: b.root.id, role: 'reviewer', model: { provider: 'codex', model: 'gpt-6.1-sol' }, token: 't', status: 'failed',
    startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:05:00.000Z', failureReason: 'rate limit reached', promptVersion: 'p',
  });
  b.store.userRequests.insert({ id: 'req_extra', workspaceId: b.root.id, agentRunId: 'arun_extra', kind: 'captcha', details: 'd', status: 'pending', createdAt: '2026-11-03T10:00:00.000Z' });
  const opts = { level: 'standard' as const, appVersion: '0.1.0', platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' }, clis: [{ name: 'claude', version: '2.1.0' }] };
  first = buildBundle({ store: a.store, config: a.config }, { ...opts, note: 'The first tester found the setup slow.' });
  second = buildBundle({ store: b.store, config: b.config }, { ...opts, platform: { os: 'win32', arch: 'x64', node: '25.0.0' }, level: 'with_texts' });
  dir = mkdtempSync(join(tmpdir(), 'bif-report-'));
  mkdirSync(join(dir, 'inbox'));
  writeFileSync(join(dir, 'inbox', bundleFileName(first)), encodeBundle(first));
  writeFileSync(join(dir, 'inbox', bundleFileName(second)), encodeBundle(second));
  writeFileSync(join(dir, 'inbox', 'notes.txt'), 'not a bundle, and not named like one');
  writeFileSync(join(dir, 'later.json.gz'), gzipSync(Buffer.from(JSON.stringify({ ...first, manifest: { ...first.manifest, format: BUNDLE_FORMAT + 1 } }))));
});
afterAll(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('readBundles', () => {
  it('reads the bundle files of a folder and single files, and refuses what it does not know', () => {
    const r = readBundles([join(dir, 'inbox'), join(dir, 'later.json.gz'), join(dir, 'missing.json.gz')]);
    expect(r.bundles.map((b) => b.bundle.id).sort()).toEqual([first.id, second.id].sort());
    expect(r.refused).toEqual([
      { file: join(dir, 'later.json.gz'), reason: expect.stringContaining(`format version ${BUNDLE_FORMAT + 1}`) },
      { file: join(dir, 'missing.json.gz'), reason: expect.stringContaining('cannot be read') },
    ]);
  });

  it('reads a bundle given twice once', () => {
    const file = join(dir, 'inbox', bundleFileName(first));
    expect(readBundles([file, join(dir, 'inbox')]).bundles).toHaveLength(2);
  });
});

describe('feedbackReport', () => {
  let report: string;
  beforeAll(() => {
    const r = readBundles([join(dir, 'inbox'), join(dir, 'later.json.gz')]);
    report = feedbackReport(r.bundles, r.refused);
  });

  it('says how many bundles were read and which files were refused, with the reason', () => {
    expect(report).toMatch(/^# BIF feedback report/);
    expect(report).toContain('2 bundles read');
    expect(report).toContain('## Refused files');
    expect(report).toMatch(new RegExp(`later\\.json\\.gz.*format version ${BUNDLE_FORMAT + 1}`));
  });

  it('lists versions and platforms per bundle', () => {
    const table = report.slice(report.indexOf('## Versions and platforms'), report.indexOf('## Combined'));
    expect(table).toContain(`| ${first.id} |`);
    expect(table).toContain('darwin arm64');
    expect(table).toContain('win32 x64');
    expect(table).toContain('claude 2.1.0');
    expect(table).toContain('with review texts');
    expect(table).toContain(String(first.manifest.schemaVersion));
  });

  it('has a combined part and one part per tester, each with every block of the design', () => {
    expect(report).toContain('## Combined (2 bundles)');
    expect(report).toContain(`## Tester ${first.id}`);
    expect(report).toContain(`## Tester ${second.id}`);
    const blocks = ['Runs and failures', 'Review: pass rate and rounds', 'Cost and tokens by role', 'Cost and tokens by model', 'Most frequent lesson-signal categories', 'Rating agreement', 'Review council', 'Persona panel', 'Requests to the person'];
    for (const part of [report.slice(report.indexOf('## Combined'), report.indexOf('## Tester')), report.slice(report.indexOf(`## Tester ${first.id}`))]) {
      for (const b of blocks) expect(part, b).toContain(`### ${b}`);
    }
    expect(report).toContain('The first tester found the setup slow.');
  });

  const part = (heading: string, block: string) => {
    const from = report.indexOf(heading);
    const start = report.indexOf(`### ${block}`, from);
    const end = report.indexOf('\n### ', start + 1);
    return report.slice(start, end === -1 ? undefined : end);
  };

  it('combined figures are the sums over the bundles', () => {
    const runsOf = (b: Bundle) => (b.sections.runs as Array<{ tables: { runs: Array<{ status: string }> } }>).flatMap((x) => x.tables.runs);
    const all = [...runsOf(first), ...runsOf(second)];
    const failed = all.filter((r) => r.status === 'failed').length;
    expect(part('## Combined', 'Runs and failures')).toContain(`| ${all.length} | ${failed} |`);
    expect(part('## Combined', 'Runs and failures')).toContain('| rate_limited | 1 |');
    expect(part(`## Tester ${first.id}`, 'Runs and failures')).toContain(`| ${runsOf(first).length} | ${runsOf(first).filter((r) => r.status === 'failed').length} |`);
    expect(part(`## Tester ${first.id}`, 'Runs and failures')).not.toContain('rate_limited');
    // Tasks: each seeded store has seven finished tasks (three verified; one failed, and so did the task
    // of withheld research and the two arms of the experiment on it); a verified task took two rounds.
    expect(part('## Combined', 'Review: pass rate and rounds')).toContain('| 14 | 6 | 43% | 0% | 2 |');
    expect(part(`## Tester ${second.id}`, 'Review: pass rate and rounds')).toContain('| 7 | 3 | 43% | 0% | 2 |');
  });

  it('cost, signals, ratings, council, panel and requests are reported', () => {
    expect(part('## Combined', 'Cost and tokens by role')).toMatch(/\| worker \| \d+ \| 2520 \| 0\.0246 \|/);
    expect(part(`## Tester ${first.id}`, 'Cost and tokens by model')).toMatch(/\| claude\/sonnet \| \d+ \| 1260 \| 0\.0123 \|/);
    expect(part('## Combined', 'Most frequent lesson-signal categories')).toContain('| review:blocking:news_scan |');
    expect(part(`## Tester ${first.id}`, 'Rating agreement')).toMatch(/\| \d+ \| \d+ \| \d+% \|/);
    expect(part(`## Tester ${first.id}`, 'Review council')).toContain('| 1 | 0 | 6 | 1 | 1 | 1 | 1 | 1 |');
    expect(part('## Combined', 'Review council')).toContain('| 2 | 0 | 6 | 2 | 2 | 2 | 2 | 2 |');
    expect(part(`## Tester ${first.id}`, 'Persona panel')).toContain('| 1 | 1 | 1 | 0 | 2 |');
    const requests = part(`## Tester ${second.id}`, 'Requests to the person');
    expect(requests).toContain('| Kind | Asked | Answered | Denied | Closed by a stop | Pending | Median wait |');
    expect(requests).toContain('| login | 1 | 1 | 0 | 0 | 0 | 30 min |');
    expect(requests).toContain('| escalation | 1 | 1 | 0 | 0 | 0 | 1 h |');
    expect(requests).toContain('| captcha | 1 | 0 | 0 | 0 | 1 | — |');
    // A request that "Stop research" closed is no denial by the person, and its wait is no answer time.
    expect(requests).toContain('| approval | 2 | 1 | 0 | 1 | 0 | 3 min |');
  });

  it('holds nothing a bundle does not hold', () => {
    for (const gone of [...Object.values(NAMES), USER]) expect(report).not.toContain(gone);
  });

  it('with no bundle says so', () => {
    expect(feedbackReport([], [])).toContain('No bundle was read');
  });
});

describe('main', () => {
  it('writes the report where asked and answers 0; 1 when a file was refused or nothing was given', () => {
    const out = join(dir, 'report.md');
    const logs: string[] = [];
    const io = { out: (s: string) => logs.push(s), err: (s: string) => logs.push(`ERR ${s}`) };
    expect(main([join(dir, 'inbox'), '--out', out], io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('## Combined (2 bundles)');
    expect(main([join(dir, 'inbox')], io)).toBe(0);
    expect(logs.some((l) => l.startsWith('# BIF feedback report'))).toBe(true);
    expect(main([join(dir, 'inbox'), join(dir, 'later.json.gz')], io)).toBe(1);
    expect(logs.some((l) => l.startsWith('ERR') && l.includes('later.json.gz') && l.includes('format version'))).toBe(true);
    expect(main([], io)).toBe(1);
    expect(logs.at(-1)).toContain('Usage');
  });
});
