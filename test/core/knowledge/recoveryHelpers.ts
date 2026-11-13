/**
 * Re-gate (binding recovery shapes): a shortened item's `full` names the call that returns it whole.
 * `expectRecovered` makes that call and checks that every piece of text of the uncut item is in the answer.
 */
import { expect } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import type { ToolName } from '../../../src/core/harness/tools/registry.js';
import { RECOVERY_KINDS, type Recover } from '../../../src/core/knowledge/readCommon.js';
import type { Ks4 } from './ks4fixture.js';

/** Text pieces of an item: its string leaves (fence lines and cut marks removed), flags left out. */
export function textPieces(item: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (key === 'flags' || key === 'type' || key === 'kind' || key === 'change') return; // labels, not content
    if (typeof v === 'string') {
      const core = v.replace(/^<<<EVIDENCE [^\n]*\n/, '').replace(/\n>>>$/, '').replace(/^…|…$/g, '').trim();
      if (core.length >= 3) out.push(core);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(item);
  return out;
}

/** Follows `cut.full` and asserts the answer carries every text piece of `ref` (the uncut item). Returns the kind. */
export async function expectRecovered(t: Ks4, c: RunContext, cut: Record<string, unknown>, ref: unknown, label = ''): Promise<string> {
  const full = cut.full as Recover | undefined;
  expect(full, `${label}: a cut item carries a pointer`).toBeDefined();
  expect(RECOVERY_KINDS as readonly string[], label).toContain(full!.kind);
  const answer = await t.call<Record<string, unknown>>(c, full!.tool as ToolName, full!.input);
  const json = JSON.stringify(answer);
  for (const piece of textPieces(ref)) expect(json, `${label} (${full!.kind}): "${piece.slice(0, 60)}"`).toContain(JSON.stringify(piece).slice(1, -1));
  return full!.kind;
}
