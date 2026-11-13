/**
 * KS-8 design-thread ruling after the real-CLI smoke: read tools page by position and never skip.
 *
 * - The artifact header (identity: kind, id, kind of artifact, title, mode) and its notes are sent on the
 *   first page only (paging rework: metadata and description are its first items); later pages carry the
 *   items and the envelope (tokens, truncated, more, cursor, content_trust) and nothing else.
 * - Text reads (`read_artifact` text / raw, `expand` on a chunk or with neighbours): a passage that
 *   does not fit is served up to the budget and the next `cursor` continues from exactly that point;
 *   `cut: true` only ever means "the next page continues this passage". No placeholder, no
 *   `retry_cursor`, nothing skipped.
 * - Lists of short items: never skip an item; an item too long for the page is shortened, marked
 *   `cut: true`, and `expand` of its id gives the full text.
 * - Still: redaction before every cut, no cut inside a fence marker, every response within budget
 *   (clamped up to the tool's floor), cursors bound to the request, the retrieval row lists every item
 *   whose text was served.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTIONS, toolJsonSchema } from '../../../src/core/harness/tools/registry.js';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { cutServedText, shortenItem } from '../../../src/core/knowledge/readCommon.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import { servedChunkText } from '../../../src/core/knowledge/texts.js';
import { stripFences } from '../../../src/core/knowledge/trust.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { ks4, T0, type Ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Item = Record<string, unknown> & { type?: string; chunk_id?: string; text?: string; cut?: boolean; id?: string };
type Page = Record<string, unknown> & { items?: Item[]; truncated: boolean; more?: number; cursor?: string; notes?: string[]; tokens: number };

const SECRET = 'Zq7-hunter-secret';
const LONG = `The Team plan costs $49 per user per month, billed annually. ${'It includes unlimited warehouses and shared dashboards. '.repeat(30)}Login ${SECRET} is not for sharing. Some <<<fake fence>>> text. The end of the plan text.`;
const TEXT = `# Overview\n\nPricing overview for a fictional vendor.\n\n## Plans\n\n${LONG}\n\n## Trial\n\nEvery plan starts with a 14-day free trial.\n\n## Support\n\n${'Support answers within two business days. '.repeat(6)}\n`;
const FENCED = /^<<<EVIDENCE [A-Za-z0-9_-]+\n([\s\S]*)\n>>>$/;
const LATER_KEYS = new Set(['items', 'tokens', 'truncated', 'more', 'cursor', 'content_trust']);
const FLOOR = READ_FLOOR_TOKENS.read_artifact;

async function setup(extra: Record<string, unknown> = {}) {
  const t = ks4(opened);
  t.store.identities.insert({ id: 'idn_1', workspaceId: 'ws_a', site: 'x.test', name: 'n', email: 'n@x.test', password: SECRET, createdAt: T0 });
  const a = await t.page('ws_a', TEXT, { mime: 'text/markdown', title: 'pricing page', description: 'A fictional pricing page with plans and a trial.', ...extra });
  const chunks = knowledgeRepos(t.store).chunks.list({ artifactId: a.id }).sort((x, y) => x.seq - y.seq);
  return { t, a, chunks, c: t.ctx('ws_a') };
}

/** Follows `cursor` until it is absent; returns every page. */
async function follow(t: Ks4, c: RunContext, tool: 'read_artifact' | 'expand' | 'search' | 'get_card', input: Record<string, unknown>, max = 60): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const p = await t.call<Page>(c, tool, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(p);
    if (!p.cursor) return pages;
    cursor = p.cursor;
  }
  throw new Error('cursor never ended');
}

/** Joins the served pieces of each passage (fence removed). */
function joined(pages: Page[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages) {
    for (const it of p.items ?? []) {
      if (it.type !== 'chunk') continue;
      const m = FENCED.exec(String(it.text));
      expect(m, 'every piece is one whole fence').not.toBeNull();
      expect(m![1]).not.toMatch(/<<<|>>>/);
      out.set(it.chunk_id!, (out.get(it.chunk_id!) ?? '') + m![1]);
    }
  }
  return out;
}

