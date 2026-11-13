/**
 * Agent tools for living facts (design §7.2, §7.3, §9; build plan KS-2): the knowledge-store part of
 * `save_finding` (relation, duplicate handshake, `applies_to`, `evidence_refs` with verified quotes,
 * `ttl_days`) and the new `confirm_finding` / `retract_finding`. The dispatcher
 * (`harness/tools/handlers.ts`) validates input and the role, keeps the same-(task, claim) replay
 * rule first, and calls these.
 *
 * Every judgment records a Decision with refs (design §13): the save (`score`, as before, with the
 * relation chosen and `applies_to` in its payload), a confirmation / retraction (`score`, payload
 * tool `confirm_finding` / `retract_finding` even when it came through `save_finding`, so the
 * fact's save decision stays the one `outputSaveDecision` finds), and each duplicate handshake
 * (`decision`, event `duplicate_handshake`, refs = the candidates shown). The candidates shown are a
 * read: a `retrieval_events` row (tool `save_finding`) lists every fact whose text was returned.
 */
import type { BifConfig } from '../config/schema.js';
import type { EventBus } from '../events.js';
import type { ArtifactStore } from '../evidence/artifacts.js';
import type { RunContext } from '../harness/tokens.js';
import type { ToolResult } from '../harness/tools/handlers.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { Decision, FindingEvidence, Finding, Task, TextChunk } from '../types.js';
import { estimateTokens } from './budget.js';
import { knowledgeSettings } from './config.js';
import { blocksText, extract } from './extract/index.js';
import { normalizeText } from './extract/normalize.js';
import {
  addObservation,
  factScope,
  findCandidates,
  nextVersion,
  type FactCandidate,
} from './facts.js';
import { recordRetrieval } from './retrievalLog.js';
import { inTree, notFound, setItemScopes, type KnowledgeScope } from './scope.js';
import { redactServed } from './trust.js';

export type FactToolEnv = {
  store: Store;
  artifacts: ArtifactStore;
  config: BifConfig;
  events?: EventBus;
  /** The dispatcher's Decision writer (redacts identity secrets, stamps run and prompt version). */
  recordDecision: (ctx: RunContext, kind: Decision['kind'], payload: unknown, refs: string[]) => Decision;
  /**
   * KS-1 seam: extract and index an artifact whose `artifact_texts` row is still `pending`
   * (`ingestArtifact`). Without it, a pending artifact is extracted in memory for the quote check
   * only (nothing stored).
   */
  ensureExtracted?: (artifactId: string) => Promise<void>;
};

const fail = (error: string): ToolResult => ({ ok: false, error });
const ok = (data: unknown): ToolResult => ({ ok: true, data });

function emitDecision(env: FactToolEnv, ctx: RunContext, d: Decision): void {
  env.events?.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: d });
}

// ---------------------------------------------------------------------------
// evidence captured by the task (design §7.3)

/**
 * Artifacts among `ids` captured by the task: a capture row (`artifact_captures`, written per save by
 * KS-1) with the task's id or one of its agent runs. Confirmations and retractions must cite ≥ 1.
 */
export function capturedByTask(store: Store, task: Pick<Task, 'id'>, ids: string[]): string[] {
  const runs = new Set(store.agentRuns.list({ taskId: task.id }).map((r) => r.id));
  const captures = knowledgeRepos(store).artifactCaptures;
  return [...new Set(ids)].filter((id) =>
    captures.list({ artifactId: id }).some((c) => c.taskId === task.id || (c.agentRunId !== undefined && runs.has(c.agentRunId))),
  );
}

// ---------------------------------------------------------------------------
// evidence_refs and quotes (design §7.3)

export const NO_TEXT_ERROR = 'artifact has no extracted text; cite without a quote';

type ArtifactTextView = { text: string; chunks: TextChunk[] };

/** Whitespace-insensitive form used for the quote match. */
const squash = (s: string) => normalizeText(s).replace(/\s+/g, ' ').trim();

/**
 * The extracted text of an artifact: its chunks (or its canonical's, for a text duplicate). A
 * `pending` artifact is extracted first (`ensureExtracted`, KS-1), else in memory with the KS-1a
 * library (nothing stored). `undefined` when there is no text (image, unsupported, empty, failed).
 */
