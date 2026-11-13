/**
 * Paging sweep (paging rework, binding acceptance test; the last reviewer's probes turned into tests).
 * For one request, `sweepRequest` pages it at every budget given — from the start and from later cursors —
 * and follows every pointer, failing on:
 * - an empty page while content remains, or a "nothing fits" / "raised" note (false "nothing fits");
 * - a page over its budget (the budget clamped up to the tool's floor), or a `tokens` that is not the
 *   page's measured size;
 * - a header on a later page (a request with a cursor), or a first-page header that differs from the
 *   whole one (the header is never cut);
 * - a cut item without a pointer, sharing its page, or with a pointer budget that would have held it here;
 * - a pointer whose answer does not return the item whole (on a later page, within its own budget);
 * - content never served: the pages joined (pieces of a passage concatenated, cut items recovered through
 *   their pointer) must equal the reference — the same request read at the hard maximum;
 * - a retrieval row that does not list an item served on its page.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import type { ToolName } from '../../../src/core/harness/tools/registry.js';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { verifyEvidenceRefs } from '../../../src/core/knowledge/factTools.js';
import { addRelation } from '../../../src/core/knowledge/relations.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { READ_FLOOR_TOKENS, type KnowledgeReadTool } from '../../../src/core/knowledge/tools.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Role } from '../../../src/core/types.js';
import { ks4, T0, type Ks4 } from './ks4fixture.js';
import { textPieces } from './recoveryHelpers.js';

type Page = Record<string, unknown> & { tokens: number; cursor?: string; notes?: string[] };
type Unit = { value: unknown; text?: string };

const ENVELOPE = new Set(['tokens', 'truncated', 'more', 'cursor', 'relaxed', 'content_trust', 'notes']);
const HARD_MAX = 8000;

export type SweepStats = { pages: number; calls: number; pointers: Record<string, number>; cuts: number; pieces: number; restarts: number };
export const newStats = (): SweepStats => ({ pages: 0, calls: 0, pointers: {}, cuts: 0, pieces: 0, restarts: 0 });

/** Appends `stats` to the file named by SWEEP_STATS_FILE (a summary for the report; nothing otherwise). */
export function reportStats(label: string, stats: SweepStats): void {
  const file = process.env.SWEEP_STATS_FILE;
  if (file) appendFileSync(file, `${JSON.stringify({ label, ...stats })}\n`);
}

/** The text inside a fence (or the string itself). */
const inner = (s: unknown): string => (typeof s === 'string' ? s.replace(/^<<<EVIDENCE [^\n]*\n/, '').replace(/\n>>>$/, '') : '');
const isPiece = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && ((x as { type?: unknown }).type === 'chunk' || (x as { type?: unknown }).type === 'raw') && typeof (x as { text?: unknown }).text === 'string';
/** Cursor format `c1.<key>.<offset>[.<pos>].<check>` (design §9). */
function cursorAt(cursor: string): { offset: number; pos: number } {
  const p = cursor.split('.');
  return { offset: Number(p[2]), pos: p.length === 5 ? Number(p[3]) : 0 };
}

export function sweepBudgets(tool: KnowledgeReadTool, extra: number[] = []): number[] {
  const floor = READ_FLOOR_TOKENS[tool];
  const out = new Set<number>([1, 2, 37, 99, 100, floor - 1, ...extra]);
  for (let b = floor; b < floor + 160; b += 3) out.add(b);
  for (let b = floor + 160; b < 1200; b += 23) out.add(b);
  for (let b = 1200; b <= 2400; b += 150) out.add(b);
  return [...out].filter((b) => b >= 1).sort((a, b) => a - b);
}

export type SweepCase = { name: string; tool: KnowledgeReadTool; input: Record<string, unknown>; key: 'items' | 'lines' | 'hits' | 'changes' };