describe('read_artifact text pages by position (KS-8 ruling)', () => {
  for (const budget of [100, 160, 250, 400, 2000]) {
    it(`max_tokens ${budget}: every passage is served whole across the pages, nothing skipped, each page within budget`, async () => {
      const { t, a, chunks, c } = await setup({ title: undefined, description: undefined });
      const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: budget });
      for (const p of pages) expect(estimateTokens(JSON.stringify(p))).toBeLessThanOrEqual(Math.max(FLOOR, budget));
      const served = joined(pages);
      for (const ch of chunks) expect(served.get(ch.id)).toBe(stripFences(servedChunkText(t.store, 'ws_a', ch)));
      expect(pages.at(-1)!.truncated).toBe(false);
      expect(JSON.stringify(pages)).not.toMatch(/retry_cursor|"omitted"/);
    });
  }

  it('a passage longer than a page is continued exactly where the last page stopped; cut means "continues on the next page"', async () => {
    const { t, a, c } = await setup();
    const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: FLOOR });
    const pieces = pages.flatMap((p) => p.items ?? []);
    expect(pieces.filter((i) => i.cut).length).toBeGreaterThan(1);
    pages.forEach((p, i) => {
      const last = p.items?.at(-1);
      if (last?.cut) expect(pages[i + 1]!.items![0]!.chunk_id).toBe(last.chunk_id);
      for (const it of (p.items ?? []).slice(0, -1)) expect(it.cut).toBeUndefined();
    });
  });

  it('the artifact header is sent on the first page only', async () => {
    const { t, a, c } = await setup();
    const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 250 });
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toMatchObject({ kind: 'artifact', id: a.id, title: 'pricing page', mode: 'text' });
    const items = pages.flatMap((p) => p.items ?? []);
    expect(items[0]).toMatchObject({ type: 'meta', mime: 'text/markdown' });
    expect(String(items.find((i) => i.type === 'description')!.text)).toContain('fictional pricing page');
    for (const p of pages.slice(1)) for (const k of Object.keys(p)) expect(LATER_KEYS.has(k), `later page key ${k}`).toBe(true);
  });

  it('redaction runs before every cut: no piece shows any part of a secret', async () => {
    const { t, a, c } = await setup();
    for (const budget of [100, 130, 160, 190]) {
      const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: budget });
      const all = JSON.stringify(pages);
      for (let n = 4; n <= SECRET.length; n++) {
        for (let i = 0; i + n <= SECRET.length; i += 3) expect(all).not.toContain(SECRET.slice(i, i + n));
      }
      expect([...joined(pages).values()].join('')).toContain('[redacted]');
    }
  });

  it('the retrieval row of each page lists every passage it served', async () => {
    const { t, a, c } = await setup();
    const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 160 });
    const rows = t.rows(c.agentRunId);
    expect(rows).toHaveLength(pages.length);
    pages.forEach((p, i) => {
      const ids = rows[i]!.resultIds.map((r) => r.id);
      for (const it of (p.items ?? []).filter((x) => x.type === 'chunk')) expect(ids).toContain(it.chunk_id);
    });
  });

  it('a hand-edited cursor (position changed) is rejected: pass it exactly as returned', async () => {
    const { t, a, c } = await setup();
    const p = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 160 });
    // c1.<key>.<offset>[.<pos>].<check>: move the position by one, keep the check value.
    const parts = p.cursor!.split('.');
    const forged = parts.length === 5
      ? [parts[0], parts[1], parts[2], String(Number(parts[3]) + 1), parts[4]].join('.')
      : [parts[0], parts[1], parts[2], '1', parts[3]].join('.');
    const r = await t.handle(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 160, cursor: forged });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/exactly as returned/);
  });

  it('cursors stay bound to the request', async () => {
    const { t, a, c } = await setup();
    const p = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 160 });
    const r = await t.handle(c, 'read_artifact', { artifact_id: a.id, mode: 'outline', cursor: p.cursor });
    expect(r.ok).toBe(false);
  });
});

