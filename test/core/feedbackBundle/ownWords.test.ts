/**
 * A name rule changes no figure the tool wrote (feedback bundle redaction, `redact.ts`): businesses
 * named with an id prefix ("Arun", "Pipe"), with words of the tool's labels ("Phase", "Synthetic",
 * "Submit"), with a phase ("Synthesis"), a model ("Opus") and the word a person is written as
 * ("Tester") are added to the seeded world, and the standard bundle keeps every id, label, phase, task
 * type, tool and event name, model name and `tester` actor it had without them. The full names of
 * several words are still replaced where the tester typed them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBundle, type Bundle, type BundleOptions } from '../../../src/core/feedbackBundle/bundle.js';
import type { TreeBlock } from '../../../src/core/feedbackBundle/sections.js';
import { redaction } from '../../../src/core/feedbackBundle/redact.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import type { Workspace } from '../../../src/core/types.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';
import { seedWorld, USER, type Seeded } from './seed.js';

const ADDED = ['Arun Pipe Works', 'Action Phase Synthetic Submit Prompt', 'Synthesis', 'Opus', 'Tester'];
const OPTS: BundleOptions = { level: 'standard', appVersion: '0.1.0', platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' } };

const opened: Store[] = [];
let w: Seeded;
/** The standard bundle of the seeded world, and the one of the same store once the five businesses exist. */
let before: Bundle;
let after: Bundle;
let added: Workspace[];
beforeAll(async () => {
  w = await seedWorld(opened);
  const build = () => buildBundle({ store: w.store, config: w.config }, OPTS);
  before = build();
  added = ADDED.map((name) => createWorkspace(w.store, { name, sector: 'retail' }));
  // The tester writes of two of them by their full names, each in a reason on the business itself.
  for (const ws of added.slice(0, 2)) {
    recordFeedback(w.store, {
      workspaceId: ws.id, actor: USER, kind: 'weights_change', targetType: 'workspace', targetId: ws.id, createdAt: '2026-11-03T10:00:00.000Z',
      afterJson: { impact: 2 }, reason: `the weights of ${ws.name} were wrong, and ${ws.name.toLowerCase()} said so`,
    });
  }
  after = build();
});
afterAll(() => {
  for (const s of opened.splice(0)) s.close();
});

type Row = Record<string, unknown>;
const blocks = (b: Bundle, section: string): TreeBlock[] => b.sections[section] as TreeBlock[];
/** The rows of one table of a section, over the given trees. */
const rowsOf = (b: Bundle, section: string, table: string, trees: readonly string[]): Row[] =>
  blocks(b, section).filter((x) => trees.includes(x.tree)).flatMap((x) => (x.tables[table] ?? []) as Row[]);
const sorted = (ids: unknown[]): unknown[] => [...ids].sort();

