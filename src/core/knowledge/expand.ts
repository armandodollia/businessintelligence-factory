/**
 * `expand` and `read_artifact` (design §9). Reads by id: any id of the caller's tree (see
 * `readCommon.ts`); an unknown id and an id of another tree get the same "not found" text.
 *
 * - fact: header (kind, id, subject, status, lifecycle, version, entity, source); items: the claim,
 *   criteria, state (lineage, confirmations, freshness), evidence, each verified quote, versions, the
 *   unverified update (a rejected replacement), relations it asserts.
 * - artifact: header (kind, id, artifact kind, title, source); items: metadata and extraction state,
 *   description, captures, previous / next capture of the same URL (text changed or not), outline
 *   (headings with chunk ids and sizes); notes say when extraction is pending and when the document was
 *   cut at the extraction cap.
 * - chunk: its text (redacted across chunk boundaries, fenced), `around` neighbours on each side.
 * - entity: its card with the `expand` budget (more facts than `get_card`); node: its node card.
 * - record (competitor, persona, symptom, hypothesis, recommendation): one item per field; a flow: its
 *   fields, steps, check answers, other versions and review counts; a review mention: its quote, source
 *   and attribution (step text, notes and quotes fenced).
 *
 * `read_artifact` modes: `outline` (documents' default), `text` (the extracted text, chunk by chunk),
 * `image` (screenshots' and images' default), `raw` (the stored bytes of a text format, redacted whole
 * and then paged, fenced). Every mode pages with a cursor bound to the request.
 *
 * Paging (rework, binding; `paging.ts`): a small fixed header — identity only, bounded — on the first
 * page only, then items, each page assembled by measuring the real response. Text (passages, raw) pages
 * by position: a piece that does not end its passage is `cut: true` and the cursor continues from its
 * next character. Any other item too big for a page on its own is cut and carries `full`.
 *
 * Synthesizer and interviewer see usable facts and records only: anything else answers "not found",
 * and history / unverified updates are left out. Reviewer and escalation runs read only their task's
 * review slice; nested items outside it are left out.
 */
import type { ArtifactStore } from '../evidence/artifacts.js';
import { flowRepos } from '../flows/repos.js';
import { FLOW_TEXT_MAX, type Checklist, type FlowCheck } from '../flows/types.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Artifact, Finding, RetrievalResultRef, TextChunk } from '../types.js';
import { isHidden } from '../stakeholders/personas.js';
import { encodeCursor } from './budget.js';
import { cardPageLines, entityCard, HEADER_NAME_JSON, nodeCard, nodeLineRecover } from './cards.js';
import { getEntity } from './entities.js';
import { normalizeText } from './extract/index.js';
import { factFreshness, isFactUsable, lineageVersions } from './facts.js';
import { assemblePage, boundedText, laterPageNeed, type PageItem } from './paging.js';
import { itemIsUploadDerived } from './provenance.js';
import {
  aroundVisible, artifactInNodeScope, entityVisibleIn, factInNodeScope, inSlice, outsideScopeNote, readableById,
  sourceLabel, usableOnly, type ReadEnv, type ReadOutput, type Recover,
} from './readCommon.js';
import { narrowTo, notFound, type ScopeMode } from './scope.js';
import { artifactChunks, canonicalArtifactId, servedChunkText, servedLine, servedTextState, type ServedTextState } from './texts.js';
import { fenceEvidence, redactServed, stripFences, stripSecretTail, treeSecrets } from './trust.js';

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
/** A response before paging: its header (identity), items, and the notes of its first page. */
type Built = {
  header: Record<string, unknown>; headerRefs: RetrievalResultRef[]; upload: boolean;
  items: PageItem[]; notes: string[]; outside: number;
};

function built(header: Record<string, unknown>, headerRefs: RetrievalResultRef[], upload: boolean): Built {
  return { header, headerRefs, upload, items: [], notes: [], outside: 0 };
}

function push(b: Built, item: Item, refs: RetrievalResultRef[] = [], upload = false, extra: Partial<PageItem> = {}): void {
  b.items.push({ value: item, refs, upload, ...extra });
}

/**
 * A name for the header, bounded (`boundedText`); when the bound cuts it, the whole value is served as a
 * `field` item too (paging rework: the header never needs cutting, and nothing is lost).
 */
function named(b: Built, field: string, full: string, refs: RetrievalResultRef[] = [], upload = false, maxJson = HEADER_NAME_JSON): string {
  const shown = boundedText(full, maxJson);
  if (shown !== full) push(b, { type: 'field', field, value: full }, refs, upload);
  return shown;
}

