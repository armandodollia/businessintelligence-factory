/**
 * KS-4 gate fixes: redact-then-cut on every served and prompt path that still cut first (reviewer
 * context claims and reasons, stored entity names, the quote-rejection error, duplicate-handshake
 * candidates), and the reviewer context fitted WHOLE (header, lifecycle lines, quotes) within the
 * reviewer briefing budget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config/schema.js';
import { budgetFor, estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { reviewFactContext } from '../../../src/core/knowledge/factReview.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const SECRET = 'Zq9xK2mPw7Lr';

function noPartOfSecret(text: string): void {
  for (let n = 4; n <= SECRET.length; n++) {
    expect(text).not.toContain(SECRET.slice(0, n));
    expect(text).not.toContain(SECRET.slice(SECRET.length - n));
  }
}

function setup() {
  const t = ks4(opened);
  t.store.identities.insert({ id: 'idn_s', workspaceId: 'ws_a', site: 's.test', name: 'n', email: 'n@s.test', password: SECRET, createdAt: T0 });
  const task: Task = t.store.tasks.insert({
    id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', subject: 'Acme',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['c'], status: 'reviewing', round: 1, createdAt: T0,
  });
  const observe = (kind: 'confirm' | 'retract', factId: string, reason?: string) =>
    knowledgeRepos(t.store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_a', lineageId: factId, findingId: factId, kind, taskId: task.id, taskRound: 1, evidence: ['art_x'],
      status: 'pending', createdAt: T0, ...(reason ? { reason } : {}),
    });
  return { t, task, observe };
}

/** `text` with SECRET placed so that it straddles character `at`. */
const straddling = (at: number) => `${'w'.repeat(at - 5)}${SECRET} tail text after the secret`;

describe('reviewer context: redact the whole text, then cut (gate finding 1)', () => {
  it('a secret straddling the 300-char claim cut or the reason cut leaves no part in the prompt', () => {
    const { t, task, observe } = setup();
    const prior = t.fact('ws_a', straddling(300));
    const out = t.fact('ws_a', 'new claim', { taskId: task.id, replacesId: prior.id, status: 'pending' });
    const retracted = t.fact('ws_a', straddling(300));
    observe('retract', retracted.id, straddling(300));
    const ctx = reviewFactContext(t.store, defaultConfig, task, [out]);
    expect(ctx.section).toContain(`REPLACES [${prior.id}]`);
    expect(ctx.section).toContain(`RETRACTS [${retracted.id}]`);
    noPartOfSecret(ctx.section);
    expect(ctx.section).toContain('[reda'); // the marker itself may be cut, never the secret
  });
});

describe('reviewer context: the whole section fits the briefing budget (gate finding 2)', () => {
  it('many confirmations and long retraction reasons stay within budget; left-out lines are said, shown facts listed', () => {
    const { t, task, observe } = setup();
    const facts = Array.from({ length: 120 }, (_, i) => t.fact('ws_a', `Fact number ${i} ${'claim text '.repeat(20)}`));
    for (const [i, f] of facts.entries()) observe(i % 2 ? 'retract' : 'confirm', f.id, i % 2 ? `reason ${'long '.repeat(400)}` : undefined);
    const ctx = reviewFactContext(t.store, defaultConfig, task, []);
    const budget = budgetFor(defaultConfig, 'reviewer', undefined, 'briefing');
    expect(estimateTokens(ctx.section)).toBeLessThanOrEqual(budget);
    expect(ctx.tokens).toBe(estimateTokens(ctx.section));
    expect(ctx.truncated).toBe(true);
    expect(ctx.section).toMatch(/left out for length/);
    // Every fact stays in the reviewer slice; only facts whose text is shown are logged.
    expect(ctx.factIds).toHaveLength(120);
    const shown = facts.filter((f) => ctx.section.includes(`[${f.id}] "Fact number`));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(120);
    expect(new Set(ctx.results.map((r) => r.id))).toEqual(new Set(shown.map((f) => f.id)));
  });
});

describe('other cuts that ran before redaction', () => {
  it('an entity name is redacted before the 200-char cut it is stored with', () => {
    const { t } = setup();
    const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'topic', name: straddling(200) });
    noPartOfSecret(e.name);
    noPartOfSecret(e.nameKey);
  });

  it('the quote-rejection error is redacted before its 80-char cut', async () => {
    const { t, task } = setup();
    const a = await t.page('ws_a', 'Some page text.');
    const c = t.ctx('ws_a', 'worker', { taskId: task.id });
    const r = await t.handle(c, 'save_finding', {
      claim: 'x', subject: 'Acme', evidence: [a.id], relation: 'new', evidence_refs: [{ artifact_id: a.id, quote: straddling(80) }],
    });
    expect(r.ok).toBe(false);
    noPartOfSecret((r as { error: string }).error);
    const bus = t.seen.filter((e) => e.type === 'tool_call' && !e.ok).map((e) => JSON.stringify(e)).join('');
    noPartOfSecret(bus);
  });

  it('duplicate-handshake candidate claims are redacted whole, then cut', async () => {
    const { t, task } = setup();
    const a = await t.page('ws_a', 'Evidence text.');
    t.fact('ws_a', `Acme widget pricing ${straddling(500)}`, { subject: 'Acme' });
    const c = t.ctx('ws_a', 'worker', { taskId: task.id });
    const r = await t.call<{ saved: boolean; candidates: Array<{ claim: string }> }>(c, 'save_finding', {
      claim: `Acme widget pricing ${straddling(500)} changed`, subject: 'Acme', evidence: [a.id],
    });
    expect(r.saved).toBe(false);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const cand of r.candidates) {
      noPartOfSecret(cand.claim);
      expect(cand.claim.length).toBeLessThanOrEqual(501);
    }
  });
});