/** Pages of one request from `cursor` (or the start), each checked (see module doc). */
async function run(t: Ks4, c: RunContext, cs: SweepCase, budget: number, stats: SweepStats, from?: string): Promise<Page[]> {
  const out: Page[] = [];
  let cursor = from;
  for (let i = 0; i < 3000; i++) {
    const before = knowledgeRepos(t.store).retrievalEvents.list({ agentRunId: c.agentRunId }).length;
    const r = await t.handle(c, cs.tool as ToolName, { ...cs.input, ...(cursor ? { cursor } : {}), ...(budget ? { max_tokens: budget } : {}) });
    stats.calls++;
    expect(r.ok, `${cs.name} @${budget}: ${(r as { error?: string }).error}`).toBe(true);
    const p = (r as { data: Page }).data;
    out.push(p);
    stats.pages++;
    const label = `${cs.name} @${budget} page ${i}${from ? ' (from a later cursor)' : ''}`;
    // Measured truthfully and within budget (clamped up to the floor).
    expect(p.tokens, `${label}: tokens is the page's size`).toBe(estimateTokens(JSON.stringify(p)));
    expect(p.tokens, `${label}: over budget`).toBeLessThanOrEqual(Math.max(budget || 0, READ_FLOOR_TOKENS[cs.tool]));
    expect(JSON.stringify(p.notes ?? []), `${label}: no "nothing fits" / raised budget`).not.toMatch(/nothing|raised/);
    // A later page carries no header.
    if (cursor) for (const k of Object.keys(p)) expect(ENVELOPE.has(k) || k === cs.key, `${label}: header field "${k}" on a later page`).toBe(true);
    // Every item served is listed in the page's retrieval row.
    const rows = knowledgeRepos(t.store).retrievalEvents.list({ agentRunId: c.agentRunId });
    expect(rows.length, `${label}: one retrieval row per page`).toBe(before + 1);
    const listed = new Set(rows.at(-1)!.resultIds.map((x) => x.id));
    for (const it of (p[cs.key] as unknown[]) ?? []) for (const id of servedIds(it)) expect(listed.has(id), `${label}: ${id} served but not logged`).toBe(true);
    if (!p.cursor) break;
    expect(p.cursor, `${label}: the cursor moves`).not.toBe(cursor);
    cursor = p.cursor;
  }
  return out;
}

/** Ids whose text an item carries (checked against the retrieval row). */
function servedIds(it: unknown): string[] {
  if (!it || typeof it !== 'object') return [];
  const o = it as Record<string, unknown>;
  const ids: string[] = [];
  if ((o.type === 'quote' || (o.type === 'evidence' && !o.outside_scope)) && typeof o.artifact_id === 'string') ids.push(o.artifact_id);
  if ((o.type === 'chunk' || o.type === 'section') && typeof o.chunk_id === 'string') ids.push(o.chunk_id);
  if ((o.type === 'version' || o.type === 'unverified_update') && typeof o.claim === 'string') ids.push(o.id as string);
  if (typeof o.kind === 'string' && ['fact', 'passage', 'artifact', 'entity', 'record'].includes(o.kind) && typeof o.id === 'string') ids.push(o.id);
  return ids;
}

/** Items of pages joined into units: pieces of one passage concatenated (`text` = the passage from its first piece). */
type Served = Unit & { cut?: Record<string, unknown>; page: number };
function units(pages: Page[], key: string): Served[] {
  const out: Served[] = [];
  let open: (Served & { text: string }) | undefined;
  for (const [page, p] of pages.entries()) {
    for (const it of (p[key] as unknown[]) ?? []) {
      if (isPiece(it)) {
        const o = it as Record<string, unknown>;
        if (open) open.text += inner(o.text);
        else open = { value: o, text: inner(o.text), page };
        if (o.cut !== true) {
          out.push(open);
          open = undefined;
        }
        continue;
      }
      expect(open, 'a passage piece is followed by its continuation').toBeUndefined();
      const cut = it && typeof it === 'object' && (it as { cut?: unknown }).cut === true ? (it as Record<string, unknown>) : undefined;
      out.push({ value: it, page, ...(cut ? { cut } : {}) });
    }
  }
  if (open) out.push(open);
  return out;
}

