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
import { redactSecrets, type IdentitySource } from '../store/redact.js';
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
  const root = rootOf(store, workspaceId);
  const ids = [root, ...descendants(store, root).map((w) => w.id)];
  if (!ids.includes(workspaceId)) ids.push(workspaceId);
  const source: IdentitySource = { identities: { list: () => ids.flatMap((id) => store.identities.list({ workspaceId: id })) } };
  return redactSecrets(source, workspaceId, value);
}
