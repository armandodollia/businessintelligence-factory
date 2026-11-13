/**
 * Knowledge-store parts of `save_artifact` and `describe_artifact` (KS-1; design §8.1, §9, §12).
 * `harness/tools/handlers.ts` keeps the file handling and calls these.
 *
 * - Caption rule: image artifacts saved by agents (`kind: screenshot` or an `image/*` mime) need a
 *   `description` of at least `captions.minChars` (when `captions.required`). Uploads never pass
 *   through `save_artifact`, so they are exempt.
 * - `entity` (id or `{ kind, name }`) and `applies_to` are validated against the caller's tree
 *   before anything is written; out-of-tree and unknown ids get the same "not found" error.
 * - `applies_to` replaces the `home` scope of a new artifact (source `agent`); on identical bytes
 *   saved earlier it only adds labels, so a later save never narrows what other nodes saw. The
 *   label is a judgment and is logged as a Decision (design §13).
 * - `describe_artifact`: only when the artifact has no description or the caller's agent run saved
 *   it (it has a capture of that run). The description lives on the artifact row, so it carries the
 *   artifact's `upload_derived` flag (a description of an upload is upload-derived).
 */
import type { BifConfig } from '../config/schema.js';
import type { ArtifactStore, CaptureResult } from '../evidence/artifacts.js';
import type { RunContext } from '../harness/tokens.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Entity, EntityKind } from '../types.js';
import { rootOf, sameTree } from '../workspace/tree.js';
import { knowledgeSettings } from './config.js';
import { ensureEntity, survivorOf } from './entityKeys.js';
import { ingestorFor, type ExtractionSummary } from './ingest.js';
import { inTree, KnowledgeNotFoundError, notFound, scopeFor, setItemScopes } from './scope.js';

export type EntityRef = string | { kind: EntityKind; name: string };

type Deps = { store: Store; artifacts: ArtifactStore; config: Pick<BifConfig, 'knowledge'> };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const IMAGE_MIME = /^image\//i;

/** Whether `save_artifact` input is an image that needs a caption (design §8.1). */
export function needsCaption(kind: string, mime: string): boolean {
  return kind === 'screenshot' || IMAGE_MIME.test(mime.split(';')[0]!.trim());
}

// --- KS-3 seam: entity resolution for save_artifact ---------------------------------------------
// KS-1 resolves with KS-0's `ensureEntity` (exact key / alias in the tree, else create). KS-3's
// `resolveEntity` (merge suggestions, upload-only names) replaces the body of `resolveArtifactEntity`
// at merge; the validation (`checkEntityRef`) stays.

/** Validates an entity reference without writing: an id must name an entity of the caller's tree. */
function checkEntityRef(store: Store, workspaceId: string, ref: EntityRef): void {
  if (typeof ref !== 'string') return;
  const e = knowledgeRepos(store).entities.get(ref);
  if (!e || e.rootWorkspaceId !== rootOf(store, workspaceId)) throw notFound('entity', ref);
}

/** Resolves (or creates) the entity an artifact save names; merged entities resolve to the survivor. */
export function resolveArtifactEntity(store: Store, ctx: Pick<RunContext, 'workspaceId' | 'agentRunId'>, ref: EntityRef): Entity {
  checkEntityRef(store, ctx.workspaceId, ref);
  if (typeof ref === 'string') return survivorOf(store, knowledgeRepos(store).entities.get(ref)!);
  return ensureEntity(store, {
    rootWorkspaceId: rootOf(store, ctx.workspaceId),
    workspaceId: ctx.workspaceId,
    kind: ref.kind,
    name: ref.name,
    createdByRun: ctx.agentRunId,
  }).entity;
}
// --- end KS-3 seam -------------------------------------------------------------------------------

export type ArtifactSaveExtras = {
  description?: string;
  entity?: EntityRef;
  appliesTo?: string[];
};

