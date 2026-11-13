/**
 * Knowledge store KS-7: the Knowledge view's logic (design §17). Search with "this part / whole
 * business", entity list → card → item (fact history, evidence), merge suggestions, stale and
 * conflict lists, changes, and the gc report with a user prune. Views render what `useKnowledgeView`
 * returns and call its actions; nothing here renders HTML.
 *
 * Display rules: stored text (claims, evidence, descriptions) is plain text, never HTML; evidence
 * arrives fenced (`<<<EVIDENCE art_… … >>>`) and is shown as untrusted text with its artifact id
 * (`parseEvidence`); upload-derived items are marked and carry `uploadWhy` (why the export leaves them
 * out by default).
 */
import { useCallback, useState } from 'react';
import { ApiError, knowledgeApi } from './api.js';
import { useResource } from './hooks.js';

export type KnowledgeScope = 'node' | 'tree';

export const SCOPE_LABELS: Record<KnowledgeScope, string> = { node: 'This part of the business', tree: 'Whole business' };

/** Fields every read response carries (KS-4 envelope). */
type Envelope = { tokens: number; truncated: boolean; more?: number; cursor?: string; notes?: string[]; content_trust?: string; uploadWhy?: string; upload?: boolean };

export type SearchHit = {
  kind: 'fact' | 'passage' | 'artifact' | 'entity' | 'record';
  id: string;
  type?: string;
  title?: string;
  snippet?: string;
  artifact_id?: string;
  entity?: { id: string; name: string };
  source?: string;
  flags?: string[];
  age_days?: number;
  uploadWhy?: string;
};
export type SearchResult = Envelope & { query: string; scope: KnowledgeScope; hits: SearchHit[]; relaxed?: boolean };

export type UploadMark = { upload?: true; uploadWhy?: string };
export type EntityRow = { id: string; kind: string; name: string; home: string; source?: string; facts: number; aliases: number } & UploadMark;
export type MergeSide = { id: string; name: string; kind: string; home: string };
export type MergeSuggestionRow = { id: string; score: number; createdAt: string; entity: MergeSide; candidate: MergeSide } & UploadMark;
export type FactRow = {
  id: string; claim: string; lifecycle: string; status: string; version: number; lastConfirmedAt?: string; ageDays: number; ttlDays: number;
  stale: boolean; conflict?: true; entity?: { id: string; name: string }; source?: string;
} & UploadMark;
export type KnowledgeStats = {
  scope: KnowledgeScope;
  facts: { current: number; usable: number; stale: number; candidate: number; replaced: number; retracted: number; conflicts: number };
  artifacts: number; chunks: number; entities: number; openMergeSuggestions: number;
};
export type CardView = Envelope & {
  /** Identity only; aliases arrive as card lines (`alias: …`). */
  entity?: { id: string; name: string; kind: string; home: string; upload?: boolean };
  node?: { id: string; name?: string };
  source?: string;
  /** A line too long for the page comes back shortened as `{ text, cut: true }` (expand its id for the full text). */
  lines: Array<string | { text: string; cut?: boolean }>;
};
/**
 * One `expand` response: a small header (identity: kind fact / artifact / chunk / entity / record, id,
 * name or subject, state, source) and listed items — a fact's claim, criteria and quotes, a record's
 * fields, an artifact's metadata and description (paging rework).
 */
export type ItemView = Envelope & { kind?: string; id?: string; source?: string; items?: Array<Record<string, unknown>> } & Record<string, unknown>;
export type ArtifactTextView = Envelope & { items?: Array<Record<string, unknown>> } & Record<string, unknown>;
export type ChangesView = Envelope & { changes: Array<Record<string, unknown>> };
export type GcCandidate = { artifactId: string; workspaceId: string; kind: string; mime: string; title?: string; bytes: number; lastCapturedAt: string; ageDays: number; uploadDerived: boolean };
export type GcBucket = { count: number; bytes: number };
export type GcReportView = {
  minAgeDays: number;
  totals: { artifacts: number; files: GcBucket; referenced: GcBucket; tooRecent: GcBucket; reclaimable: GcBucket; pruned: number; missing: number };
  byNode: Array<{ workspaceId: string } & GcBucket>;
  byAge: Array<{ bucket: string } & GcBucket>;
  candidates: GcCandidate[];
  moreCandidates: number;
  olderExtractorTexts: number;
};

