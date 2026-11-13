/**
 * The four findings of the last review at dadcd82, as tests (the reviewer's probes s10, s5-s7, s8, s3),
 * plus "a later cursor never re-serves the header". The sweep (`pagingSweep*.test.ts`) covers them across
 * all budgets; these name each case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import { verifyEvidenceRefs } from '../../../src/core/knowledge/factTools.js';
import { ks4, T0, type Ks4 } from './ks4fixture.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import type { ToolName } from '../../../src/core/harness/tools/registry.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Page = Record<string, unknown> & { tokens: number; cursor?: string; items?: Array<Record<string, unknown>>; lines?: unknown[]; notes?: string[] };

async function pages(t: Ks4, c: RunContext, tool: ToolName, input: Record<string, unknown>): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 500; i++) {
    const p = await t.call<Page>(c, tool, { ...input, ...(cursor ? { cursor } : {}) });
    out.push(p);
    if (!p.cursor) break;
    cursor = p.cursor;
  }
  return out;
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const inner = (s: unknown) => String(s).replace(/^<<<EVIDENCE [^\n]*\n/, '').replace(/\n>>>$/, '');

describe('review findings at dadcd82', () => {
  it('finding 1: a 13-field persona at the default budget is 13 whole field items over two pages, never silently cut', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', 'Interview notes. '.repeat(20));
    const sentence = 'Mid-market IT leads who own procurement for SaaS tools, evaluate vendors on security reviews and SSO support, and need to justify spend to finance. ';
    t.store.personas.insert({ id: 'per_real', workspaceId: 'ws_a', slug: 'it-lead', segment: 'IT leads at mid-market companies', agentMdPath: 'x', version: 1, status: 'verified',
      profile: Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: sentence.repeat(4).slice(0, 560), confidence: 0.7, evidence: [a.id, a.id] }])) } as never);
    expect(PERSONA_FIELDS).toHaveLength(13);
    for (const role of ['worker', 'synthesizer', 'interviewer'] as const) {
      const ps = await pages(t, t.ctx('ws_a', role), 'expand', { id: 'per_real' });
      expect(ps.length, role).toBe(2);
      expect(ps[0]).toMatchObject({ kind: 'record', type: 'persona', id: 'per_real', truncated: true });
      expect(ps[0]!.header_cut).toBeUndefined();
      const profile = ps.flatMap((p) => p.items ?? []).filter((i) => String(i.field).startsWith('profile.'));
      expect(profile.map((i) => i.field)).toEqual(PERSONA_FIELDS.map((f) => `profile.${f}`));
      for (const i of profile) expect(i).toEqual({ type: 'field', field: i.field, value: sentence.repeat(4).slice(0, 560), confidence: 0.7, evidence: [a.id, a.id] });
      expect(ps.flatMap((p) => p.items ?? []).some((i) => i.cut === true)).toBe(false);
    }
  });

  it('finding 2: an artifact with captures, scope tree, never answers "nothing fits" (100-700 tokens)', async () => {
    const t = ks4(opened);
    const k = knowledgeRepos(t.store);
    const b = await t.page('ws_a', 'Zephyr second page. '.repeat(40), { title: 'Second page', description: 'A description of the second page. '.repeat(20) } as never);
    for (let i = 0; i < 4; i++) k.artifactCaptures.insert({ id: newId('cap'), artifactId: b.id, workspaceId: 'ws_a', capturedAt: T0, note: `capture note ${i} `.repeat(30), description: 'cap desc '.repeat(60) });
    const c = t.ctx('ws_a');
    for (const scope of [{}, { scope: 'tree' }, { scope: 'node' }]) {
      for (let m = 100; m <= 700; m += 3) {
        const p = await t.call<Page>(c, 'expand', { id: b.id, ...scope, max_tokens: m });
        expect(p.notes ?? [], `${m}`).toEqual([]);
        expect(p.items!.length, `${m}`).toBeGreaterThan(0);
        expect(p.tokens).toBeLessThanOrEqual(Math.max(m, READ_FLOOR_TOKENS.expand));
      }
    }
  });

  it('finding 3: a quote across a chunk boundary is served whole; its passage pointer is a call that holds the whole quote', async () => {
    const t = ks4(opened);
    const k = knowledgeRepos(t.store);
    const a = await t.page('ws_a', Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about pricing and seats in region ${i}. `.repeat(8)).join('\n\n'));
    const chunks = k.chunks.list({ artifactId: a.id }).sort((x, y) => x.seq - y.seq);
    const quote = `${chunks[0]!.text.slice(-500)}\n\n${chunks[1]!.text.slice(0, 600)}`;
    expect(squash(chunks[0]!.text).includes(squash(quote))).toBe(false);
    const v = await verifyEvidenceRefs({ store: t.store, artifacts: t.artifacts, config: t.config } as never, 'ws_a', [{ artifact_id: a.id, chunk_id: chunks[0]!.id, quote }]);
    if (!v.ok) throw new Error(v.error);
    const f = t.fact('ws_a', 'Pricing claim', { evidence: [a.id] });
    k.findingEvidence.insert({ findingId: f.id, seq: 0, ...v.rows[0]! });
    const c = t.ctx('ws_a');
    for (const m of [READ_FLOOR_TOKENS.expand, 450, 520, 2000]) {
      const items = (await pages(t, c, 'expand', { id: f.id, max_tokens: m })).flatMap((p) => p.items ?? []);
      const q = items.find((i) => i.type === 'quote')!;
      const served = q.cut === true ? (await t.call<Page>(c, (q.full as { tool: ToolName }).tool, (q.full as { input: unknown }).input)).items![0]! : q;
      expect(squash(inner(served.quote)), `${m}`).toBe(squash(quote));
      expect(q.passage, `${m}: chunk 0 alone does not hold the quote`).toEqual({ kind: 'expand_chunk', tool: 'expand', input: { id: chunks[0]!.id, around: 1 } });
      const passage = (await pages(t, c, 'expand', (q.passage as { input: Record<string, unknown> }).input)).flatMap((p) => p.items ?? []);
      // Pieces of one passage concatenated; passages separated as in the document.
      const byChunk = new Map<string, string>();
      for (const i of passage) byChunk.set(String(i.chunk_id), (byChunk.get(String(i.chunk_id)) ?? '') + inner(i.text));
      const joined = [...byChunk.values()].join('\n\n');
      expect(squash(joined).includes(squash(quote)), `${m}: the passage holds the whole quote`).toBe(true);
    }
  });

  it('finding 4: a node line cut on a later expand page points at read_workspace with a budget that holds it (no header repeated)', async () => {
    const t = ks4(opened);
    t.store.profiles.insert({ workspaceId: 'ws_a', data: { ['"'.repeat(200)]: 1, [`${'\\'.repeat(150)}tail`]: 2, ['\u0001'.repeat(200)]: 3, normal: 4 } });
    const c = t.ctx('ws_a');
    let followed = 0;
    for (let m = READ_FLOOR_TOKENS.expand; m < 500; m += 5) {
      const ps = await pages(t, c, 'expand', { id: 'ws_a', max_tokens: m });
      for (const [pi, p] of ps.entries()) {
        for (const it of p.items ?? []) {
          if (it.cut !== true) continue;
          const full = it.full as { kind: string; tool: ToolName; input: Record<string, unknown> };
          expect(full.kind).toBe('read_workspace_line');
          const answer = await t.call<Page>(c, full.tool, full.input);
          expect(answer.tokens).toBeLessThanOrEqual(full.input.max_tokens as number);
          expect(Object.keys(answer).filter((x) => !['lines', 'tokens', 'truncated', 'more', 'cursor', 'content_trust', 'notes'].includes(x)), `page ${pi}`).toEqual([]);
          const whole = (await t.call<Page>(c, 'expand', { id: 'ws_a', max_tokens: 8000 })).items!;
          expect(whole.map((x) => x.text)).toContain(answer.lines![0]);
          expect(typeof answer.lines![0]).toBe('string');
          followed++;
        }
      }
    }
    expect(followed).toBeGreaterThan(0);
  });

  it('a later cursor never re-serves the header, for every paged tool (read_workspace included)', async () => {
    const t = ks4(opened);
    t.store.profiles.insert({ workspaceId: 'ws_a', data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key ${i} ${'x'.repeat(60)}`, i])) });
    const a = await t.page('ws_a', 'Acme pricing body. '.repeat(400), { title: 'Acme pricing' } as never);
    const f = t.fact('ws_a', `Acme claim ${'detail '.repeat(300)}`, { evidence: [a.id] });
    for (let i = 0; i < 12; i++) t.fact('ws_a', `Acme fact ${i} ${'more '.repeat(40)}`);
    const c = t.ctx('ws_a');
    const envelope = ['tokens', 'truncated', 'more', 'cursor', 'relaxed', 'content_trust', 'notes'];
    for (const [tool, input, key] of [
      ['read_workspace', { workspace_id: 'ws_a' }, 'lines'], ['get_card', { workspace_id: 'ws_a' }, 'lines'], ['expand', { id: f.id }, 'items'],
      ['expand', { id: 'ws_a' }, 'items'], ['read_artifact', { artifact_id: a.id, mode: 'text' }, 'items'], ['search', { query: 'acme' }, 'hits'],
    ] as const) {
      const ps = await pages(t, c, tool, { ...input, max_tokens: READ_FLOOR_TOKENS[tool] });
      expect(ps.length, tool).toBeGreaterThan(1);
      for (const p of ps.slice(1)) expect(Object.keys(p).filter((x) => x !== key && !envelope.includes(x)), tool).toEqual([]);
      for (const p of ps) expect(p.tokens).toBe(estimateTokens(JSON.stringify(p)));
    }
  });
});

describe('floors (paging rework, binding floor invariant)', () => {
  it('at budget 1 every tool serves an item within its floor, even with the largest header and every first-page note', async () => {
    const t = ks4(opened);
    const k = knowledgeRepos(t.store);
    const Q = '"'.repeat(400); // JSON-escaped two-fold: every bounded name at its bound
    t.store.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(Q, 'ws_d');
    const a = await t.page('ws_d', `Body ${'text '.repeat(300)}`, { title: Q, sourceUrl: `https://x.test/${'p'.repeat(300)}`, description: Q } as never);
    t.store.db.prepare("UPDATE artifact_texts SET status = 'too_large', char_count = 10 WHERE artifact_id = ?").run(a.id);
    const ch = k.chunks.list({ artifactId: a.id })[0]!;
    t.store.db.prepare('UPDATE chunks SET heading_path = ? WHERE id = ?').run(Q, ch.id);
    const e = (await import('../../../src/core/knowledge/entities.js')).resolveEntity(t.store, (await import('../../../src/core/knowledge/scope.js')).scopeFor(t.store, 'ws_d'), { kind: 'competitor', name: 'Q'.repeat(150) });
    t.store.db.prepare('UPDATE entities SET name = ? WHERE id = ?').run(Q, e.id);
    const f = t.fact('ws_d', `${'\u0001'.repeat(400)}`, { subject: Q, entityId: e.id, evidence: [a.id] });
    t.fact('ws_c', 'v2', { lineageId: f.id, version: 2, replacesId: f.id, lifecycle: 'candidate', status: 'pending' } as never); // outside node scope of ws_d
    k.factObservations.insert({ id: newId('obs'), workspaceId: 'ws_d', lineageId: f.id, findingId: f.id, kind: 'create', evidence: [], status: 'applied', createdAt: new Date().toISOString(), appliedAt: new Date().toISOString() });
    t.store.profiles.insert({ workspaceId: 'ws_d', data: { ['\u0001'.repeat(200)]: 1 } });
    t.store.recommendations.insert({ id: 'rec_q', workspaceId: 'ws_d', title: Q, summary: '\u0001'.repeat(3000), criteria: {}, findingIds: [], personaFeedback: [], priority: 0, createdAt: T0, status: 'verified' } as never);
    for (const role of ['worker', 'synthesizer'] as const) {
      const c = t.ctx('ws_d', role);
      const calls: Array<[ToolName, Record<string, unknown>, string]> = [
        ['search', { query: `${'zz '.repeat(600)}`.trim(), include_unverified: true, include_history: true }, 'hits'],
        ['search', { query: 'body', include_unverified: true }, 'hits'],
        ['get_card', { entity_id: e.id, scope: 'tree' }, 'lines'],
        ['get_card', { workspace_id: 'ws_d', scope: 'tree' }, 'lines'],
        ['read_workspace', { workspace_id: 'ws_d', scope: 'tree' }, 'lines'],
        ['list_changes', { since: '2026-10-01', entity_id: e.id, scope: 'tree' }, 'changes'],
        ['expand', { id: f.id, scope: 'tree' }, 'items'],
        ['expand', { id: f.id }, 'items'],
        ['expand', { id: a.id, scope: 'tree' }, 'items'],
        ['expand', { id: ch.id, around: 3, scope: 'tree' }, 'items'],
        ['expand', { id: e.id, scope: 'tree' }, 'items'],
        ['expand', { id: 'ws_d', scope: 'tree' }, 'items'],
        ['expand', { id: 'rec_q', scope: 'tree' }, 'items'],
        ['read_artifact', { artifact_id: a.id, mode: 'text', scope: 'tree' }, 'items'],
        ['read_artifact', { artifact_id: a.id, mode: 'raw', scope: 'tree' }, 'items'],
      ];
      for (const [tool, input, key] of calls) {
        const r = await t.handle(c, tool, { ...input, max_tokens: 1 });
        if (!r.ok) continue; // a record the synthesizer may not read
        const p = (r as { data: Page }).data;
        const label = `${role} ${tool} ${JSON.stringify(input).slice(0, 60)}`;
        expect(JSON.stringify(p.notes ?? []), label).not.toMatch(/raised|nothing/);
        expect(p.tokens, label).toBeLessThanOrEqual(READ_FLOOR_TOKENS[tool as keyof typeof READ_FLOOR_TOKENS]);
        const items = (p[key] as unknown[]) ?? [];
        if (p.cursor || p.truncated) expect(items.length, label).toBeGreaterThan(0);
      }
    }
  });
});