describe('raw mode and expand on chunks page by position', () => {
  for (const budget of [100, 200, 2000]) {
    it(`raw at max_tokens ${budget}: the joined pieces are the whole stored text, header on the first page only`, async () => {
      const { t, a, c } = await setup();
      const pages = await follow(t, c, 'read_artifact', { artifact_id: a.id, mode: 'raw', max_tokens: budget });
      for (const p of pages) expect(p.tokens).toBeLessThanOrEqual(Math.max(FLOOR, budget));
      const text = pages.flatMap((p) => p.items ?? []).filter((i) => i.type === 'raw').map((i) => FENCED.exec(String(i.text))![1]).join('');
      expect(text).toBe(stripFences(TEXT.replace(SECRET, '[redacted]')));
      for (const p of pages.slice(1)) for (const k of Object.keys(p)) expect(LATER_KEYS.has(k), `later page key ${k}`).toBe(true);
    });
  }

  it('a first page at the floor carries the whole header and still serves an item (never header_cut)', async () => {
    const { t, a, c } = await setup();
    const p = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 1 });
    expect(p).toMatchObject({ kind: 'artifact', id: a.id, title: 'pricing page', mode: 'text' });
    expect(p.header_cut).toBeUndefined();
    expect(p.items!.length).toBeGreaterThan(0);
    expect(p.cursor).toBeDefined();
  });

  it('expand of a chunk with neighbours serves every neighbour whole across the pages', async () => {
    const { t, chunks, c } = await setup();
    const mid = chunks[1]!;
    const pages = await follow(t, c, 'expand', { id: mid.id, around: 1, max_tokens: 140 });
    const served = joined(pages);
    for (const ch of chunks.filter((x) => Math.abs(x.seq - mid.seq) <= 1)) {
      expect(served.get(ch.id)).toBe(stripFences(servedChunkText(t.store, 'ws_a', ch)));
    }
    expect(pages[0]).toMatchObject({ kind: 'chunk', id: mid.id });
    for (const p of pages.slice(1)) for (const k of Object.keys(p)) expect(LATER_KEYS.has(k), `later page key ${k}`).toBe(true);
  });
});

