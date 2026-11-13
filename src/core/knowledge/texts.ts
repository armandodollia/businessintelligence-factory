/**
 * Extracted text of an artifact as KS-4's read tools (`expand`, `read_artifact`, `search`) serve it
 * (design §8.2–8.5; KS-1 rulings).
 *
 * - Duplicates: an artifact whose text is `duplicate_of` another has no chunks of its own and
 *   resolves to the canonical's chunks. `duplicate_of` is followed ONE level: KS-1 always points it
 *   at an artifact whose own `duplicate_of` is NULL (tested invariant).
 * - Upload flag: text served for artifact X carries X's flag OR the chunk's flag (a duplicate that is
 *   an upload resolves to a public canonical's chunks whose own flag is 0). KS-4 must list X (the
 *   artifact asked for) in `retrieval_events.result_ids`, not only the canonical's chunk ids.
 * - `too_large` with partial text: indexed; `truncated` says the document was cut at the cap.
 * - `artifact_texts.error` is derived text: served only after the artifact's own scope check,
 *   with the artifact's upload flag, redacted, fence-stripped, capped and fenced.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { ArtifactText, ExtractionState, TextChunk } from '../types.js';
import { activeIds, notFound, type KnowledgeScope, type ScopeMode } from './scope.js';
import { CONTENT_TRUST, fenceEvidence, redactRange, redactServed, treeSecrets } from './trust.js';

/** Cap on `artifact_texts.error` when stored and when served (chars, before the fence). */
export const SERVED_ERROR_MAX_CHARS = 300;

/** Cuts `s` to `max` UTF-16 units (never between surrogate halves), marking the cut with `…`. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return `${s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)}…`;
}

/** True when the indexed text is the start of a document cut at `maxTextChars` (`too_large` with text). */
export function textTruncated(row: Pick<ArtifactText, 'status' | 'charCount'> | undefined): boolean {
  return row?.status === 'too_large' && row.charCount > 0;
}

/** The artifact whose chunks hold `artifactId`'s text: its `duplicate_of`, else itself. */
export function canonicalArtifactId(store: Store, artifactId: string): string {
  return knowledgeRepos(store).artifactTexts.get(artifactId)?.duplicateOf ?? artifactId;
}

