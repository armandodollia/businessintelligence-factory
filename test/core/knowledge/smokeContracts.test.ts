/**
 * KS-8 real-CLI smoke follow-ups: the paging contract the read tools' descriptions now state, so a
 * real agent that follows them gets the whole text.
 * - `max_tokens` can be raised (up to the default budget) on a repeat with the same cursor: a page
 *   where nothing fit is served whole, starting at the same item.
 * - A passage shortened to fit is marked `cut: true`; `expand` of its chunk id returns all of it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTIONS, toolJsonSchema } from '../../../src/core/harness/tools/registry.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Item = { type?: string; chunk_id?: string; text?: string; cut?: boolean; omitted?: boolean };
type Page = { items?: Item[]; truncated: boolean; cursor?: string; notes?: string[] };

const LONG = `The Team plan costs $49 per user per month, billed annually. ${'It includes unlimited warehouses and shared dashboards. '.repeat(12)}The end of the plan text.`;
const TEXT = `Pricing overview for a fictional vendor.\n\n${LONG}\n\nEvery plan starts with a 14-day free trial.`;

describe('read tool descriptions (KS-8 smoke)', () => {
  it('say that max_tokens may be raised on a repeat and that cut passages are expanded by chunk id', () => {
    const maxTokens = (tool: 'read_artifact' | 'expand' | 'search') =>
      ((toolJsonSchema(tool) as { properties: Record<string, { description?: string }> }).properties.max_tokens?.description ?? '');
    for (const tool of ['read_artifact', 'expand', 'search'] as const) {
      expect(maxTokens(tool)).toMatch(/capped/);
      expect(maxTokens(tool)).toMatch(/Raise it .*same cursor/);
    }
    expect(TOOL_DESCRIPTIONS.read_artifact).toMatch(/`cut: true`.*expand its chunk_id/);
    expect(TOOL_DESCRIPTIONS.expand).toMatch(/`cut: true`/);
  });
});

describe('read_artifact text paging (KS-8 smoke)', () => {
  it('a page where nothing fit is served from the same item when the cursor is repeated with a larger max_tokens', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', TEXT, { title: 'pricing' });
    const c = t.ctx('ws_a');
    const tiny = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 100 });
    expect(tiny.truncated).toBe(true);
    expect(tiny.notes?.join(' ')).toMatch(/larger max_tokens/);
    const again = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 2000, cursor: tiny.cursor });
    const first = knowledgeRepos(t.store).chunks.list({ artifactId: a.id }).sort((x, y) => x.seq - y.seq)[0]!;
    expect(again.items?.[0]?.chunk_id).toBe(first.id);
    expect(again.truncated).toBe(false);
  });

  it('a passage cut to fit is marked cut, and expand of its chunk id returns the whole passage', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', TEXT, { title: 'pricing' });
    const c = t.ctx('ws_a');
    const served: Item[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const p = await t.call<Page>(c, 'read_artifact', { artifact_id: a.id, mode: 'text', max_tokens: 250, ...(cursor ? { cursor } : {}) });
      served.push(...(p.items ?? []));
      if (!p.truncated || !p.cursor) break;
      cursor = p.cursor;
    }
    const cut = served.find((x) => x.cut === true);
    expect(cut?.chunk_id).toBeDefined();
    expect(cut!.text).not.toContain('The end of the plan text.');
    const full = await t.call<{ items: Item[] }>(c, 'expand', { id: cut!.chunk_id });
    const passage = full.items.find((x) => x.chunk_id === cut!.chunk_id);
    expect(passage?.cut).toBeUndefined();
    expect(passage?.text).toContain('The end of the plan text.');
  });
});
