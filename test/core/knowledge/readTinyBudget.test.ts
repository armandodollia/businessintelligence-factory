/**
 * KS-4 re-gate: no response or prompt section ever exceeds its budget, and one that drops content
 * says so — `truncated`, how many items, a cursor (tools) / a count (prompt sections). An agent must
 * never read "nothing fit" as "nothing exists".
 * - Tool calls: the effective budget is clamped up to `MIN_RESPONSE_TOKENS`, which always fits the
 *   truncation notice.
 * - The reviewer context degrades: footer ids → count footer → one count line → empty (budget 1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { budgetFor, estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { reviewFactContext } from '../../../src/core/knowledge/factReview.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { MIN_RESPONSE_TOKENS } from '../../../src/core/knowledge/tools.js';
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

describe('tool responses at tiny configured budgets (clamped to MIN_RESPONSE_TOKENS)', () => {
  for (const n of [1, 10]) {
    it(`budget ${n}: every tool stays within the floor and reports truncated, more and a cursor`, async () => {
      const t = ks4(opened, withBudget(n));
      const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
      for (let i = 0; i < 5; i++) t.fact('ws_a', `Globex fact ${i} ${'detail '.repeat(30)}`, { entityId: e.id, lastConfirmedAt: '2025-01-01T00:00:00.000Z' }); // stale: list_changes has items
      const c = t.ctx('ws_a');
      const calls: Array<[string, Record<string, unknown>]> = [
        ['search', { query: 'globex', kinds: ['fact'] }],
        ['get_card', { entity_id: e.id }],
        ['read_workspace', { workspace_id: 'ws_a' }],
        ['list_changes', { since: '2000-01-01' }],
        ['expand', { id: e.id }],
      ];
      for (const [tool, input] of calls) {
        const r = await t.call<{ truncated: boolean; more?: number; cursor?: string }>(c, tool as never, input);
        expect(estimateTokens(JSON.stringify(r)), tool).toBeLessThanOrEqual(MIN_RESPONSE_TOKENS);
        expect(r.truncated, tool).toBe(true);
        expect(r.more, tool).toBeGreaterThan(0);
        expect(r.cursor, tool).toBeDefined();
      }
    });
  }

  it('a header too large for max_tokens is shortened (header_cut, Opus finding 4); expand with a larger budget serves it whole', async () => {
    const t = ks4(opened);
    const f = t.fact('ws_a', `Long claim ${'word '.repeat(700)}`);
    const c = t.ctx('ws_a');
    const small = await t.call<{ id: string; claim?: string; header_cut?: boolean; tokens: number; notes?: string[] }>(c, 'expand', { id: f.id, max_tokens: MIN_RESPONSE_TOKENS });
    expect(small.tokens).toBeLessThanOrEqual(MIN_RESPONSE_TOKENS);
    expect(small).toMatchObject({ id: f.id, header_cut: true });
    expect(JSON.stringify(small.notes ?? [])).not.toMatch(/nothing of this page fits/);
    const big = await t.call<{ claim: string }>(c, 'expand', { id: f.id, max_tokens: 4000 });
    expect(big.claim).toBe(f.claim);
  });

  it('an item larger than the page is shortened and marked cut, and the cursor moves on (KS-8: no placeholder)', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', 'Quote source text.');
    const f = t.fact('ws_a', 'Big evidence', { evidence: [a.id] });
    for (let i = 0; i < 3; i++) knowledgeRepos(t.store).findingEvidence.insert({ findingId: f.id, seq: i, artifactId: a.id, quote: `quote ${i} ${'q'.repeat(1500)}` });
    const c = t.ctx('ws_a');
    const r = await t.call<{ tokens: number; items: Array<{ type: string; cut?: boolean; omitted?: boolean }> }>(c, 'expand', { id: f.id, max_tokens: 300 });
    expect(r.tokens).toBeLessThanOrEqual(300);
    expect(r.items[0]).toMatchObject({ type: 'evidence', cut: true });
    expect(JSON.stringify(r)).not.toMatch(/retry_cursor|omitted/);
  });
});

