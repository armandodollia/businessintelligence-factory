/**
 * Entity resolution on save (design §7.4; build plan KS-3): every save path calls one of these inside
 * its own transaction, so a record, its `entity_id` and its automatic edges commit together.
 *
 * - `linkFinding`: `entity` (ref) or the subject rule (`subjectEntity`), plus `relations` from the
 *   finding's entity (source: the fact).
 * - `linkCompetitor`: `competitor` entity named by the competitor; edge `competes_with` → the node's
 *   company entity (source: the competitor).
 * - `linkPersona`: `persona` entity named by the segment.
 * - `linkSymptom`: `symptom` entity (strengths: `topic`) named by the title.
 * - `linkHypothesis`: `cause` entity named by the hypothesis; edge `causes` → the symptom's entity
 *   (source: the hypothesis).
 * - `linkArtifactEntity` (KS-1's `save_artifact` / capture path): the capture's entity and, when the
 *   artifact has a flow, edge `has_flow` → a `flow` entity (source: the artifact).
 *
 * A record that already has an `entity_id` keeps it (resolved to its survivor), so a user's merge or
 * rename is never undone by a later re-save. A record of a workspace that does not exist gets no
 * entity (`undefined`).
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Competitor, Entity, Finding, Persona, RelationType, Symptom, SymptomHypothesis } from '../types.js';
import { entityNameKey, survivorOf } from './entityKeys.js';
import {
  companyEntity,
  lookupEntity,
  lookupSubjectEntity,
  resolveEntityDetailed,
  subjectEntity,
  type EntityContext,
  type EntityRef,
} from './entities.js';
import { addRelation } from './relations.js';
import { scopeFor, type KnowledgeScope } from './scope.js';

/**
 * The tree of a record's workspace; `undefined` when the workspace row does not exist (no tree, so no
 * entity — such records only occur in tests that skip creating the workspace).
 */
function treeOf(store: Store, workspaceId: string): KnowledgeScope | undefined {
  return store.workspaces.get(workspaceId) ? scopeFor(store, workspaceId) : undefined;
}

/** Run context of the saving agent (entity creation is attributed to it). */
export type LinkContext = { agentRunId?: string; now?: Date };

const ctxFor = (workspaceId: string, c: LinkContext): EntityContext => ({
  workspaceId,
  ...(c.agentRunId !== undefined ? { agentRunId: c.agentRunId } : {}),
  ...(c.now ? { now: c.now } : {}),
});

/** The survivor of a record's current entity, if it still has one. */
function current(store: Store, entityId: string | undefined): Entity | undefined {
  const e = entityId ? knowledgeRepos(store).entities.get(entityId) : undefined;
  return e && survivorOf(store, e);
}

/** A relation a finding asserts from its entity (`save_finding` `relations`). */
export type FindingRelation = { type: RelationType; to: EntityRef };

/**
 * The entity of a finding about to be inserted (or re-saved): the explicit `entity` ref when given,
 * else the finding's current entity, else the subject rule. Throws `KnowledgeNotFoundError` for an
 * id outside the tree.
 */
export function findingEntity(
  store: Store,
  finding: Pick<Finding, 'workspaceId' | 'subject' | 'entityId'>,
  ref: EntityRef | undefined,
  c: LinkContext = {},
  scope: KnowledgeScope | undefined = treeOf(store, finding.workspaceId),
): Entity | undefined {
  if (!scope) return undefined;
  const ctx = ctxFor(finding.workspaceId, c);
  if (ref) return resolveEntityDetailed(store, scope, ref, ctx).entity;
  return current(store, finding.entityId) ?? subjectEntity(store, scope, finding.subject, ctx).entity;
}

/**
 * The entity `findingEntity(…, ref)` would give a NEW finding, without writing anything (KS-2's
 * duplicate handshake decides sameness before anything is saved): its id, `null` when resolving
 * would create it (so no stored fact has it), `undefined` when the workspace has no row (no entity).
 * Throws `KnowledgeNotFoundError` for an id outside the tree, like `findingEntity`.
 */
