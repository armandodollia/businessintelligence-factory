/**
 * Use linkage (design §13 "Use linkage"; build plan KS-6). When a run saves something that cites ids
 * — a finding, a confirmation or retraction (an observation), a recommendation, persona, competitor,
 * hypothesis or symptom — every cited id that an EARLIER retrieval of the same agent run returned is
 * marked used: one `retrieval_uses` row per (retrieval event, item, saving record). Hit rate =
 * share of retrievals with at least one used result (`metrics.ts`).
 *
 * "Cited" is generic on purpose: every string anywhere in the tool input is a candidate (evidence
 * ids, `evidence_refs` chunk ids, `relation.confirms` / `replaces`, `finding_ids`, entity ids,
 * `relations[].to`, a hypothesis' symptom id, ...), and only those the run was actually shown count.
 * So a new input field that carries an id needs no change here. The dispatcher calls
 * `recordToolUses` after every successful tool call (`harness/tools/handlers.ts`, KS-6 block).
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { RetrievalResultRef, RetrievalUse } from '../types.js';

/** Tools whose successful call is a save that may cite retrieved ids. */
export const CITING_SAVE_TOOLS = [
  'save_finding',
  'confirm_finding',
  'retract_finding',
  'save_recommendation',
  'save_persona',
  'save_competitor',
  'save_hypothesis',
  'save_symptom',
] as const;
const CITING: ReadonlySet<string> = new Set(CITING_SAVE_TOOLS);

/** What a save tool's result names as the saved record; `undefined` when nothing was saved (handshake). */
const SAVED_KEYS: ReadonlyArray<[string, string]> = [
  ['observationId', 'observation'],
  ['findingId', 'finding'],
  ['recommendationId', 'recommendation'],
  ['personaId', 'persona'],
  ['competitorId', 'competitor'],
  ['hypothesisId', 'hypothesis'],
  ['symptomId', 'symptom'],
];

/**
 * The record a save tool's result data names: a confirmation / retraction (also through
 * `save_finding`) is the `observation`, else the output it saved. `undefined` when the call saved
 * nothing (`saved: false`, the duplicate handshake) or names no record.
 */
export function savedRecordOf(data: unknown): { kind: string; id: string } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (d.saved === false) return undefined;
  for (const [key, kind] of SAVED_KEYS) if (typeof d[key] === 'string') return { kind, id: d[key] as string };
  return undefined;
}

/** Every string in `value` (deep), at most `max`. */
export function stringsIn(value: unknown, max = 2000): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.size >= max || depth > 12) return;
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

/**
 * Marks as used every id in `cited` that a retrieval of `agentRunId` returned (one row per
 * retrieval event that returned it), for the saving record `usedBy`. Idempotent (a replayed save adds
 * nothing). The saving record's own id is never its own use. Returns the rows written now.
 */
export function recordRetrievalUses(
  store: Store,
  input: { agentRunId: string; usedBy: { kind: string; id: string }; cited: Iterable<string>; now?: Date },
): RetrievalUse[] {
  const cited = new Set(input.cited);
  cited.delete(input.usedBy.id);
  if (!cited.size) return [];
  const rows = store.db
    .prepare('SELECT id, result_ids AS r FROM retrieval_events WHERE agent_run_id = ? ORDER BY rowid')
    .all(input.agentRunId) as Array<{ id: string; r: string }>;
  if (!rows.length) return [];
  const createdAt = (input.now ?? new Date()).toISOString();
  const repo = knowledgeRepos(store).retrievalUses;
  const out: RetrievalUse[] = [];
  for (const row of rows) {
    let refs: RetrievalResultRef[];
    try {
      refs = JSON.parse(row.r) as RetrievalResultRef[];
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const ref of refs) {
      const id = ref?.id;
      if (typeof id !== 'string' || seen.has(id) || !cited.has(id)) continue;
      seen.add(id);
      const use: RetrievalUse = { retrievalEventId: row.id, itemId: id, usedByKind: input.usedBy.kind, usedById: input.usedBy.id, createdAt };
      if (repo.insertIgnore(use)) out.push(use);
    }
  }
  return out;
}

/**
 * The dispatcher hook: after a successful call of a citing save tool by an agent run, records the
 * uses of what the call cited (its whole input). No-op for other tools, failures and handshakes.
 */
export function recordToolUses(
  store: Store,
  ctx: { agentRunId: string },
  tool: string,
  input: unknown,
  result: { ok: boolean; data?: unknown },
): RetrievalUse[] {
  if (!CITING.has(tool) || !result.ok) return [];
  const usedBy = savedRecordOf(result.data);
  if (!usedBy) return [];
  return recordRetrievalUses(store, { agentRunId: ctx.agentRunId, usedBy, cited: stringsIn(input) });
}

/** Uses of one retrieval event, in insertion order. */
export function usesOf(store: Store, retrievalEventId: string): RetrievalUse[] {
  return knowledgeRepos(store).retrievalUses.list({ retrievalEventId });
}