describe('lists never skip an item (KS-8 ruling)', () => {
  it('evidence items that do not fit after the header start the next page whole (re-gate Opus 1); following the cursor visits every item', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', 'Quote source text.');
    const f = t.fact('ws_a', 'Big evidence', { evidence: [a.id] });
    const b = await t.page('ws_a', 'Another source.');
    const g = await t.page('ws_a', 'Third source.');
    t.store.findings.update(f.id, { evidence: [a.id, b.id, g.id] });
    for (const [i, art] of [a, b, g].entries()) {
      knowledgeRepos(t.store).findingEvidence.insert({ findingId: f.id, seq: i, artifactId: art.id, quote: `quote ${i} ${'q'.repeat(1500)}` });
    }
    const c = t.ctx('ws_a');
    const pages = await follow(t, c, 'expand', { id: f.id, max_tokens: 400 });
    for (const p of pages) expect(p.tokens).toBeLessThanOrEqual(400);
    const evidence = pages.flatMap((p) => p.items ?? []).filter((i) => i.type === 'evidence');
    expect(evidence.map((e) => e.artifact_id)).toEqual([a.id, b.id, g.id]);
    expect(evidence.some((e) => e.cut === true)).toBe(false); // each fits a later page whole
    // Re-gate (binding): each quote is an item of its own, fenced.
    const quotes = pages.flatMap((p) => p.items ?? []).filter((i) => i.type === 'quote');
    expect(quotes.map((q) => q.artifact_id)).toEqual([a.id, b.id, g.id]);
    for (const q of quotes) expect(q.quote as string).toMatch(FENCED);
    expect(JSON.stringify(pages)).not.toMatch(/retry_cursor|"omitted"/);
  });

  it('search hits: every hit is served once across the pages at the minimum budget', async () => {
    const t = ks4(opened);
    const ids = Array.from({ length: 6 }, (_, i) => t.fact('ws_a', `Globex widget fact number ${i} ${'detail '.repeat(25)}`).id);
    const c = t.ctx('ws_a');
    const pages = await follow(t, c, 'search', { query: 'globex widget', kinds: ['fact'], max_tokens: 1 });
    for (const p of pages) expect(p.tokens).toBeLessThanOrEqual(READ_FLOOR_TOKENS.search);
    const hits = pages.flatMap((p) => (p.hits as Item[]) ?? []);
    expect(hits.map((h) => h.id).sort()).toEqual([...ids].sort());
    const rows = t.rows(c.agentRunId);
    pages.forEach((p, i) => {
      for (const h of (p.hits as Item[]) ?? []) expect(rows[i]!.resultIds.map((r) => r.id)).toContain(h.id);
    });
  });

  it('card lines: every fact line is served across the pages; a line too long for the page is shortened, and expand of its id gives the full claim', async () => {
    const t = ks4(opened);
    const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
    // Control characters are JSON-escaped six-fold: these lines are larger than a page at the floor.
    const facts = Array.from({ length: 4 }, (_, i) => t.fact('ws_a', `Globex claim ${i} ${'\u0001'.repeat(200)} end of claim ${i}`, { entityId: e.id }));
    const c = t.ctx('ws_a');
    const pages = await follow(t, c, 'get_card', { entity_id: e.id, max_tokens: READ_FLOOR_TOKENS.get_card });
    for (const p of pages) expect(p.tokens).toBeLessThanOrEqual(READ_FLOOR_TOKENS.get_card);
    expect(pages.flatMap((p) => (p.lines as unknown[]) ?? []).some((l) => typeof l === 'object'), 'some line is cut').toBe(true);
    type Line = string | { text: string; cut?: boolean; full?: { tool: string; input: Record<string, unknown> } };
    const lines = pages.flatMap((p) => (p.lines as Line[]) ?? []);
    // Re-gate (binding): a cut line carries the call that returns it whole (this card, at it, larger budget).
    const recovered: string[] = [];
    for (const l of lines) {
      if (typeof l === 'string') recovered.push(l);
      else if (l.cut && l.full) {
        expect(l.full.tool).toBe('get_card');
        const back = await t.call<{ lines: string[] }>(c, 'get_card', l.full.input);
        recovered.push(back.lines[0]!);
      } else recovered.push(l.text);
    }
    // Every fact line is back whole; a card line summarises its claim (≤ 300 chars), `expand` of the id has all of it.
    for (const f of facts) {
      expect(recovered.some((l) => l.includes(f.id)), f.id).toBe(true);
      expect((await t.call<{ items: Array<{ type: string; text?: string }> }>(c, 'expand', { id: f.id })).items[0]!.text).toMatch(/end of claim \d$/);
    }
  });
});