/** The whole response at the hard maximum: the reference units and the first page's header. */
export async function reference(t: Ks4, c: RunContext, cs: SweepCase): Promise<{ units: Unit[]; header: Record<string, unknown> }> {
  const stats = newStats();
  const pages = await run(t, c, cs, HARD_MAX, stats);
  const u = units(pages, cs.key);
  for (const x of u) expect((x as { cut?: unknown }).cut, `${cs.name}: the reference has no cut item`).toBeUndefined();
  const header = Object.fromEntries(Object.entries(pages[0]!).filter(([k]) => !ENVELOPE.has(k) && k !== cs.key));
  return { units: u, header };
}

/** Follows a cut item's pointer and checks that it returns `ref` whole, on a later page within its own budget. */
async function follow(t: Ks4, c: RunContext, cs: SweepCase, cut: Record<string, unknown>, ref: Unit, budget: number, onLaterPage: boolean, stats: SweepStats, label: string): Promise<void> {
  stats.cuts++;
  const full = cut.full as { kind: string; tool: string; input: Record<string, unknown> } | undefined;
  expect(cut.too_large, `${label}: too_large only above the hard maximum`).toBeUndefined();
  expect(full, `${label}: a cut item carries a pointer: ${JSON.stringify(cut).slice(0, 200)}`).toBeDefined();
  stats.pointers[full!.kind] = (stats.pointers[full!.kind] ?? 0) + 1;
  const r = await t.handle(c, full!.tool as ToolName, full!.input);
  stats.calls++;
  expect(r.ok, `${label}: pointer ${JSON.stringify(full)} fails`).toBe(true);
  const a = (r as { data: Page }).data;
  if (full!.kind === 'expand_id') {
    const json = JSON.stringify(a);
    for (const piece of textPieces(ref.value)) expect(json, `${label}: expand_id answer lacks "${piece.slice(0, 60)}"`).toContain(JSON.stringify(piece).slice(1, -1));
    return;
  }
  const m = full!.input.max_tokens as number;
  expect(typeof m, `${label}: the pointer states max_tokens`).toBe('number');
  // This request at the item: a later page of `m` tokens holds it, so it could not fit a later page here.
  if (onLaterPage && full!.kind === 'same_call') expect(m, `${label}: cut, but a page of ${m} tokens would have held it here`).toBeGreaterThan(budget);
  expect(a.tokens, `${label}: pointer answer within its max_tokens`).toBeLessThanOrEqual(m);
  for (const k of Object.keys(a)) expect(ENVELOPE.has(k) || ['items', 'lines', 'hits', 'changes'].includes(k), `${label}: pointer answer repeats the header (${k})`).toBe(true);
  const first = ((a.items ?? a.lines ?? a.hits ?? a.changes) as unknown[] | undefined)?.[0];
  const refText = typeof ref.value === 'string' ? ref.value : (ref.value as { text?: unknown }).text;
  if (full!.kind === 'same_call') expect(first, `${label}: same_call answer`).toEqual(ref.value);
  else expect(first, `${label}: ${full!.kind} answer`).toBe(refText);
}

/**
 * Sweeps `budgets` for `cs` from the start, and from later cursors of the run at the tool's floor, checking
 * every page and following every pointer.
 */