/** Checks run before any write: caption rule, entity id and `applies_to` in the caller's tree. */
export function checkArtifactSave(
  deps: Deps,
  ctx: RunContext,
  input: { kind: string; mime: string } & ArtifactSaveExtras,
): Outcome<void> {
  const { captions } = knowledgeSettings(deps.config);
  const description = input.description?.trim() ?? '';
  if (captions.required && needsCaption(input.kind, input.mime)) {
    if (!description) {
      return {
        ok: false,
        error:
          `description is required for screenshots and images: say what is on screen that matters (page purpose, ` +
          `visible prices, plan names, button labels, error text), at least ${captions.minChars} characters`,
      };
    }
    if (description.length < captions.minChars) {
      return { ok: false, error: `description must be at least ${captions.minChars} characters (got ${description.length})` };
    }
  }
  try {
    if (input.entity !== undefined) checkEntityRef(deps.store, ctx.workspaceId, input.entity);
    if (input.appliesTo?.length) {
      const scope = scopeFor(deps.store, ctx.workspaceId);
      for (const ws of input.appliesTo) if (!inTree(scope, ws)) throw notFound('workspace', ws);
    }
  } catch (e) {
    if (e instanceof KnowledgeNotFoundError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, value: undefined };
}

/** Capture metadata of a save by this run (agent run, task, research run, entity). */
export function captureMeta(deps: Deps, ctx: RunContext, extras: ArtifactSaveExtras) {
  const task = ctx.taskId ? deps.store.tasks.get(ctx.taskId) : undefined;
  const meta: { agentRunId: string; taskId?: string; runId?: string; description?: string; entityId?: string } = {
    agentRunId: ctx.agentRunId,
  };
  if (task && task.workspaceId === ctx.workspaceId) {
    meta.taskId = task.id;
    meta.runId = task.runId;
  }
  if (extras.description?.trim()) meta.description = extras.description;
  if (extras.entity !== undefined) meta.entityId = resolveArtifactEntity(deps.store, ctx, extras.entity).id;
  return meta;
}

/**
 * After the bytes are stored: `applies_to` labels (+ Decision via `logJudgment`), then extraction
 * (inline when small, else queued). Returns the tool's response data.
 */
export async function finishArtifactSave(
  deps: Deps,
  ctx: RunContext,
  saved: CaptureResult,
  extras: ArtifactSaveExtras,
  logJudgment: (payload: Record<string, unknown>, refs: string[]) => void,
): Promise<{ artifactId: string; sha256: string; captureId: string; extraction: ExtractionSummary }> {
  const { store } = deps;
  const id = saved.artifact.id;
  if (extras.appliesTo?.length) {
    const ids = [...new Set(extras.appliesTo)];
    store.transaction(() => {
      if (saved.created) setItemScopes(store, 'artifact', id, ids, 'agent');
      else for (const ws of ids) knowledgeRepos(store).itemScopes.insertIgnore({ itemKind: 'artifact', itemId: id, workspaceId: ws, source: 'agent' });
      logJudgment({ tool: 'save_artifact', artifactId: id, appliesTo: ids }, [id]);
    });
  }
  const extraction = await ingestorFor(deps).submit(id);
  return { artifactId: id, sha256: saved.artifact.sha256, captureId: saved.captureId, extraction };
}

/** `describe_artifact` (design §9). */
export function describeArtifact(
  deps: Deps,
  ctx: RunContext,
  input: { artifact_id: string; description: string },
): Outcome<{ artifactId: string; description: string; uploadDerived: boolean }> {
  const { store, artifacts } = deps;
  const art = store.artifacts.get(input.artifact_id);
  if (!art || !sameTree(store, ctx.workspaceId, art.workspaceId)) return { ok: false, error: notFound('artifact', input.artifact_id).message };
  const { captions } = knowledgeSettings(deps.config);
  const text = input.description.trim();
  if (text.length < captions.minChars) {
    return { ok: false, error: `description must be at least ${captions.minChars} characters (got ${text.length})` };
  }
  const savedByCaller = knowledgeRepos(store).artifactCaptures.list({ artifactId: art.id, agentRunId: ctx.agentRunId }).length > 0;
  if (art.description && !savedByCaller) {
    return { ok: false, error: `artifact '${art.id}' already has a description; only the run that saved it may replace it` };
  }
  const updated = artifacts.setDescription(art.id, text);
  return { ok: true, value: { artifactId: art.id, description: updated.description ?? '', uploadDerived: updated.uploadDerived === true } };
}
