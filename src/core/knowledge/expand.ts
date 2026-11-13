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
 * Synthesizer and interviewer see usable facts and records only: anything else answers "not found",
 * and history / unverified updates are left out. Reviewer and escalation runs read only their task's
 * review slice; nested items outside it are left out.
 */
import type { ArtifactStore } from '../evidence/artifacts.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Artifact, Finding, RetrievalResultRef, TextChunk } from '../types.js';
import { estimateTokens, truncateToTokens, decodeCursor, encodeCursor } from './budget.js';
import { entityCard, type CardLine } from './cards.js';
import { getEntity } from './entities.js';
import { factFreshness, isFactUsable, lineageVersions } from './facts.js';
import { itemIsUploadDerived } from './provenance.js';
import { ENVELOPE_TOKENS, inSlice, pageOf, uniqueRefs, usableOnly, type ReadEnv, type ReadOutput } from './readCommon.js';
import { notFound } from './scope.js';
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
type Built = { header: Record<string, unknown>; items: Item[]; refs: Map<Item, RetrievalResultRef[]>; headerRefs: RetrievalResultRef[]; upload: boolean; itemUpload: Map<Item, boolean>; notes: string[] };

function built(header: Record<string, unknown>, headerRefs: RetrievalResultRef[], upload: boolean): Built {
  return { header, items: [], refs: new Map(), headerRefs, upload, itemUpload: new Map(), notes: [] };
}

function push(b: Built, item: Item, refs: RetrievalResultRef[] = [], upload = false): void {
  b.items.push(item);
  b.refs.set(item, refs);
  b.itemUpload.set(item, upload);
}

function inTree(env: ReadEnv, ws: string | undefined): boolean {
  return ws !== undefined && env.scope.treeIds.includes(ws);
}

/** Pages `b.items` within `budget` and assembles the output. */
function finish(env: ReadEnv, b: Built, budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  const page = pageOf(b.items, b.header, budget, { key, notes: b.notes, ...(cursor ? { cursor } : {}) });
  const results = uniqueRefs([...b.headerRefs, ...page.items.flatMap((i) => b.refs.get(i) ?? [])]);
  const out: ReadOutput = {
    data: { ...b.header, items: page.items },
    results,
    uploadDerived: b.upload || page.items.some((i) => b.itemUpload.get(i) === true),
    truncated: page.truncated,
    more: page.more,
    notes: b.notes,
    query,
    scopeLabel: 'tree',
  };
  if (page.cursor) out.cursor = page.cursor;
  return out;
}

// ---------------------------------------------------------------------------
// facts

