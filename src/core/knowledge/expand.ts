/**
 * `expand` and `read_artifact` (design §9). Reads by id: any id of the caller's tree (see
 * `readCommon.ts`); an unknown id and an id of another tree get the same "not found" text.
 *
 * - fact: full claim, criteria, freshness, evidence with quotes and captions, version history, the
 *   unverified update (a rejected replacement), relations it asserts.
 * - artifact: metadata, description, captures, previous / next capture of the same URL (text changed
 *   or not), outline (headings with chunk ids and sizes); says when extraction is pending and when the
 *   document was cut at the extraction cap.
 * - chunk: its text (redacted across chunk boundaries, fenced), `around` neighbours on each side.
 * - entity: its card with the `expand` budget (more facts than `get_card`).
 * - record (competitor, persona, symptom, hypothesis, recommendation): its fields.
 *
 * `read_artifact` modes: `outline` (documents' default), `text` (the extracted text, chunk by chunk),
 * `image` (screenshots' and images' default), `raw` (the stored bytes of a text format, redacted whole
 * and then paged, fenced). Every mode pages with a cursor bound to the request.
 *
 * Paging (KS-8 design-thread ruling): the header goes on the first page only (later pages: `id`, items,
 * envelope). Text reads (text / raw modes, chunks and their neighbours) page by position — a passage that
 * does not fit is served up to the budget, marked `cut: true`, and the next cursor continues from that
 * character; nothing is skipped. Other items are listed whole, or shortened and marked `cut: true` when
 * one alone is larger than the page (`shortenItem`).
 *
 * Synthesizer and interviewer see usable facts and records only: anything else answers "not found",
 * and history / unverified updates are left out. Reviewer and escalation runs read only their task's
 * review slice; nested items outside it are left out.
 */
import type { ArtifactStore } from '../evidence/artifacts.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Artifact, Finding, RetrievalResultRef, TextChunk } from '../types.js';
import { estimateTokens, decodeCursorAt, encodeCursor } from './budget.js';
import { entityCard, type CardLine } from './cards.js';
import { getEntity } from './entities.js';
import { factFreshness, isFactUsable, lineageVersions } from './facts.js';
import { itemIsUploadDerived } from './provenance.js';
import {
  aroundVisible, artifactInNodeScope, entityVisibleIn, factInNodeScope, inSlice, outsideScopeNote, pageOf, readableById, shortenItem,
  sourceLabel, uniqueRefs, usableOnly,
  type ReadEnv, type ReadOutput,
} from './readCommon.js';
import { notFound, type ScopeMode } from './scope.js';
import { artifactChunks, canonicalArtifactId, servedChunkText, servedLine, servedTextState, type ServedTextState } from './texts.js';
import { CONTENT_TRUST, fenceEvidence, redactServed, stripFences, stripSecretTail, treeSecrets } from './trust.js';

const CLAIM_MAX = 4000;
const LINE = 400;
const MAX_AROUND = 3;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-ndjson)|.*\+xml$|.*\+json$)/i;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;

/** "Not found" for an unknown id, an id of another tree, and (reviewer) an id outside the slice alike. */
export const expandNotFound = (id: string) => notFound('item', id);
export const artifactNotFound = (id: string) => notFound('artifact', id);

type Item = Record<string, unknown> & { type: string };
type Built = { header: Record<string, unknown>; items: Item[]; refs: Map<Item, RetrievalResultRef[]>; headerRefs: RetrievalResultRef[]; upload: boolean; itemUpload: Map<Item, boolean>; notes: string[]; outside: number };

function built(header: Record<string, unknown>, headerRefs: RetrievalResultRef[], upload: boolean): Built {
  return { header, items: [], refs: new Map(), headerRefs, upload, itemUpload: new Map(), notes: [], outside: 0 };
}

function push(b: Built, item: Item, refs: RetrievalResultRef[] = [], upload = false): void {
  b.items.push(item);
  b.refs.set(item, refs);
  b.itemUpload.set(item, upload);
}

const modeOf = (env: ReadEnv): ScopeMode => env.mode ?? 'node';

/** A typed record (no scope rows) named by id: in the tree, and in node scope or allowed by the sibling rule. */
function recordReadable(env: ReadEnv, ws: string): boolean {
  return inTree(env, ws) && readableById(env.scope, modeOf(env), env.scope.nodeIds.includes(ws));
}

function inTree(env: ReadEnv, ws: string | undefined): boolean {
  return ws !== undefined && env.scope.treeIds.includes(ws);
}

/**
 * KS-8 ruling: the header (and the notes about the item) goes on the first page only; a later page
 * carries the item's id, its items and the envelope. A page starting at the very beginning (also a
 * "nothing fits" restart cursor) is a first page.
 */
function firstPage(header: Record<string, unknown>, at: { offset: number; pos: number }): { header: Record<string, unknown>; first: boolean } {
  const first = at.offset === 0 && at.pos === 0;
  return { header: first ? header : { id: header.id }, first };
}