const modeOf = (env: ReadEnv): ScopeMode => env.mode ?? 'node';

/** A typed record (no scope rows) named by id: in the tree, and in node scope or allowed by the sibling rule. */
function recordReadable(env: ReadEnv, ws: string): boolean {
  return inTree(env, ws) && readableById(env.scope, modeOf(env), env.scope.nodeIds.includes(ws));
}

function inTree(env: ReadEnv, ws: string | undefined): boolean {
  return ws !== undefined && env.scope.treeIds.includes(ws);
}

/** Pages `b.items` within `budget` (`assemblePage`: header and notes on the first page only). */
function finish(env: ReadEnv, b: Built, budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  if (b.outside) b.notes.push(outsideScopeNote(b.outside));
  const page = assemblePage({
    key, cursor, budget, itemsKey: 'items', header: b.header, headerRefs: b.headerRefs, headerUpload: b.upload,
    notes: env.pageNotes, firstNotes: b.notes, items: b.items, again: env.again,
  });
  return { data: page.data, results: page.results, uploadDerived: page.uploadDerived, truncated: page.truncated, query, scopeLabel: 'tree' };
}

/** A passage of a text read: position-paged (`paging.ts`); its text redacted across chunk boundaries, fence sequences removed. */
function passageItem(env: ReadEnv, c: TextChunk, upload: boolean, fence: string): PageItem {
  const meta: Item = { type: 'chunk', chunk_id: c.id, seq: c.seq };
  if (c.headingPath) meta.heading = servedLine(env.store, env.scope.workspaceId, stripFences(c.headingPath), 160);
  if (c.locator) meta.locator = c.locator;
  // Redacted first, then fence sequences removed: positions index this text, and a cut made in it can
  // never fall inside a fence marker (the fence is added around each piece).
  const body = stripFences(servedChunkText(env.store, env.scope.workspaceId, c));
  const cont = { type: 'chunk', chunk_id: c.id, seq: c.seq };
  return {
    value: { ...meta, text: fenceEvidence(fence, body) },
    refs: [{ id: c.id, kind: 'chunk' }],
    upload: upload || c.uploadDerived === true,
    text: { body, fence, meta: (pos) => (pos === 0 ? meta : cont) },
  };
}

// ---------------------------------------------------------------------------
// facts

function factById(env: ReadEnv, id: string): Finding {
  const f = env.store.findings.get(id);
  if (!f || !inTree(env, f.workspaceId) || !readableById(env.scope, modeOf(env), factInNodeScope(env.store, env.scope, f.id))) throw expandNotFound(id);
  if (usableOnly(env.role) && !isFactUsable(f)) throw expandNotFound(id);
  return f;
}

/** Whitespace-insensitive form (as the quote check of `save_finding`). */
const squash = (s: string) => normalizeText(s).replace(/\s+/g, ' ').trim();

/**
 * The passage around a quote (design §7.3 as amended): `expand <chunk>` when that chunk holds the whole
 * quote, else with the fewest neighbours (`around`) that hold it; none when no such call does.
 */
function quotePassage(env: ReadEnv, chunkId: string, quote: string): Recover | undefined {
  const c = knowledgeRepos(env.store).chunks.get(chunkId);
  if (!c) return undefined;
  const q = squash(quote);
  const all = artifactChunks(env.store, c.artifactId);
  for (let n = 0; n <= MAX_AROUND; n++) {
    const text = all.filter((x) => x.seq >= c.seq - n && x.seq <= c.seq + n).map((x) => x.text).join('\n\n');
    if (squash(text).includes(q)) return { kind: 'expand_chunk', tool: 'expand', input: { id: chunkId, ...(n ? { around: n } : {}) } };
  }
  return undefined;
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
    push(b, item, [{ id: aid, kind: 'artifact' }], a.uploadDerived === true);
    // Each verified quote is its own item, so the fact's cursor pages through all of them. A quote cut
    // because it is larger than a page is recovered by this request at it (`same_call`); `passage` is the
    // passage around it, given only when that call holds the whole quote.
    for (const r of refsRows.filter((x) => x.artifactId === aid && x.quote)) {
      const passage = r.chunkId ? quotePassage(env, r.chunkId, r.quote!) : undefined;
      const q: Item = {
        type: 'quote', artifact_id: aid, ...(r.chunkId ? { chunk_id: r.chunkId } : {}),
        quote: fenceEvidence(aid, servedLine(store, ws, r.quote!, CLAIM_MAX)), ...(passage ? { passage } : {}),
      };
      push(b, q, [{ id: aid, kind: 'artifact' }, ...(r.chunkId ? [{ id: r.chunkId, kind: 'chunk' as const }] : [])], a.uploadDerived === true);
    }
  }
}

