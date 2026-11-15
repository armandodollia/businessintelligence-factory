/**
 * Review mentions (design 2026-11-14-flow-records-and-ranking-design.md §9, §14): one record per
 * piece of real public (or user-provided) feedback about a subject, quoted from a stored copy of
 * its source.
 *
 * - The quote is verified against the artifact's extracted text with the citation rule
 *   (`verifyEvidenceRefs`: artifact in the caller's tree, whitespace-insensitive match, at most
 *   `QUOTE_MAX_CHARS`); the chunk it sits in is kept. Each mention is verified on its own, so one
 *   bad mention is rejected (with its index and reason) and the others still save.
 * - Third-party text: the quote (and the source address) is stored redacted and fence-stripped,
 *   and capped at `QUOTE_MAX_CHARS` after redaction.
 * - One mention per subject and quote: `quoteHash` = sha256 of the stored quote, whitespace-squashed
 *   and lowercased (UNIQUE with the tree and subject). The same complaint from another address is a
 *   duplicate; counts are of distinct mentions.
 * - Attribution: a flow type (and, optionally, one item of its active checklists) with a confidence
 *   (default 1). Without a flow type the mention stays on the subject only (confidence 0) and
 *   counts for no flow.
 * - Dates: an unparseable or future `publishedAt` is stored as undated. Only mentions dated within
 *   `mentionWindowDays` and attributed with at least `minAttributionConfidence` count toward a
 *   threshold (`mentionCounts`); the others are kept and shown as not counted.
 * - No author name or handle is accepted or stored.
 *
 * Import cycle note: `./checks.ts` imports `mentionsFor` / `mentionCounts` from here, and this module
 * imports `./catalog.ts` and `./flows.ts`, which lead back to checks. Call-time use only; keep it so.
 */