export function peekFindingEntity(store: Store, workspaceId: string, subject: string, ref: EntityRef | undefined): string | null | undefined {
  const scope = treeOf(store, workspaceId);
  if (!scope) return undefined;
  const e = ref ? lookupEntity(store, scope, ref) : lookupSubjectEntity(store, scope, subject);
  return e ? e.id : null;
}

/** Adds the finding's `relations` (from its entity; source = the fact). The finding row must exist. */
export function linkFindingRelations(store: Store, finding: Finding, relations: readonly FindingRelation[], c: LinkContext = {}): void {
  const scope = relations.length ? treeOf(store, finding.workspaceId) : undefined;
  const from = scope && (current(store, finding.entityId) ?? findingEntity(store, finding, undefined, c, scope));
  if (!scope || !from) return;
  for (const r of relations) {
    const to = resolveEntityDetailed(store, scope, r.to, ctxFor(finding.workspaceId, c)).entity;
    addRelation(store, scope, { from: from.id, type: r.type, to: to.id, sourceKind: 'fact', sourceId: finding.id }, c.now);
  }
}

/**
 * Re-save of an existing finding (`save_finding` same task + claim): an explicit `entity`, or a
 * changed subject, re-resolves the entity; otherwise it is kept. New `relations` are added.
 */
export function relinkFinding(
  store: Store,
  prior: Finding,
  input: { subject: string; entity?: EntityRef | undefined; relations?: readonly FindingRelation[] | undefined },
  c: LinkContext = {},
): Entity | undefined {
  const subjectChanged = entityNameKey(prior.subject) !== entityNameKey(input.subject);
  const entity =
    input.entity || subjectChanged
      ? findingEntity(store, { workspaceId: prior.workspaceId, subject: input.subject }, input.entity, c)
      : findingEntity(store, prior, undefined, c);
  if (!entity) return undefined;
  if (prior.entityId !== entity.id) store.findings.update(prior.id, { entityId: entity.id });
  linkFindingRelations(store, { ...prior, entityId: entity.id }, input.relations ?? [], c);
  return entity;
}

/** Sets the competitor's entity and its `competes_with` edge to the node's company entity. */
export function linkCompetitor(store: Store, competitor: Competitor, c: LinkContext = {}): Entity | undefined {
  const scope = treeOf(store, competitor.workspaceId);
  if (!scope) return undefined;
  const ctx = ctxFor(competitor.workspaceId, c);
  const entity = current(store, competitor.entityId) ?? resolveEntityDetailed(store, scope, { kind: 'competitor', name: competitor.name }, ctx).entity;
  if (competitor.entityId !== entity.id) store.competitors.update(competitor.id, { entityId: entity.id });
  const company = companyEntity(store, scope, competitor.workspaceId, ctx);
  if (company.id !== entity.id) {
    addRelation(store, scope, { from: entity.id, type: 'competes_with', to: company.id, sourceKind: 'competitor', sourceId: competitor.id }, c.now);
  }
  return entity;
}

/** Sets the persona's entity (`persona`, named by its segment). */
export function linkPersona(store: Store, persona: Persona, c: LinkContext = {}): Entity | undefined {
  const scope = treeOf(store, persona.workspaceId);
  if (!scope) return undefined;
  const entity =
    current(store, persona.entityId) ??
    resolveEntityDetailed(store, scope, { kind: 'persona', name: persona.segment }, ctxFor(persona.workspaceId, c)).entity;
  if (persona.entityId !== entity.id) store.personas.update(persona.id, { entityId: entity.id });
  return entity;
}

/** Sets the symptom's entity (`symptom`; a strength is a `topic`), named by its title. */
export function linkSymptom(store: Store, symptom: Symptom, c: LinkContext = {}): Entity | undefined {
  const scope = treeOf(store, symptom.workspaceId);
  if (!scope) return undefined;
  const kind = symptom.kind === 'strength' ? 'topic' : 'symptom';
  const entity =
    current(store, symptom.entityId) ?? resolveEntityDetailed(store, scope, { kind, name: symptom.title }, ctxFor(symptom.workspaceId, c)).entity;
  if (symptom.entityId !== entity.id) store.symptoms.update(symptom.id, { entityId: entity.id });
  return entity;
}