export async function sweepRequest(t: Ks4, c: RunContext, cs: SweepCase, budgets: number[], stats: SweepStats): Promise<void> {
  const ref = await reference(t, c, cs);
  const check = async (budget: number, from?: string) => {
    const pages = await run(t, c, cs, budget, stats, from);
    const label = `${cs.name} @${budget}${from ? ` from ${from}` : ''}`;
    const start = from ? cursorAt(from) : { offset: 0, pos: 0 };
    let expected: Unit[] = ref.units.slice(start.offset);
    if (start.pos > 0) {
      const u = expected[0]!;
      expected = [{ value: u.value, text: u.text!.slice(start.pos) }, ...expected.slice(1)];
    }
    if (!from) {
      const header = Object.fromEntries(Object.entries(pages[0]!).filter(([k]) => !ENVELOPE.has(k) && k !== cs.key));
      expect(header, `${label}: the first page carries the whole header`).toEqual(ref.header);
    }
    // No empty page while content remains: each page but a final empty list serves an item.
    pages.forEach((p, i) => {
      const n = ((p[cs.key] as unknown[]) ?? []).length;
      if (expected.length) expect(n, `${label} page ${i}: empty page while content remains`).toBeGreaterThan(0);
      for (const it of (p[cs.key] as unknown[]) ?? []) {
        if (it && typeof it === 'object' && (it as { cut?: unknown }).cut === true && !isPiece(it)) expect(n, `${label} page ${i}: a cut item shares its page`).toBe(1);
        if (isPiece(it) && (it as { cut?: unknown }).cut === true) stats.pieces++;
      }
    });
    const got = units(pages, cs.key);
    expect(got.length, `${label}: units served`).toBe(expected.length);
    for (const [i, u] of got.entries()) {
      const want = expected[i]!;
      if (u.text !== undefined) {
        expect(u.text, `${label} unit ${i}: passage text`).toBe(want.text);
        continue;
      }
      if (u.cut) {
        await follow(t, c, cs, u.cut, want, Math.max(budget, READ_FLOOR_TOKENS[cs.tool]), Boolean(from) || u.page > 0, stats, `${label} unit ${i}`);
        continue;
      }
      expect(u.value, `${label} unit ${i}`).toEqual(want.value);
    }
  };
  for (const b of budgets) await check(b);
  // Later-page cursors: restart from the cursors of a run at the floor (pieces included), at a few budgets.
  const floorRun = await run(t, c, cs, READ_FLOOR_TOKENS[cs.tool], stats);
  const cursors = floorRun.map((p) => p.cursor).filter((x): x is string => !!x);
  const picks = [...new Set([cursors[0], cursors[Math.floor(cursors.length / 2)], cursors.at(-1)])].filter((x): x is string => !!x);
  for (const from of picks) {
    for (const b of [1, READ_FLOOR_TOKENS[cs.tool] + 7, 500, 2000]) {
      stats.restarts++;
      await check(b, from);
    }
  }
}

// ---------------------------------------------------------------------------
// The sweep world: the last reviewer's probe fixtures (probe3 s1, s3, s5, s6, s8, s10) in one tree.


/** Keys whose JSON escaping doubles (quotes, backslashes) or sextuples (control characters) their size. */
export const ESCAPE_KEYS = ['"'.repeat(200), `${'\\'.repeat(150)}tail`, '\u0001'.repeat(100), '\u0002'.repeat(200), 'normal'];

