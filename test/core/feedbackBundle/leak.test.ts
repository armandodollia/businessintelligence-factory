/**
 * The leak test of the feedback bundle (design §7; plan review focus 1), against the encoded file:
 * a store seeded with a marker in every text field, an upload, a stored site password, business and
 * node names, the user id and machine paths in failure messages. None of it is in a standard bundle;
 * uploads, upload-derived text, internal records, passwords, names, the user id and machine paths are
 * in neither level. The tester's own words are in both, as typed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBundle, encodeBundle, type BundleLevel } from '../../../src/core/feedbackBundle/bundle.js';
import { REDACTED } from '../../../src/core/store/redact.js';
import { getExperiment } from '../../../src/core/learning/experiments.js';
import type { Store } from '../../../src/core/store/db.js';
import { INBOX_PASSWORD, KEYS, MACHINE_PARTS, NAME_WORDS, NAMES, NEVER, OWN, own, PASSWORD, RESEARCH, seedWorld, SITE_HOST, SITE_URL, USER, WITHHELD_REASONS, type Seeded } from './seed.js';

const opened: Store[] = [];
let w: Seeded;
beforeAll(async () => {
  w = await seedWorld(opened);
});
afterAll(() => {
  for (const s of opened.splice(0)) s.close();
});

/** The file as a tester would save it, decompressed to the text a reader of it sees. */
function fileText(level: BundleLevel): string {
  const bundle = buildBundle(
    { store: w.store, config: w.config },
    { level, note: `${own('note')} about ${NAMES.business}, logged in with ${PASSWORD}`, appVersion: '0.1.0', platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' } },
  );
  return gunzipSync(encodeBundle(bundle)).toString('utf8');
}

/** Every stored text of the store, to prove a marker really is in the data the bundle is built from. */
function storeText(): string {
  const tables = (w.store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>)
    // Full-text index tables repeat what the base tables hold.
    .filter((t) => !/_fts(_|$)/.test(t.name));
  return tables.map((t) => JSON.stringify(w.store.db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
}

/**
 * A token as it may stand in JSON text as well: a Windows path's back-slashes are doubled there, so
 * `C:\\Users\\x` is searched for in that form too.
 */
const inText = (text: string, t: string) => text.includes(t) || text.includes(JSON.stringify(t).slice(1, -1));

const absent = (text: string, tokens: readonly string[], what: string) => {
  const found = tokens.filter((t) => inText(text, t));
  expect(found, `${what} found in the bundle`).toEqual([]);
};

describe('the seed', () => {
  it('holds every marker, name, password and the user id in the store the bundle is built from', () => {
    const stored = `${storeText()}\n${readFileSync(join(w.dir, w.upload.path), 'utf8')}`;
    const missing = [...RESEARCH, ...NEVER, ...KEYS, ...OWN.filter((t) => !t.includes('-note-')), ...Object.values(NAMES), USER, PASSWORD, INBOX_PASSWORD, 'zq-home-dir', w.dir, SITE_URL].filter(
      (t) => !inText(stored, t),
    );
    expect(missing).toEqual([]);
    // A word of a name stands alone and inside a key too, not only in the name.
    for (const t of ['for Quillfeather and', "zephyrine's shop", 'zephyrineShare', 'outfitters_total']) expect(stored, t).toContain(t);
    expect(RESEARCH.length).toBeGreaterThan(40);
    expect(NEVER.length).toBeGreaterThanOrEqual(8);
    expect(KEYS.length).toBeGreaterThanOrEqual(7);
  });

  it('holds withheld research that failed: a task, its run and the arms of an experiment, each with its own reason', () => {
    const { store } = w;
    expect(store.tasks.get(w.withheldTask.id)).toMatchObject({ type: 'own_stakeholders', status: 'failed' });
    const armTasks = w.experiment.arms.flatMap((a) => a.taskIds).map((id) => store.tasks.get(id)!);
    expect(armTasks.map((t) => t.status)).toEqual(['failed', 'failed']);
    const reasons = [
      ...[w.withheldTask, ...armTasks].flatMap((t) => [store.tasks.get(t.id)!.failureReason, ...store.agentRuns.list({ taskId: t.id }).map((r) => r.failureReason)]),
      getExperiment(store, w.experiment.id)!.failureReason,
    ];
    // Every failed run made a marker of its own: each is the reason of a run, and the last of each task is the task's.
    expect(WITHHELD_REASONS.length).toBeGreaterThanOrEqual(3);
    for (const token of WITHHELD_REASONS) expect(reasons.some((r) => r?.includes(token)), token).toBe(true);
    for (const t of [w.withheldTask, ...armTasks]) expect(WITHHELD_REASONS.some((token) => store.tasks.get(t.id)!.failureReason?.includes(token)), t.id).toBe(true);
  });
});

/** What P1 to P3 of the council's first round were about, at one level. */
function upheldLeaks(level: BundleLevel, read: () => string) {
  it('holds no key of a free-form record: not of an edited profile, not of a before / after value, not of a digest', () => {
    absent(read(), KEYS, 'a key of a free-form record');
    const parsed = JSON.parse(read()) as { sections: { feedback: Array<{ tree: string; tables: { events: Array<Record<string, unknown>> } }> } };
    const events = parsed.sections.feedback.find((b) => b.tree === w.root.id)!.tables.events;
    const edit = events.find((e) => e.kind === 'profile_edit')!;
    // A profile edit says which sections changed and how many values each held, and nothing of them.
    expect(edit).not.toHaveProperty('before');
    expect(edit).not.toHaveProperty('after');
    expect(edit.profileChange).toEqual([
      { section: 'pricing', leavesBefore: 1, leavesAfter: 2 },
      { section: 'key_1', leavesBefore: 1, leavesAfter: 2 },
    ]);
    // Another record keeps its figures under keys that say nothing.
    expect(events.some((e) => JSON.stringify(e.after) === JSON.stringify({ include: true, weights: { key_1: 0.4, key_2: 0.6 } }))).toBe(true);
    expect(events.some((e) => JSON.stringify(e.before) === JSON.stringify({ include: null, key_1: 3 }))).toBe(true);
  });

  it('holds no distinctive word of a business name: not alone in a text, not inside the key of a free-form record', () => {
    absent(read().toLowerCase(), NAME_WORDS, 'a word of a business name');
    expect(read()).toContain(`the figures for ${w.other.id} and for ${w.root.id}'s shop`);
    const parsed = JSON.parse(read()) as { sections: { feedback: Array<{ tree: string; tables: { events: Array<Record<string, unknown>> } }> } };
    const events = parsed.sections.feedback.find((b) => b.tree === w.root.id)!.tables.events;
    expect(events.some((e) => JSON.stringify(e.after) === JSON.stringify({ include: false, key_1: 0.7, key_2: 3 }))).toBe(true);
  });

  it('holds no failure reason of withheld research, in any section: its failures are counted under their class', () => {
    absent(read(), WITHHELD_REASONS, 'a failure reason of withheld research');
    const parsed = JSON.parse(read()) as { sections: Record<string, Array<{ tree: string; tables: Record<string, Array<Record<string, unknown>>> }>> };
    const tables = (section: string) => parsed.sections[section]!.find((b) => b.tree === w.root.id)!.tables;
    // The metrics still count the failed runs of the withheld task, under their class alone.
    const failedRuns = w.store.agentRuns.list({ taskId: w.withheldTask.id }).filter((r) => r.status === 'failed').length;
    expect(failedRuns).toBeGreaterThan(0);
    expect(tables('metrics').failuresByReason).toContainEqual({ failureClass: 'error', runs: failedRuns });
    // The experiment still says that its arm tasks failed, and nothing of why.
    const arms = (tables('audits').experiments!.find((e) => e.id === w.experiment.id)!.arms as Array<{ tasks: Array<Record<string, unknown>> }>).flatMap((a) => a.tasks);
    expect(arms).toHaveLength(2);
    for (const t of arms) expect(t).toEqual({ taskId: expect.any(String), status: 'failed', round: expect.any(Number), finalScore: null });
  });

  it(level === 'standard' ? 'holds no address of a site under research: a URL in a carried text is written <url>' : 'keeps the addresses in the texts it carries', () => {
    const text = read();
    if (level === 'standard') {
      absent(text, [SITE_HOST, SITE_URL], 'the address of a site under research');
      expect(text).toContain('navigation failed: net::ERR_NAME_NOT_RESOLVED at <url>');
    } else {
      expect(text).toContain(`navigation failed: net::ERR_NAME_NOT_RESOLVED at ${SITE_URL}`);
    }
  });
}

describe('a standard bundle', () => {

  it('holds no name of a competitor the tester wrote in a reason: not whole, not by its distinctive word', () => {
    expect(storeText()).toContain('Brindlewick Freight');
    const text = fileText('standard');
    expect(text.toLowerCase()).not.toContain('brindlewick');
    expect(text).toContain('we lost two deals to cmp_named, and cmp_named undercut us');
  });

  it('at the fuller level a competitor is named, as the review texts name it', () => {
    expect(fileText('with_texts')).toContain('Brindlewick');
  });
  let text: string;
  beforeAll(() => {
    text = fileText('standard');
  });

  it('holds no research content: no marker of any text field', () => {
    absent(text, RESEARCH, 'research text');
  });

  it('holds nothing of an upload, of text taken from one, or of an internal stakeholder record', () => {
    absent(text, NEVER, 'upload or internal text');
    absent(text, [w.upload.sha256, w.upload.path], 'the upload file');
  });

  it('holds no business or node name, no user id, no stored password and no machine path', () => {
    absent(text, Object.values(NAMES), 'a business or node name');
    absent(text, [USER], 'the user id');
    absent(text, [PASSWORD, INBOX_PASSWORD], 'a stored password');
    absent(text, [...MACHINE_PARTS, w.dir, w.config.dataDir], 'a machine path');
  });

  it("holds the tester's own words as typed, with passwords and names redacted in them", () => {
    const missing = OWN.filter((t) => !text.includes(t));
    expect(missing).toEqual([]);
    expect(text).toContain(`I used ${REDACTED} on ${w.root.id}`);
    expect(text).toContain(`about ${w.root.id}, logged in with ${REDACTED}`);
  });

  upheldLeaks('standard', () => text);

  it('writes the tester as tester and has no texts section', () => {
    const parsed = JSON.parse(text) as { sections: Record<string, unknown> };
    expect(parsed.sections).not.toHaveProperty('texts');
    expect(text).toContain('"actor":"tester"');
  });
});

describe('a bundle with review texts', () => {
  let text: string;
  beforeAll(() => {
    text = fileText('with_texts');
  });

  it('holds the texts it is for: review issues, council findings, failure messages in full, decision lines', () => {
    for (const t of [
      'ZQRES-review-issue-7731', 'ZQRES-council-upheld-7731', 'ZQRES-council-question-7731', 'ZQRES-failure-tail-7731', 'ZQRES-attempt-failure-tail-7731',
      'ZQRES-experiment-failure-tail-7731', 'ZQRES-retro-failure-tail-7731', 'ZQRES-learning-failure-tail-7731', 'ZQRES-deliverable-summary-7731',
    ]) {
      expect(text, t).toContain(t);
    }
  });

  it('holds nothing of an upload, of text taken from one, or of an internal stakeholder record', () => {
    absent(text, NEVER, 'upload or internal text');
    absent(text, [w.upload.sha256, w.upload.path], 'the upload file');
  });

  it('holds no business or node name, no user id, no stored password and no machine path', () => {
    absent(text, Object.values(NAMES), 'a business or node name');
    absent(text, [USER], 'the user id');
    absent(text, [PASSWORD, INBOX_PASSWORD], 'a stored password');
    absent(text, [...MACHINE_PARTS, w.dir, w.config.dataDir], 'a machine path');
  });

  upheldLeaks('with_texts', () => text);

  it("holds the tester's own words as typed", () => {
    expect(OWN.filter((t) => !text.includes(t))).toEqual([]);
  });
});