/** The chunks of `artifactId`'s text (the canonical's for a duplicate), in order. No scope check. */
export function artifactChunks(store: Store, artifactId: string): TextChunk[] {
  return knowledgeRepos(store)
    .chunks.list({ artifactId: canonicalArtifactId(store, artifactId) })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The indexed text of `artifactId` (the canonical's for a duplicate), rebuilt from its chunks so
 * that every chunk's `charStart` / `charEnd` index it (`text.slice(charStart, charEnd) === chunk.text`).
 * Only whitespace lies between chunks (KS-1a); gaps are filled with newlines (a single gap char with
 * a space), so whitespace-normalized matching (KS-2 quote checks) sees the original text.
 * `undefined` when the artifact has no indexed text. No scope check, not redacted at serve time.
 */
export function artifactText(store: Store, artifactId: string): string | undefined {
  const chunks = artifactChunks(store, artifactId);
  if (!chunks.length) return undefined;
  let out = '';
  for (const c of chunks) {
    const gap = c.charStart - out.length;
    if (gap > 0) out += gap === 1 ? ' ' : '\n'.repeat(gap);
    out += c.text;
  }
  return out;
}

/**
 * The one way to serve a piece of evidence text (snippet, chunk, raw page): identity secrets of the
 * caller's tree redacted FIRST (so a cut cannot leave half a secret), then cut to `maxChars`, then
 * fenced with fence sequences removed (`fenceEvidence`). Responses carrying it set
 * `content_trust: CONTENT_TRUST`.
 */
export function serveEvidenceText(store: Store, workspaceId: string, artifactId: string, text: string, maxChars: number): string {
  return fenceEvidence(artifactId, capText(redactServed(store, workspaceId, text), maxChars));
}

/** Number of chunks holding `artifactId`'s text. */
export function chunkCount(store: Store, artifactId: string): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM chunks WHERE artifact_id = ?')
    .get(canonicalArtifactId(store, artifactId)) as { n: number };
  return Number(row.n);
}

/**
 * Whether `artifactId` is visible in `scope` (design §7.1): its workspace is in the caller's tree,
 * and in `node` mode one of its `item_scopes` rows is in the active ids.
 */
export function artifactVisible(store: Store, scope: KnowledgeScope, artifactId: string, mode: ScopeMode): boolean {
  const art = store.artifacts.get(artifactId);
  if (!art || !scope.treeIds.includes(art.workspaceId)) return false;
  if (mode === 'tree') return true;
  const ids = new Set(activeIds(scope, mode));
  return knowledgeRepos(store).itemScopes.list({ itemKind: 'artifact', itemId: artifactId }).some((s) => ids.has(s.workspaceId));
}

export type ServedTextState = {
  artifactId: string;
  status: ExtractionState;
  extractor?: string;
  charCount: number;
  tokenEstimate: number;
  /** The document was cut at `maxTextChars`; only its start is indexed (`expand` / `read_artifact` say so). */
  truncated: boolean;
  duplicateOf?: string;
  /** The artifact whose chunks hold the text (`duplicateOf` or the artifact itself). */
  canonicalId: string;
  chunkCount: number;
  /** The artifact's flag (or the canonical's): covers the error text and every chunk served for it. */
  uploadDerived: boolean;
  /** Extraction error: redacted, fence-stripped, capped and fenced. */
  error?: string;
  /** `untrusted` whenever `error` is present. */
  contentTrust?: typeof CONTENT_TRUST;
};

/**
 * Extraction state of an artifact for a caller in `scope`. Throws `KnowledgeNotFoundError`
 * ("artifact '<id>' not found") for an unknown artifact and for one outside the scope alike.
 */
export function servedTextState(store: Store, scope: KnowledgeScope, artifactId: string, mode: ScopeMode): ServedTextState {
  if (!artifactVisible(store, scope, artifactId, mode)) throw notFound('artifact', artifactId);
  const art = store.artifacts.get(artifactId)!;
  const row = knowledgeRepos(store).artifactTexts.get(artifactId);
  const canonicalId = row?.duplicateOf ?? artifactId;
  const canonicalFlag = canonicalId === artifactId ? false : store.artifacts.get(canonicalId)?.uploadDerived === true;
  const out: ServedTextState = {
    artifactId,
    status: row?.status ?? 'pending',
    charCount: row?.charCount ?? 0,
    tokenEstimate: row?.tokenEstimate ?? 0,
    truncated: textTruncated(row),
    canonicalId,
    chunkCount: chunkCount(store, artifactId),
    uploadDerived: art.uploadDerived === true || canonicalFlag,
  };
  if (row?.extractor !== undefined) out.extractor = row.extractor;
  if (row?.duplicateOf !== undefined) out.duplicateOf = row.duplicateOf;
  if (row?.error) {
    out.error = serveEvidenceText(store, scope.workspaceId, artifactId, row.error, SERVED_ERROR_MAX_CHARS);
    out.contentTrust = CONTENT_TRUST;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Knowledge store KS-4: serving chunks and snippets with "redact before every cut".
//
// Chunk text was redacted at ingest with the identities that existed then. Identities created later
// are redacted at serve time; since a chunk is a cut of the document, a secret that runs across a
// chunk boundary is redacted against the neighbouring chunks (`redactRange`), so neither chunk shows
// half of it. Snippets are windows of a chunk chosen AFTER the same range redaction.

/** `chunk`'s text in its artifact with up to one neighbour on each side, and where the chunk sits in it. */
function chunkContext(store: Store, chunk: TextChunk): { full: string; start: number; end: number } {
  const near = store.db
    .prepare('SELECT id FROM chunks WHERE artifact_id = ? AND seq IN (?, ?) ORDER BY seq')
    .all(chunk.artifactId, chunk.seq - 1, chunk.seq + 1) as Array<{ id: string }>;
  const repo = knowledgeRepos(store).chunks;
  const rows = near.map((r) => repo.get(r.id)!);
  const prev = rows.find((r) => r.seq === chunk.seq - 1);
  const next = rows.find((r) => r.seq === chunk.seq + 1);
  const gap = (n: number) => (n <= 0 ? '' : n === 1 ? ' ' : '\n'.repeat(Math.min(n, 4)));
  let full = '';
  if (prev) full += prev.text + gap(chunk.charStart - prev.charEnd);
  const start = full.length;
  full += chunk.text;
  const end = full.length;
  if (next) full += gap(next.charStart - chunk.charEnd) + next.text;
  return { full, start, end };
}

/**
 * The text of `chunk` (or of `[from, to)` within it) as served to a caller in `workspaceId`: secrets of
 * the caller's tree redacted across the chunk's boundaries, NOT fenced (callers fence).
 */
export function servedChunkText(store: Store, workspaceId: string, chunk: TextChunk, from = 0, to = chunk.text.length): string {
  const secrets = treeSecrets(store, workspaceId);
  if (!secrets.length) return chunk.text.slice(from, to);
  const c = chunkContext(store, chunk);
  return redactRange(c.full, c.start + from, c.start + Math.min(to, chunk.text.length), secrets);
}

/** Longest snippet served by search (design §9: ≤ 200 chars). */
export const SNIPPET_MAX_CHARS = 200;

/**
 * A search snippet of a chunk: a window of at most `maxChars` around the first occurrence of one of
 * `terms` (case-insensitive; the chunk start when none occurs), redacted across chunk boundaries
 * BEFORE the window is cut, then capped and fenced with the artifact id the hit is reported under.
 */
export function chunkSnippet(
  store: Store,
  workspaceId: string,
  reportedArtifactId: string,
  chunk: TextChunk,
  terms: readonly string[],
  maxChars = SNIPPET_MAX_CHARS,
): string {
  const lower = chunk.text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = t ? lower.indexOf(t.toLowerCase()) : -1;
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const lead = Math.floor(maxChars / 3);
  let from = at < 0 ? 0 : Math.max(0, at - lead);
  const to = Math.min(chunk.text.length, from + maxChars);
  from = Math.max(0, Math.min(from, to - maxChars));
  let text = servedChunkText(store, workspaceId, chunk, from, to);
  if (from > 0) text = `…${text}`;
  if (to < chunk.text.length) text = `${text}…`;
  return fenceEvidence(reportedArtifactId, capText(text, maxChars + 2));
}

/** Agent- or user-written store text (claims, titles, descriptions, names) as served: redacted whole, then cut. */
export function servedLine(store: Store, workspaceId: string, text: string, maxChars: number): string {
  return capText(redactServed(store, workspaceId, text), maxChars);
}
// --- end KS-4 -------------------------------------------------------------------------------------
