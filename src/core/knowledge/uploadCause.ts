/**
 * Why an item is upload-derived (design §12; KS-2 ruling "why a flag was set"). The UI and the
 * export report explain an exclusion with `explainUploadDerived`: it follows the RECORDED cause
 * (`upload_cause`, kept by the migration-18 triggers, first cause wins) from the item down to the
 * upload itself, e.g.
 *
 *   fnd_… (observation:obs_…) → obs_… (cites art_…) → art_… (kind:upload)
 *
 * Records without a flag column (observations, competitors, symptoms, hypotheses, personas,
 * recommendations, unit proposals) are explained through the first item they cite that is
 * upload-derived now (`itemIsUploadDerived`), so the explanation and the check always agree.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import { evidenceOf, itemIsUploadDerived } from './provenance.js';

export type UploadCauseStep = {
  id: string;
  kind: 'artifact' | 'finding' | 'chunk' | 'observation' | 'record';
  /** The recorded cause on a flagged row (`kind:upload`, `observation:<id>`, ...); absent on records. */
  cause?: string;
  /** One-line reading of this step. */
  note: string;
};

export type UploadExplanation = {
  itemId: string;
  /** From the item down to the upload (last step). */
  chain: UploadCauseStep[];
  /** The chain as one sentence, for the UI and the export report. */
  text: string;
};

type FlagRow = { d: number; c: string | null };

const flagRow = (store: Store, table: 'artifacts' | 'findings', id: string): FlagRow | undefined =>
  store.db.prepare(`SELECT upload_derived AS d, upload_cause AS c FROM ${table} WHERE id = ?`).get(id) as FlagRow | undefined;

/** The cause id after the `prefix:` of a recorded cause, if it names an item. */
function causeTarget(cause: string): string | undefined {
  const i = cause.indexOf(':');
  if (i < 0) return undefined;
  const kind = cause.slice(0, i);
  return ['duplicate_of', 'evidence', 'finding_evidence', 'observation', 'lineage'].includes(kind) ? cause.slice(i + 1) : undefined;
}

const NOTES: Record<string, (target: string) => string> = {
  'kind:upload': () => 'is an internal upload',
  profile: (ws) => `is listed as an upload in the profile of ${ws}`,
  duplicate_of: (a) => `has the same text as ${a}`,
  evidence: (a) => `cites ${a} as evidence`,
  finding_evidence: (a) => `quotes ${a}`,
  observation: (o) => `was confirmed, replaced or retracted by observation ${o}`,
  lineage: (f) => `is a later version of ${f}`,
};

function noteFor(cause: string): string {
  if (cause === 'kind:upload') return NOTES['kind:upload']!('');
  const i = cause.indexOf(':');
  const kind = i < 0 ? cause : cause.slice(0, i);
  return NOTES[kind]?.(cause.slice(i + 1)) ?? `is upload-derived (${cause})`;
}

/**
 * The recorded reason item `id` is upload-derived, as a chain down to the upload; `undefined` when
 * the item is not upload-derived (or unknown). Cycle-safe.
 */
export function explainUploadDerived(store: Store, id: string): UploadExplanation | undefined {
  if (!itemIsUploadDerived(store, id)) return undefined;
  const chain: UploadCauseStep[] = [];
  const seen = new Set<string>();
  let next: string | undefined = id;
  while (next !== undefined && !seen.has(next)) {
    seen.add(next);
    const step = stepOf(store, next);
    if (!step) break;
    chain.push(step.step);
    next = step.next;
  }
  const text = chain.map((s) => `${s.id} ${s.note}`).join('; ');
  return { itemId: id, chain, text };
}

function stepOf(store: Store, id: string): { step: UploadCauseStep; next?: string } | undefined {
  for (const table of ['artifacts', 'findings'] as const) {
    const row = flagRow(store, table, id);
    if (!row) continue;
    if (row.d !== 1) return undefined;
    const kind = table === 'artifacts' ? 'artifact' : 'finding';
    if (!row.c) return { step: { id, kind, note: 'is upload-derived (cause not recorded)' } };
    const target = causeTarget(row.c);
    return { step: { id, kind, cause: row.c, note: noteFor(row.c) }, ...(target ? { next: target } : {}) };
  }
  const chunk = store.db.prepare('SELECT artifact_id AS a FROM chunks WHERE id = ?').get(id) as { a: string } | undefined;
  if (chunk) return { step: { id, kind: 'chunk', note: `is a passage of ${chunk.a}` }, next: chunk.a };
  // An observation is explained by the evidence it cites (its fact may be flagged BY it).
  const obs = knowledgeRepos(store).factObservations.get(id);
  const ids = obs ? [...obs.evidence, obs.findingId] : (evidenceOf(store, id) ?? []);
  const cited = ids.find((e) => itemIsUploadDerived(store, e));
  if (cited === undefined) return undefined;
  return { step: { id, kind: obs ? 'observation' : 'record', note: `cites ${cited}` }, next: cited };
}