function expandFact(env: ReadEnv, id: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const f = factById(env, id);
  const fresh = factFreshness(store, f, env.config, env.now);
  const headerRefs: RetrievalResultRef[] = [{ id: f.id, kind: 'fact' }];
  let upload = f.uploadDerived === true;
  let entity: { id: string; name: string } | undefined;
  if (f.entityId && !env.slice) {
    try {
      const e = getEntity(store, env.scope, f.entityId);
      entity = { id: e.id, name: servedLine(store, ws, e.name, 160) };
      headerRefs.push({ id: e.id, kind: 'entity' });
      upload ||= itemIsUploadDerived(store, e.id);
    } catch {
      // entity of another tree cannot happen; leave it out
    }
  }
  const b = built({}, headerRefs, upload);
  b.header = {
    kind: 'fact', id: f.id,
    subject: named(b, 'subject', servedLine(store, ws, f.subject, 200), [{ id: f.id, kind: 'fact' }], f.uploadDerived === true),
    status: f.status,
    lifecycle: f.lifecycle ?? 'current',
    version: f.version ?? 1,
    ...(f.workspaceId !== ws ? { source: f.workspaceId } : {}),
    ...(entity ? { entity: { id: entity.id, name: named(b, 'entity_name', entity.name, [{ id: entity.id, kind: 'entity' }], upload) } } : {}),
    ...(upload ? { upload: true } : {}),
  };
  const factRef = [{ id: f.id, kind: 'fact' as const }];
  push(b, { type: 'claim', text: servedLine(store, ws, f.claim, CLAIM_MAX) }, factRef, f.uploadDerived === true);
  const criteria = redactServed(store, ws, f.criteria);
  if (criteria && typeof criteria === 'object' && Object.keys(criteria).length) push(b, { type: 'criteria', criteria }, factRef, f.uploadDerived === true);
  // Every item of the fact lists the fact, so a page that serves only its state still logs it (§12).
  push(b, {
    type: 'state', lineage_id: f.lineageId ?? f.id, confirm_count: f.confirmCount ?? 0,
    freshness: { since: fresh.since, age_days: fresh.ageDays, ttl_days: fresh.ttlDays, stale: fresh.stale },
    ...(f.lineageConflict ? { lineage_conflict: true } : {}),
  }, factRef, f.uploadDerived === true);
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
  if (state.ocr) x.ocr = state.ocr;
  if (state.error) x.error = state.error;
  return x;
}

function extractionNotes(state: ServedTextState): string[] {
  const notes: string[] = [];
  if (state.status === 'pending') notes.push('text extraction is still pending for this artifact; expand it again shortly');
  if (state.truncated) notes.push('the document was cut at the extraction cap (maxTextChars): only its start is indexed and served');
  if (state.status === 'unsupported' && state.ocr !== 'pending') notes.push('no text is extracted from this type: it is searchable by its title and description');
  // Two-pass OCR: what a model has read, is reading, or could not read of a scan or image.
  if (state.ocr === 'pending') notes.push('a model is still transcribing the scanned parts of this artifact (ocr: pending); read it again shortly');
  else if (state.ocr === 'done' && state.chunkCount > 0) notes.push('passages with an "(ocr)" locator were transcribed by a model from a scan or image');
  else if (state.ocr === 'failed' || state.ocr === 'skipped') notes.push(`the scanned parts of this artifact are not in its text (ocr: ${state.ocr})`);
  return notes;
}

/**
 * An artifact's header (kind, id, artifact kind, title, source, flags) and its first items: `meta` (mime,
 * capture time, URL, flow, extraction state) and its `description`. Notes: extraction state.
 */
