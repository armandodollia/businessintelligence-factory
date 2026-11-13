/**
 * "Usable" as SQL (design §7.2, §7.4), shared by the graph reads (`relations.ts`) and the entity
 * upload rule (`provenance.ts`) so both agree on which records count.
 *
 * - fact (finding): lifecycle `current` and `isSynthesisEligible` (not superseded; the user's
 *   include override, else verified);
 * - competitor, persona, hypothesis: `isOutputUsable` (not superseded; include override, else verified);
 * - symptom (interview record, no review) and artifact (evidence, no review): usable while the row exists.
 *
 * Each predicate takes a table alias and must stay in step with `isOutputUsable`
 * (`research/outputs.ts`) and `isSynthesisEligible` (`evidence/synthesis.ts`).
 */
import type { RelationSourceKind } from '../types.js';

/** Finding usable as a current fact. */
export const factUsableSql = (a: string): string =>
  `(${a}.lifecycle = 'current' AND COALESCE(${a}.status, 'pending') <> 'superseded'
    AND COALESCE(${a}.include_in_synthesis, COALESCE(${a}.status, 'pending') = 'verified') = 1)`;

/** Reviewed output (competitor, persona, symptom hypothesis) usable downstream. */
export const outputUsableSql = (a: string): string =>
  `(COALESCE(${a}.status, 'pending') <> 'superseded'
    AND COALESCE(${a}.include_override, COALESCE(${a}.status, 'pending') = 'verified') = 1)`;

/** Table of each kind of record that can assert an edge or reference an entity. */
export const SOURCE_TABLES: Record<RelationSourceKind, string> = {
  fact: 'findings',
  competitor: 'competitors',
  persona: 'personas',
  symptom: 'symptoms',
  hypothesis: 'symptom_hypotheses',
  artifact: 'artifacts',
};

/** Usable predicate of a record of `kind` aliased `a`. */
export function recordUsableSql(kind: RelationSourceKind, a: string): string {
  switch (kind) {
    case 'fact':
      return factUsableSql(a);
    case 'competitor':
    case 'persona':
    case 'hypothesis':
      return outputUsableSql(a);
    case 'symptom':
    case 'artifact':
      return '1';
  }
}

/**
 * SQL expression (0/1): the record named by `${kindCol}` / `${idCol}` exists and is usable.
 * Unknown kinds are never usable.
 */
export function sourceUsableSql(kindCol: string, idCol: string): string {
  const arms = (Object.keys(SOURCE_TABLES) as RelationSourceKind[]).map(
    (k) => `WHEN '${k}' THEN EXISTS (SELECT 1 FROM ${SOURCE_TABLES[k]} u WHERE u.id = ${idCol} AND ${recordUsableSql(k, 'u')})`,
  );
  return `(CASE ${kindCol} ${arms.join(' ')} ELSE 0 END)`;
}

/**
 * SQL expression (0/1): the record is visible from the workspaces of a CTE `vis(ws)` that the
 * caller's query defines (design §7.1): facts and artifacts by their `item_scopes` rows, typed
 * records by their `workspace_id`.
 */
export function sourceVisibleSql(kindCol: string, idCol: string): string {
  const scoped = (k: 'fact' | 'artifact') =>
    `WHEN '${k}' THEN EXISTS (SELECT 1 FROM item_scopes s WHERE s.item_kind = '${k}' AND s.item_id = ${idCol} AND s.workspace_id IN (SELECT ws FROM vis))`;
  const typed = (['competitor', 'persona', 'symptom', 'hypothesis'] as const).map(
    (k) => `WHEN '${k}' THEN EXISTS (SELECT 1 FROM ${SOURCE_TABLES[k]} v WHERE v.id = ${idCol} AND v.workspace_id IN (SELECT ws FROM vis))`,
  );
  return `(CASE ${kindCol} ${scoped('fact')} ${scoped('artifact')} ${typed.join(' ')} ELSE 0 END)`;
}
