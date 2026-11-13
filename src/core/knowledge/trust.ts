/**
 * Untrusted content (design §8.5) and served-value redaction.
 *
 * Extracted third-party text is data. Wherever it is returned (snippets, chunks, raw mode) it is
 * fenced with `fenceEvidence`, and the response carries `content_trust: CONTENT_TRUST`. The fence
 * sequences are removed from the content first, so evidence can neither close its fence early nor
 * forge another one. Identity secrets are redacted from everything served (`redactServed`) — and
 * from everything indexed (KS-1 ingest applies `redactServed` before writing chunks).
 */
import type { Store } from '../store/db.js';
import { REDACTED, redactSecrets, type IdentitySource } from '../store/redact.js';
import { descendants, rootOf } from '../workspace/tree.js';

/** Value of `content_trust` on every response that carries evidence text. */
export const CONTENT_TRUST = 'untrusted' as const;

export const FENCE_OPEN = '<<<EVIDENCE';
export const FENCE_CLOSE = '>>>';

/**
 * Invisible format characters (zero-width, bidi controls, soft hyphen, BOM, Unicode tags) — removed
 * so they cannot hide a fence sequence (`>​>>`) or smuggle hidden text.
 */
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]|\uDB40[\uDC00-\uDC7F]/g;

/** Runs of three or more angle brackets, including fullwidth and small-form lookalikes. */
const FENCE_RUN = /[<＜﹤]{3,}|[>＞﹥]{3,}/g;

/** `text` without invisible characters and without any run of ≥ 3 angle brackets (repeated until none remains). */
export function stripFences(text: string): string {
  let out = text.replace(INVISIBLE, '');
  for (;;) {
    const next = out.replace(FENCE_RUN, '');
    if (next === out) return out;
    out = next;
  }
}

/** Evidence text fenced and labelled with its artifact id: `<<<EVIDENCE art_…\n…\n>>>`. */
export function fenceEvidence(artifactId: string, text: string): string {
  const label = artifactId.replace(/[^A-Za-z0-9_-]/g, '');
  return `${FENCE_OPEN} ${label}\n${stripFences(text)}\n${FENCE_CLOSE}`;
}

/**
 * Redacts the identity secrets (site and inbox passwords) of every workspace in `workspaceId`'s
 * business tree from `value` (strings at any depth). Knowledge responses can carry text saved by
 * any node of the tree, so the caller's own workspace's secrets are not enough.
 */
export function redactServed<T>(store: Store, workspaceId: string, value: T): T {
  const source: IdentitySource = { identities: { list: () => treeIdentities(store, workspaceId) } };
  return redactSecrets(source, workspaceId, value);
}

function treeIdentities(store: Store, workspaceId: string) {
  const root = rootOf(store, workspaceId);
  const ids = [root, ...descendants(store, root).map((w) => w.id)];
  if (!ids.includes(workspaceId)) ids.push(workspaceId);
  return ids.flatMap((id) => store.identities.list({ workspaceId: id }));
}

// --- Knowledge store KS-4: redact before every cut (design-thread ruling) ---------------------------
// A cut made BEFORE redaction can leave part of a secret that the redaction no longer recognises.
// So text is redacted whole and only then cut; where a cut happened upstream (KS-1a caps text and
// error messages before any redaction runs) the partial secret it may have left at the cut is removed
// with `stripSecretTail`.

/** The identity secrets `redactServed` replaces for `workspaceId`'s tree (same ≥ 4 chars rule). */
export function treeSecrets(store: Store, workspaceId: string): string[] {
  const out = new Set<string>();
  for (const i of treeIdentities(store, workspaceId)) {
    for (const s of [i.password, i.emailPassword]) if (typeof s === 'string' && s.length >= 4) out.add(s);
  }
  return [...out];
}

/**
 * `text` without its longest suffix that is the start of a secret (a secret cut in half upstream).
 * Apply only at a cut point: it may also drop an innocent trailing character or two.
 */
export function stripSecretTail(text: string, secrets: readonly string[]): string {
  let drop = 0;
  for (const s of secrets) {
    for (let n = Math.min(s.length - 1, text.length); n > drop; n--) {
      if (text.endsWith(s.slice(0, n))) {
        drop = n;
        break;
      }
    }
  }
  return drop ? text.slice(0, text.length - drop) : text;
}

/**
 * `full.slice(start, end)` with every secret occurrence in `full` that overlaps the range replaced by
 * `[redacted]` — also one that only straddles an edge of the range, so a window or a chunk never
 * shows part of a secret even when the secret runs across its boundary.
 */
export function redactRange(full: string, start: number, end: number, secrets: readonly string[]): string {
  const hits: Array<[number, number]> = [];
  for (const s of secrets) {
    let from = Math.max(0, start - s.length + 1);
    for (;;) {
      const i = full.indexOf(s, from);
      if (i < 0 || i >= end) break;
      hits.push([i, i + s.length]);
      from = i + 1;
    }
  }
  if (!hits.length) return full.slice(start, end);
  hits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = start;
  let i = 0;
  while (i < hits.length) {
    let [hs, he] = hits[i]!;
    while (i + 1 < hits.length && hits[i + 1]![0] < he) he = Math.max(he, hits[++i]![1]);
    i++;
    if (hs > pos) out += full.slice(pos, Math.min(hs, end));
    out += REDACTED;
    pos = Math.max(pos, he);
    if (pos >= end) break;
  }
  if (pos < end) out += full.slice(pos, end);
  return out;
}
// --- end KS-4 -------------------------------------------------------------------------------------