import { createHash } from 'node:crypto';
import type { EntityRef } from '../knowledge/entities.js';
import { normalizeText } from '../knowledge/extract/normalize.js';
import { QUOTE_MAX_CHARS, verifyEvidenceRefs, type FactToolEnv } from '../knowledge/factTools.js';
import { scopeFor } from '../knowledge/scope.js';
import { redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { rootOf } from '../workspace/tree.js';
import { activeChecklists, flowTypeByKey } from './catalog.js';
import type { FlowsSettings } from './config.js';
import { FlowInputError, resolveSubject, type FlowCtx } from './flows.js';
import { flowRepos } from './repos.js';
import type { Flow, ReviewMention, ReviewSourceType } from './types.js';

export type ReviewMentionInput = {
  sourceType: ReviewSourceType;
  sourceUrl?: string;
  artifactId: string;
  quote: string;
  publishedAt?: string;
  rating?: number;
  polarity: 'negative' | 'neutral' | 'positive';
  flowTypeKey?: string;
  checkKey?: string;
  confidence?: number;
};
export type SaveReviewMentionsResult = { saved: number; duplicates: number; rejected: Array<{ index: number; error: string }> };

export const REVIEW_SOURCE_TYPES: readonly ReviewSourceType[] = ['app_store', 'review_site', 'forum', 'community', 'support_board', 'social', 'user_provided'];
export const MENTION_POLARITIES: readonly ReviewMention['polarity'][] = ['negative', 'neutral', 'positive'];

const DAY_MS = 86_400_000;

/** Third-party text: the tree's identity secrets redacted, fence sequences removed, trimmed. */
function cleanText(store: Store, workspaceId: string, s: string): string {
  return stripFences(redactServed(store, workspaceId, s)).trim();
}

/** sha256 of the quote, whitespace-squashed and lowercased. */
function quoteHash(quote: string): string {
  return createHash('sha256').update(normalizeText(quote).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

/** An ISO timestamp for a parseable date not after `now`; undefined (undated) otherwise. */
function datedAt(value: unknown, now: Date): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const t = Date.parse(value.trim());
  if (!Number.isFinite(t) || t > now.getTime()) return undefined;
  return new Date(t).toISOString();
}

/** A mention's fields checked and attributed; the quote is verified separately. Throws `FlowInputError`. */
function validated(store: Store, workspaceId: string, m: ReviewMentionInput): { flowTypeId?: string; checkKey?: string; confidence: number } {
  if (!m || typeof m !== 'object') throw new FlowInputError('a mention is { sourceType, artifactId, quote, polarity, ... }');
  if (!REVIEW_SOURCE_TYPES.includes(m.sourceType)) throw new FlowInputError(`sourceType must be one of ${REVIEW_SOURCE_TYPES.join(', ')}`);
  if (typeof m.artifactId !== 'string' || !m.artifactId) throw new FlowInputError('artifactId is required: the stored copy of the source');
  if (typeof m.quote !== 'string' || !m.quote.trim()) throw new FlowInputError('quote is required: the words of the feedback as they appear in the stored copy');
  if (!MENTION_POLARITIES.includes(m.polarity)) throw new FlowInputError(`polarity must be one of ${MENTION_POLARITIES.join(', ')}`);
  if (m.rating !== undefined && (typeof m.rating !== 'number' || !Number.isFinite(m.rating))) throw new FlowInputError('rating must be a number');
  if (m.sourceUrl !== undefined && typeof m.sourceUrl !== 'string') throw new FlowInputError('sourceUrl must be a text');
  if (m.confidence !== undefined && (typeof m.confidence !== 'number' || !(m.confidence >= 0 && m.confidence <= 1))) {
    throw new FlowInputError('confidence must be a number from 0 to 1');
  }
  if (m.flowTypeKey === undefined) {
    if (m.checkKey !== undefined) throw new FlowInputError('checkKey needs flowTypeKey: name the flow type the check belongs to');
    return { confidence: 0 };
  }
  const type = typeof m.flowTypeKey === 'string' ? flowTypeByKey(store, workspaceId, m.flowTypeKey) : undefined;
  if (!type) throw new FlowInputError(`unknown flow type '${String(m.flowTypeKey)}'; read the flow catalog, or leave flowTypeKey out to attach the mention to the subject only`);
  if (type.status === 'rejected') throw new FlowInputError(`flow type '${type.key}' was rejected by the user; use another type or leave flowTypeKey out`);
  const out: { flowTypeId: string; checkKey?: string; confidence: number } = { flowTypeId: type.id, confidence: m.confidence ?? 1 };
  if (m.checkKey !== undefined) {
    const { general, specific } = activeChecklists(store, workspaceId, type.id);
    const keys = [...general.items, ...(specific?.items ?? [])].map((i) => i.key);
    if (typeof m.checkKey !== 'string' || !keys.includes(m.checkKey)) {
      throw new FlowInputError(`unknown check '${String(m.checkKey)}' for flow type '${type.key}'; its checklist items are: ${[...new Set(keys)].join(', ')}`);
    }
    out.checkKey = m.checkKey;
  }
  return out;
}

/**
 * Verifies and stores review mentions about one subject. Each mention is checked on its own: a bad
 * one is listed in `rejected` (by its index in `mentions`) and the rest still save. A quote already
 * stored for the subject (same `quoteHash`) is counted in `duplicates`, not saved.
 *
 * The subject is resolved like a flow's (`resolveSubject`); a subject outside the caller's tree, or
 * not one that can have flows, throws `FlowInputError` and nothing is saved.
 */
export async function saveReviewMentions(env: FactToolEnv, ctx: FlowCtx, subject: EntityRef, mentions: ReviewMentionInput[]): Promise<SaveReviewMentionsResult> {
  const { store } = env;
  if (!Array.isArray(mentions)) throw new FlowInputError('mentions must be an array');
  const scope = scopeFor(store, ctx.workspaceId);
  const entity = store.transaction(() => resolveSubject(store, scope, subject, ctx));
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const taskId = task && task.workspaceId === ctx.workspaceId ? task.id : undefined;
  const repo = flowRepos(store).reviewMentions;
  const result: SaveReviewMentionsResult = { saved: 0, duplicates: 0, rejected: [] };

  for (const [index, m] of mentions.entries()) {
    try {
      const attribution = validated(store, ctx.workspaceId, m);
      const checked = await verifyEvidenceRefs(env, ctx.workspaceId, [{ artifact_id: m.artifactId, quote: m.quote }]);
      if (!checked.ok) throw new FlowInputError(checked.error.replace(/^evidence_refs: /, ''));
      const quote = cleanText(store, ctx.workspaceId, m.quote).slice(0, QUOTE_MAX_CHARS).trim();
      if (!quote) throw new FlowInputError('quote has no text left once fence markers are removed');
      const hash = quoteHash(quote);
      // No await between this check and the insert: concurrent calls cannot both pass it.
      if (repo.list({ rootWorkspaceId: scope.rootId, subjectEntityId: entity.id, quoteHash: hash }).length) {
        result.duplicates++;
        continue;
      }
      const now = new Date();
      const row: ReviewMention = {
        id: newId('rvm'),
        workspaceId: ctx.workspaceId,
        rootWorkspaceId: scope.rootId,
        subjectEntityId: entity.id,
        sourceType: m.sourceType,
        artifactId: m.artifactId,
        quote,
        quoteHash: hash,
        polarity: m.polarity,
        attributionConfidence: attribution.confidence,
        createdAt: now.toISOString(),
      };
      const sourceUrl = m.sourceUrl !== undefined ? cleanText(store, ctx.workspaceId, m.sourceUrl) : '';
      if (sourceUrl) row.sourceUrl = sourceUrl;
      const chunkId = checked.rows[0]?.chunkId;
      if (chunkId !== undefined) row.chunkId = chunkId;
      const publishedAt = datedAt(m.publishedAt, now);
      if (publishedAt !== undefined) row.publishedAt = publishedAt;
      if (m.rating !== undefined) row.rating = m.rating;
      if (attribution.flowTypeId !== undefined) row.flowTypeId = attribution.flowTypeId;
      if (attribution.checkKey !== undefined) row.checkKey = attribution.checkKey;
      if (taskId !== undefined) row.taskId = taskId;
      repo.insert(row);
      result.saved++;
    } catch (e) {
      if (!(e instanceof FlowInputError)) throw e;
      result.rejected.push({ index, error: e.message });
    }
  }
  return result;
}

/** The caller's tree's mentions of a subject, optionally of one flow type and check; in insertion order. */
export function mentionsFor(store: Store, workspaceId: string, q: { subjectEntityId: string; flowTypeId?: string; checkKey?: string }): ReviewMention[] {
  return flowRepos(store).reviewMentions.list({
    rootWorkspaceId: rootOf(store, workspaceId), subjectEntityId: q.subjectEntityId, flowTypeId: q.flowTypeId, checkKey: q.checkKey,
  });
}

/** A mention counts toward a threshold when it is dated within the window and attributed with enough confidence. */
export function mentionCounts(m: ReviewMention, settings: FlowsSettings, now: Date): boolean {
  if (m.flowTypeId === undefined || m.attributionConfidence < settings.minAttributionConfidence) return false;
  const t = m.publishedAt === undefined ? NaN : Date.parse(m.publishedAt);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime() && t >= now.getTime() - settings.mentionWindowDays * DAY_MS;
}

/** { total, negative, counted } of the distinct mentions attributed to the flow's subject and type. */
export function reviewDigest(
  store: Store,
  flow: Flow,
  settings: FlowsSettings,
  now: Date = new Date(),
): { total: number; negative: number; counted: number; quotes: Array<{ id: string; quote: string; polarity: string }> } {
  const mentions = flowRepos(store).reviewMentions.list({
    rootWorkspaceId: flow.rootWorkspaceId, subjectEntityId: flow.subjectEntityId, flowTypeId: flow.flowTypeId,
  });
  return {
    total: mentions.length,
    negative: mentions.filter((m) => m.polarity === 'negative').length,
    counted: mentions.filter((m) => mentionCounts(m, settings, now)).length,
    quotes: mentions.map((m) => ({ id: m.id, quote: m.quote, polarity: m.polarity })),
  };
}
