/**
 * Flow records and flow ranking routes (design 2026-11-14-flow-records-and-ranking-design.md §10.4,
 * §10.5, §11, §12.2, §14): the Flows page's API, under `/api/workspaces/:id/flows/…` where `:id` is
 * the caller's node.
 *
 * - Reads: the flow types with their flow counts and the proposals waiting on the user; the node's
 *   ranking of one type; the active checklists of a type; one flow with everything behind its
 *   position; two flows side by side.
 *   Rankings are computed on read (`nodeRanking`); a read first marks the rulings whose flows have a
 *   new version (`refreshOverrides`), so the page asks the user at once.
 * - Writes: every action goes through `core/flows/feedback.ts` and records one feedback event; the
 *   actor is `actorOf(config)`, never the request body. A reason is optional, at most 2,000 characters.
 * - Isolation: an id of another business tree answers exactly like an unknown one (404).
 * - Persona verdicts are always served with `simulated: true`. Step text, notes and review quotes are
 *   served as stored (redacted) plain data for the browser; nothing here is shown to an agent.
 * - Every ruling is served with `winnerName` / `loserName` ("subject — variant" of its two flows).
 * - Whether a flow is its subject's main way through is served as `primary` (`isPrimaryVariant`, the
 *   rankings' rule), never read from the stored flag by the page.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import type { ArtifactStore } from '../core/evidence/artifacts.js';
import { actorOf } from '../core/feedback/events.js';
import { activeChecklists, CHECK_QUESTION_MAX, FlowCatalogError, listFlowTypes, MAX_CHECKLIST_ITEMS } from '../core/flows/catalog.js';
import { CHECK_ANSWERS } from '../core/flows/checks.js';
import { flowsSettings } from '../core/flows/config.js';
import {
  FlowFeedbackError,
  REASON_MAX,
  confirmOverride,
  correctAttributionAs,
  correctCheckAs,
  decideChecklistAs,
  decideFlowTypeAs,
  editChecklistAs,
  overridePair,
  ownFlow,
  ownFlowType,
  ownOverride,
  ownVerdict,
  reactToPosition,
  reactToVerdict,
  refreshOverrides,
  revokeOverride,
} from '../core/flows/feedback.js';
import { currentOfLineage, flowSteps, FlowInputError, isPrimaryVariant, rankableFlows } from '../core/flows/flows.js';
import { explainPosition, nodeRanking, usablePersonaIds } from '../core/flows/rankings.js';
import { flowRepos } from '../core/flows/repos.js';
import { mentionCounts } from '../core/flows/reviews.js';
import type { CheckAnswer, Flow, FlowOverride, FlowVerdict } from '../core/flows/types.js';
import { liveVerdicts } from '../core/flows/verdicts.js';
import { itemIsUploadDerived } from '../core/knowledge/provenance.js';
import type { Store } from '../core/store/db.js';
import { knowledgeRepos } from '../core/store/repos.js';
import type { Workspace } from '../core/types.js';
import { rootOf } from '../core/workspace/tree.js';
import { isHidden } from '../core/stakeholders/personas.js';

export type FlowRouteDeps = { store: Store; config: BifConfig; artifacts: ArtifactStore };

class BadRequest extends Error {}

const reason = z.string().max(REASON_MAX, `reason is at most ${REASON_MAX.toLocaleString('en-US')} characters`).optional();
const reaction = z.enum(['agree', 'disagree']);
const schemas = {
  position: z.object({ flowTypeId: z.string().min(1), reaction, reason }),
  verdict: z.object({ reaction, reason }),
  override: z.object({ flowTypeId: z.string().min(1), winnerFlowId: z.string().min(1), loserFlowId: z.string().min(1), reason }),
  reasonOnly: z.object({ reason }),
  confirm: z.object({ keep: z.boolean(), reason }),
  check: z.object({
    checklistId: z.string().min(1),
    itemKey: z.string().min(1),
    answer: z.enum(CHECK_ANSWERS as [CheckAnswer, ...CheckAnswer[]]),
    note: z.string().max(2000).optional(),
    reason,
  }),
  typeDecision: z.discriminatedUnion('action', [
    z.object({ action: z.literal('accept'), reason }),
    z.object({ action: z.literal('reject'), reason }),
    z.object({ action: z.literal('merge'), intoId: z.string().min(1), reason }),
    z.object({ action: z.literal('edit'), name: z.string().max(200).optional(), definition: z.string().max(1000).optional(), reason }),
  ]),
  checklistDecision: z.discriminatedUnion('action', [
    z.object({ action: z.literal('accept'), coverage: z.number().min(0).max(1).optional(), reason }),
    z.object({ action: z.literal('reject'), reason }),
  ]),
  attribution: z.object({ flowTypeKey: z.string().min(1).optional(), checkKey: z.string().min(1).optional(), reason }),
  // Item edits are loose objects: a field this editor does not take (kind, pass rule) reaches the core,
  // which refuses it with a message saying so.
  checklistEdit: z.object({
    coverage: z.number().min(0).max(1).optional(),
    items: z
      .array(
        z.looseObject({
          key: z.string().min(1),
          question: z.string().max(CHECK_QUESTION_MAX).optional(),
          weight: z.number().optional(),
          remove: z.boolean().optional(),
        }),
      )
      .max(MAX_CHECKLIST_ITEMS),
    reason,
  }),
};

const issuesText = (error: z.ZodError) => error.issues.map((i) => `${i.path.map(String).join('.') || '<body>'}: ${i.message}`).join('; ');

async function body<T extends z.ZodType>(c: Context, schema: T, opts: { optional?: boolean } = {}): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' && opts.optional ? {} : JSON.parse(text);
  } catch {
    throw new BadRequest('request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new BadRequest(issuesText(r.error));
  return r.data;
}

/** Mounts the flow routes. Call before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404. */
export function mountFlowRoutes(app: Hono, deps: FlowRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;
  const base = '/api/workspaces/:id/flows';
  const r = flowRepos(store);
  const entities = knowledgeRepos(store).entities;

  const wrap =
    (fn: (c: Context, ws: Workspace) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      const ws = workspace(c.req.param('id')!);
      try {
        return await fn(c, ws);
      } catch (e) {
        if (e instanceof BadRequest || e instanceof FlowInputError) return c.json({ error: e.message }, 400);
        if (e instanceof FlowFeedbackError || e instanceof FlowCatalogError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };

  const subjectOf = (f: Flow) => {
    const e = entities.get(f.subjectEntityId);
    return { id: f.subjectEntityId, name: e?.name ?? f.subjectEntityId };
  };
  const personaOf = (id: string) => {
    const p = store.personas.get(id);
    if (!p) return { id };
    // A hidden stakeholder (stakeholder design §7): id, label and type only.
    if (isHidden(p)) return { id: p.id, label: p.segment, stakeholderType: p.stakeholderType ?? 'other', disclosure: 'hidden' as const };
    return { id: p.id, slug: p.slug, segment: p.segment, version: p.version };
  };
  const servedVerdict = (v: FlowVerdict) => ({ ...v, simulated: true as const, persona: personaOf(v.personaId) });
  /** "Subject — variant" of a stored flow id; when the row is gone, of the current flow of the lineage that id started. */
  const flowName = (wsId: string, id: string) => {
    const f =
      r.flows.get(id) ??
      r.flows.list({ rootWorkspaceId: rootOf(store, wsId), lineageId: id, lifecycle: 'current' }).find((x) => x.status !== 'superseded');
    if (!f) return 'a flow that is no longer found';
    const subject = subjectOf(f).name;
    return f.variant ? `${subject} — ${f.variant}` : subject;
  };
  /** A ruling with the names of its two flows, so the page needs no lookup per ruling. */
  const servedOverride = (wsId: string, o: FlowOverride) => ({ ...o, winnerName: flowName(wsId, o.winnerFlowId), loserName: flowName(wsId, o.loserFlowId) });
  const nonRevokedOverrides = (wsId: string, flowTypeId: string) => r.flowOverrides.list({ workspaceId: wsId, flowTypeId }).filter((o) => !o.revokedAt);
  const actor = () => actorOf(config);

  // --- reads (static paths before `/:flowId`) --------------------------------------------------

  /** The node's flow types (active and proposed) with their flow counts, and the proposals waiting on the user. */
  app.get(
    `${base}/types`,
    wrap((c, ws) => {
      const types = listFlowTypes(store, ws.id).filter((t) => t.status === 'active' || t.status === 'proposed');
      return c.json({
        flowTypes: types.map((t) => ({
          ...t,
          flowCount: rankableFlows(store, ws.id, t.id).length,
          variantCount: rankableFlows(store, ws.id, t.id, { allVariants: true }).length,
        })),
        proposals: {
          flowTypes: types.filter((t) => t.status === 'proposed'),
          checklists: r.checklists.list({ rootWorkspaceId: rootOf(store, ws.id), status: 'proposed' }),
        },
      });
    }),
  );

  /**
   * The node's ranking of one type; `?persona=` ranks on one persona's verdicts, `?variants=all` adds
   * the other variants. A proposed type answers `isRanked: false` with its flows listed unranked.
   */
  app.get(
    `${base}/rankings/:flowTypeId`,
    wrap((c, ws) => {
      const type = ownFlowType(store, ws.id, c.req.param('flowTypeId')!);
      const variants = c.req.query('variants');
      if (variants !== undefined && variants !== '' && variants !== 'all') throw new BadRequest('variants must be "all"');
      const personaId = c.req.query('persona') || undefined;
      const asked = personaId !== undefined ? store.personas.get(personaId) : undefined;
      // A user persona judges no flows (user persona design §5): it answers like an unknown id.
      if (personaId !== undefined && (asked?.workspaceId !== ws.id || asked.kind === 'user')) {
        return c.json({ error: `persona '${personaId}' not found` }, 404);
      }
      refreshOverrides(store, ws.id);
      const ranking = nodeRanking(store, config, ws.id, type.id, { ...(personaId ? { personaId } : {}), allVariants: variants === 'all' });
      return c.json({
        ...ranking,
        ranked: ranking.ranked.map((f) => ({ ...f, subject: subjectOf(f.flow) })),
        overrides: nonRevokedOverrides(ws.id, type.id).map((o) => servedOverride(ws.id, o)),
        personas: [...usablePersonaIds(store, ws.id)].map(personaOf),
      });
    }),
  );

  /**
   * The active checklists for a flow type (`?flowTypeId=`; without it, the general one only): each with
   * its items (question, kind, scored or not, weight), coverage, version and origin.
   */
  app.get(
    `${base}/checklists`,
    wrap((c, ws) => {
      const flowTypeId = c.req.query('flowTypeId') || undefined;
      if (flowTypeId === undefined) return c.json({ general: activeChecklists(store, ws.id).general });
      const type = ownFlowType(store, ws.id, flowTypeId);
      const { general, specific } = activeChecklists(store, ws.id, type.id);
      return c.json(specific ? { general, specific } : { general });
    }),
  );

  /** Two flows of one type side by side: steps, the live verdicts on the pair, and the node's rulings on it. */
  app.get(
    `${base}/compare`,
    wrap((c, ws) => {
      const aId = c.req.query('a');
      const bId = c.req.query('b');
      if (!aId || !bId) throw new BadRequest('give two flow ids: ?a=…&b=…');
      const a = ownFlow(store, ws.id, aId);
      const b = ownFlow(store, ws.id, bId);
      if (a.flowTypeId !== b.flowTypeId) throw new BadRequest('the two flows must be of the same flow type');
      if (a.id === b.id) throw new BadRequest('give two different flows');
      const side = (f: Flow) => ({ flow: f, subject: subjectOf(f), primary: isPrimaryVariant(store, f), partial: !f.reachedGoal, steps: flowSteps(store, f.id) });
      const lineages = new Set([a.lineageId, b.lineageId]);
      const lineageOf = (id: string) => r.flows.get(id)?.lineageId;
      return c.json({
        flowType: r.flowTypes.get(a.flowTypeId),
        a: side(a),
        b: side(b),
        verdicts: liveVerdicts(store, ws.id, a.flowTypeId)
          .filter((v) => (v.flowAId === a.id && v.flowBId === b.id) || (v.flowAId === b.id && v.flowBId === a.id))
          .map(servedVerdict),
        overrides: nonRevokedOverrides(ws.id, a.flowTypeId).filter((o) => {
          const w = lineageOf(o.winnerFlowId);
          const l = lineageOf(o.loserFlowId);
          return w !== undefined && l !== undefined && w !== l && lineages.has(w) && lineages.has(l);
        }).map((o) => servedOverride(ws.id, o)),
      });
    }),
  );

  /**
   * One flow and everything behind its position (spec §10.5): steps (with their screenshot artifact
   * ids), checks, review mentions (counted or not), the persona verdicts (simulated; `counted` when
   * the opponent is in the ranking the flow's persona score comes from), the rulings, both scores,
   * coverage, and whether the flow rests on uploaded material.
   */
  app.get(
    `${base}/:flowId`,
    wrap((c, ws) => {
      const flow = ownFlow(store, ws.id, c.req.param('flowId')!);
      refreshOverrides(store, ws.id);
      const why = explainPosition(store, config, ws.id, flow.id);
      const primary = isPrimaryVariant(store, flow);
      const ranking = nodeRanking(store, config, ws.id, flow.flowTypeId, { allVariants: !primary });
      const ranked = new Set(ranking.isRanked ? ranking.ranked.map((f) => f.flowId) : []);
      const settings = flowsSettings(config);
      const now = new Date();
      const opponent = (id: string) => {
        const f = r.flows.get(id);
        return f ? { id: f.id, name: f.name, variant: f.variant, subject: subjectOf(f) } : { id };
      };
      return c.json({
        flow,
        subject: subjectOf(flow),
        primary,
        partial: !flow.reachedGoal,
        upload: itemIsUploadDerived(store, flow.id),
        current: currentOfLineage(store, flow.id)?.id === flow.id,
        steps: flowSteps(store, flow.id),
        ...why,
        overrides: why.overrides.map((o) => servedOverride(ws.id, o)),
        mentions: why.mentions.map((m) => ({ ...m, counted: mentionCounts(m, settings, now) })),
        verdicts: why.verdicts.map((v) => ({
          ...servedVerdict(v),
          opponent: opponent(v.opponentId),
          counted: ranked.has(flow.id) && ranked.has(v.opponentId),
        })),
      });
    }),
  );

  // --- reactions --------------------------------------------------------------------------------

  /** Agree / disagree with a verdict (static `verdicts/` path, before the `/:flowId/…` routes). */
  app.post(
    `${base}/verdicts/:verdictId/reaction`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.verdict);
      const v = ownVerdict(store, ws.id, c.req.param('verdictId')!);
      return c.json(reactToVerdict(store, actor(), v.id, input.reaction, input.reason));
    }),
  );

  /** Agree / disagree with a flow's position in the node's ranking. */
  app.post(
    `${base}/:flowId/reaction`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.position);
      return c.json(reactToPosition(store, actor(), ws.id, c.req.param('flowId')!, input.flowTypeId, input.reaction, input.reason, config));
    }),
  );

  // --- overrides --------------------------------------------------------------------------------

  /** Rule that one flow is better than another (a hard constraint on the node's ranking). */
  app.post(
    `${base}/overrides`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.override);
      return c.json(overridePair(store, actor(), ws.id, input.flowTypeId, input.winnerFlowId, input.loserFlowId, input.reason), 201);
    }),
  );

  /** Revoke a ruling; the body (`{ reason? }`) is optional. */
  app.delete(
    `${base}/overrides/:overrideId`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.reasonOnly, { optional: true });
      const o = ownOverride(store, ws.id, c.req.param('overrideId')!);
      return c.json(revokeOverride(store, actor(), o.id, input.reason));
    }),
  );

  /** After a new version: keep the ruling (re-pointed at the current versions) or drop it. */
  app.post(
    `${base}/overrides/:overrideId/confirm`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.confirm);
      const o = ownOverride(store, ws.id, c.req.param('overrideId')!);
      return c.json(confirmOverride(store, actor(), o.id, input.keep, input.reason));
    }),
  );

  // --- corrections and decisions ----------------------------------------------------------------

  /** Correct a check's answer. */
  app.post(
    `${base}/:flowId/checks`,
    wrap(async (c, ws) => {
      const { reason: why, ...input } = await body(c, schemas.check);
      const check = correctCheckAs(store, actor(), ws.id, c.req.param('flowId')!, input, why);
      return c.json({ check });
    }),
  );

  /** Accept, reject, merge or edit a flow type (a reject of a type with flows is refused: 409, merge instead). */
  app.post(
    `${base}/types/:typeId/decision`,
    wrap(async (c, ws) => {
      const { reason: why, ...decision } = await body(c, schemas.typeDecision);
      return c.json(decideFlowTypeAs(store, actor(), ws.id, c.req.param('typeId')!, decision, why));
    }),
  );

  /** Accept (optionally with another coverage) or reject a checklist proposal; lists the flows needing a re-walk. */
  app.post(
    `${base}/checklists/:checklistId/decision`,
    wrap(async (c, ws) => {
      const { reason: why, ...decision } = await body(c, schemas.checklistDecision);
      return c.json(decideChecklistAs(store, actor(), ws.id, c.req.param('checklistId')!, decision, why));
    }),
  );

  /**
   * Edit an active checklist (coverage; per item its question, weight or removal): a new active version
   * of origin `user`. Answers the new checklist and the flows needing a re-walk.
   */
  app.post(
    `${base}/checklists/:checklistId/edit`,
    wrap(async (c, ws) => {
      const { reason: why, ...input } = await body(c, schemas.checklistEdit);
      return c.json(editChecklistAs(store, actor(), ws.id, { checklistId: c.req.param('checklistId')!, ...input }, why));
    }),
  );

  /** Correct a review mention's attribution (flow type and check; none = the subject only). */
  app.post(
    `${base}/mentions/:mentionId/attribution`,
    wrap(async (c, ws) => {
      const { reason: why, ...input } = await body(c, schemas.attribution);
      return c.json(correctAttributionAs(store, config, actor(), ws.id, c.req.param('mentionId')!, input, why));
    }),
  );
}
