/**
 * (A module with no imports, so the config schema validates `knowledge.hardMaxTokens` against the floors
 * without an import cycle.)
 *
 * Floor of each read tool's response budget (tokens; paging rework, binding floor invariant): a smaller
 * configured budget or `max_tokens` is clamped up to it. At its floor a page holds the tool's header
 * (bounded), its notes, the envelope and at least one item: whole, a passage piece, or cut with its
 * pointer — so while content remains, no page is empty. `knowledge.hardMaxTokens` may not be set below
 * the highest floor (validated at load, `HIGHEST_READ_FLOOR`); a provider scale that brings the hard
 * maximum under a floor does not lower it: the floor wins. Measured by the sweep tests
 * (`test/core/knowledge/pagingSweep*.test.ts`); documented in design §9 and the tool descriptions.
 */
export const READ_FLOOR_TOKENS = {
  search: 200,
  get_card: 200,
  expand: 300,
  read_artifact: 300,
  list_changes: 200,
  read_workspace: 200,
} as const satisfies Record<string, number>;

/** The highest floor: the smallest `knowledge.hardMaxTokens` a config may set. */
export const HIGHEST_READ_FLOOR = Math.max(...Object.values(READ_FLOOR_TOKENS));