export async function sweepWorld(opened: Store[]) {
  const t = ks4(opened);
  const k = knowledgeRepos(t.store);
  const sc = scopeFor(t.store, 'ws_a');
  // A long document (13 chunks) and a page with captures and a long description (s1, s5).
  const a = await t.page('ws_a', Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: Zephyr pricing detail sentence about the Pro plan seat price in region ${i}. `.repeat(6)).join('\n\n'), { title: 'Zephyr pricing page' } as never);
  const b = await t.page('ws_a', 'Zephyr second page. '.repeat(40), { title: 'Second page', description: 'A description of the second page. '.repeat(20) } as never);
  for (let i = 0; i < 4; i++) k.artifactCaptures.insert({ id: newId('cap'), artifactId: b.id, workspaceId: 'ws_a', capturedAt: T0, note: `capture note ${i} `.repeat(30), description: 'cap desc '.repeat(60) });
  // A markdown document with long headings (s6).
  const md = await t.page('ws_a', Array.from({ length: 10 }, (_, i) => `# Heading ${i} ${'long heading words '.repeat(6)}\n\n${'Para text. '.repeat(150)}`).join('\n\n'), { title: 'Doc', mime: 'text/markdown' } as never);
  const chunks = k.chunks.list({ artifactId: a.id }).sort((x, y) => x.seq - y.seq);
  // Entity with many facts, aliases (one full of escapes) and a relation (s1).
  const e = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Globex' });
  const e2 = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Initech' });
  t.store.db.prepare('UPDATE entities SET aliases = ? WHERE id = ?').run(JSON.stringify(['Globex Corp', '"'.repeat(120), 'Globex International Holdings']), e.id);
  const facts = Array.from({ length: 18 }, (_, i) =>
    t.fact('ws_a', `Globex Zephyr claim ${i} ${'with more detail about the product line '.repeat((i % 7) * 3)}end ${i}`, { entityId: e.id, createdAt: T0 }));
  // A fact with a long claim and criteria, quotes (legacy ones over the cap, one across a chunk boundary), a version, a relation.
  const F = t.fact('ws_a', `Zephyr pricing master claim: ${'the Pro plan tiers and seat prices differ by region and contract length; '.repeat(20)}`, {
    entityId: e.id, evidence: [a.id, b.id], subject: `Zephyr ${'"quoted" '.repeat(40)}`,
    criteria: { source_quality: 'primary pricing page and partner sheets. '.repeat(10), recency: 'checked this week. '.repeat(6) } as never,
  });
  for (let i = 0; i < 9; i++) {
    const ch = chunks[i % chunks.length]!;
    const q = i % 3 === 0 ? ch.text.slice(0, 1900) : i % 3 === 1 ? ch.text.slice(10, 400) : `short quote ${i}`;
    k.findingEvidence.insert({ findingId: F.id, seq: i, artifactId: a.id, ...(i % 2 === 0 ? { chunkId: ch.id } : {}), quote: q });
  }
  // s8: quotes across the boundary of chunks 0 and 1 — one verified at the cap, one legacy (1990 characters).
  const span = (n: number) => `${chunks[0]!.text.slice(-700)}\n\n${chunks[1]!.text.slice(0, 1300)}`.slice(0, n);
  const v = await verifyEvidenceRefs({ store: t.store, artifacts: t.artifacts, config: t.config } as never, 'ws_a', [{ artifact_id: a.id, chunk_id: chunks[0]!.id, quote: span(1150) }]);
  if (!v.ok) throw new Error(v.error);
  k.findingEvidence.insert({ findingId: F.id, seq: 10, ...v.rows[0]! });
  k.findingEvidence.insert({ findingId: F.id, seq: 11, artifactId: a.id, chunkId: chunks[0]!.id, quote: span(1990) });
  k.findingEvidence.insert({ findingId: F.id, seq: 20, artifactId: b.id, quote: 'Zephyr second page. Zephyr second page.' });
  t.fact('ws_a', `Zephyr pricing v2 ${'newer tiers '.repeat(60)}`, { lineageId: F.id, version: 2, replacesId: F.id, lifecycle: 'candidate', status: 'pending' } as never);
  addRelation(t.store, sc, { from: e.id, type: 'competes_with', to: e2.id, sourceKind: 'fact', sourceId: F.id });
  // A claim of control characters (JSON-escaped six-fold): its card line, hit and change are larger than
  // the tools' floors, so they are cut and their pointers (get_card_line, expand_id, same_call) followed.
  const X = t.fact('ws_a', `Zephyr ${'\u0003'.repeat(280)}`, { entityId: e.id, createdAt: T0, lastConfirmedAt: '2026-11-10T10:00:00.000Z' });
  for (const f of [...facts.slice(0, 6), F, X]) {
    k.factObservations.insert({ id: newId('obs'), workspaceId: 'ws_a', lineageId: f.id, findingId: f.id, kind: 'create', evidence: [], status: 'applied', createdAt: new Date().toISOString(), appliedAt: new Date().toISOString() });
  }
  // Node card: many profile keys, keys full of escapes (s3), symptoms with quoted titles.
  const prof: Record<string, number> = {};
  for (let i = 0; i < 25; i++) prof[`key_${i}_${'x'.repeat(i * 9)}`] = i;
  for (const [i, key] of ESCAPE_KEYS.entries()) prof[key] = 100 + i;
  t.store.profiles.insert({ workspaceId: 'ws_a', data: prof });
  for (let i = 0; i < 5; i++) t.store.symptoms.insert({ id: newId('sym'), workspaceId: 'ws_a', kind: 'symptom', title: `"Renewals fell "quoted" in segment ${i} ${'and more detail '.repeat(i * 4)}`, detail: 'd'.repeat(3000), criteria: {}, evidence: [] });
  // Long records (s1, s10).
  t.store.personas.insert({ id: 'per_big', workspaceId: 'ws_a', slug: 'it-lead', segment: 'IT', agentMdPath: 'x', version: 1,
    profile: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`trait_${i}`, { value: `persona trait ${i} `.repeat(40), confidence: 0.7, evidence: [] }])) } as never);
  const sentence = 'Mid-market IT leads who own procurement for SaaS tools, evaluate vendors on security reviews and SSO support, and need to justify spend to finance. ';
  t.store.personas.insert({ id: 'per_real', workspaceId: 'ws_a', slug: 'it-lead-2', segment: 'IT leads at mid-market companies', agentMdPath: 'x', version: 1, status: 'verified',
    profile: Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: sentence.repeat(4).slice(0, 560), confidence: 0.7, evidence: [a.id, a.id] }])) } as never);
  t.store.recommendations.insert({ id: 'rec_big', workspaceId: 'ws_a', title: 'Raise prices', summary: 'Summary text. '.repeat(250), criteria: { upside: 4 }, findingIds: [...facts.map((f) => f.id), X.id], personaFeedback: [], priority: 0, createdAt: T0, status: 'verified' } as never);
  return { t, a, b, md, chunks, e, F, facts };
}