/** Every place where two values differ, as `path: a → b` (a key or an item that only one has is a difference). */
function differences(a: unknown, b: unknown, path = ''): string[] {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => differences((a as Row)[k], (b as Row)[k], path ? `${path}.${k}` : k));
  }
  return Object.is(a, b) ? [] : [`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}

/** The bundle without what the added businesses bring: their own trees, and the manifest's counts and stamps. */
function withoutAdded(b: Bundle): { manifest: Row; sections: Row } {
  const addedIds = new Set(added.map((x) => x.id));
  const { id: _id, createdAt: _at, trees: _trees, rows: _rows, ...manifest } = b.manifest;
  return {
    manifest,
    sections: Object.fromEntries(
      Object.entries(b.sections).map(([name, s]) => [name, Array.isArray(s) ? (s as TreeBlock[]).filter((x) => !addedIds.has(x.tree)) : s]),
    ),
  };
}

describe('a standard bundle of a store that has businesses named with the words of the tool', () => {
  it('the comparison sees a difference when there is one, and none between two bundles of one store', () => {
    const again = buildBundle({ store: w.store, config: w.config }, OPTS);
    expect(differences(withoutAdded(after), withoutAdded(again))).toEqual([]);
    expect(differences({ a: [{ phase: 'synthesis' }] }, { a: [{ phase: 'ws_1' }] })).toEqual(['a.0.phase: "synthesis" → "ws_1"']);
    expect(differences({ a: 1 }, { a: 1, b: 2 })).toEqual(['b: undefined → 2']);
  });

  it('has a block for each of the five businesses, under its stored id', () => {
    for (const section of ['trees', 'runs', 'tasks', 'feedback']) {
      expect(blocks(after, section).map((x) => x.tree), section).toEqual([w.root.id, w.other.id, ...added.map((x) => x.id)]);
    }
    expect(rowsOf(after, 'trees', 'nodes', added.map((x) => x.id)).map((n) => n.id)).toEqual(added.map((x) => x.id));
  });

  it("every id is the store's id: of the runs, the tasks, the research runs, the pipelines and the nodes", () => {
    const { store } = w;
    const seeded = [w.root.id, w.child.id, w.other.id];
    const trees = [w.root.id, w.other.id];
    const runs = seeded.flatMap((ws) => store.agentRuns.list({ workspaceId: ws }));
    const tasks = seeded.flatMap((ws) => store.tasks.list({ workspaceId: ws }));
    expect(runs.length).toBeGreaterThan(5);
    expect(tasks.length).toBeGreaterThan(4);
    expect(sorted(rowsOf(after, 'runs', 'runs', trees).map((r) => r.id))).toEqual(sorted(runs.map((r) => r.id)));
    expect(sorted(rowsOf(after, 'runs', 'runs', trees).map((r) => r.taskId))).toEqual(sorted(runs.map((r) => r.taskId)));
    expect(sorted(rowsOf(after, 'tasks', 'tasks', trees).map((t) => t.id))).toEqual(sorted(tasks.map((t) => t.id)));
    expect(sorted(rowsOf(after, 'tasks', 'tasks', trees).map((t) => t.researchRunId))).toEqual(sorted(tasks.map((t) => t.runId)));
    expect(sorted(rowsOf(after, 'tasks', 'researchRuns', trees).map((r) => r.id))).toEqual(sorted(seeded.flatMap((ws) => store.researchRuns.list({ workspaceId: ws })).map((r) => r.id)));
    expect(sorted(rowsOf(after, 'tasks', 'pipelines', trees).map((p) => p.id))).toEqual(sorted(seeded.flatMap((ws) => store.pipelines.list({ workspaceId: ws })).map((p) => p.id)));
    expect(sorted(rowsOf(after, 'trees', 'nodes', trees).map((n) => n.id))).toEqual(sorted(seeded));
    // Every row says its node by the node's stored id.
    const nodeIds = new Set(store.workspaces.list().map((x) => x.id));
    for (const [name, section] of Object.entries(after.sections)) {
      if (!Array.isArray(section)) continue;
      for (const block of section as TreeBlock[]) {
        for (const [table, rows] of Object.entries(block.tables)) {
          for (const r of rows as Row[]) if (typeof r.workspaceId === 'string') expect(nodeIds.has(r.workspaceId), `${name}.${table}: ${r.workspaceId}`).toBe(true);
        }
      }
    }
  });

  it('no id, label, phase, task type, tool or event name, model name or tester actor differs from the bundle without the five businesses', () => {
    expect(differences(withoutAdded(before), withoutAdded(after))).toEqual([]);
    // What the comparison covers: the phases, the task types, the models, the events and the tester are there to be damaged.
    const text = JSON.stringify(withoutAdded(after));
    for (const figure of ['"phase":"deep_dives"', '"model":"opus"', '"claude/opus"', '"actor":"tester"', '"kind":"include_override"', '"type":"news_scan"', '"action":"start_research"', '"phases":2']) {
      expect(text, figure).toContain(figure);
    }
  });

  it('no label of a row is changed by a business named with a word of it: every label of the seeded rows, word by word', () => {
    // The labels of the rows: every value of a tree section that is one lower-case word, or such words joined as the tool joins them.
    const labels = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === 'string') {
        if (/^[a-z]+([_:/-][a-z]+)*$/.test(v)) labels.add(v);
      } else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    for (const section of Object.values(before.sections)) if (Array.isArray(section)) collect(section);
    // Not the tool's words: the names the seed gave its council members, and the section of the profile the interviewer named.
    for (const given of ['evidence-reader', 'brief-reader', 'pricing']) expect(labels.delete(given), given).toBe(true);
    expect(labels.size).toBeGreaterThan(80);
    // A business for each word of each label, in a store of its own.
    const words = new Set([...labels].flatMap((l) => l.split(/[^a-z]+/)));
    const store = openStore(':memory:');
    opened.push(store);
    for (const word of words) createWorkspace(store, { name: word[0]!.toUpperCase() + word.slice(1), sector: 'retail' });
    const r = redaction({ store, config: w.config });
    expect([...labels].filter((l) => r.text(l) !== l)).toEqual([]);
  });

  it('a full name of several words typed in a reason is replaced by the id of the business, in any case', () => {
    const events = rowsOf(after, 'feedback', 'events', added.map((x) => x.id));
    expect(events.map((e) => e.reason)).toEqual(added.slice(0, 2).map((ws) => `the weights of ${ws.id} were wrong, and ${ws.id} said so`));
    expect(events.map((e) => e.actor)).toEqual(['tester', 'tester']);
    const text = JSON.stringify(after).toLowerCase();
    for (const name of ADDED.slice(0, 2)) expect(text, name).not.toContain(name.toLowerCase());
  });
});