/** Error text; a refused prune lists each refused file and why. */
export function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const body = e instanceof ApiError ? (e.body as { refused?: Array<{ artifactId: string; reason: string }> } | undefined) : undefined;
  if (body?.refused?.length) return `${msg}: ${body.refused.map((r) => `${r.artifactId} (${r.reason.replace(/_/g, ' ')})`).join(', ')}`;
  return msg;
}

// ---------------------------------------------------------------------------
// display helpers (pure)

export type EvidenceText = { artifactId?: string; text: string };

/**
 * Splits fenced evidence (`<<<EVIDENCE art_x\n…\n>>>`) into its artifact id and the text, for display
 * as PLAIN TEXT (never HTML). Unfenced text is returned as is.
 */
export function parseEvidence(s: string): EvidenceText {
  const m = /^<<<EVIDENCE ([A-Za-z0-9_-]*)\n([\s\S]*)\n>>>$/.exec(s);
  return m ? { artifactId: m[1] || undefined, text: m[2]! } : { text: s };
}

/** `1.2 MB`, `340 KB`, `12 B`. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Item ids the view can open (`expand`): facts, artifacts, chunks, entities, typed records. */
export function isItemId(v: unknown): v is string {
  return typeof v === 'string' && /^(fnd|art|chk|ent|cmp|per|sym|hyp|rec)_/.test(v);
}

/** Header fields of an item response shown as label / value rows (stored text stays plain text). */
const HIDDEN = new Set(['items', 'tokens', 'truncated', 'more', 'cursor', 'notes', 'content_trust', 'retrievalEventId', 'uploadWhy', 'upload', 'kind', 'id']);
export function itemFields(item: ItemView): Array<{ key: string; value: string; evidence?: EvidenceText }> {
  return Object.entries(item)
    .filter(([k, v]) => !HIDDEN.has(k) && v !== undefined && v !== null)
    .map(([key, v]) => {
      if (typeof v === 'string') return v.startsWith('<<<EVIDENCE') ? { key, value: '', evidence: parseEvidence(v) } : { key, value: v };
      return { key, value: JSON.stringify(v) };
    });
}