// ---------------------------------------------------------------------------
// The sweep's request shapes, in four shards (one test file each, so they run in parallel).


type World = Awaited<ReturnType<typeof sweepWorld>>;
type Spec = { shard: 'A' | 'B' | 'C' | 'D'; caller?: string; role?: Role; make: (w: World) => SweepCase };

export const SWEEP_SPECS: Record<string, Spec> = {
  // expand: facts (long claim and criteria, legacy quotes over the cap, quotes across a chunk boundary, a version, a relation)
  'expand fact': { shard: 'A', make: (w) => ({ name: 'expand fact', tool: 'expand', input: { id: w.F.id }, key: 'items' }) },
  'expand fact, scope tree': { shard: 'A', make: (w) => ({ name: 'expand fact tree', tool: 'expand', input: { id: w.F.id, scope: 'tree' }, key: 'items' }) },
  // expand: entities (aliases full of escapes, a line larger than the floor), nodes (many keys, keys full of escapes)
  'expand entity': { shard: 'C', make: (w) => ({ name: 'expand entity', tool: 'expand', input: { id: w.e.id }, key: 'items' }) },
  'expand entity, scope tree': { shard: 'D', make: (w) => ({ name: 'expand entity tree', tool: 'expand', input: { id: w.e.id, scope: 'tree' }, key: 'items' }) },
  'expand node': { shard: 'D', make: () => ({ name: 'expand node', tool: 'expand', input: { id: 'ws_a' }, key: 'items' }) },
  'expand node, scope tree': { shard: 'D', make: () => ({ name: 'expand node tree', tool: 'expand', input: { id: 'ws_a', scope: 'tree' }, key: 'items' }) },
  'expand node from ws_c, scope tree': { shard: 'D', caller: 'ws_c', make: () => ({ name: 'expand node from ws_c', tool: 'expand', input: { id: 'ws_a', scope: 'tree' }, key: 'items' }) },
  // expand: an artifact with captures (finding 2), chunks with neighbours, long records (finding 1)
  'expand artifact with captures': { shard: 'D', make: (w) => ({ name: 'expand artifact', tool: 'expand', input: { id: w.b.id }, key: 'items' }) },
  'expand artifact with captures, scope tree': { shard: 'D', make: (w) => ({ name: 'expand artifact tree', tool: 'expand', input: { id: w.b.id, scope: 'tree' }, key: 'items' }) },
  'expand chunk, around 1': { shard: 'A', make: (w) => ({ name: 'expand chunk around 1', tool: 'expand', input: { id: w.chunks[2]!.id, around: 1 }, key: 'items' }) },
  'expand chunk, around 3, scope tree': { shard: 'D', make: (w) => ({ name: 'expand chunk around 3', tool: 'expand', input: { id: w.chunks[0]!.id, around: 3, scope: 'tree' }, key: 'items' }) },
  'expand persona, 20 long traits': { shard: 'C', make: () => ({ name: 'expand per_big', tool: 'expand', input: { id: 'per_big' }, key: 'items' }) },
  'expand persona, 13 fields x 560 characters': { shard: 'D', make: () => ({ name: 'expand per_real', tool: 'expand', input: { id: 'per_real' }, key: 'items' }) },
  'expand recommendation, long summary': { shard: 'D', make: () => ({ name: 'expand rec_big', tool: 'expand', input: { id: 'rec_big' }, key: 'items' }) },
  // cards
  'get_card entity': { shard: 'C', make: (w) => ({ name: 'get_card entity', tool: 'get_card', input: { entity_id: w.e.id }, key: 'lines' }) },
  'get_card node': { shard: 'C', make: () => ({ name: 'get_card node', tool: 'get_card', input: { workspace_id: 'ws_a' }, key: 'lines' }) },
  'read_workspace': { shard: 'C', make: () => ({ name: 'read_workspace', tool: 'read_workspace', input: { workspace_id: 'ws_a' }, key: 'lines' }) },
  'read_workspace, scope tree': { shard: 'C', make: () => ({ name: 'read_workspace tree', tool: 'read_workspace', input: { workspace_id: 'ws_a', scope: 'tree' }, key: 'lines' }) },
  'read_workspace of ws_a from ws_g': { shard: 'C', caller: 'ws_g', make: () => ({ name: 'read_workspace from ws_g', tool: 'read_workspace', input: { workspace_id: 'ws_a' }, key: 'lines' }) },
  // search and list_changes (a role note on every page for the synthesizer)
  'search': { shard: 'B', make: () => ({ name: 'search', tool: 'search', input: { query: 'zephyr' }, key: 'hits' }) },
  'search, scope tree': { shard: 'D', make: () => ({ name: 'search tree', tool: 'search', input: { query: 'zephyr pricing', scope: 'tree', limit: 30 }, key: 'hits' }) },
  'search, synthesizer with a role note': { shard: 'B', role: 'synthesizer', make: () => ({ name: 'search synthesizer', tool: 'search', input: { query: 'zephyr', include_unverified: true }, key: 'hits' }) },
  'list_changes': { shard: 'A', make: () => ({ name: 'list_changes', tool: 'list_changes', input: { since: '2026-10-01' }, key: 'changes' }) },
  'list_changes, synthesizer': { shard: 'B', role: 'synthesizer', make: () => ({ name: 'list_changes synthesizer', tool: 'list_changes', input: { since: '2026-10-01' }, key: 'changes' }) },
  // read_artifact
  'read_artifact outline': { shard: 'D', make: (w) => ({ name: 'read_artifact outline', tool: 'read_artifact', input: { artifact_id: w.a.id }, key: 'items' }) },
  'read_artifact text': { shard: 'B', make: (w) => ({ name: 'read_artifact text', tool: 'read_artifact', input: { artifact_id: w.a.id, mode: 'text' }, key: 'items' }) },
  'read_artifact text, long headings, scope tree': { shard: 'B', make: (w) => ({ name: 'read_artifact text md', tool: 'read_artifact', input: { artifact_id: w.md.id, mode: 'text', scope: 'tree' }, key: 'items' }) },
  'read_artifact raw': { shard: 'A', make: (w) => ({ name: 'read_artifact raw', tool: 'read_artifact', input: { artifact_id: w.a.id, mode: 'raw' }, key: 'items' }) },
};

/** Runs one shard of `SWEEP_SPECS` as a test file. */
export function sweepShard(shard: Spec['shard']): void {
  const opened: Store[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
  });
  const stats = newStats();
  afterAll(() => reportStats(`shard ${shard}`, stats));
  describe(`paging sweep, shard ${shard}: budgets from 1, from the start and from later cursors, every pointer followed`, () => {
    for (const [label, spec] of Object.entries(SWEEP_SPECS)) {
      if (spec.shard !== shard) continue;
      it(label, async () => {
        const w = await sweepWorld(opened);
        const cs = spec.make(w);
        await sweepRequest(w.t, w.t.ctx(spec.caller ?? 'ws_a', spec.role ?? 'worker'), cs, sweepBudgets(cs.tool), stats);
        expect(stats.pages).toBeGreaterThan(0);
      }, 120_000);
    }
  });
}
