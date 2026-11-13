/**
 * KS-4 re-gate: no response or prompt section ever exceeds its budget, and one that drops content
 * says so — `truncated`, how many items, a cursor (tools) / a count (prompt sections). An agent must
 * never read "nothing fit" as "nothing exists".
 * - Tool calls: the effective budget is clamped up to the tool's floor (`READ_FLOOR_TOKENS`), at which
 *   every page serves an item (paging rework, floor invariant): never a "nothing fits" notice.
 * - The reviewer context degrades: footer ids → count footer → one count line → empty (budget 1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { budgetFor, estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { reviewFactContext } from '../../../src/core/knowledge/factReview.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const withBudget = (n: number | undefined) => (c: BifConfig) => {
  if (n === undefined) return;
  const all = { search: n, card: n, expand: n, briefing: n };
  c.knowledge = { ...(c.knowledge ?? {}), budgets: { default: all, roles: { reviewer: all, worker: all } } };
};

describe('reviewer context at budgets 1, 10 and the default', () => {
  for (const n of [1, 10, undefined]) {
    it(`budget ${n ?? 'default'}: within budget, and says what it left out`, () => {
      const t = ks4(opened, withBudget(n));
      const task: Task = t.store.tasks.insert({
        id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', subject: 'Acme',
        model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['c'], status: 'reviewing', round: 1, createdAt: T0,
      });
      const f = t.fact('ws_a', 'Acme sells three plans');
      knowledgeRepos(t.store).factObservations.insert({
        id: newId('obs'), workspaceId: 'ws_a', lineageId: f.id, findingId: f.id, kind: 'confirm', taskId: task.id, taskRound: 1,
        evidence: ['art_x'], status: 'pending', createdAt: T0,
      });
      const ctx = reviewFactContext(t.store, t.config, task, []);
      const budget = budgetFor(t.config, 'reviewer', undefined, 'briefing');
      expect(estimateTokens(ctx.section)).toBeLessThanOrEqual(budget);
      expect(ctx.factIds).toEqual([f.id]); // the slice is never cut
      if (n === 1) {
        expect(ctx.section).toBe('');
        expect(ctx.truncated).toBe(true);
        expect(ctx.results).toEqual([]);
      } else if (n === 10) {
        expect(ctx.section).toMatch(/1 item\(s\) left out/);
        expect(ctx.results).toEqual([]);
      } else {
        expect(ctx.section).toContain(`CONFIRMS [${f.id}]`);
        expect(ctx.truncated).toBe(false);
      }
    });
  }
});

describe('tool responses at tiny configured budgets (clamped to each tool\'s floor)', () => {
  for (const n of [1, 10]) {
    it(`budget ${n}: every tool stays within its floor, serves an item, and reports truncated, more and a cursor`, async () => {
      const t = ks4(opened, withBudget(n));
      const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
      for (let i = 0; i < 5; i++) t.fact('ws_a', `Globex fact ${i} ${'detail '.repeat(30)}`, { entityId: e.id, lastConfirmedAt: '2025-01-01T00:00:00.000Z' }); // stale: list_changes has items
      t.store.profiles.insert({ workspaceId: 'ws_a', data: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`profile key number ${i}`, i])) });
      const c = t.ctx('ws_a');
      const calls: Array<[string, Record<string, unknown>]> = [
        ['search', { query: 'globex', kinds: ['fact'] }],
        ['get_card', { entity_id: e.id }],
        ['read_workspace', { workspace_id: 'ws_a' }],
        ['list_changes', { since: '2000-01-01' }],
        ['expand', { id: e.id }],
      ];
      for (const [tool, input] of calls) {
        const r = await t.call<{ truncated: boolean; more?: number; cursor?: string; notes?: string[] } & Record<string, unknown>>(c, tool as never, input);
        expect(estimateTokens(JSON.stringify(r)), tool).toBeLessThanOrEqual(READ_FLOOR_TOKENS[tool as keyof typeof READ_FLOOR_TOKENS]);
        expect(((r.hits ?? r.lines ?? r.changes ?? r.items) as unknown[]).length, tool).toBeGreaterThan(0);
        expect(JSON.stringify(r.notes ?? []), tool).not.toMatch(/nothing|raised/);
        expect(r.truncated, tool).toBe(true);
        expect(r.more, tool).toBeGreaterThan(0);
        expect(r.cursor, tool).toBeDefined();
      }
    });
  }

  it('a long claim is an item, never a cut header (paging rework); at the floor it is cut with a pointer that returns it', async () => {
    const t = ks4(opened);
    const f = t.fact('ws_a', `Long claim ${'word '.repeat(700)}`);
    const c = t.ctx('ws_a');
    const small = await t.call<{ id: string; header_cut?: boolean; tokens: number; notes?: string[]; items: Array<Record<string, unknown>> }>(c, 'expand', { id: f.id, max_tokens: 1 });
    expect(small.tokens).toBeLessThanOrEqual(READ_FLOOR_TOKENS.expand);
    expect(small).toMatchObject({ kind: 'fact', id: f.id, subject: f.subject });
    expect(small.header_cut).toBeUndefined();
    expect(small.items[0]).toMatchObject({ type: 'claim', cut: true, full: { kind: 'same_call', tool: 'expand' } });
    const back = await t.call<{ items: Array<Record<string, unknown>> }>(c, 'expand', (small.items[0]!.full as { input: Record<string, unknown> }).input);
    expect(back.items[0]).toEqual({ type: 'claim', text: f.claim });
  });

  it('an item larger than the page is shortened and marked cut, and the cursor moves on (KS-8: no placeholder)', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', 'Quote source text.');
    const f = t.fact('ws_a', 'Big evidence', { evidence: [a.id] });
    for (let i = 0; i < 3; i++) knowledgeRepos(t.store).findingEvidence.insert({ findingId: f.id, seq: i, artifactId: a.id, quote: `quote ${i} ${'q'.repeat(1500)}` });
    const c = t.ctx('ws_a');
    // Re-gate (binding): a quote too long for a page (no passage id) points at this request, at it, with
    // the budget that holds it; following that pointer serves the whole quote.
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await t.call<{ tokens: number; cursor?: string; items: Array<Record<string, unknown>> }>(c, 'expand', { id: f.id, max_tokens: 300, ...(cursor ? { cursor } : {}) });
      expect(r.tokens).toBeLessThanOrEqual(300);
      items.push(...r.items);
      if (!r.cursor) break;
      cursor = r.cursor;
    }
    const cut = items.filter((x) => x.type === 'quote' && x.cut === true);
    expect(cut).toHaveLength(3);
    const back = await t.call<{ items: Array<Record<string, unknown>> }>(c, 'expand', (cut[1]!.full as { input: Record<string, unknown> }).input);
    expect(cut[1]!.full).toMatchObject({ kind: 'same_call', tool: 'expand' });
    expect(back.items[0]!.quote).toBe(`<<<EVIDENCE ${a.id}\nquote 1 ${'q'.repeat(1500)}\n>>>`);
    expect(JSON.stringify(items)).not.toMatch(/retry_cursor/);
  });
});

