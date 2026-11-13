import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeIds,
  narrowTo,
  scopeFor,
  scopeRank,
  setItemScopes,
  type KnowledgeScope,
} from '../../../src/core/knowledge/scope.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

/**
 * Tree 1: root R → divisions D1, D2; D1 → slices S1, S2.
 * Tree 2: root Q → division X (same names would not matter: ids are the boundary).
 */
function trees(): Store {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'bif-kscope-')), 'bif.db'));
  opened.push(s);
  const ws = (id: string, parent?: string) =>
    s.workspaces.insert({ id, name: id, sector: 'saas', createdAt: T0, ...(parent ? { parentWorkspaceId: parent } : {}) });
  ws('R');
  ws('D1', 'R');
  ws('D2', 'R');
  ws('S1', 'D1');
  ws('S2', 'D1');
  ws('Q');
  ws('X', 'Q');
  return s;
}

const sorted = (ids: string[]) => [...ids].sort();

describe('knowledge scope (KS-0, design §7.1)', () => {
  it('scopeFor: tree = every node of the tree; node = self, descendants and ancestors', () => {
    const s = trees();
    const s1 = scopeFor(s, 'S1');
    expect(s1.workspaceId).toBe('S1');
    expect(s1.rootId).toBe('R');
    expect(sorted(s1.treeIds)).toEqual(['D1', 'D2', 'R', 'S1', 'S2']);
    expect(s1.nodeIds).toEqual(['S1', 'D1', 'R']); // self, descendants, ancestors nearest first
    expect(s1.ancestorIds).toEqual(['D1', 'R']);

    const d1 = scopeFor(s, 'D1');
    expect(d1.nodeIds).toEqual(['D1', 'S1', 'S2', 'R']);
    const r = scopeFor(s, 'R');
    expect(sorted(r.nodeIds)).toEqual(sorted(r.treeIds)); // the root sees its whole tree by default
    expect(r.treeIds[0]).toBe('R');

    const x = scopeFor(s, 'X');
    expect(sorted(x.treeIds)).toEqual(['Q', 'X']);
    expect(() => scopeFor(s, 'nope')).toThrow(/not found/);
  });

  it('activeIds: node scope excludes siblings and cousins; tree scope includes them; never another tree', () => {
    const s = trees();
    const d1 = scopeFor(s, 'D1');
    expect(activeIds(d1, 'node')).not.toContain('D2');
    expect(activeIds(d1, 'tree')).toContain('D2');
    const s1 = scopeFor(s, 'S1');
    expect(activeIds(s1, 'node')).not.toContain('S2'); // sibling
    expect(activeIds(s1, 'node')).not.toContain('D2'); // cousin branch
    for (const mode of ['node', 'tree'] as const) {
      expect(activeIds(s1, mode)).not.toContain('Q');
      expect(activeIds(s1, mode)).not.toContain('X');
    }
  });

  it('narrowTo: a node of the same tree narrows to that node’s own view; anything else is undefined', () => {
    const s = trees();
    const s1 = scopeFor(s, 'S1');
    const d2 = narrowTo(s, s1, 'D2') as KnowledgeScope;
    expect(d2.workspaceId).toBe('D2');
    expect(d2.nodeIds).toEqual(['D2', 'R']);
    expect(d2.treeIds).toEqual(s1.treeIds);
    expect(narrowTo(s, s1, 'X')).toBeUndefined(); // other tree
    expect(narrowTo(s, s1, 'nope')).toBeUndefined(); // unknown: same answer
  });

  it('scopeRank orders own, descendant, ancestor, rest', () => {
    const s = trees();
    const d1 = scopeFor(s, 'D1');
    expect(scopeRank(d1, 'D1')).toBe(0);
    expect(scopeRank(d1, 'S2')).toBe(1);
    expect(scopeRank(d1, 'R')).toBe(2);
    expect(scopeRank(d1, 'D2')).toBe(3);
    expect(scopeRank(d1, 'X')).toBe(3);
    const ordered = ['X', 'R', 'S1', 'D2', 'D1'].sort((a, b) => scopeRank(d1, a) - scopeRank(d1, b));
    expect(ordered.slice(0, 3)).toEqual(['D1', 'S1', 'R']);
  });

  it('setItemScopes replaces an item’s labels, within its tree only', () => {
    const s = trees();
    const k = knowledgeRepos(s);
    s.findings.insert({
      id: 'fnd_1', workspaceId: 'D1', runId: 'r', taskId: 't', subject: 'Acme', claim: 'c', criteria: {}, evidence: [],
      status: 'verified', createdAt: T0,
    });
    const scopes = () => k.itemScopes.list({ itemKind: 'fact', itemId: 'fnd_1' }).map((r) => `${r.workspaceId}:${r.source}`);
    expect(scopes()).toEqual(['D1:home']); // from the insert trigger
    setItemScopes(s, 'fact', 'fnd_1', ['S1', 'S2', 'S1'], 'agent');
    expect(sorted(scopes())).toEqual(['S1:agent', 'S2:agent']);
    expect(() => setItemScopes(s, 'fact', 'fnd_1', ['S1', 'X'], 'user')).toThrow(/not found/);
    expect(() => setItemScopes(s, 'fact', 'fnd_1', [], 'user')).toThrow(/at least one/);
    expect(() => setItemScopes(s, 'fact', 'fnd_missing', ['D1'], 'user')).toThrow(/not found/);
    expect(sorted(scopes())).toEqual(['S1:agent', 'S2:agent']); // failed calls change nothing

    s.artifacts.insert({ id: 'art_1', workspaceId: 'R', kind: 'text', path: 'p', sha256: 'h', mime: 'text/plain', capturedAt: T0 });
    setItemScopes(s, 'artifact', 'art_1', ['D2'], 'user');
    expect(k.itemScopes.list({ itemKind: 'artifact', itemId: 'art_1' })).toEqual([
      { itemKind: 'artifact', itemId: 'art_1', workspaceId: 'D2', source: 'user' },
    ]);
  });
});