function factById(env: ReadEnv, id: string): Finding {
  const f = env.store.findings.get(id);
  if (!f || !inTree(env, f.workspaceId)) throw expandNotFound(id);
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
    const item: Item = { type: 'evidence', artifact_id: aid, artifact_kind: a.kind };
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
  const versions = lineageVersions(store, lineage).filter((v) => v.id !== f.id && inTree(env, v.workspaceId));
  if (usableOnly(env.role)) {
    if (versions.length) b.notes.push('version history is not shown to this role (usable facts only)');
  } else {
    for (const v of versions) {
      if (v.lifecycle === 'candidate' && v.replacesId === f.id) {
        const item: Item = { type: 'unverified_update', id: v.id, version: v.version ?? 1, status: v.status };
        if (inSlice(env, v.id)) item.claim = servedLine(store, ws, v.claim, LINE);
        push(b, item, item.claim ? [{ id: v.id, kind: 'fact' }] : [], item.claim ? v.uploadDerived === true : false);
        continue;
      }
      const item: Item = { type: 'version', id: v.id, version: v.version ?? 1, lifecycle: v.lifecycle ?? 'current', status: v.status, created_at: v.createdAt };
      if (inSlice(env, v.id)) item.claim = servedLine(store, ws, v.claim, LINE);
      push(b, item, item.claim ? [{ id: v.id, kind: 'fact' }] : [], item.claim ? v.uploadDerived === true : false);
    }
  }
  if (!env.slice) {
    const edges = knowledgeRepos(store).relations.list({ sourceKind: 'fact', sourceId: f.id });
    for (const e of edges) {
      const names: Array<{ id: string; name: string }> = [];
      for (const eid of [e.fromEntityId, e.toEntityId]) {
        try {
          const ent = getEntity(store, env.scope, eid);
          names.push({ id: ent.id, name: servedLine(store, ws, ent.name, 120) });
        } catch {
          // skip
        }
      }
      if (names.length < 2) continue;
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
  if (!a || !inTree(env, a.workspaceId)) throw nf(id);
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
    const item: Item = { type: 'capture', id: cap.id, captured_at: cap.capturedAt };
    if (cap.workspaceId !== ws) item.node = cap.workspaceId;
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
    const own = knowledgeRepos(store).artifactTexts.get(canonicalArtifactId(store, a.id))?.contentSha256;
    const prev = rows.filter((r) => r.at <= a.capturedAt).at(-1);
    const next = rows.find((r) => r.at > a.capturedAt);
    for (const [rel, r] of [['previous', prev], ['next', next]] as const) {
      if (!r) continue;
      const item: Item = { type: 'page_version', relation: rel, artifact_id: r.id, captured_at: r.at };
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
    if (a && inTree(env, a.workspaceId) && (!env.slice || env.slice.artifactIds.has(a.id) || env.slice.ids.has(a.id))) return a;
  }
  return undefined;
}

function chunkItem(env: ReadEnv, owner: Artifact, c: TextChunk, maxTokens?: number): Item {
  let text = servedChunkText(env.store, env.scope.workspaceId, c); // redacted before any cut
  let cut = false;
  if (maxTokens !== undefined && estimateTokens(text) > maxTokens) {
    text = truncateToTokens(text, maxTokens).text;
    cut = true;
  }
  const item: Item = { type: 'chunk', chunk_id: c.id, seq: c.seq, text: fenceEvidence(owner.id, text) };
  if (c.headingPath) item.heading = servedLine(env.store, env.scope.workspaceId, stripFences(c.headingPath), 160);
  if (c.locator) item.locator = c.locator;
  if (cut) item.cut = true;
  return item;
}

function expandChunk(env: ReadEnv, id: string, around: number, budget: number): Built {
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
  // Any single chunk fits the page on its own (cut after redaction when the budget is very small).
  const room = Math.max(16, budget - estimateTokens(JSON.stringify(header)) - ENVELOPE_TOKENS - 64);
  for (const x of all) push(b, chunkItem(env, owner, x, room), [{ id: x.id, kind: 'chunk' }], state.uploadDerived || x.uploadDerived === true);
  return b;
}

// ---------------------------------------------------------------------------
// entities and records

function expandEntity(env: ReadEnv, id: string): Built {
  let card;
  try {
    card = entityCard(env, env.scope, 'node', id, 40);
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
      if (!c || !inTree(env, c.workspaceId) || (usableOnly(env.role) && !usable(c))) throw expandNotFound(id);
      home = c.workspaceId;
      header = { kind: 'record', type, id, name: red(c.name), site: c.site ? red(c.site) : undefined, threat: c.threat, directness: c.directness, comparison: c.comparison, evidence: c.evidence, status: c.status, entity_id: c.entityId };
      break;
    }
    case 'persona': {
      const p = store.personas.get(id);
      if (!p || !inTree(env, p.workspaceId) || (usableOnly(env.role) && !usable(p))) throw expandNotFound(id);
      home = p.workspaceId;
      const profile = Object.fromEntries(Object.entries(p.profile ?? {}).map(([k, v]) => [k, { value: servedLine(store, ws, v?.value ?? '', 600), confidence: v?.confidence, evidence: v?.evidence }]));
      header = { kind: 'record', type, id, slug: p.slug, segment: red(p.segment), audience: p.audience ?? 'external', profile, status: p.status, entity_id: p.entityId };
      break;
    }
    case 'symptom': {
      const s = store.symptoms.get(id);
      if (!s || !inTree(env, s.workspaceId)) throw expandNotFound(id);
      home = s.workspaceId;
      header = { kind: 'record', type: s.kind, id, title: red(s.title), detail: servedLine(store, ws, s.detail, 2000), criteria: red(s.criteria), evidence: s.evidence, entity_id: s.entityId };
      break;
    }
    case 'hypothesis': {
      const h = store.symptomHypotheses.get(id);
      if (!h || !inTree(env, h.workspaceId) || (usableOnly(env.role) && !usable(h))) throw expandNotFound(id);
      home = h.workspaceId;
      header = { kind: 'record', type, id, symptom_id: h.symptomId, hypothesis: servedLine(store, ws, h.hypothesis, 2000), confidence: h.confidence, evidence: h.evidence, status: h.status, entity_id: h.entityId };
      break;
    }
    default: {
      const r = store.recommendations.get(id);
      if (!r || !inTree(env, r.workspaceId) || (usableOnly(env.role) && !usable(r))) throw expandNotFound(id);
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

// ---------------------------------------------------------------------------
// entry points

export type ExpandInput = { id: string; around?: number; cursor?: string };

export function runExpand(env: ReadEnv, input: ExpandInput, budget: number, key: string): ReadOutput {
  const id = input.id;
  let b: Built;
  if (id.startsWith('fnd_')) b = expandFact(env, id);
  else if (id.startsWith('art_')) b = expandArtifact(env, id);
  else if (id.startsWith('chk_')) b = expandChunk(env, id, input.around ?? 0, budget);
  else if (id.startsWith('ent_')) b = expandEntity(env, id);
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
      const room = Math.max(16, budget - estimateTokens(JSON.stringify(header)) - ENVELOPE_TOKENS - 64);
      for (const c of artifactChunks(store, a.id)) push(b, chunkItem(env, a, c, room), [{ id: c.id, kind: 'chunk' }], h.upload || c.uploadDerived === true);
      if (!b.items.length) b.notes.push('no extracted text to serve for this artifact');
      return finish(env, b, budget, key, input.cursor, query);
    }
    case 'image': {
      const out = finish(env, b, budget, key, undefined, query);
      if (!IMAGE_MIME.test(base)) {
        out.notes = [...(out.notes ?? []), `not an inlinable image (${base}); use mode "outline" or "text"`];
        return out;
      }
      const { bytes } = files.read(a.id);
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

/** Raw text of a text-format artifact: redacted WHOLE (up to the extraction cap), then paged by characters and fenced. */
function rawPage(env: ReadEnv, files: ArtifactBytes, a: Artifact, b: Built, budget: number, key: string, cursor: string | undefined, query: string): ReadOutput {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const cap = (env.config.knowledge?.extraction?.maxTextChars ?? 2_000_000);
  const secrets = treeSecrets(store, ws);
  const margin = secrets.reduce((m, s) => Math.max(m, s.length), 0);
  const all = files.read(a.id).bytes.toString('utf8');
  let text = redactServed(store, ws, all.slice(0, cap + margin));
  if (all.length > cap + margin) text = stripSecretTail(text, secrets);
  const docCut = all.length > cap;
  if (text.length > cap) text = text.slice(0, cap);
  if (docCut) {
    b.header.document_truncated = true;
    b.notes.push(`the stored file is longer than ${cap} characters; raw mode serves its start only`);
  }
  const offset = cursor ? Math.min(decodeCursor(cursor, key), text.length) : 0;
  const overhead = estimateTokens(JSON.stringify({ ...b.header, items: [] })) + ENVELOPE_TOKENS + estimateTokens(JSON.stringify(b.notes)) + 32;
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
  push(b, item, [{ id: a.id, kind: 'artifact' }], b.upload);
  const out: ReadOutput = {
    data: { ...b.header, items: b.items },
    results: uniqueRefs(b.headerRefs),
    uploadDerived: b.upload,
    truncated: end < text.length,
    more: end < text.length ? text.length - end : 0,
    notes: b.notes,
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