function artifactBuilt(env: ReadEnv, a: Artifact, extra: Record<string, unknown> = {}): { b: Built; state: ServedTextState } {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const state = servedTextState(store, env.scope, a.id, 'tree');
  const refs: RetrievalResultRef[] = [{ id: a.id, kind: 'artifact' }];
  if (state.canonicalId !== a.id) refs.push({ id: state.canonicalId, kind: 'artifact' });
  const upload = state.uploadDerived;
  const b = built({}, refs, upload);
  const title = a.title ? named(b, 'title', servedLine(store, ws, stripFences(a.title), 200), refs, upload) : undefined;
  b.header = {
    kind: 'artifact', id: a.id, artifact_kind: a.kind, ...(title !== undefined ? { title } : {}), ...extra,
    ...(state.truncated ? { document_truncated: true } : {}),
    ...(a.workspaceId !== ws ? { source: a.workspaceId } : {}),
    ...(upload ? { upload: true } : {}),
  };
  const meta: Item = { type: 'meta', mime: a.mime, captured_at: a.capturedAt };
  if (a.sourceUrl) meta.source_url = servedLine(store, ws, a.sourceUrl, 400);
  if (a.flow) meta.flow = servedLine(store, ws, stripFences(a.flow), 80);
  if (a.step !== undefined) meta.step = a.step;
  meta.extraction = extractionInfo(state);
  push(b, meta, refs, upload);
  if (a.description) push(b, { type: 'description', text: fenceEvidence(a.id, servedLine(store, ws, a.description, 1000)) }, refs, upload);
  b.notes.push(...extractionNotes(state));
  return { b, state };
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
  const { b } = artifactBuilt(env, a);
  const artRef: RetrievalResultRef[] = [{ id: a.id, kind: 'artifact' }];
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
    push(b, item, artRef, b.upload);
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
  outlineItems(env, b, a, b.upload);
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

function expandChunk(env: ReadEnv, id: string, around: number): Built {
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
  for (const x of artifactChunks(store, owner.id).filter((x) => x.seq >= c.seq - n && x.seq <= c.seq + n)) {
    b.items.push(passageItem(env, x, state.uploadDerived, owner.id));
  }
  return b;
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
  // A line too long for a page points at `get_card <entity>` at that line (the entity card lists fewer
  // facts, so the line is found by its text, on a card built only then); a line only this fuller card
  // lists is recovered by this request at it.
  const cardInput: Record<string, unknown> = { entity_id: id, ...(env.mode === 'tree' ? { scope: 'tree' } : {}) };
  let plain: string[] | undefined;
  const onCard = (text: string): Recover | undefined => {
    if (!env.keyFor || !env.pointerBudget) return undefined;
    plain ??= cardPageLines(entityCard(env, env.scope, modeOf(env), id)).map((l) => l.text);
    const j = plain.indexOf(text);
    if (j < 0) return undefined;
    const key = env.keyFor('get_card', cardInput);
    const next = j + 1 < plain.length ? encodeCursor({ key, offset: j + 1 }) : undefined;
    const m = env.pointerBudget(laterPageNeed('lines', text, next, plain.length - j - 1), 'get_card');
    return m === undefined ? undefined : { kind: 'get_card_line', tool: 'get_card', input: { ...cardInput, cursor: encodeCursor({ key, offset: j }), max_tokens: m } };
  };
  for (const l of cardPageLines(card)) push(b, { type: 'line', text: l.text }, l.refs, l.upload, { recover: () => onCard(l.text) });
  return b;
}

/** `expand` of a node id returns its node card (lines as items), as `read_workspace` does. */
function expandNode(env: ReadEnv, id: string): Built {
  const node = env.store.workspaces.get(id);
  if (!node || !env.scope.treeIds.includes(id)) throw expandNotFound(id);
  const view = narrowTo(env.store, env.scope, id);
  if (!view || !readableById(env.scope, modeOf(env), env.scope.nodeIds.includes(id))) throw expandNotFound(id);
  const card = nodeCard(env, view, modeOf(env));
  const b = built({ kind: 'node', id, ...card.header }, card.headerRefs, card.headerUpload);
  const recover = nodeLineRecover(env, id, modeOf(env), card);
  cardPageLines(card).forEach((l, i) => push(b, { type: 'line', text: l.text }, l.refs, l.upload, { recover: () => recover(i) }));
  return b;
}

const RECORD_PREFIX: Record<string, string> = {
  cmp_: 'competitor', per_: 'persona', sym_: 'symptom', hyp_: 'hypothesis', rec_: 'recommendation', flw_: 'flow', rvm_: 'review_mention',
};

/** A reviewed output usable downstream (`isOutputUsable`, research/outputs.ts). */
const usable = (r: { status?: string; includeOverride?: boolean | undefined }) => r.status !== 'superseded' && (r.includeOverride ?? r.status === 'verified');

/**
 * A typed record: header (kind, record type, id, name, status, source) and one `field` item per other
 * field (paging rework: a persona's 13 profile fields are 13 items, paged by the cursor). Flows and
 * review mentions have their own shape (`expandFlow`, `expandMention`).
 */
function expandRecord(env: ReadEnv, id: string, type: string): Built {
  if (type === 'flow') return expandFlow(env, id);
  if (type === 'review_mention') return expandMention(env, id);
  const { store } = env;
  const ws = env.scope.workspaceId;
  const red = <T>(v: T): T => redactServed(store, ws, v);
  let name: string | undefined;
  let recordType = type;
  let status: string | undefined;
  let home: string;
  const fields: Array<[string, unknown]> = [];
  switch (type) {
    case 'competitor': {
      const c = store.competitors.get(id);
      if (!c || !recordReadable(env, c.workspaceId) || (usableOnly(env.role) && !usable(c))) throw expandNotFound(id);
      home = c.workspaceId;
      name = red(c.name);
      status = c.status;
      fields.push(['site', c.site ? red(c.site) : undefined], ['threat', c.threat], ['directness', c.directness], ['comparison', c.comparison], ['evidence', c.evidence], ['entity_id', c.entityId]);
      break;
    }
    case 'persona': {
      const p = store.personas.get(id);
      // A user persona (user persona design §5) is not a record of the store: it answers like an unknown id.
      if (!p || p.kind === 'user' || !recordReadable(env, p.workspaceId) || (usableOnly(env.role) && !usable(p))) throw expandNotFound(id);
      home = p.workspaceId;
      name = p.slug;
      status = p.status;
      // A hidden stakeholder (stakeholder design §7): its label and type only, never what research found.
      if (isHidden(p)) {
        fields.push(['segment', red(p.segment)], ['stakeholder_type', p.stakeholderType ?? 'other'], ['disclosure', 'hidden']);
        break;
      }
      fields.push(['segment', red(p.segment)], ['audience', p.audience ?? 'external'], ['entity_id', p.entityId]);
      for (const [k, v] of Object.entries(p.profile ?? {})) {
        fields.push([`profile.${k}`, { value: servedLine(store, ws, v?.value ?? '', 600), confidence: v?.confidence, evidence: v?.evidence }]);
      }
      break;
    }
    case 'symptom': {
      const s = store.symptoms.get(id);
      if (!s || !recordReadable(env, s.workspaceId)) throw expandNotFound(id);
      home = s.workspaceId;
      recordType = s.kind;
      name = red(s.title);
      fields.push(['detail', servedLine(store, ws, s.detail, 2000)], ['criteria', red(s.criteria)], ['evidence', s.evidence], ['entity_id', s.entityId]);
      break;
    }
    case 'hypothesis': {
      const h = store.symptomHypotheses.get(id);
      if (!h || !recordReadable(env, h.workspaceId) || (usableOnly(env.role) && !usable(h))) throw expandNotFound(id);
      home = h.workspaceId;
      status = h.status;
      fields.push(['symptom_id', h.symptomId], ['hypothesis', servedLine(store, ws, h.hypothesis, 2000)], ['confidence', h.confidence], ['evidence', h.evidence], ['entity_id', h.entityId]);
      break;
    }
    default: {
      const r = store.recommendations.get(id);
      if (!r || !recordReadable(env, r.workspaceId) || (usableOnly(env.role) && !usable(r))) throw expandNotFound(id);
      home = r.workspaceId;
      recordType = 'recommendation';
      name = red(r.title);
      status = r.status;
      fields.push(['summary', servedLine(store, ws, r.summary, 3000)], ['criteria', red(r.criteria)], ['finding_ids', r.findingIds], ['priority', r.priority]);
    }
  }
  const upload = itemIsUploadDerived(store, id);
  const refs: RetrievalResultRef[] = [{ id, kind: 'record' }];
  const b = built({}, refs, upload);
  const shownName = name !== undefined ? named(b, 'name', name, refs, upload) : undefined;
  b.header = {
    kind: 'record', type: recordType, id, ...(shownName !== undefined ? { name: shownName } : {}), ...(status !== undefined ? { status } : {}),
    ...(home !== ws ? { source: home } : {}), ...(upload ? { upload: true } : {}),
  };
  for (const [field, v] of fields) {
    if (v === undefined) continue;
    // A profile field keeps its value, confidence and evidence together; any other field is `value`.
    const item: Item = field.startsWith('profile.') ? { type: 'field', field, ...(v as object) } : { type: 'field', field, value: v };
    push(b, item, refs, upload);
  }
  return b;
}

// ---------------------------------------------------------------------------
// flow records (flow design §8.2–§8.4, §9.2): third-party text (step text, the notable note, check
// notes and recorded values, review quotes) is served fenced; names and goals are labels, as a claim.

/** JSON characters of a flow type key and of a variant in a flow's header (the full value is an item when cut). */
const FLOW_TYPE_JSON = 80;
const VARIANT_JSON = 120;
/** Review mention ids listed in a flow's review counts (negative first). */
const MAX_MENTION_IDS = 10;

/** The subject entity of a flow record for its header: `{ id, name }`, upload status; none for a reviewer (outside the slice). */
function subjectOf(env: ReadEnv, b: Built, entityId: string): { id: string; name: string } | undefined {
  if (env.slice) return undefined;
  try {
    const e = getEntity(env.store, env.scope, entityId);
    const ref: RetrievalResultRef[] = [{ id: e.id, kind: 'entity' }];
    const upload = itemIsUploadDerived(env.store, e.id);
    b.headerRefs.push(...ref);
    b.upload ||= upload;
    return { id: e.id, name: named(b, 'subject', servedLine(env.store, env.scope.workspaceId, e.name, 200), ref, upload) };
  } catch {
    return undefined; // an entity of another tree cannot happen; leave it out
  }
}

/**
 * A flow version: header (kind, type `flow`, id, subject, flow type, variant, version, lifecycle, status,
 * primary, partial, source, upload); items: its fields (name, goal, entry point, stop reason, notable,
 * entity, state), one item per step (seq, action, observation, asked, error, screenshot, page), one per
 * check answer (question, answer, value, steps, mentions, note, origin), its other versions, and the
 * review counts of its subject and flow type. Synthesizer and interviewer read the current, usable
 * version only. The checklist score is not computed here.
 */
function expandFlow(env: ReadEnv, id: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const r = flowRepos(store);
  const f = r.flows.get(id);
  if (!f || !recordReadable(env, f.workspaceId)) throw expandNotFound(id);
  if (usableOnly(env.role) && !(f.lifecycle === 'current' && usable(f))) throw expandNotFound(id);
  const upload = itemIsUploadDerived(store, f.id);
  const refs: RetrievalResultRef[] = [{ id: f.id, kind: 'record' }];
  const b = built({}, [...refs], upload);
  const fence = (text: string, max: number) => fenceEvidence(f.id, servedLine(store, ws, text, max));
  const subject = subjectOf(env, b, f.subjectEntityId);
  const type = r.flowTypes.get(f.flowTypeId);
  b.header = {
    kind: 'record', type: 'flow', id: f.id,
    ...(subject ? { subject } : {}),
    flow_type: named(b, 'flow_type', type?.key ?? f.flowTypeId, refs, false, FLOW_TYPE_JSON),
    variant: named(b, 'variant', servedLine(store, ws, f.variant, 400), refs, upload, VARIANT_JSON),
    version: f.version, lifecycle: f.lifecycle, status: f.status,
    ...(f.isPrimary ? { primary: true } : {}),
    ...(f.reachedGoal ? {} : { partial: true }),
    ...(f.workspaceId !== ws ? { source: f.workspaceId } : {}),
    ...(b.upload ? { upload: true } : {}),
  };
  const field = (name: string, value: unknown) => push(b, { type: 'field', field: name, value }, refs, upload);
  field('name', servedLine(store, ws, f.name, 400));
  field('goal', servedLine(store, ws, f.goal, FLOW_TEXT_MAX));
  if (f.entryUrl) field('entry_url', servedLine(store, ws, f.entryUrl, 400));
  if (f.stopReason) field('stop_reason', f.stopReason);
  if (f.notable) field('notable', fence(f.notable, FLOW_TEXT_MAX));
  if (f.entityId) field('entity_id', f.entityId);
  field('state', {
    lineage_id: f.lineageId, first_seen_at: f.firstSeenAt, confirm_count: f.confirmCount,
    ...(f.lastConfirmedAt ? { last_confirmed_at: f.lastConfirmedAt } : {}),
  });

  for (const s of r.flowSteps.list({ flowId: f.id }).sort((x, y) => x.seq - y.seq)) {
    const item: Item = { type: 'step', seq: s.seq, action: fence(s.action, FLOW_TEXT_MAX) };
    if (s.observation) item.observation = fence(s.observation, FLOW_TEXT_MAX);
    // Uncut (at most 50 labels of 200 characters): only the pager cuts, with its pointer.
    if (s.asked.length) item.asked = fenceEvidence(f.id, redactServed(store, ws, s.asked.join('\n')));
    if (s.error) item.error = fence(s.error, FLOW_TEXT_MAX);
    if (s.artifactId) item.artifact_id = s.artifactId;
    if (s.pageUrl) item.page_url = servedLine(store, ws, s.pageUrl, 400);
    push(b, item, [...refs, ...(s.artifactId ? [{ id: s.artifactId, kind: 'artifact' }] : [])], upload);
  }

  // Check answers, general checklist first, each list in its item order.
  const lists = new Map<string, Checklist | undefined>();
  const listOf = (cid: string) => {
    if (!lists.has(cid)) lists.set(cid, r.checklists.get(cid));
    return lists.get(cid);
  };
  const order = (c: FlowCheck) => {
    const list = listOf(c.checklistId);
    return [list?.flowTypeId ? 1 : 0, list?.items.findIndex((i) => i.key === c.itemKey) ?? -1] as const;
  };
  const checks = r.flowChecks.list({ flowId: f.id }).sort((x, y) => {
    const [a, b2] = [order(x), order(y)];
    return a[0] - b2[0] || x.checklistId.localeCompare(y.checklistId) || a[1] - b2[1];
  });
  for (const c of checks) {
    const list = listOf(c.checklistId);
    const def = list?.items.find((i) => i.key === c.itemKey);
    const item: Item = { type: 'check', checklist: list?.flowTypeId ? 'specific' : 'general', checklist_id: c.checklistId, key: c.itemKey };
    if (def) item.question = servedLine(store, ws, def.question, 400);
    item.answer = c.answer;
    if (c.value !== undefined && c.value !== null) item.value = typeof c.value === 'string' ? fence(c.value, FLOW_TEXT_MAX) : c.value;
    if (c.stepRefs.length) item.steps = c.stepRefs;
    if (c.mentionRefs.length) item.mention_ids = c.mentionRefs;
    if (c.note) item.note = fence(c.note, FLOW_TEXT_MAX);
    item.origin = c.origin;
    // An answer resting on review mentions is upload-derived when any of them is (flow design §8.4).
    const cited: RetrievalResultRef[] = c.mentionRefs.map((m) => ({ id: m, kind: 'record' }));
    push(b, item, [...refs, ...cited], upload || c.mentionRefs.some((m) => itemIsUploadDerived(store, m)));
  }

  if (!usableOnly(env.role)) {
    for (const v of r.flows.list({ rootWorkspaceId: f.rootWorkspaceId, lineageId: f.lineageId }).filter((v) => v.id !== f.id && inTree(env, v.workspaceId))) {
      push(b, { type: 'version', id: v.id, version: v.version, lifecycle: v.lifecycle, status: v.status, created_at: v.createdAt, ...sourceLabel(env, v.workspaceId) }, refs, upload);
    }
  }

  const mentions = r.reviewMentions.list({ rootWorkspaceId: f.rootWorkspaceId, subjectEntityId: f.subjectEntityId, flowTypeId: f.flowTypeId });
  const by = (p: string) => mentions.filter((m) => m.polarity === p);
  push(b, {
    type: 'reviews', total: mentions.length, negative: by('negative').length, neutral: by('neutral').length, positive: by('positive').length,
    ...(mentions.length ? { mention_ids: [...by('negative'), ...by('neutral'), ...by('positive')].slice(0, MAX_MENTION_IDS).map((m) => m.id) } : {}),
  }, [...refs, ...mentions.map((m) => ({ id: m.id, kind: 'record' }))], upload || mentions.some((m) => itemIsUploadDerived(store, m.id)));
  return b;
}

/**
 * A review mention: header (kind, type `review_mention`, id, subject, source type, polarity, source,
 * upload); items: the quote (fenced under its stored copy, with the passage around it), its source
 * (stored copy, address, date, rating) and its attribution (flow type, check, confidence).
 */
function expandMention(env: ReadEnv, id: string): Built {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const r = flowRepos(store);
  const m = r.reviewMentions.get(id);
  if (!m || !recordReadable(env, m.workspaceId)) throw expandNotFound(id);
  const upload = itemIsUploadDerived(store, m.id);
  const refs: RetrievalResultRef[] = [{ id: m.id, kind: 'record' }];
  const b = built({}, [...refs], upload);
  const subject = subjectOf(env, b, m.subjectEntityId);
  b.header = {
    kind: 'record', type: 'review_mention', id: m.id, ...(subject ? { subject } : {}), source_type: m.sourceType, polarity: m.polarity,
    ...(m.workspaceId !== ws ? { source: m.workspaceId } : {}),
    ...(b.upload ? { upload: true } : {}),
  };
  const art: RetrievalResultRef[] = [{ id: m.artifactId, kind: 'artifact' }, ...(m.chunkId ? [{ id: m.chunkId, kind: 'chunk' }] : [])];
  const passage = m.chunkId ? quotePassage(env, m.chunkId, m.quote) : undefined;
  push(b, {
    type: 'quote', artifact_id: m.artifactId, ...(m.chunkId ? { chunk_id: m.chunkId } : {}),
    text: fenceEvidence(m.artifactId, servedLine(store, ws, m.quote, CLAIM_MAX)), ...(passage ? { passage } : {}),
  }, [...refs, ...art], upload);
  push(b, {
    type: 'source', artifact_id: m.artifactId,
    ...(m.sourceUrl ? { source_url: servedLine(store, ws, m.sourceUrl, 400) } : {}),
    ...(m.publishedAt ? { published_at: m.publishedAt } : {}),
    ...(m.rating !== undefined ? { rating: m.rating } : {}),
    created_at: m.createdAt,
  }, refs, upload);
  const type = m.flowTypeId ? r.flowTypes.get(m.flowTypeId) : undefined;
  push(b, {
    type: 'attribution',
    ...(m.flowTypeId ? { flow_type: type?.key ?? m.flowTypeId } : {}),
    ...(m.checkKey ? { check_key: m.checkKey } : {}),
    confidence: m.attributionConfidence,
  }, refs, upload);
  return b;
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
  else if (id.startsWith('chk_')) b = expandChunk(env, id, input.around ?? 0);
  else if (id.startsWith('ent_')) b = expandEntity(env, id);
  else if (env.store.workspaces.get(id)) b = expandNode(env, id);
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
  const { b } = artifactBuilt(env, a, { mode });
  const query = `${a.id} ${mode}`;
  const done = () => finish(env, b, budget, key, input.cursor, query);
  switch (mode) {
    case 'outline':
      outlineItems(env, b, a, b.upload);
      return done();
    case 'text': {
      const chunks = artifactChunks(store, a.id);
      if (!chunks.length) b.notes.push('no extracted text to serve for this artifact');
      for (const c of chunks) b.items.push(passageItem(env, c, b.upload, a.id));
      return done();
    }
    case 'image': {
      // The image goes with the first page (its header); a later page carries only the remaining items.
      const note = (n: string) => {
        b.notes.push(n);
        return done();
      };
      if (!IMAGE_MIME.test(base)) return note(`not an inlinable image (${base}); use mode "outline" or "text"`);
      const bytes = storedBytes(files, a.id);
      if (!bytes) return note(FILE_GONE);
      if (bytes.byteLength > IMAGE_MAX_BYTES) return note(`image too large to inline (${bytes.byteLength} bytes)`);
      const out = done();
      if (!input.cursor) out.images = [{ data: bytes.toString('base64'), mimeType: base }];
      return out;
    }
    case 'raw': {
      if (!TEXT_MIME.test(base)) {
        b.notes.push(`raw mode serves text formats only (${base} is binary); use mode "text" for the extracted text`);
        return done();
      }
      rawItem(env, files, a, b);
      return done();
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

/** Raw text of a text-format artifact: redacted WHOLE (up to the extraction cap), then one position-paged, fenced item. */
function rawItem(env: ReadEnv, files: ArtifactBytes, a: Artifact, b: Built): void {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const cap = env.config.knowledge?.extraction?.maxTextChars ?? 2_000_000;
  const secrets = treeSecrets(store, ws);
  const margin = secrets.reduce((m, s) => Math.max(m, s.length), 0);
  const bytes = storedBytes(files, a.id);
  if (!bytes) {
    b.notes.push(FILE_GONE);
    return;
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
  b.items.push({
    value: { type: 'raw', offset: 0, text: fenceEvidence(a.id, text) },
    // The artifact (and its canonical) on every page that serves a piece: a later page's retrieval row
    // must list what it served (§12 exposure resolves these ids), not rely on page 1's header refs.
    refs: b.headerRefs, upload: b.upload,
    text: { body: text, fence: a.id, meta: (pos) => ({ type: 'raw', offset: pos }) },
  });
}
