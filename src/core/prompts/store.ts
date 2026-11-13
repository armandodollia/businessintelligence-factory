/**
 * Prompt store (learning loop WP-B): every `prompt_version` hash recorded on a run or decision
 * resolves to its full text in `prompt_versions`.
 *
 * Public API:
 * - `recordPromptVersion(store, role, text)` — stores `text` under its hash (`promptVersion(text)`), returns the hash.
 *   Call it wherever a prompt version is recorded that is not the run's system prompt (e.g. a
 *   decision tagged with a role's current prompt version).
 * - `getPromptText(store, hash)` — the stored record, or undefined.
 * - `recordRunPrompt` — what the supervisor calls for every run.
 * - `promptStoreGaps(store)` — recorded hashes without text (diagnostics / tests).
 */
import type { Store } from '../store/db.js';
import { usageRepos } from '../store/usageRepos.js';
import type { PromptVersionRecord } from '../types.js';
import { promptVersion } from './index.js';

/** Pseudo versions of decisions no prompt produced (system / user decisions). */
const NOT_A_PROMPT = new Set(['', 'n/a']);

function insertIgnore(store: Store, hash: string, role: string, text: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO prompt_versions (hash, role, text, created_at) VALUES (?, ?, ?, ?)')
    .run(hash, role, text, new Date().toISOString());
}

/** Stores `text` under its prompt version (first write wins); returns the version hash. */
export function recordPromptVersion(store: Store, role: string, text: string): string {
  const hash = promptVersion(text);
  insertIgnore(store, hash, role, text);
  return hash;
}

/**
 * Records the prompt of an agent run: when `systemPrompt` hashes to `hash` it is the exact text;
 * otherwise (a caller hashed more than the system prompt, e.g. persona panel = system + template,
 * and should have recorded the exact text with `recordPromptVersion` first) the system prompt is
 * stored only if nothing is stored yet, so the hash always resolves.
 */
export function recordRunPrompt(store: Store, role: string, hash: string, systemPrompt: string): void {
  if (NOT_A_PROMPT.has(hash)) return;
  insertIgnore(store, hash, role, systemPrompt);
}

export function getPromptText(store: Store, hash: string): PromptVersionRecord | undefined {
  return usageRepos(store).promptVersions.get(hash);
}

/**
 * Prompt versions recorded anywhere (agent runs, decisions, usage, ratings, feedback events,
 * decision outcomes, review issues) that have no stored text.
 */
export function promptStoreGaps(store: Store): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT v FROM (
         SELECT prompt_version AS v FROM agent_runs
         UNION SELECT prompt_version AS v FROM decisions
         UNION SELECT prompt_version AS v FROM agent_usage
         UNION SELECT prompt_version AS v FROM ratings
         UNION SELECT prompt_version AS v FROM feedback_events
         UNION SELECT prompt_version AS v FROM decision_outcomes
         UNION SELECT worker_prompt_version AS v FROM review_issues
       ) WHERE v IS NOT NULL AND v NOT IN ('', 'n/a') AND v NOT IN (SELECT hash FROM prompt_versions) ORDER BY v`,
    )
    .all() as Array<{ v: string }>;
  return rows.map((r) => r.v);
}
