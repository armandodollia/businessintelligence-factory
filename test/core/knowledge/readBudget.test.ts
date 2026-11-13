/**
 * KS-4: design §18 "Budgets" (no response over its budget or `hardMaxTokens`; cursors return the
 * rest with no loss or repeat; a cursor is bound to its request) and the retrieval log (one row per
 * call, every served item listed, token count = the response's).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { budgetFor, estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4, type Ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Paged = { tokens: number; truncated: boolean; more?: number; cursor?: string; content_trust: string };

/** Calls `tool` page by page; returns every page. */
async function allPages<T extends Paged>(t: Ks4, c: ReturnType<Ks4['ctx']>, tool: string, input: Record<string, unknown>): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const p = await t.call<T>(c, tool as never, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(p);
    if (!p.cursor) break;
    cursor = p.cursor;
  }
  return pages;
}

async function big(t: Ks4) {
  const ent = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
  for (let i = 0; i < 60; i++) {
    t.fact('ws_a', `Globex plan number ${i} costs ${i * 3} dollars per seat and includes feature ${'x'.repeat(i % 7)} for teams`, { entityId: ent.id });
  }
  const long = Array.from({ length: 40 }, (_, i) => `Section ${i}. Globex pricing details paragraph ${i} ${'lorem ipsum dolor '.repeat(30)}`).join('\n\n');
  const doc = await t.page('ws_a', long, { title: 'Globex pricing handbook' });
  return { ent, doc };
}

describe('budgets and cursors (design §9, §18)', () => {
  it('every response stays within its budget; paging returns every item once', async () => {
    const t = ks4(opened);
    const { ent, doc } = await big(t);
    const c = t.ctx('ws_a');
    const cases: Array<[string, Record<string, unknown>, 'search' | 'card' | 'expand', string]> = [
      ['search', { query: 'globex', kinds: ['fact'], limit: 50 }, 'search', 'hits'],
      ['get_card', { entity_id: ent.id }, 'card', 'lines'],
      ['expand', { id: ent.id }, 'expand', 'items'],
      ['read_artifact', { artifact_id: doc.id, mode: 'text' }, 'expand', 'items'],
      ['read_artifact', { artifact_id: doc.id, mode: 'raw' }, 'expand', 'items'],
      ['list_changes', { since: '2000-01-01' }, 'search', 'changes'],
    ];
    for (const [tool, input, kind, key] of cases) {
      const budget = budgetFor(t.config, 'worker', 'claude', kind);
      const pages = await allPages<Paged & Record<string, unknown>>(t, c, tool, input);
      for (const p of pages) {
        const size = estimateTokens(JSON.stringify(p));
        expect(size, `${tool} page size`).toBeLessThanOrEqual(budget);
        expect(p.tokens, tool).toBe(size);
        expect(p.content_trust).toBe('untrusted');
      }
      if (tool !== 'read_artifact' || input.mode !== 'raw') {
        const ids = pages.flatMap((p) => (p[key] as unknown[]).map((x) => JSON.stringify(x)));
        expect(new Set(ids).size, `${tool} no repeats`).toBe(ids.length);
      }
      if (pages.length > 1) expect(pages[0]!.truncated).toBe(true);
    }
    // Paged search returns exactly the 50 facts it found, each once.
    const pages = await allPages<Paged & { hits: Array<{ id: string }> }>(t, c, 'search', { query: 'globex', kinds: ['fact'], limit: 50 });
    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(pages.flatMap((p) => p.hits.map((h) => h.id))).size).toBe(50);
    expect(pages.slice(0, -1).every((p) => p.more! > 0)).toBe(true);
    // Raw pages, concatenated, are the whole (redacted) file.
    const raw = await allPages<Paged & { items: Array<{ text: string }> }>(t, c, 'read_artifact', { artifact_id: doc.id, mode: 'raw' });
    const text = raw.map((p) => p.items[0]!.text.replace(/^<<<EVIDENCE [^\n]*\n/, '').replace(/\n>>>$/, '')).join('');
    expect(text).toBe(t.artifacts.read(doc.id).bytes.toString('utf8'));
  });

  it('max_tokens lowers the budget (never raises it) and hardMaxTokens caps any role override', async () => {
    const t = ks4(opened, (cfg) => {
      cfg.knowledge = { ...(cfg.knowledge ?? {}), hardMaxTokens: 900, budgets: { roles: { worker: { search: 5000 } } } };
    });
    await big(t);
    const c = t.ctx('ws_a');
    const capped = await t.call<Paged>(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50 });
    expect(capped.tokens).toBeLessThanOrEqual(900);
    const small = await t.call<Paged>(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50, max_tokens: 200 });
    expect(small.tokens).toBeLessThanOrEqual(200);
    const raised = await t.call<Paged>(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50, max_tokens: 100000 });
    expect(raised.tokens).toBeLessThanOrEqual(900);
    expect((await t.handle(c, 'search', { query: 'globex', max_tokens: 5 })).ok).toBe(false); // below the floor
  });

  it('a cursor is bound to its request: another query, node or role rejects it', async () => {
    const t = ks4(opened);
    await big(t);
    const c = t.ctx('ws_a');
    const first = await t.call<Paged>(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50 });
    expect(first.cursor).toBeDefined();
    const wrong = await t.handle(c, 'search', { query: 'globex plan', kinds: ['fact'], limit: 50, cursor: first.cursor });
    expect(wrong).toEqual({ ok: false, error: 'invalid cursor: pass the `cursor` of the previous response exactly as returned, or repeat the call without one' });
    expect((await t.handle(t.ctx('ws_c'), 'search', { query: 'globex', kinds: ['fact'], limit: 50, cursor: first.cursor })).ok).toBe(false);
    expect((await t.handle(t.ctx('ws_a', 'orchestrator'), 'search', { query: 'globex', kinds: ['fact'], limit: 50, cursor: first.cursor })).ok).toBe(false);
    expect((await t.handle(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50, cursor: 'garbage' })).ok).toBe(false);
    // The same request continues, whatever max_tokens it asks for.
    expect((await t.handle(c, 'search', { query: 'globex', kinds: ['fact'], limit: 50, cursor: first.cursor, max_tokens: 400 })).ok).toBe(true);
  });
});