async function artifactText(env: FactToolEnv, artifactId: string): Promise<ArtifactTextView | undefined> {
  const k = knowledgeRepos(env.store);
  const load = () => {
    const row = k.artifactTexts.get(artifactId);
    const chunks = k.chunks.list({ artifactId: row?.duplicateOf ?? artifactId }).sort((a, b) => a.seq - b.seq);
    return { row, chunks };
  };
  let { row, chunks } = load();
  if (!chunks.length && (!row || row.status === 'pending') && env.ensureExtracted) {
    await env.ensureExtracted(artifactId);
    ({ row, chunks } = load());
  }
  if (chunks.length) return { text: chunks.map((c) => c.text).join('\n\n'), chunks };
  if (row && row.status !== 'pending') return undefined;
  try {
    const { artifact, bytes } = env.artifacts.read(artifactId);
    const s = knowledgeSettings(env.config).extraction;
    const ex = await extract(new Uint8Array(bytes), artifact.mime, {
      maxTextChars: s.maxTextChars,
      xlsxMaxRows: s.xlsxMaxRows,
      ...(artifact.title ? { filename: artifact.title } : {}),
    });
    const text = (ex.status === 'ok' || ex.status === 'too_large') && ex.blocks.length ? blocksText(ex.blocks) : '';
    return text.trim() ? { text, chunks: [] } : undefined;
  } catch {
    return undefined;
  }
}

export type EvidenceRefInput = { artifact_id: string; chunk_id?: string | undefined; quote?: string | undefined };
export type VerifiedRef = Omit<FindingEvidence, 'findingId' | 'seq'>;

/**
 * Checks `evidence_refs`: each artifact is in the caller's tree, a `chunk_id` belongs to it (or to
 * its canonical text), and a `quote` occurs in its extracted text (whitespace-normalized
 * substring). The quote's chunk is re-resolved by search (the given `chunk_id` is only a hint).
 */