/** Sets the hypothesis' `cause` entity and its `causes` edge to the symptom's entity. */
export function linkHypothesis(store: Store, hypothesis: SymptomHypothesis, c: LinkContext = {}): Entity | undefined {
  const scope = treeOf(store, hypothesis.workspaceId);
  if (!scope) return undefined;
  const entity =
    current(store, hypothesis.entityId) ??
    resolveEntityDetailed(store, scope, { kind: 'cause', name: hypothesis.hypothesis }, ctxFor(hypothesis.workspaceId, c)).entity;
  if (hypothesis.entityId !== entity.id) store.symptomHypotheses.update(hypothesis.id, { entityId: entity.id });
  const symptom = store.symptoms.get(hypothesis.symptomId);
  if (symptom) {
    const target = linkSymptom(store, symptom, c);
    if (target && target.id !== entity.id) {
      addRelation(store, scope, { from: entity.id, type: 'causes', to: target.id, sourceKind: 'hypothesis', sourceId: hypothesis.id }, c.now);
    }
  }
  return entity;
}

/**
 * Entity of an artifact capture (KS-1 calls this from `save_artifact` with the tool's `entity`, then
 * stores the id on the capture row): resolves the ref in the artifact's tree and, when the artifact
 * has a `flow`, adds `has_flow` from that entity to a `flow` entity of that name (source: the
 * artifact). `undefined` without a ref.
 */
export function linkArtifactEntity(
  store: Store,
  artifact: { id: string; workspaceId: string; flow?: string | undefined },
  ref: EntityRef | undefined,
  c: LinkContext = {},
): Entity | undefined {
  const scope = ref ? treeOf(store, artifact.workspaceId) : undefined;
  if (!ref || !scope) return undefined;
  const ctx = ctxFor(artifact.workspaceId, c);
  const entity = resolveEntityDetailed(store, scope, ref, ctx).entity;
  const flow = artifact.flow?.trim();
  if (flow) {
    const target = resolveEntityDetailed(store, scope, { kind: 'flow', name: flow }, ctx).entity;
    if (target.id !== entity.id) {
      addRelation(store, scope, { from: entity.id, type: 'has_flow', to: target.id, sourceKind: 'artifact', sourceId: artifact.id }, c.now);
    }
  }
  return entity;
}

export type EntityLinkBackfill = { hypotheses: number; competitorEdges: number };

/**
 * Startup completion of what KS-0's backfill leaves to KS-3 (idempotent, incremental): symptom
 * hypotheses without an entity get their `cause` entity and `causes` edge; competitors without a
 * `competes_with` edge get it. Rows of workspaces that no longer exist are skipped.
 */
export function backfillEntityLinks(store: Store, now: Date = new Date()): EntityLinkBackfill {
  const r: EntityLinkBackfill = { hypotheses: 0, competitorEdges: 0 };
  store.transaction(() => {
    for (const h of store.symptomHypotheses.list({ entityId: null })) {
      if (linkHypothesis(store, h, { now })) r.hypotheses++;
    }
    const bare = store.db
      .prepare(
        `SELECT c.id AS id FROM competitors c WHERE NOT EXISTS (
           SELECT 1 FROM relations r WHERE r.source_kind = 'competitor' AND r.source_id = c.id AND r.type = 'competes_with')
         ORDER BY c.rowid`,
      )
      .all() as Array<{ id: string }>;
    for (const { id } of bare) {
      const c = store.competitors.get(id)!;
      if (!entityNameKey(c.name) || !store.workspaces.get(c.workspaceId)) continue;
      linkCompetitor(store, c, { now });
      if (knowledgeRepos(store).relations.list({ sourceKind: 'competitor', sourceId: id, type: 'competes_with' }).length) r.competitorEdges++;
    }
  });
  return r;
}