const cursorAt = (cursor: string | undefined, key: string) => (cursor ? decodeCursorAt(cursor, key) : { offset: 0, pos: 0 });

/** Pages `b.items` within `budget` and assembles the output. */
function finish(env: ReadEnv, b: Built, budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  if (b.outside) b.notes.push(outsideScopeNote(b.outside));
  const { header, first } = firstPage(b.header, cursorAt(cursor, key));
  const notes = first ? b.notes : [];
  const page = pageOf(b.items, header, budget, { key, notes, ...(cursor ? { cursor } : {}) });
  // A shortened item is a new object: its refs are those of the item it was cut from.
  const src = b.items.slice(page.offset, page.offset + page.items.length);
  const results = uniqueRefs([...(first ? b.headerRefs : []), ...src.flatMap((i) => b.refs.get(i) ?? [])]);
  const out: ReadOutput = {
    data: { ...header, items: page.items },
    results,
    uploadDerived: (first && b.upload) || src.some((i) => b.itemUpload.get(i) === true),
    truncated: page.truncated,
    restart: { cursor: page.startCursor, remaining: page.remaining },
    more: page.more,
    notes,
    query,
    scopeLabel: 'tree',
  };
  if (page.stalled) out.stalled = true;
  if (page.cursor) out.cursor = page.cursor;
  return out;
}

/**
 * Tokens of the envelope the dispatcher adds to a page of this request (tokens, truncated, more, the
 * longest cursor this request can hand out, content_trust), measured rather than reserved.
 */
function envelopeTokens(budget: number, key: string, items: number, longest: number): number {
  return estimateTokens(JSON.stringify({
    tokens: budget, truncated: true, more: items, cursor: encodeCursor({ key, offset: items, pos: longest }), content_trust: CONTENT_TRUST,
  })) + 2;
}

/**
 * Header of a text read's page. First page: the whole header and notes; when they would leave less
 * than `room` for text (a small max_tokens), the header is shortened (`shortenItem`, then just the id)
 * and marked `header_cut: true` — `expand` of the id gives all of it — so the first page still serves
 * text and the cursor always moves forward. Later pages: the id only.
 */
function textHeader(b: Built, at: { offset: number; pos: number }, room: number): { header: Record<string, unknown>; first: boolean; notes: string[] } {
  const { header, first } = firstPage(b.header, at);
  if (!first) return { header, first, notes: [] };
  const size = (h: unknown, n: string[]) => estimateTokens(JSON.stringify({ ...(h as object), items: [] })) + (n.length ? estimateTokens(JSON.stringify(n)) : 0);
  if (size(header, b.notes) <= room) return { header, first, notes: b.notes };
  const notes = size({ id: header.id, header_cut: true }, b.notes) <= room ? b.notes : [];
  const short = shortenItem(header, (h) => size(h, notes) <= room) as Record<string, unknown> | undefined;
  const { cut: _cut, ...shortHeader } = short ?? { id: header.id };
  return { header: { ...shortHeader, header_cut: true }, first, notes };
}

/** One passage of a text read: its served text (redacted, fence sequences removed) and its item fields. */
type Passage = { chunk: TextChunk; text: string; meta: Item; refs: RetrievalResultRef[]; upload: boolean };

function passageOf(env: ReadEnv, c: TextChunk, upload: boolean): Passage {
  const meta: Item = { type: 'chunk', chunk_id: c.id, seq: c.seq };
  if (c.headingPath) meta.heading = servedLine(env.store, env.scope.workspaceId, stripFences(c.headingPath), 160);
  if (c.locator) meta.locator = c.locator;
  // Redacted across chunk boundaries first, then fence sequences removed: positions index this text, and
  // a cut made in it can never fall inside a fence marker (the fence is added around each piece).
  const text = stripFences(servedChunkText(env.store, env.scope.workspaceId, c));
  return { chunk: c, text, meta, refs: [{ id: c.id, kind: 'chunk' }], upload: upload || c.uploadDerived === true };
}

/** Smallest piece of a passage served after whole passages on the same page (characters). */
const MIN_PIECE_CHARS = 48;

/** Prefer to end a cut piece after a space (within the last 40 characters), never inside a surrogate pair. */
function cutPoint(text: string, n: number): number {
  let k = n;
  if (k < text.length) {
    const ws = text.slice(Math.max(0, k - 40), k).search(/\s\S*$/);
    if (ws >= 0) {
      const at = Math.max(0, k - 40) + ws + 1;
      if (at > 0) k = at;
    }
  }
  const code = text.charCodeAt(k - 1);
  if (k > 0 && k < text.length && code >= 0xd800 && code <= 0xdbff) k--;
  return k;
}