describe('shortening helpers (KS-8 ruling)', () => {
  it('cutServedText cuts inside a fence, never through its markers, and never ends in an angle-bracket run', () => {
    const fenced = `<<<EVIDENCE art_1\n${'x'.repeat(200)}\n>>>`;
    expect(cutServedText(fenced, 60)).toMatch(/^<<<EVIDENCE art_1\nx+…\n>>>$/);
    expect(cutServedText(fenced, 60).length).toBeLessThanOrEqual(62);
    expect(cutServedText('plain words then <<<<<< more', 21)).toBe('plain words then …');
    expect(cutServedText('short', 10)).toBe('short');
  });

  it('shortenItem keeps ids whole, cuts text, trims lists only when needed, and marks cut', () => {
    const fits = (n: number) => (x: unknown) => estimateTokens(JSON.stringify(x)) <= n;
    const line = shortenItem(`[fnd_ABC] ${'claim '.repeat(100)}`, fits(30)) as { text: string; cut: boolean };
    expect(line).toMatchObject({ cut: true });
    expect(line.text.startsWith('[fnd_ABC] claim')).toBe(true);
    const hit = shortenItem({ kind: 'fact', id: 'fnd_0123456789', title: 't'.repeat(400), artifact_id: 'art_0123456789' }, fits(40)) as Record<string, unknown>;
    expect(hit).toMatchObject({ kind: 'fact', id: 'fnd_0123456789', artifact_id: 'art_0123456789', cut: true });
    expect(String(hit.title).length).toBeLessThan(400);
    const ev = shortenItem({ type: 'evidence', artifact_id: 'art_1', quotes: Array.from({ length: 30 }, (_, i) => `<<<EVIDENCE art_1\nq${i} ${'q'.repeat(300)}\n>>>`) }, fits(120)) as { quotes: string[] };
    expect(ev.quotes.length).toBeGreaterThan(0);
    expect(ev.quotes.length).toBeLessThan(30);
    for (const q of ev.quotes) expect(q).toMatch(/^<<<EVIDENCE art_1\n[\s\S]*\n>>>$/);
    expect(shortenItem({ id: 'x'.repeat(400) }, fits(20))).toBeUndefined();
  });
});

describe('read tool descriptions (KS-8 ruling, paging rework)', () => {
  it('say: follow cursor until it is absent; cut carries full; a passage piece continues; the floor', () => {
    for (const tool of ['read_artifact', 'expand', 'search', 'get_card', 'list_changes', 'read_workspace'] as const) {
      const props = (toolJsonSchema(tool) as { properties: Record<string, { description?: string }> }).properties;
      expect(props.cursor?.description, tool).toMatch(/until it is absent/);
      expect(props.max_tokens?.description, tool).toMatch(/capped/);
      expect(TOOL_DESCRIPTIONS[tool], tool).toMatch(/follow `cursor` until it is absent; an item marked `cut` carries `full`, the exact call that returns it/);
      expect(TOOL_DESCRIPTIONS[tool], tool).not.toMatch(/retry_cursor|header_cut/);
    }
    expect(TOOL_DESCRIPTIONS.read_artifact).toMatch(/a passage marked `cut` continues on the next page/);
    expect(TOOL_DESCRIPTIONS.expand).toMatch(/a passage marked `cut` continues on the next page/);
  });
});

describe('save_finding relation input (KS-8 smoke: haiku sent "\\"new\\"")', () => {
  it('accepts a JSON-encoded relation and explains the valid forms otherwise', async () => {
    const { toolInputSchemas } = await import('../../../src/core/harness/tools/registry.js');
    const base = { claim: 'c', subject: 's', evidence: ['art_1'] };
    expect(toolInputSchemas.save_finding.parse({ ...base, relation: '"new"' }).relation).toBe('new');
    expect(toolInputSchemas.save_finding.parse({ ...base, relation: '{"confirms":"fnd_1"}' }).relation).toEqual({ confirms: 'fnd_1' });
    expect(toolInputSchemas.save_finding.parse({ ...base, relation: { replaces: 'fnd_2' } }).relation).toEqual({ replaces: 'fnd_2' });
    const shown = (toolJsonSchema('save_finding') as { properties: Record<string, { anyOf?: unknown[] }> }).properties.relation;
    expect(shown?.anyOf).toHaveLength(3); // agents still see the three forms
    const bad = toolInputSchemas.save_finding.safeParse({ ...base, relation: 'old' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe('relation must be "new", {"confirms": "<fact id>"} or {"replaces": "<fact id>"}');
  });
});