describe('retrieval log (design §13; hard ruling: every served item is listed)', () => {
  it('one row per call, with the served ids in order and the response token count', async () => {
    const t = ks4(opened);
    const { ent, doc } = await big(t);
    const c = t.ctx('ws_a', 'worker', { taskId: 'tsk_1' });
    const s = await t.call<Paged & { hits: Array<{ id: string; entity?: { id: string } }> }>(c, 'search', { query: 'globex plan', kinds: ['fact'], limit: 3 });
    const card = await t.call<Paged & { lines: string[] }>(c, 'get_card', { entity_id: ent.id });
    const ex = await t.call<Paged>(c, 'expand', { id: doc.id });
    const rows = t.rows(c.agentRunId);
    expect(rows.map((r) => r.tool)).toEqual(['search', 'get_card', 'expand']);
    expect(rows[0]).toMatchObject({
      role: 'worker', taskId: 'tsk_1', provider: 'claude', model: 'sonnet', promptVersion: 'pv_ks4', query: 'globex plan', scope: 'node',
      tokensReturned: s.tokens, resultCount: rows[0]!.resultIds.length, uploadDerived: false,
    });
    // Each fact hit and the entity named on it.
    expect(rows[0]!.resultIds).toEqual(s.hits.flatMap((h) => [{ id: h.id, kind: 'fact' }, { id: ent.id, kind: 'entity' }]));
    expect(s.hits.every((h) => h.entity?.id === ent.id)).toBe(true);
    // Every fact id shown on a card line is listed.
    const lineIds = card.lines.flatMap((l) => [...l.matchAll(/\[(fnd_[0-9A-Z]+)\]/g)].map((m) => m[1]!));
    expect(lineIds.length).toBeGreaterThan(0);
    for (const id of lineIds) expect(rows[1]!.resultIds.map((r) => r.id)).toContain(id);
    expect(rows[1]!.tokensReturned).toBe(card.tokens);
    expect(rows[2]!.resultIds[0]).toEqual({ id: doc.id, kind: 'artifact' });
    expect(rows[2]!.tokensReturned).toBe(ex.tokens);
    expect(rows.every((r) => r.latencyMs >= 0)).toBe(true);
    // A retrieval bus event per row, carrying only the id.
    expect(t.seen.filter((e) => e.type === 'retrieval').map((e) => (e as { retrievalEventId: string }).retrievalEventId)).toEqual(rows.map((r) => r.id));
  });

  it('a failed read (not found, bad cursor) writes no row', async () => {
    const t = ks4(opened);
    const c = t.ctx('ws_a');
    await t.handle(c, 'expand', { id: 'fnd_nope' });
    await t.handle(c, 'search', { query: 'x', cursor: 'bad' });
    expect(t.rows(c.agentRunId)).toEqual([]);
  });
});