export async function verifyEvidenceRefs(
  env: FactToolEnv,
  workspaceId: string,
  refs: EvidenceRefInput[],
): Promise<{ ok: true; rows: VerifiedRef[] } | { ok: false; error: string }> {
  const k = knowledgeRepos(env.store);
  const rows: VerifiedRef[] = [];
  for (const ref of refs) {
    const id = ref.artifact_id;
    if (env.artifacts.exists(workspaceId, [id]).length) return { ok: false, error: `evidence_refs: artifact '${id}' not found` };
    const row: VerifiedRef = { artifactId: id };
    if (ref.chunk_id !== undefined) {
      const canonical = k.artifactTexts.get(id)?.duplicateOf ?? id;
      const chunk = k.chunks.get(ref.chunk_id);
      if (!chunk || (chunk.artifactId !== id && chunk.artifactId !== canonical)) {
        return { ok: false, error: `evidence_refs: chunk '${ref.chunk_id}' not found` };
      }
      row.chunkId = chunk.id;
    }
    const quote = ref.quote?.trim();
    if (quote) {
      const text = await artifactText(env, id);
      if (!text) return { ok: false, error: `evidence_refs: artifact '${id}': ${NO_TEXT_ERROR}` };
      const q = squash(quote);
      if (!q || !squash(text.text).includes(q)) {
        const shown = quote.length > 80 ? `${quote.slice(0, 80)}…` : quote;
        return { ok: false, error: `evidence_refs: quote not found in the extracted text of artifact '${id}' (whitespace-insensitive match): "${shown}"` };
      }
      row.quote = quote;
      const hit = text.chunks.find((c) => squash(c.text).includes(q));
      if (hit) {
        row.chunkId = hit.id;
        const at = hit.text.indexOf(quote);
        if (at >= 0) {
          row.charStart = hit.charStart + at;
          row.charEnd = row.charStart + quote.length;
        }
      } else if (!text.chunks.length) {
        const at = text.text.indexOf(quote);
        if (at >= 0) {
          row.charStart = at;
          row.charEnd = at + quote.length;
        }
      }
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// confirm / retract (design §7.2, §9)

export type ObserveOptions = { reason?: string; via?: 'save_finding' | 'handshake' };

/**
 * A confirmation or retraction of a current fact by the task (`confirm_finding`,
 * `retract_finding`, `save_finding relation: confirms`, or an exact handshake match): a pending
 * observation, applied when the task is verified. Needs a fact of the caller's tree that is current
 * and not an output of this task, and evidence with ≥ 1 artifact captured by this task. Idempotent
 * per (task, fact, kind): a repeat merges its evidence and marks it re-submitted in this round.
 */
export function observeFact(
  env: FactToolEnv,
  ctx: RunContext,
  task: Task,
  findingId: string,
  evidence: string[],
  kind: 'confirm' | 'retract',
  opts: ObserveOptions = {},
): ToolResult {
  const { store } = env;
  const scope = factScope(store, ctx.workspaceId);
  const f = store.findings.get(findingId);
  if (!f || !inTree(scope, f.workspaceId)) return fail(notFound('finding', findingId).message);
  const lifecycle = f.lifecycle ?? 'current';
  const verb = kind === 'confirm' ? 'confirmed' : 'retracted';
  if (lifecycle !== 'current') return fail(`finding '${findingId}' is ${lifecycle}; only a current fact can be ${verb}`);
  if (f.taskId === task.id && f.workspaceId === task.workspaceId) {
    return fail(`finding '${findingId}' is an output of this task; only facts from earlier work can be ${verb}`);
  }
  const missing = env.artifacts.exists(ctx.workspaceId, evidence);
  if (missing.length) return fail(`evidence references unknown artifacts (not in this workspace's business tree): ${missing.join(', ')}`);
  if (!capturedByTask(store, task, evidence).length) {
    return fail(`evidence must include at least one artifact captured by this task (save_artifact first, then cite its id) to ${kind} a fact`);
  }
  const repo = knowledgeRepos(store).factObservations;
  const relation = kind === 'confirm' ? 'confirms' : 'retracts';
  const prior = repo.list({ taskId: task.id, findingId, kind }).find((o) => o.workspaceId === ctx.workspaceId);
  if (prior) {
    if (prior.status === 'pending') {
      repo.update(prior.id, {
        evidence: [...new Set([...prior.evidence, ...evidence])],
        taskRound: task.round,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });
    }
    return ok({ findingId, observationId: prior.id, relation, duplicate: true });
  }
  const tool = kind === 'confirm' ? 'confirm_finding' : 'retract_finding';
  const { obs, d } = store.transaction(() => {
    const obs = addObservation(store, {
      workspaceId: ctx.workspaceId, finding: f, kind, task, agentRunId: ctx.agentRunId, evidence,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    const payload: Record<string, unknown> = { tool, findingId, observationId: obs.id, evidence: obs.evidence };
    if (opts.reason !== undefined) payload.reason = opts.reason;
    if (opts.via) payload.via = opts.via;
    return { obs, d: env.recordDecision(ctx, 'score', payload, [findingId, ...obs.evidence]) };
  });
  emitDecision(env, ctx, d);
  return ok({ findingId, observationId: obs.id, relation, status: 'pending', note: 'applied when this task is verified' });
}

// ---------------------------------------------------------------------------
// save_finding (after the same-(task, claim) replay rule)

export type SaveFindingInput = ToolInput<'save_finding'>;
export type SaveFindingOptions = {
  /** An entity already resolved for this fact; used for sameness and stored. */
  entityId?: string;
  /**
   * KS-3 (`save_finding` in the dispatcher): the fact's entity, resolved lazily so that only a save
   * that inserts a fact row can create one. The duplicate handshake and confirmations never write an
   * entity (an entity nothing references reads as publicly attested, design §12). Wins over
   * `entityId`.
   */
  entity?: FactEntityHooks;
};

export type FactEntityHooks = {
  /** The entity a new fact would get, without writing (`null`: it would be created; `undefined`: none). */
  peek(): string | null | undefined;
  /**
   * Resolve-or-create, inside the save transaction. `prior` = the version being replaced: without an
   * explicit entity the new version keeps the prior's (its merge survivor).
   */
  resolve(prior?: Finding): string | undefined;
  /** After the fact row is inserted (same transaction): `relations` asserted by the fact. */
  link?(finding: Finding): void;
};

/** The entity a sameness check compares against (see `CandidateQuery.entityId`). */
function candidateEntity(opts: SaveFindingOptions): string | null | undefined {
  return opts.entity ? opts.entity.peek() : opts.entityId;
}

/** The entity stored on a fact row about to be inserted (inside its transaction). */
function storedEntity(opts: SaveFindingOptions, prior?: Finding): string | undefined {
  if (opts.entity) return opts.entity.resolve(prior);
  return opts.entityId ?? prior?.entityId;
}

/**
 * `save_finding` beyond the replay rule (design §7.2, §9):
 * - `relation` omitted → duplicate handshake: an exact same-entity match among current facts of the
 *   tree is treated as `confirms` (needs evidence captured by this task, else the candidates come
 *   back); otherwise candidates above the similarity floor are returned and NOTHING is saved; else
 *   the fact is saved as `new`.
 * - `new` → a new current fact (+ a `create` observation, applied with the task).
 * - `{ confirms: id }` → no new row: a confirmation (`observeFact`).
 * - `{ replaces: id }` → a new version in the prior's lineage, lifecycle `candidate`, + a pending
 *   `replace` observation.
 */
export async function saveFindingFact(
  env: FactToolEnv,
  ctx: RunContext,
  task: Task,
  input: SaveFindingInput,
  opts: SaveFindingOptions = {},
): Promise<ToolResult> {
  const { store } = env;
  const scope = factScope(store, ctx.workspaceId);
  let refs: VerifiedRef[] = [];
  if (input.evidence_refs?.length) {
    const checked = await verifyEvidenceRefs(env, ctx.workspaceId, input.evidence_refs);
    if (!checked.ok) return fail(checked.error);
    refs = checked.rows;
  }
  const evidence = [...new Set([...input.evidence, ...refs.map((r) => r.artifactId)])];
  const appliesTo = input.applies_to ? [...new Set(input.applies_to)] : undefined;
  for (const ws of appliesTo ?? []) if (!inTree(scope, ws)) return fail(`applies_to: ${notFound('workspace', ws).message}`);

  const relation = input.relation;
  if (relation === undefined) {
    const started = performance.now();
    const settings = knowledgeSettings(env.config).dedupe;
    const entityId = candidateEntity(opts);
    const found = findCandidates(
      store, scope, { claim: input.claim, subject: input.subject, excludeTaskId: task.id, ...(entityId !== undefined ? { entityId } : {}) }, settings,
    );
    if (found.exact && capturedByTask(store, task, evidence).length) {
      logCandidates(env, ctx, input.claim, [found.exact], { autoConfirmed: true }, started);
      const r = observeFact(env, ctx, task, found.exact.id, evidence, 'confirm', { via: 'handshake' });
      return r.ok ? ok({ ...(r.data as object), autoConfirmed: true, matched: 'exact claim of a current fact' }) : r;
    }
    const shown = found.exact ? [found.exact, ...found.candidates] : found.candidates;
    if (shown.length) return handshake(env, ctx, task, input, shown, found.exact !== undefined, started);
    return saveNew(env, ctx, task, input, evidence, refs, appliesTo, opts, false);
  }
  if (relation === 'new') return saveNew(env, ctx, task, input, evidence, refs, appliesTo, opts, true);
  if ('confirms' in relation) return observeFact(env, ctx, task, relation.confirms, evidence, 'confirm', { via: 'save_finding' });
  return saveReplacement(env, ctx, task, input, relation.replaces, evidence, refs, appliesTo, opts, scope);
}

/** Candidate lines as the agent sees them (claims redacted like any served text). */
function candidateView(store: Store, ctx: RunContext, c: FactCandidate, exact: boolean): Record<string, unknown> {
  const flags: string[] = [];
  if (exact) flags.push('exact');
  if (c.status !== 'verified') flags.push('unverified');
  if (c.uploadDerived) flags.push('upload');
  return {
    id: c.id,
    claim: redactServed(store, ctx.workspaceId, c.claim),
    subject: redactServed(store, ctx.workspaceId, c.subject),
    last_confirmed: c.lastConfirmedAt ?? null,
    similarity: c.similarity,
    ...(c.workspaceId !== ctx.workspaceId ? { source_node: c.workspaceId } : {}),
    ...(flags.length ? { flags } : {}),
  };
}

function logCandidates(
  env: FactToolEnv,
  ctx: RunContext,
  claim: string,
  shown: FactCandidate[],
  response: unknown,
  started: number,
): string {
  const ev = recordRetrieval(
    { store: env.store, ...(env.events ? { events: env.events } : {}) },
    {
      workspaceId: ctx.workspaceId, agentRunId: ctx.agentRunId, role: ctx.role, model: ctx.model, promptVersion: ctx.promptVersion,
      ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    },
    {
      tool: 'save_finding',
      query: claim,
      scope: 'tree',
      results: shown.map((c) => ({ id: c.id, kind: 'fact' })),
      tokensReturned: estimateTokens(JSON.stringify(response)),
      latencyMs: performance.now() - started,
      uploadDerived: shown.some((c) => c.uploadDerived),
    },
  );
  return ev.id;
}

function handshake(
  env: FactToolEnv,
  ctx: RunContext,
  task: Task,
  input: SaveFindingInput,
  shown: FactCandidate[],
  exactFirst: boolean,
  started: number,
): ToolResult {
  const data: Record<string, unknown> = {
    saved: false,
    reason: exactFirst
      ? 'a current fact has exactly this claim; confirming it needs evidence captured by this task'
      : 'possible duplicate of current facts',
    candidates: shown.map((c, i) => candidateView(env.store, ctx, c, exactFirst && i === 0)),
    next:
      'Nothing was saved. Call save_finding again with relation {"confirms": "<id>"} if the claim is the same fact ' +
      '(cite an artifact you saved in this task), {"replaces": "<id>"} if that fact changed, or "new" if it is a different fact.',
  };
  const retrievalEventId = logCandidates(env, ctx, input.claim, shown, data, started);
  const d = env.recordDecision(
    ctx,
    'decision',
    {
      tool: 'save_finding', event: 'duplicate_handshake', claim: input.claim, subject: input.subject,
      candidates: shown.map((c) => ({ id: c.id, similarity: c.similarity })), retrievalEventId,
    },
    [task.id, ...shown.map((c) => c.id)],
  );
  emitDecision(env, ctx, d);
  return ok(data);
}

function insertRefs(store: Store, findingId: string, refs: VerifiedRef[]): void {
  const repo = knowledgeRepos(store).findingEvidence;
  refs.forEach((r, seq) => repo.insert({ findingId, seq, ...r }));
}

function baseFinding(ctx: RunContext, task: Task, input: SaveFindingInput, evidence: string[]): Finding {
  const f: Finding = {
    id: newId('fnd'),
    workspaceId: ctx.workspaceId,
    runId: task.runId,
    taskId: task.id,
    subject: input.subject,
    claim: input.claim,
    criteria: input.criteria,
    evidence,
    status: 'pending',
    createdAt: new Date().toISOString(),
    taskRound: task.round,
  };
  if (input.ttl_days !== undefined) f.ttlDays = input.ttl_days;
  return f;
}

/** `applies_to` replaces the home label only when it differs from it. */
const differsFromHome = (appliesTo: string[] | undefined, home: string) =>
  appliesTo !== undefined && !(appliesTo.length === 1 && appliesTo[0] === home);

function saveNew(
  env: FactToolEnv,
  ctx: RunContext,
  task: Task,
  input: SaveFindingInput,
  evidence: string[],
  refs: VerifiedRef[],
  appliesTo: string[] | undefined,
  opts: SaveFindingOptions,
  explicit: boolean,
): ToolResult {
  const { store } = env;
  const finding: Finding = { ...baseFinding(ctx, task, input, evidence), lifecycle: 'current' };
  const d = store.transaction(() => {
    const entityId = storedEntity(opts);
    if (entityId) finding.entityId = entityId;
    store.findings.insert(finding);
    opts.entity?.link?.(finding);
    insertRefs(store, finding.id, refs);
    addObservation(store, { workspaceId: ctx.workspaceId, finding, kind: 'create', task, agentRunId: ctx.agentRunId, evidence });
    if (differsFromHome(appliesTo, ctx.workspaceId)) setItemScopes(store, 'fact', finding.id, appliesTo!, 'agent');
    const payload: Record<string, unknown> = { tool: 'save_finding', findingId: finding.id, criteria: input.criteria };
    if (explicit) payload.relation = 'new';
    if (differsFromHome(appliesTo, ctx.workspaceId)) payload.appliesTo = appliesTo;
    if (refs.length) payload.evidenceRefs = refs.map((r) => ({ artifactId: r.artifactId, ...(r.quote ? { quoted: true } : {}) }));
    return env.recordDecision(ctx, 'score', payload, [finding.id, ...evidence]);
  });
  emitDecision(env, ctx, d);
  return ok({ findingId: finding.id, ...(finding.entityId ? { entityId: finding.entityId } : {}) });
}

function saveReplacement(
  env: FactToolEnv,
  ctx: RunContext,
  task: Task,
  input: SaveFindingInput,
  priorId: string,
  evidence: string[],
  refs: VerifiedRef[],
  appliesTo: string[] | undefined,
  opts: SaveFindingOptions,
  scope: KnowledgeScope,
): ToolResult {
  const { store } = env;
  const prior = store.findings.get(priorId);
  if (!prior || !inTree(scope, prior.workspaceId)) return fail(notFound('finding', priorId).message);
  const lifecycle = prior.lifecycle ?? 'current';
  if (lifecycle !== 'current') return fail(`finding '${priorId}' is ${lifecycle}; only the current version of a fact can be replaced`);
  if (prior.taskId === task.id && prior.workspaceId === task.workspaceId) {
    return fail(`finding '${priorId}' is an output of this task: save the corrected claim as a new finding instead`);
  }
  const lineageId = prior.lineageId ?? prior.id;
  const finding: Finding = {
    ...baseFinding(ctx, task, input, evidence),
    lineageId,
    version: nextVersion(store, lineageId),
    replacesId: prior.id,
    lifecycle: 'candidate',
  };
  if (finding.ttlDays === undefined && prior.ttlDays !== undefined) finding.ttlDays = prior.ttlDays;
  // Without applies_to, the new version keeps the nodes the prior version was labelled with.
  const scopes = knowledgeRepos(store).itemScopes.list({ itemKind: 'fact', itemId: prior.id });
  const inherited = scopes.length && !(scopes.length === 1 && scopes[0]!.workspaceId === ctx.workspaceId) ? scopes : undefined;
  const d = store.transaction(() => {
    // The prior's entity unless one is given (KS-3: resolved to its merge survivor).
    const entityId = storedEntity(opts, prior);
    if (entityId) finding.entityId = entityId;
    store.findings.insert(finding);
    opts.entity?.link?.(finding);
    insertRefs(store, finding.id, refs);
    addObservation(store, {
      workspaceId: ctx.workspaceId, finding, kind: 'replace', priorFindingId: prior.id, task, agentRunId: ctx.agentRunId, evidence,
    });
    if (differsFromHome(appliesTo, ctx.workspaceId)) setItemScopes(store, 'fact', finding.id, appliesTo!, 'agent');
    else if (!appliesTo && inherited) {
      setItemScopes(store, 'fact', finding.id, inherited.map((s) => s.workspaceId), inherited.some((s) => s.source === 'user') ? 'user' : 'agent');
    }
    const payload: Record<string, unknown> = {
      tool: 'save_finding', findingId: finding.id, criteria: input.criteria, relation: { replaces: prior.id }, version: finding.version,
    };
    if (differsFromHome(appliesTo, ctx.workspaceId)) payload.appliesTo = appliesTo;
    if (refs.length) payload.evidenceRefs = refs.map((r) => ({ artifactId: r.artifactId, ...(r.quote ? { quoted: true } : {}) }));
    return env.recordDecision(ctx, 'score', payload, [finding.id, prior.id, ...evidence]);
  });
  emitDecision(env, ctx, d);
  return ok({
    findingId: finding.id, relation: 'replaces', replaces: prior.id, version: finding.version, lifecycle: 'candidate',
    ...(finding.entityId ? { entityId: finding.entityId } : {}),
    note: 'the new version becomes current when this task is verified',
  });
}