/**
 * Pages passages by position (KS-8 ruling). From the cursor's (passage, character): whole passages
 * while they fit; then the next one up to the budget, marked `cut: true`, and the cursor continues
 * from exactly that character. Nothing is skipped; a piece always fits (or nothing is served and the
 * page is `stalled`). A continued piece carries only `type`, `chunk_id` and `seq`.
 */
function finishText(b: Built, fenceId: string, passages: Passage[], budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  const at = cursorAt(cursor, key);
  const longest = passages.reduce((m, x) => Math.max(m, x.text.length), 0);
  const envelope = envelopeTokens(budget, key, passages.length, longest);
  const minPiece = passages.length ? estimateTokens(JSON.stringify({ type: 'chunk', chunk_id: passages[0]!.chunk.id, seq: 0, text: fenceEvidence(fenceId, 'x'.repeat(64)), cut: true })) : 0;
  const { header, first, notes } = textHeader(b, at, budget - envelope - minPiece);
  let o = Math.min(at.offset, passages.length);
  let p = o < passages.length ? Math.min(at.pos, passages[o]!.text.length) : 0;
  let used = estimateTokens(JSON.stringify({ ...header, items: [] })) + envelope + (notes.length ? estimateTokens(JSON.stringify(notes)) : 0);
  const items: Item[] = [];
  const refs: RetrievalResultRef[] = first ? [...b.headerRefs] : [];
  let upload = first && b.upload;
  const cost = (it: Item) => estimateTokens(`${JSON.stringify(it)}\n`);
  while (o < passages.length) {
    const ps = passages[o]!;
    let base: Item = p === 0 ? ps.meta : { type: 'chunk', chunk_id: ps.chunk.id, seq: ps.chunk.seq };
    const rest = ps.text.slice(p);
    const whole: Item = { ...base, text: fenceEvidence(fenceId, rest) };
    if (used + cost(whole) <= budget) {
      items.push(whole);
      used += cost(whole);
      refs.push(...ps.refs);
      upload ||= ps.upload;
      o++;
      p = 0;
      continue;
    }
    // A long heading must not stop the passage from starting on a small page (the outline lists headings).
    if (!items.length && base === ps.meta && used + cost({ ...base, text: fenceEvidence(fenceId, rest.slice(0, 64)), cut: true }) > budget) {
      base = { type: 'chunk', chunk_id: ps.chunk.id, seq: ps.chunk.seq };
    }
    const piece = (n: number): Item => ({ ...base, text: fenceEvidence(fenceId, rest.slice(0, n)), cut: true });
    let lo = 0;
    let hi = rest.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (used + cost(piece(mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const n = lo > 0 ? cutPoint(rest, lo) : 0;
    // After whole passages, a sliver (under MIN_PIECE_CHARS) is not worth a piece: the passage starts on the next page.
    if (n > 0 && (!items.length || n >= MIN_PIECE_CHARS)) {
      items.push(piece(n));
      refs.push(...ps.refs);
      upload ||= ps.upload;
      p += n;
    }
    break;
  }
  const truncated = o < passages.length;
  const out: ReadOutput = {
    data: { ...header, items },
    results: uniqueRefs(refs),
    uploadDerived: upload,
    truncated,
    restart: { cursor: encodeCursor({ key, offset: at.offset, pos: at.pos }), remaining: Math.max(1, passages.length - at.offset) },
    more: passages.length - o,
    notes,
    query,
    scopeLabel: 'tree',
  };
  if (truncated && !items.length) out.stalled = true;
  else if (truncated) out.cursor = encodeCursor({ key, offset: o, pos: p });
  return out;
}

// ---------------------------------------------------------------------------
// facts

function factById(env: ReadEnv, id: string): Finding {
  const f = env.store.findings.get(id);
  if (!f || !inTree(env, f.workspaceId) || !readableById(env.scope, modeOf(env), factInNodeScope(env.store, env.scope, f.id))) throw expandNotFound(id);
  if (usableOnly(env.role) && !isFactUsable(f)) throw expandNotFound(id);
  return f;
}

function evidenceItems(env: ReadEnv, b: Built, f: Finding): void {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const refsRows = knowledgeRepos(store).findingEvidence.list({ findingId: f.id });
  const ids = [...new Set([...f.evidence, ...refsRows.map((r) => r.artifactId)])];
  for (const aid of ids) {
    const a = store.artifacts.get(aid);
    if (!a || !inTree(env, a.workspaceId) || !inSlice(env, aid)) continue;
    if (!aroundVisible(env, { kind: 'artifact', id: aid })) {
      // The id is the fact's own citation; the artifact's metadata follows the request scope.
      push(b, { type: 'evidence', artifact_id: aid, outside_scope: true });
      continue;
    }
    const item: Item = { type: 'evidence', artifact_id: aid, artifact_kind: a.kind, ...sourceLabel(env, a.workspaceId) };
    if (a.title || a.sourceUrl) item.title = servedLine(store, ws, stripFences(a.title ?? a.sourceUrl ?? ''), 160);
    if (a.description) item.description = fenceEvidence(aid, servedLine(store, ws, a.description, 300));
    const quotes = refsRows.filter((r) => r.artifactId === aid && r.quote).map((r) => fenceEvidence(aid, servedLine(store, ws, r.quote!, 600)));
    if (quotes.length) item.quotes = quotes;
    push(b, item, [{ id: aid, kind: 'artifact' }], a.uploadDerived === true);
  }
}

function expandFact(env: ReadEnv, id: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const f = factById(env, id);
  const fresh = factFreshness(store, f, env.config, env.now);
  const headerRefs: RetrievalResultRef[] = [{ id: f.id, kind: 'fact' }];
  let upload = f.uploadDerived === true;
  const header: Record<string, unknown> = {
    kind: 'fact', id: f.id,
    subject: servedLine(store, ws, f.subject, 200),
    claim: servedLine(store, ws, f.claim, CLAIM_MAX),
    criteria: redactServed(store, ws, f.criteria),
    status: f.status,
    lifecycle: f.lifecycle ?? 'current',
    version: f.version ?? 1,
    lineage_id: f.lineageId ?? f.id,
    confirm_count: f.confirmCount ?? 0,
    freshness: { since: fresh.since, age_days: fresh.ageDays, ttl_days: fresh.ttlDays, stale: fresh.stale },
  };
  if (f.workspaceId !== ws) header.source = f.workspaceId;
  if (f.lineageConflict) header.lineage_conflict = true;
  if (f.entityId && !env.slice) {
    try {
      const e = getEntity(store, env.scope, f.entityId);
      header.entity = { id: e.id, name: servedLine(store, ws, e.name, 160) };
      headerRefs.push({ id: e.id, kind: 'entity' });
      upload ||= itemIsUploadDerived(store, e.id);
    } catch {
      // entity of another tree cannot happen; leave it out
    }
  }
  if (upload) header.upload = true;
  const b = built(header, headerRefs, upload);
  evidenceItems(env, b, f);
  const lineage = f.lineageId ?? f.id;
  const all = lineageVersions(store, lineage).filter((v) => v.id !== f.id && inTree(env, v.workspaceId));
  const versions = all.filter((v) => aroundVisible(env, { kind: 'fact', id: v.id }));
  b.outside += all.length - versions.length;
  if (usableOnly(env.role)) {
    if (versions.length) b.notes.push('version history is not shown to this role (usable facts only)');
  } else {
    for (const v of versions) {
      if (v.lifecycle === 'candidate' && v.replacesId === f.id) {
        const item: Item = { type: 'unverified_update', id: v.id, version: v.version ?? 1, status: v.status, ...sourceLabel(env, v.workspaceId) };
        if (inSlice(env, v.id)) item.claim = servedLine(store, ws, v.claim, LINE);
        push(b, item, item.claim ? [{ id: v.id, kind: 'fact' }] : [], item.claim ? v.uploadDerived === true : false);
        continue;
      }
      const item: Item = { type: 'version', id: v.id, version: v.version ?? 1, lifecycle: v.lifecycle ?? 'current', status: v.status, created_at: v.createdAt, ...sourceLabel(env, v.workspaceId) };
      if (inSlice(env, v.id)) item.claim = servedLine(store, ws, v.claim, LINE);
      push(b, item, item.claim ? [{ id: v.id, kind: 'fact' }] : [], item.claim ? v.uploadDerived === true : false);
    }
  }
  if (!env.slice) {
    const edges = knowledgeRepos(store).relations.list({ sourceKind: 'fact', sourceId: f.id });
    for (const e of edges) {
      const names: Array<{ id: string; name: string; source?: string }> = [];
      for (const eid of [e.fromEntityId, e.toEntityId]) {
        try {
          const ent = getEntity(store, env.scope, eid);
          // Each endpoint carries its source node when it is not the caller's (KS-7, gate nit).
          if (aroundVisible(env, { kind: 'entity', entity: ent })) names.push({ id: ent.id, name: servedLine(store, ws, ent.name, 120), ...sourceLabel(env, ent.workspaceId) });
        } catch {
          // skip
        }
      }
      if (names.length < 2) {
        b.outside++;
        continue;
      }
      push(b, { type: 'relation', relation: e.type, from: names[0]!, to: names[1]! }, names.map((n) => ({ id: n.id, kind: 'entity' })),
        names.some((n) => itemIsUploadDerived(store, n.id)));
    }
  }
  return b;
}

// ---------------------------------------------------------------------------
// artifacts

function artifactById(env: ReadEnv, id: string, nf: (id: string) => Error = expandNotFound): Artifact {
  const a = env.store.artifacts.get(id);
  if (!a || !inTree(env, a.workspaceId) || !readableById(env.scope, modeOf(env), artifactInNodeScope(env.store, env.scope, a.id))) throw nf(id);
  return a;
}

function extractionInfo(state: ServedTextState): Record<string, unknown> {
  const x: Record<string, unknown> = { status: state.status, chunks: state.chunkCount };
  if (state.truncated) x.truncated = true;
  if (state.duplicateOf) x.duplicate_of = state.duplicateOf;
  if (state.error) x.error = state.error;
  return x;
}

function extractionNotes(state: ServedTextState): string[] {
  const notes: string[] = [];
  if (state.status === 'pending') notes.push('text extraction is still pending for this artifact; expand it again shortly');
  if (state.truncated) notes.push('the document was cut at the extraction cap (maxTextChars): only its start is indexed and served');
  if (state.status === 'unsupported') notes.push('no text is extracted from this type: it is searchable by its title and description');
  return notes;
}

function artifactHeader(env: ReadEnv, a: Artifact): { header: Record<string, unknown>; state: ServedTextState; refs: RetrievalResultRef[]; upload: boolean } {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const state = servedTextState(store, env.scope, a.id, 'tree');
  const header: Record<string, unknown> = { kind: 'artifact', id: a.id, artifact_kind: a.kind, mime: a.mime, captured_at: a.capturedAt };
  if (a.title) header.title = servedLine(store, ws, stripFences(a.title), 200);
  if (a.sourceUrl) header.source_url = servedLine(store, ws, a.sourceUrl, 400);
  if (a.flow) header.flow = servedLine(store, ws, stripFences(a.flow), 80);
  if (a.step !== undefined) header.step = a.step;
  if (a.description) header.description = fenceEvidence(a.id, servedLine(store, ws, a.description, 1000));
  header.extraction = extractionInfo(state);
  if (state.truncated) header.document_truncated = true;
  if (a.workspaceId !== ws) header.source = a.workspaceId;
  if (state.uploadDerived) header.upload = true;
  const refs: RetrievalResultRef[] = [{ id: a.id, kind: 'artifact' }];
  if (state.canonicalId !== a.id) refs.push({ id: state.canonicalId, kind: 'artifact' });
  return { header, state, refs, upload: state.uploadDerived };
}

function outlineItems(env: ReadEnv, b: Built, a: Artifact, upload: boolean): void {
  for (const c of artifactChunks(env.store, a.id)) {
    const item: Item = { type: 'section', chunk_id: c.id, seq: c.seq, tokens: c.tokenEstimate };
    if (c.headingPath) item.heading = servedLine(env.store, env.scope.workspaceId, stripFences(c.headingPath), 160);
    if (c.locator) item.locator = c.locator;
    push(b, item, [{ id: c.id, kind: 'chunk' }], upload || c.uploadDerived === true);
  }
}

function expandArtifact(env: ReadEnv, id: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const a = artifactById(env, id);
  const h = artifactHeader(env, a);
  const b = built(h.header, h.refs, h.upload);
  b.notes.push(...extractionNotes(h.state));
  // Captures: their text is served under the artifact's flag (a capture has no flag of its own).
  const caps = knowledgeRepos(store).artifactCaptures.list({ artifactId: a.id }).sort((x, y) => x.capturedAt.localeCompare(y.capturedAt));
  for (const cap of caps) {
    if (!aroundVisible(env, { kind: 'workspace', workspaceId: cap.workspaceId })) {
      b.outside++;
      continue;
    }
    const item: Item = { type: 'capture', id: cap.id, captured_at: cap.capturedAt, ...sourceLabel(env, cap.workspaceId) };
    if (cap.sourceUrl) item.source_url = servedLine(store, ws, cap.sourceUrl, 300);
    if (cap.title) item.title = servedLine(store, ws, stripFences(cap.title), 160);
    if (cap.flow) item.flow = servedLine(store, ws, stripFences(cap.flow), 80);
    if (cap.step !== undefined) item.step = cap.step;
    if (cap.note) item.note = fenceEvidence(a.id, servedLine(store, ws, cap.note, 300));
    if (cap.description) item.description = fenceEvidence(a.id, servedLine(store, ws, cap.description, 600));
    if (cap.entityId && !env.slice) item.entity_id = cap.entityId;
    push(b, item, [{ id: a.id, kind: 'artifact' }], h.upload);
  }
  if (!env.slice && a.urlKey) {
    // Previous / next capture of the same page (another artifact = other bytes), text changed or not.
    const rows = store.db
      .prepare(
        `SELECT a.id AS id, a.captured_at AS at, t.content_sha256 AS h FROM artifacts a LEFT JOIN artifact_texts t ON t.artifact_id = a.id
         WHERE a.url_key = ? AND a.id <> ? AND a.workspace_id IN (SELECT value FROM json_each(?)) ORDER BY a.captured_at, a.rowid`,
      )
      .all(a.urlKey, a.id, JSON.stringify(env.scope.treeIds)) as Array<{ id: string; at: string; h: string | null }>;
    // Other captures of the page follow the request scope (re-gate): node scope by default.
    const seen = rows.filter((r) => aroundVisible(env, { kind: 'artifact', id: r.id }));
    const hiddenNear = rows.filter((r) => !seen.includes(r));
    const own = knowledgeRepos(store).artifactTexts.get(canonicalArtifactId(store, a.id))?.contentSha256;
    const prev = seen.filter((r) => r.at <= a.capturedAt).at(-1);
    const next = seen.find((r) => r.at > a.capturedAt);
    // Count a hidden version only where it would have been shown (nearer than the visible one).
    const hPrev = hiddenNear.filter((r) => r.at <= a.capturedAt).at(-1);
    const hNext = hiddenNear.find((r) => r.at > a.capturedAt);
    if (hPrev && (!prev || hPrev.at > prev.at)) b.outside++;
    if (hNext && (!next || hNext.at < next.at)) b.outside++;
    for (const [rel, r] of [['previous', prev], ['next', next]] as const) {
      if (!r) continue;
      const item: Item = { type: 'page_version', relation: rel, artifact_id: r.id, captured_at: r.at, ...sourceLabel(env, store.artifacts.get(r.id)?.workspaceId) };
      if (own && r.h) item.text_changed = own !== r.h;
      push(b, item);
    }
  }
  outlineItems(env, b, a, h.upload);
  return b;
}

// ---------------------------------------------------------------------------
// chunks

/** The artifact a chunk is served under: its canonical if in the tree and allowed, else such a duplicate. */
function chunkOwner(env: ReadEnv, chunk: TextChunk): Artifact | undefined {
  const { store } = env;
  const canonical = store.artifacts.get(chunk.artifactId);
  const dupIds = (store.db.prepare('SELECT artifact_id AS id FROM artifact_texts WHERE duplicate_of = ? ORDER BY rowid').all(chunk.artifactId) as Array<{ id: string }>).map((r) => r.id);
  for (const a of [canonical, ...dupIds.map((id) => store.artifacts.get(id))]) {
    if (a && inTree(env, a.workspaceId) && (!env.slice || env.slice.artifactIds.has(a.id) || env.slice.ids.has(a.id))) {
      if (readableById(env.scope, modeOf(env), artifactInNodeScope(store, env.scope, a.id))) return a;
    }
  }
  return undefined;
}

function expandChunk(env: ReadEnv, id: string, around: number): { b: Built; owner: Artifact; passages: Passage[] } {
  const { store } = env;
  const c = knowledgeRepos(store).chunks.get(id);
  if (!c) throw expandNotFound(id);
  const owner = chunkOwner(env, c);
  if (!owner) throw expandNotFound(id);
  const state = servedTextState(store, env.scope, owner.id, 'tree');
  const header: Record<string, unknown> = { kind: 'chunk', id: c.id, artifact_id: owner.id };
  if (state.truncated) header.document_truncated = true;
  if (owner.workspaceId !== env.scope.workspaceId) header.source = owner.workspaceId;
  const refs: RetrievalResultRef[] = [{ id: owner.id, kind: 'artifact' }];
  if (c.artifactId !== owner.id) refs.push({ id: c.artifactId, kind: 'artifact' });
  const b = built(header, refs, state.uploadDerived);
  if (state.truncated) b.notes.push('the document was cut at the extraction cap (maxTextChars): only its start is indexed and served');
  const n = Math.max(0, Math.min(MAX_AROUND, Math.floor(around)));
  const all = artifactChunks(store, owner.id).filter((x) => x.seq >= c.seq - n && x.seq <= c.seq + n);
  return { b, owner, passages: all.map((x) => passageOf(env, x, state.uploadDerived)) };
}

// ---------------------------------------------------------------------------
// entities and records

function expandEntity(env: ReadEnv, id: string): Built {
  let card;
  try {
    assertEntityReadable(env, id);
    // The entity is the named item; its facts and neighbours follow the request's scope.
    card = entityCard(env, env.scope, modeOf(env), id, 40);
  } catch {
    throw expandNotFound(id);
  }
  const b = built({ kind: 'entity', ...card.header }, card.headerRefs, card.headerUpload);
  for (const l of card.lines) push(b, { type: 'line', text: l.text }, l.refs, l.upload);
  return b;
}

const RECORD_PREFIX: Record<string, string> = { cmp_: 'competitor', per_: 'persona', sym_: 'symptom', hyp_: 'hypothesis', rec_: 'recommendation' };

function expandRecord(env: ReadEnv, id: string, type: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const usable = (r: { status?: string; includeOverride?: boolean }) => r.status !== 'superseded' && (r.includeOverride ?? r.status === 'verified');
  const red = <T>(v: T): T => redactServed(store, ws, v);
  let header: Record<string, unknown>;
  let home: string;
  switch (type) {
    case 'competitor': {
      const c = store.competitors.get(id);
      if (!c || !recordReadable(env, c.workspaceId) || (usableOnly(env.role) && !usable(c))) throw expandNotFound(id);
      home = c.workspaceId;
      header = { kind: 'record', type, id, name: red(c.name), site: c.site ? red(c.site) : undefined, threat: c.threat, directness: c.directness, comparison: c.comparison, evidence: c.evidence, status: c.status, entity_id: c.entityId };
      break;
    }
    case 'persona': {
      const p = store.personas.get(id);
      if (!p || !recordReadable(env, p.workspaceId) || (usableOnly(env.role) && !usable(p))) throw expandNotFound(id);
      home = p.workspaceId;
      const profile = Object.fromEntries(Object.entries(p.profile ?? {}).map(([k, v]) => [k, { value: servedLine(store, ws, v?.value ?? '', 600), confidence: v?.confidence, evidence: v?.evidence }]));
      header = { kind: 'record', type, id, slug: p.slug, segment: red(p.segment), audience: p.audience ?? 'external', profile, status: p.status, entity_id: p.entityId };
      break;
    }
    case 'symptom': {
      const s = store.symptoms.get(id);
      if (!s || !recordReadable(env, s.workspaceId)) throw expandNotFound(id);
      home = s.workspaceId;
      header = { kind: 'record', type: s.kind, id, title: red(s.title), detail: servedLine(store, ws, s.detail, 2000), criteria: red(s.criteria), evidence: s.evidence, entity_id: s.entityId };
      break;
    }
    case 'hypothesis': {
      const h = store.symptomHypotheses.get(id);
      if (!h || !recordReadable(env, h.workspaceId) || (usableOnly(env.role) && !usable(h))) throw expandNotFound(id);
      home = h.workspaceId;
      header = { kind: 'record', type, id, symptom_id: h.symptomId, hypothesis: servedLine(store, ws, h.hypothesis, 2000), confidence: h.confidence, evidence: h.evidence, status: h.status, entity_id: h.entityId };
      break;
    }
    default: {
      const r = store.recommendations.get(id);
      if (!r || !recordReadable(env, r.workspaceId) || (usableOnly(env.role) && !usable(r))) throw expandNotFound(id);
      home = r.workspaceId;
      header = { kind: 'record', type: 'recommendation', id, title: red(r.title), summary: servedLine(store, ws, r.summary, 3000), criteria: red(r.criteria), finding_ids: r.findingIds, priority: r.priority, status: r.status };
    }
  }
  for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];
  if (home !== ws) header.source = home;
  const upload = itemIsUploadDerived(store, id);
  if (upload) header.upload = true;
  return built(header, [{ id, kind: 'record' }], upload);
}

/** Throws `notFound('entity')` unless the entity (survivor) of the tree may be read by id. */
export function assertEntityReadable(env: ReadEnv, id: string): void {
  const e = getEntity(env.store, env.scope, id);
  if (!readableById(env.scope, modeOf(env), entityVisibleIn(env.store, env.scope, 'node', e))) throw notFound('entity', id);
}

// ---------------------------------------------------------------------------
// entry points

export type ExpandInput = { id: string; around?: number; cursor?: string };

export function runExpand(env: ReadEnv, input: ExpandInput, budget: number, key: string): ReadOutput {
  const id = input.id;
  let b: Built;
  if (id.startsWith('fnd_')) b = expandFact(env, id);
  else if (id.startsWith('art_')) b = expandArtifact(env, id);
  else if (id.startsWith('chk_')) {
    const x = expandChunk(env, id, input.around ?? 0);
    return finishText(x.b, x.owner.id, x.passages, budget, key, input.cursor, id);
  } else if (id.startsWith('ent_')) b = expandEntity(env, id);
  else {
    const type = Object.entries(RECORD_PREFIX).find(([p]) => id.startsWith(p))?.[1];
    if (!type) throw expandNotFound(id);
    b = expandRecord(env, id, type);
  }
  return finish(env, b, budget, key, input.cursor, id);
}

export type ReadArtifactMode = 'outline' | 'text' | 'image' | 'raw';
export type ReadArtifactInput = { artifactId: string; mode?: ReadArtifactMode; cursor?: string };

/** Reads the stored file of an artifact (raw / image modes). */
export type ArtifactBytes = Pick<ArtifactStore, 'read'>;

export function runReadArtifact(env: ReadEnv, files: ArtifactBytes, input: ReadArtifactInput, budget: number, key: string): ReadOutput {
  const { store } = env;
  const a = artifactById(env, input.artifactId, artifactNotFound);
  const base = a.mime.split(';')[0]!.trim();
  const isImage = a.kind === 'screenshot' || base.startsWith('image/');
  const mode: ReadArtifactMode = input.mode ?? (isImage ? 'image' : 'outline');
  const h = artifactHeader(env, a);
  const header = { ...h.header, mode };
  const b = built(header, h.refs, h.upload);
  b.notes.push(...extractionNotes(h.state));
  const query = `${a.id} ${mode}`;
  switch (mode) {
    case 'outline':
      outlineItems(env, b, a, h.upload);
      return finish(env, b, budget, key, input.cursor, query);
    case 'text': {
      const passages = artifactChunks(store, a.id).map((c) => passageOf(env, c, h.upload));
      if (!passages.length) b.notes.push('no extracted text to serve for this artifact');
      return finishText(b, a.id, passages, budget, key, input.cursor, query);
    }
    case 'image': {
      const out = finish(env, b, budget, key, undefined, query);
      if (!IMAGE_MIME.test(base)) {
        out.notes = [...(out.notes ?? []), `not an inlinable image (${base}); use mode "outline" or "text"`];
        return out;
      }
      const bytes = storedBytes(files, a.id);
      if (!bytes) {
        out.notes = [...(out.notes ?? []), FILE_GONE];
        return out;
      }
      if (bytes.byteLength > IMAGE_MAX_BYTES) {
        out.notes = [...(out.notes ?? []), `image too large to inline (${bytes.byteLength} bytes)`];
        return out;
      }
      out.images = [{ data: bytes.toString('base64'), mimeType: base }];
      return out;
    }
    case 'raw': {
      if (!TEXT_MIME.test(base)) {
        b.notes.push(`raw mode serves text formats only (${base} is binary); use mode "text" for the extracted text`);
        return finish(env, b, budget, key, undefined, query);
      }
      return rawPage(env, files, a, b, budget, key, input.cursor, query);
    }
  }
}

const FILE_GONE = 'the stored file is not available (pruned or missing); its extracted text and description remain';

/** The stored bytes, or `undefined` when the file is gone (pruned, KS-7). */
function storedBytes(files: ArtifactBytes, id: string): Buffer | undefined {
  try {
    return files.read(id).bytes;
  } catch {
    return undefined;
  }
}

/** Raw text of a text-format artifact: redacted WHOLE (up to the extraction cap), then paged by characters and fenced. */
function rawPage(env: ReadEnv, files: ArtifactBytes, a: Artifact, b: Built, budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const cap = (env.config.knowledge?.extraction?.maxTextChars ?? 2_000_000);
  const secrets = treeSecrets(store, ws);
  const margin = secrets.reduce((m, s) => Math.max(m, s.length), 0);
  const bytes = storedBytes(files, a.id);
  if (!bytes) {
    b.notes.push(FILE_GONE);
    return finish(env, b, budget, key, undefined, query);
  }
  const all = bytes.toString('utf8');
  let text = redactServed(store, ws, all.slice(0, cap + margin));
  if (all.length > cap + margin) text = stripSecretTail(text, secrets);
  const docCut = all.length > cap;
  if (text.length > cap) text = text.slice(0, cap);
  // Positions index the text without fence sequences, so no page boundary can fall inside one.
  text = stripFences(text);
  if (docCut) {
    b.header.document_truncated = true;
    b.notes.push(`the stored file is longer than ${cap} characters; raw mode serves its start only`);
  }
  const offset = cursor ? Math.min(decodeCursorAt(cursor, key).offset, text.length) : 0;
  // KS-8 ruling: the artifact header and its notes on the first page only (shortened when the page is small).
  const envelope = envelopeTokens(budget, key, text.length, 0);
  const minPiece = estimateTokens(JSON.stringify({ type: 'raw', offset: text.length, text: fenceEvidence(a.id, 'x'.repeat(64)) }));
  const { header, notes } = textHeader(b, { offset, pos: 0 }, budget - envelope - minPiece);
  const overhead = estimateTokens(JSON.stringify({ ...header, items: [] })) + envelope + (notes.length ? estimateTokens(JSON.stringify(notes)) : 0);
  // Fenced, JSON-escaped text grows; leave a margin of one third.
  const pageChars = Math.max(64, Math.floor(((budget - overhead) * 4 * 2) / 3));
  let end = Math.min(text.length, offset + pageChars);
  let item: Item;
  for (;;) {
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    item = { type: 'raw', offset, text: fenceEvidence(a.id, text.slice(offset, end)) };
    // JSON escaping varies with the content: shrink until the page provably fits.
    if (overhead + estimateTokens(JSON.stringify(item)) <= budget || end - offset <= 16) break;
    end = offset + Math.floor((end - offset) * 0.8);
  }
  const out: ReadOutput = {
    data: { ...header, items: [item] },
    results: uniqueRefs(b.headerRefs),
    uploadDerived: b.upload,
    truncated: end < text.length,
    restart: { cursor: encodeCursor({ key, offset }), remaining: Math.max(1, text.length - offset) },
    more: end < text.length ? text.length - end : 0,
    notes,
    query,
    scopeLabel: 'tree',
  };
  if (end < text.length) out.cursor = encodeCursor({ key, offset: end });
  return out;
}

/** Card lines → expand items (exported for `get_card` paging in tools.ts). */
export function cardItems(lines: CardLine[]): Item[] {
  return lines.map((l) => ({ type: 'line', text: l.text }));
}