/** One listed item of an item response, as display parts. */
/** `detail`: secondary facts about the item, shown muted (a persona field's confidence and evidence). */
export type ItemPart = { label: string; text?: string; detail?: string; evidence?: EvidenceText[]; open?: string; source?: string; outside?: boolean };
export function itemPart(i: Record<string, unknown>): ItemPart {
  const type = String(i.type ?? 'item');
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  const evidence: EvidenceText[] = [];
  for (const k of ['text', 'description', 'note', 'quote']) { // re-gate: a fact's quote is an item (`type: 'quote'`)
    const v = str(k);
    if (v?.startsWith('<<<EVIDENCE')) evidence.push(parseEvidence(v));
  }
  if (Array.isArray(i.quotes)) for (const q of i.quotes) if (typeof q === 'string') evidence.push(parseEvidence(q));
  const open = [i.id, i.artifact_id, i.chunk_id].find(isItemId);
  const name = (v: unknown) => (v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : '');
  const src = (v: unknown) => (v && typeof v === 'object' && 'source' in v ? ` (${String((v as { source: unknown }).source)})` : '');
  let text: string | undefined;
  /** Scalar and object fields of the item other than its labels, as `key: value` (plain text). */
  const rest = (skip: string[]) =>
    Object.entries(i)
      .filter(([k, v]) => !['type', ...skip].includes(k) && v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' · ');
  switch (type) {
    case 'field': {
      // A record field (`profile.<key>` keeps value, confidence and evidence together).
      const v = i.value;
      text = typeof v === 'string' ? (v.startsWith('<<<EVIDENCE') ? undefined : v) : v !== undefined ? JSON.stringify(v) : rest(['field']);
      // A persona profile field also carries its confidence and the evidence it rests on.
      const extra = [
        ...(typeof i.confidence === 'number' ? [`confidence ${i.confidence}`] : []),
        ...(Array.isArray(i.evidence) && i.evidence.length ? [`evidence ${i.evidence.map(String).join(', ')}`] : []),
      ];
      return { label: String(i.field ?? 'field'), ...(text ? { text } : {}), ...(extra.length ? { detail: extra.join(' · ') } : {}), ...(evidence.length ? { evidence } : {}) };
    }
    case 'meta':
    case 'state':
    case 'criteria':
      text = rest([]);
      break;
    case 'relation':
      text = `${name(i.from)}${src(i.from)} ${String(i.relation)} ${name(i.to)}${src(i.to)}`;
      break;
    case 'version':
    case 'unverified_update':
      text = `v${String(i.version ?? '?')} ${str('lifecycle') ?? str('status') ?? ''}${str('claim') ? `: ${str('claim')}` : ''}`;
      break;
    case 'section':
      text = `${str('heading') ?? '(no heading)'}${str('locator') ? ` · ${str('locator')}` : ''} · ${String(i.tokens ?? '?')} tokens`;
      break;
    case 'page_version':
      text = `${String(i.relation)} capture ${String(i.artifact_id)} (${String(i.captured_at ?? '').slice(0, 10)})${i.text_changed === true ? ', text changed' : i.text_changed === false ? ', same text' : ''}`;
      break;
    case 'line':
      text = str('text');
      break;
    default:
      text = str('title') ?? str('claim') ?? (str('text')?.startsWith('<<<EVIDENCE') ? undefined : str('text'));
  }
  return {
    label: type.replace(/_/g, ' '),
    ...(text ? { text } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(open ? { open } : {}),
    ...(str('source') ? { source: str('source') } : {}),
    ...(i.outside_scope === true ? { outside: true } : {}),
  };
}

/** Pages fetched for one item before the view says how many items are left (`more`). */
export const ITEM_MAX_PAGES = 40;

/**
 * One item with all its pages (paging rework: a record's fields, a fact's quotes and an artifact's
 * outline are items, paged by `cursor`): page 1 (the header and its notes) with the items of every page
 * appended, following `cursor` until it is absent. After `ITEM_MAX_PAGES` pages it stops and keeps
 * `truncated` / `more` / `cursor`, so the view can say what is not loaded.
 */
export async function itemAllPages(
  fetchPage: (cursor?: string) => Promise<ItemView>,
  maxPages = ITEM_MAX_PAGES,
): Promise<ItemView> {
  const first = await fetchPage();
  const items = [...(first.items ?? [])];
  let last: ItemView = first;
  for (let n = 1; last.cursor && n < maxPages; n++) {
    const cursor: string = last.cursor;
    last = await fetchPage(cursor);
    items.push(...(last.items ?? []));
  }
  const { cursor: _c, more: _m, truncated: _t, ...rest } = first;
  return { ...rest, items, truncated: Boolean(last.cursor), ...(last.cursor ? { cursor: last.cursor, more: last.more ?? 0 } : {}) };
}

// ---------------------------------------------------------------------------
// the view's state

/** Everything the Knowledge view shows and does for workspace `wsId`. */
export function useKnowledgeView(wsId: string) {
  const [scope, setScope] = useState<KnowledgeScope>('node');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [entityId, setEntityId] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [gcOpen, setGcOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Draft id of the fact the open fact duplicates ("Retract as a duplicate"). */
  const [duplicateOf, setDuplicateOf] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const search = useResource(`k-search:${wsId}:${scope}:${submitted}`, submitted.trim() ? () => knowledgeApi.search(wsId, submitted, scope) : null);
  const entities = useResource(`k-ent:${wsId}:${scope}`, () => knowledgeApi.entities(wsId, scope));
  const card = useResource(`k-card:${wsId}:${scope}:${entityId ?? ''}`, entityId ? () => knowledgeApi.card(wsId, entityId, scope) : null);
  const item = useResource(
    `k-item:${wsId}:${scope}:${itemId ?? ''}`,
    itemId ? () => itemAllPages((cursor) => knowledgeApi.item(wsId, itemId, scope, cursor)) : null,
  );
  const stats = useResource(`k-stats:${wsId}:${scope}`, () => knowledgeApi.stats(wsId, scope));
  const stale = useResource(`k-stale:${wsId}:${scope}`, () => knowledgeApi.stale(wsId, scope));
  const conflicts = useResource(`k-conf:${wsId}:${scope}`, () => knowledgeApi.conflicts(wsId, scope));
  const suggestions = useResource(`k-merge:${wsId}:${scope}`, () => knowledgeApi.mergeSuggestions(wsId, scope));
  const changes = useResource(`k-changes:${wsId}:${scope}`, () => knowledgeApi.changes(wsId, scope));
  const gc = useResource(`k-gc:${wsId}:${scope}:${gcOpen}`, gcOpen ? () => knowledgeApi.gcReport(wsId, scope) : null);

  const runSearch = useCallback(() => setSubmitted(query), [query]);
  const openEntity = useCallback((id: string) => {
    setEntityId(id);
    setItemId(null);
  }, []);
  const openItem = useCallback((id: string) => {
    if (id.startsWith('ent_')) {
      setEntityId(id);
      setItemId(null);
    } else setItemId(id);
  }, []);
  const closeItem = useCallback(() => setItemId(null), []);

  /** Runs a user action, then reloads what it can have changed. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      setBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(done);
        await Promise.all([stats.reload(), stale.reload(), conflicts.reload(), suggestions.reload(), entities.reload(), item.reload(), card.reload(), search.reload(), changes.reload()]);
        return true;
      } catch (e) {
        setActionError(errMsg(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [stats, stale, conflicts, suggestions, entities, item, card, search, changes],
  );

  const retractFact = useCallback((id: string, reason?: string) => act(() => knowledgeApi.retractFact(wsId, id, reason), `retracted ${id}`), [act, wsId]);
  /**
   * Retracts fact `id` as a duplicate of the drafted fact id (KS-6 `duplicate-saved` trigger b). The
   * server checks the duplicate is in this business (an id of another business answers "not found").
   */
  const retractAsDuplicate = useCallback(
    async (id: string, reason?: string) => {
      const other = duplicateOf.trim();
      if (!other) return false;
      const ok = await act(() => knowledgeApi.retractFact(wsId, id, reason, other), `retracted ${id} as a duplicate of ${other}`);
      if (ok) setDuplicateOf('');
      return ok;
    },
    [act, wsId, duplicateOf],
  );
  const acceptReplacement = useCallback((id: string) => act(() => knowledgeApi.acceptReplacement(wsId, id), `applied update ${id}`), [act, wsId]);
  const acceptSuggestion = useCallback((id: string) => act(() => knowledgeApi.acceptSuggestion(wsId, id), 'entities merged'), [act, wsId]);
  const rejectSuggestion = useCallback((id: string) => act(() => knowledgeApi.rejectSuggestion(wsId, id), 'suggestion rejected'), [act, wsId]);

  const toggleSelected = useCallback((id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])), []);
  /** Prunes the selected files (the user's explicit, logged action; refused as a whole if anything is still referenced). */
  const pruneSelected = useCallback(async () => {
    if (!selected.length) return;
    const ok = await act(() => knowledgeApi.prune(wsId, selected), `pruned ${selected.length} file(s)`);
    if (ok) {
      setSelected([]);
      await gc.reload();
    }
  }, [act, gc, selected, wsId]);

  return {
    scope, setScope, scopeLabels: SCOPE_LABELS,
    query, setQuery, runSearch, submitted,
    search: search.data ?? null, searchError: search.error, searching: search.loading,
    entities: entities.data ?? [], entitiesError: entities.error,
    entityId, openEntity, card: card.data ?? null, cardError: card.error,
    itemId, openItem, closeItem, item: item.data ?? null, itemError: item.error, itemLoading: item.loading,
    stats: stats.data ?? null,
    stale: stale.data ?? null,
    conflicts: conflicts.data ?? null,
    suggestions: suggestions.data ?? [],
    changes: changes.data ?? null,
    gcOpen, setGcOpen, gc: gc.data ?? null, gcError: gc.error, selected, toggleSelected, pruneSelected,
    retractFact, duplicateOf, setDuplicateOf, retractAsDuplicate, acceptReplacement, acceptSuggestion, rejectSuggestion,
    busy, actionError, notice,
  };
}
