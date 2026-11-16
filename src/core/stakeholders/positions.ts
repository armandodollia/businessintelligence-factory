/**
 * Stakeholder positions (design 2026-11-15-stakeholder-positions-design.md §4–§6): people leave, move,
 * are promoted or demoted, and come back. The user records it; nothing here is decided by a model.
 *
 * - `markLeft`: an own stakeholder left the company, for a competitor of the tree (existing, or created
 *   here by name) or for somewhere else (parked, `subjectKind: 'former'`). What was known becomes the
 *   internal layer (`internalProfile`, every profile field `basis: 'internal'`). For someone who left
 *   already the same action records that they moved on to another company (a parked one is given a
 *   competitor, one at a competitor goes to another or elsewhere), keeping the leaving date and both layers.
 * - `changePosition`: an own stakeholder that has not left moved to another node of the tree, or was
 *   promoted or demoted (with or without a move).
 * - `markReturned`: a former colleague is an own stakeholder of a node again; the layers are cleared
 *   and `profile` stays as the working profile.
 *
 * Every action is one transaction: the `joined` baseline row when the persona has no history yet, the
 * history row, the persona (version + 1), one `stakeholder_position_change` feedback event holding ids,
 * enums and the date (the cleaned note is its reason) and, last, its agent.md: a failed insert leaves no
 * rewritten file, and a failed write rolls everything back. Refusals are `StakeholderError`s and change
 * nothing: 404 for an unknown persona, node or competitor or one of another tree (the same answer for
 * both), 409 for a stakeholder whose research is not finished or was not usable (`isOutputUsable`), a
 * hidden stakeholder or a slug another persona of the node uses, 400 for everything else.
 *
 * `holdsInternal` (`kinds.ts`, re-exported here with `isFormerColleague` and `isParked`) is the one test
 * for "this persona's text is internal" (§6): runs that carry such a persona's agent.md, learning prompt
 * or layers are offline.
 */
import { recordFeedback } from '../feedback/events.js';
import { cleanReason, FlowFeedbackError } from '../flows/feedback.js';
import { linkCompetitor } from '../knowledge/entityLinks.js';
import { findCompetitor } from '../market/competitors.js';
import { agentMdPath, writeAgentMd } from '../market/personas.js';
import { isOutputUsable } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Competitor, CompetitorComparison, LeftFrom, Persona, PersonaProfileField, Workspace } from '../types.js';
import { rootOf, sameTree, scopeOf } from '../workspace/tree.js';
import { holdsInternal, isFormerColleague, isParked } from './kinds.js';
import { competitorSlug, formerColleagues, isCurrentOwn, isHidden, LABEL_MAX, oneLine, stakeholderSlug, wentTo } from './personas.js';
import { ownStakeholder, StakeholderError } from './statements.js';
import { stakeholderRepos } from './store.js';
import { STAKEHOLDER_TYPES, type StakeholderPosition, type StakeholderType } from './types.js';

/** Longest title (characters, after `oneLine`): the cap of the relation, which a former colleague's title becomes. */
export const TITLE_MAX = 300;

// The predicates live in a module without imports (`kinds.ts`), so the agent.md compiler and the
// knowledge read paths can use them too; this is where the rest of the code finds them.
export { holdsInternal, isFormerColleague, isParked };

// `formerColleagues` is defined where the follow section of the work prompt needs it (`personas.ts`).
export { formerColleagues };

/** The persona's position history, newest first (the `joined` baseline last). */
export function positionsOf(store: Store, personaId: string): StakeholderPosition[] {
  return stakeholderRepos(store).positions.list({ personaId }).reverse();
}

export type PositionDeps = { store: Store; dataDir: string };

export type LeftInput = {
  /** YYYY-MM-DD, not in the future. */
  date: string;
  to: { competitorId: string } | { newCompetitor: { name: string; site?: string } } | { elsewhere: { companyName?: string } };
  /** A new label, for example the person's name when the persona was labelled by role. */
  label?: string;
  /** Title at the new company. */
  title?: string;
  note?: string;
};
export type ChangeInput = {
  change: 'moved' | 'promoted' | 'demoted';
  date: string;
  /** Required for `moved`: another node of the tree. */
  toWorkspaceId?: string;
  stakeholderType?: StakeholderType;
  title?: string;
  note?: string;
};
export type ReturnInput = {
  date: string;
  toWorkspaceId: string;
  /** A new label, as on leaving: the way out when the slug of the stored one is in use at the node. */
  label?: string;
  stakeholderType?: StakeholderType;
  title?: string;
  note?: string;
};

// ---------------------------------------------------------------------------
// input

const refuse = (message: string, status: 400 | 404 | 409 = 400): never => {
  throw new StakeholderError(message, status);
};

const given = (v: unknown): boolean => v !== undefined && v !== null;

const pad = (n: number) => String(n).padStart(2, '0');

/** Today's date on this machine (the user's own calendar day), as YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A day of the calendar as YYYY-MM-DD, not after today. */
function dateOf(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return refuse('date must be a day as YYYY-MM-DD');
  const at = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) return refuse(`date '${value}' is not a day of the calendar`);
  if (value > today()) return refuse(`date '${value}' lies in the future`);
  return value;
}

/** An optional text on one line, at most `max` characters; `undefined` when not given or blank. */
function lineOf(name: string, value: unknown, max: number): string | undefined {
  if (!given(value)) return undefined;
  if (typeof value !== 'string') return refuse(`${name} must be a text`);
  const line = oneLine(value);
  if (line.length > max) return refuse(`${name}: at most ${max} characters`);
  return line || undefined;
}

/** A text that must hold something. */
function requiredLine(name: string, value: unknown, max: number): string {
  return lineOf(name, value, max) ?? refuse(`${name}: must contain text`);
}

/** The note as stored: cleaned like other reasons (trimmed, at most 2,000 characters, redacted, fences removed). */
function noteOf(store: Store, workspaceId: string, note: unknown): string | undefined {
  try {
    return cleanReason(store, workspaceId, given(note) ? (note as string) : undefined);
  } catch (e) {
    if (e instanceof FlowFeedbackError) return refuse(e.message.replace(/^reason/, 'note'));
    throw e;
  }
}

function typeOf(value: unknown, fallback: StakeholderType | undefined): StakeholderType | undefined {
  if (!given(value)) return fallback;
  if (!(STAKEHOLDER_TYPES as readonly unknown[]).includes(value)) return refuse(`stakeholderType must be one of ${STAKEHOLDER_TYPES.join(', ')}`);
  return value as StakeholderType;
}

type Destination = { kind: 'competitor'; competitorId: string } | { kind: 'new'; name: string; site?: string } | { kind: 'elsewhere'; companyName?: string };

const DESTINATIONS = ['competitorId', 'newCompetitor', 'elsewhere'] as const;

/** Where the person went: exactly one of a competitor's id, a new competitor by name, or elsewhere. */
function destinationOf(to: unknown): Destination {
  const o = to && typeof to === 'object' ? (to as Record<string, unknown>) : {};
  const named = DESTINATIONS.filter((k) => given(o[k]));
  if (named.length !== 1) return refuse(`to must name exactly one of ${DESTINATIONS.join(', ')}`);
  if (named[0] === 'competitorId') {
    if (typeof o.competitorId !== 'string') return refuse('to.competitorId must be a competitor id');
    return { kind: 'competitor', competitorId: o.competitorId };
  }
  const detail = o[named[0]!];
  if (typeof detail !== 'object') return refuse(`to.${named[0]} must be an object`);
  const d = detail as Record<string, unknown>;
  if (named[0] === 'newCompetitor') {
    const site = lineOf('to.newCompetitor.site', d.site, TITLE_MAX);
    return { kind: 'new', name: requiredLine('to.newCompetitor.name', d.name, LABEL_MAX), ...(site ? { site } : {}) };
  }
  const companyName = lineOf('to.elsewhere.companyName', d.companyName, LABEL_MAX);
  return { kind: 'elsewhere', ...(companyName ? { companyName } : {}) };
}

// ---------------------------------------------------------------------------
// lookups (every id is checked against the persona's business tree)

/**
 * The stakeholder persona of the caller's tree (404), which must be open (409: its question round comes
 * first) and usable (409: its research is still pending, failed, was superseded or left out). Hidden is
 * asked first, so the answer for a hidden stakeholder says nothing about the state of its research.
 */
function openStakeholder(store: Store, workspaceId: string, personaId: unknown): Persona {
  const p = ownStakeholder(store, workspaceId, personaId);
  if (isHidden(p)) return refuse(`stakeholder '${p.id}' is hidden: answer or skip its questions first`, 409);
  if (!isOutputUsable(p)) return refuse(`stakeholder '${p.id}': its research is not finished or was not usable`, 409);
  return p;
}

/** A node of the persona's tree; 404 (as for an unknown id) otherwise. */
function nodeOf(store: Store, persona: Persona, workspaceId: unknown): Workspace {
  const ws = typeof workspaceId === 'string' ? store.workspaces.get(workspaceId) : undefined;
  if (!ws || !sameTree(store, persona.workspaceId, ws.id)) return refuse(`workspace '${String(workspaceId)}' not found`, 404);
  return ws;
}

/** A competitor of the persona's tree that is not superseded; 404 (as for an unknown id) otherwise. */
function competitorOf(store: Store, persona: Persona, competitorId: string): Competitor {
  const c = store.competitors.get(competitorId);
  if (!c || c.status === 'superseded' || !sameTree(store, persona.workspaceId, c.workspaceId)) return refuse(`competitor '${competitorId}' not found`, 404);
  return c;
}

/**
 * The competitor of the node with that name (`save_competitor` identifies a competitor by node and
 * normalized name, so a second row of the same name is never made). A live one is used as it is. A
 * superseded one is used again, reset to what a new one is: what research once rated was withdrawn, so
 * none of it (ratings, comparison, evidence, the task that saved it) comes back with the row. Otherwise
 * it is created: threat and directness 1, an empty comparison, no evidence and status `unverified` (no
 * task will review it), so it is usable for stakeholders and visibly unresearched; linked in the
 * knowledge store like a saved competitor.
 */
function competitorByName(store: Store, workspaceId: string, input: { name: string; site?: string }): Competitor {
  const now = new Date().toISOString();
  // Nothing was compared: no area has a value until research rates it.
  const unresearched = { threat: 1, directness: 1, comparison: {} as CompetitorComparison, evidence: [], status: 'unverified' as const };
  const prior = findCompetitor(store, workspaceId, input.name);
  if (prior) {
    if (prior.status !== 'superseded') return prior;
    return store.competitors.update(prior.id, { ...unresearched, taskId: undefined, taskRound: undefined, updatedAt: now });
  }
  const competitor: Competitor = { id: newId('cmp'), workspaceId, name: input.name, ...unresearched, createdAt: now, updatedAt: now, ...(input.site ? { site: input.site } : {}) };
  store.competitors.insert(competitor);
  linkCompetitor(store, competitor);
  return store.competitors.get(competitor.id)!;
}

/** 409 when another persona of `workspaceId` already has `slug` (personas are unique by node and slug). */
function refuseSlugInUse(store: Store, persona: Persona, workspaceId: string, slug: string, wayOut: string): void {
  const other = store.personas.list({ workspaceId, slug }).find((p) => p.id !== persona.id);
  if (other) refuse(`slug '${slug}' already names '${oneLine(other.segment)}' at that node: ${wayOut}`, 409);
}

// ---------------------------------------------------------------------------
// the record of a change

/** A place in the history: where, as what. */
type Place = Pick<StakeholderPosition, 'placeKind' | 'workspaceId' | 'competitorId' | 'companyName' | 'stakeholderType' | 'title' | 'relation'>;

/** Where the persona is now (the `joined` baseline of a persona without history). */
function placeOf(p: Persona): Place {
  const as = { stakeholderType: p.stakeholderType, title: p.positionTitle || undefined, relation: p.relation || undefined };
  if (p.subjectKind === 'competitor') return { placeKind: 'competitor', competitorId: p.subjectId, ...as };
  if (p.subjectKind === 'former') return { placeKind: 'elsewhere', ...as };
  return { placeKind: 'node', workspaceId: p.workspaceId, ...as };
}

type Step = {
  change: Exclude<StakeholderPosition['change'], 'joined'>;
  date: string;
  note: string | undefined;
  /** Where the person is from `date` on. */
  place: Place;
  /** What changes on the persona (the version is bumped here). */
  patch: Partial<Omit<Persona, 'id'>>;
};

/**
 * Inside the caller's transaction: the baseline row when the history is empty, the row of the change,
 * the persona with version + 1, the feedback event and, as the last step, its agent.md at its (new)
 * path (as `save_stakeholder` does: nothing can fail after the file is written).
 */
function record(deps: PositionDeps, actor: string, before: Persona, step: Step): Persona {
  const { store } = deps;
  const repo = stakeholderRepos(store).positions;
  const createdAt = new Date().toISOString();
  const row = (change: StakeholderPosition['change'], place: Place, rest: Partial<StakeholderPosition> = {}): StakeholderPosition =>
    repo.insert({ id: newId('spo'), rootWorkspaceId: rootOf(store, before.workspaceId), personaId: before.id, change, ...place, actor, createdAt, ...rest });
  // The history starts with where the person was (no date).
  if (!repo.list({ personaId: before.id }).length) row('joined', placeOf(before));
  row(step.change, step.place, { effectiveOn: step.date, ...(step.note ? { note: step.note } : {}) });

  const after = store.personas.update(before.id, { ...step.patch, version: before.version + 1 });
  recordFeedback(store, {
    workspaceId: after.workspaceId,
    actor,
    kind: 'stakeholder_position_change',
    targetType: 'stakeholder',
    targetId: after.id,
    afterJson: {
      change: step.change,
      placeKind: step.place.placeKind,
      personaId: after.id,
      workspaceId: after.workspaceId,
      ...(after.workspaceId !== before.workspaceId ? { fromWorkspaceId: before.workspaceId } : {}),
      ...(step.place.competitorId ? { competitorId: step.place.competitorId } : {}),
      date: step.date,
    },
    ...(step.note ? { reason: step.note } : {}),
  });
  writeAgentMd(store, after);
  return after;
}

// ---------------------------------------------------------------------------
// the actions

/**
 * The person left the company on `date` (§5.1), for a competitor of the tree, a competitor created here
 * by name, or somewhere else. An own stakeholder that has not left leaves: `leftAt`, `leftFrom` and the
 * internal layer are set and the history row is `left`.
 *
 * Someone who left already has moved on to another company: a parked former colleague is given a
 * competitor ("attach") or another company that is none, one at a competitor goes to another competitor
 * or elsewhere. `leftAt`, `leftFrom`, the internal layer, the public layer and the combined profile stay
 * as they are; the history row is `moved` with the new place; slug and agent.md follow the new place
 * (`stk-<competitor>-<label>` at a competitor, `stk-<label>` for one who leaves a competitor for
 * elsewhere; a parked one keeps its slug). The place the person is at already is refused (400): history
 * cannot be taken back, so a repeated request must not add a row.
 *
 * A competitor's stakeholder that never worked here cannot leave (400).
 */
export function markLeft(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: LeftInput): Persona {
  const { store, dataDir } = deps;
  const persona = openStakeholder(store, workspaceId, personaId);
  const to = destinationOf(input?.to);
  const movedOn = isFormerColleague(persona);
  if (!movedOn && !isCurrentOwn(persona)) refuse(`stakeholder '${persona.id}' is not an own stakeholder: only an own stakeholder can leave`);
  const date = dateOf(input.date);
  const label = given(input.label) ? requiredLine('label', input.label, LABEL_MAX) : persona.segment;
  const title = lineOf('title', input.title, TITLE_MAX);
  const note = noteOf(store, persona.workspaceId, input.note);

  return store.transaction(() => {
    const competitor =
      to.kind === 'competitor' ? competitorOf(store, persona, to.competitorId) : to.kind === 'new' ? competitorByName(store, persona.workspaceId, to) : undefined;
    const companyName = to.kind === 'elsewhere' ? to.companyName : undefined;
    if (movedOn) {
      const there = competitor ? persona.subjectKind === 'competitor' && persona.subjectId === competitor.id : isParked(persona) && wentTo(store, persona) === companyName;
      if (there) refuse(`stakeholder '${persona.id}' is at that company already: nothing to record`);
    }
    // At a competitor the slug names it (`stk-<competitor>-<label>`). Elsewhere: one who comes from a
    // competitor is named by its label alone again; an own or a parked persona keeps its slug.
    const slug = competitor ? stakeholderSlug(label, competitorSlug(competitor)) : persona.subjectKind === 'competitor' ? stakeholderSlug(label) : persona.slug;
    if (!slug) refuse('label: cannot derive a slug (use letters or digits)');
    refuseSlugInUse(store, persona, persona.workspaceId, slug, 'give this stakeholder another label');

    const questions = stakeholderRepos(store).questions;
    for (const q of questions.list({ personaId: persona.id, status: 'open' })) questions.update(q.id, { status: 'skipped' });

    const patch: Step['patch'] = {
      segment: label,
      slug,
      agentMdPath: agentMdPath(dataDir, persona.workspaceId, slug),
      subjectKind: competitor ? 'competitor' : 'former',
      subjectId: competitor?.id,
      // The relation described what the node needed from them: it is kept in `leftFrom`.
      relation: title ?? '',
      positionTitle: title,
    };
    if (!movedOn) {
      const ws = store.workspaces.get(persona.workspaceId);
      const leftFrom: LeftFrom = {
        workspaceId: persona.workspaceId,
        scopeName: ws ? scopeOf(ws).name : persona.workspaceId,
        stakeholderType: persona.stakeholderType ?? 'other',
        ...(persona.positionTitle ? { title: persona.positionTitle } : {}),
        ...(persona.relation ? { relation: persona.relation } : {}),
      };
      // All that is known about the person now is what the company knew from inside.
      const profile: Record<string, PersonaProfileField> = Object.fromEntries(
        Object.entries(persona.profile).map(([field, f]) => [field, { ...f, basis: 'internal' as const }]),
      );
      Object.assign(patch, { leftAt: date, leftFrom, profile, internalProfile: structuredClone(profile) });
    }
    return record(deps, actor, persona, {
      change: movedOn ? 'moved' : 'left',
      date,
      note,
      place: {
        placeKind: competitor ? 'competitor' : 'elsewhere',
        ...(competitor ? { competitorId: competitor.id } : {}),
        ...(companyName ? { companyName } : {}),
        stakeholderType: persona.stakeholderType,
        title,
      },
      patch,
    });
  });
}

/**
 * The person moved to another node of the tree, or was promoted or demoted (§5.2). `moved` needs a
 * node other than the current one; a promotion or demotion may name one. The persona's node, type and
 * title change, its agent.md path follows the node and its open questions move with it. Reads,
 * statements and learning records stay where they are. `maxOwn` at the target does not hold the user back.
 */
export function changePosition(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: ChangeInput): Persona {
  const { store, dataDir } = deps;
  const persona = openStakeholder(store, workspaceId, personaId);
  const change = input?.change;
  if (change !== 'moved' && change !== 'promoted' && change !== 'demoted') return refuse('change must be one of moved, promoted, demoted');
  if (!isCurrentOwn(persona)) {
    return refuse(`stakeholder '${persona.id}' is not an own stakeholder that still works here: only such a stakeholder can be moved or change position`);
  }
  const date = dateOf(input.date);
  const stakeholderType = typeOf(input.stakeholderType, persona.stakeholderType);
  const title = lineOf('title', input.title, TITLE_MAX);
  const note = noteOf(store, persona.workspaceId, input.note);
  const target = given(input.toWorkspaceId) ? nodeOf(store, persona, input.toWorkspaceId).id : persona.workspaceId;
  if (change === 'moved' && target === persona.workspaceId) return refuse('moved needs toWorkspaceId: another node of the tree than the current one');

  return store.transaction(() => {
    if (target !== persona.workspaceId) {
      refuseSlugInUse(store, persona, target, persona.slug, 'two personas of one node cannot share a slug');
      const questions = stakeholderRepos(store).questions;
      for (const q of questions.list({ personaId: persona.id, status: 'open' })) questions.update(q.id, { workspaceId: target });
    }
    return record(deps, actor, persona, {
      change,
      date,
      note,
      place: { placeKind: 'node', workspaceId: target, stakeholderType, title: title ?? (persona.positionTitle || undefined), relation: persona.relation || undefined },
      patch: {
        workspaceId: target,
        agentMdPath: agentMdPath(dataDir, target, persona.slug),
        stakeholderType,
        ...(title !== undefined ? { positionTitle: title } : {}),
      },
    });
  });
}

/**
 * A former colleague (at a competitor or parked) works here again (§5.3): an own stakeholder of the
 * node `toWorkspaceId`, open, under the slug `stk-<label>`. A `label` renames the person, under the rules
 * of a label on leaving (one line, at most `LABEL_MAX` characters); without one the stored label stays.
 * When another persona of the node has that slug (409), another label is the way out. The leaving date,
 * the position held then and both layers are cleared; `profile` (the combined profile) stays as the
 * working profile, with its basis marks. The relation becomes the title or empty, as when leaving: what
 * the node needs from the person now is for the user or research to say.
 */
export function markReturned(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: ReturnInput): Persona {
  const { store, dataDir } = deps;
  const persona = openStakeholder(store, workspaceId, personaId);
  if (!isFormerColleague(persona)) return refuse(`stakeholder '${persona.id}' has not left: only a former colleague can return`);
  const date = dateOf(input?.date);
  const stakeholderType = typeOf(input.stakeholderType, persona.stakeholderType);
  const title = lineOf('title', input.title, TITLE_MAX);
  const note = noteOf(store, persona.workspaceId, input.note);
  if (!given(input.toWorkspaceId)) return refuse('toWorkspaceId is required: the node the person returns to');
  const target = nodeOf(store, persona, input.toWorkspaceId).id;
  const label = given(input.label) ? requiredLine('label', input.label, LABEL_MAX) : persona.segment;
  const slug = stakeholderSlug(label);
  if (!slug) return refuse('label: cannot derive a slug (use letters or digits)');

  return store.transaction(() => {
    refuseSlugInUse(store, persona, target, slug, 'give this stakeholder another label');
    return record(deps, actor, persona, {
      change: 'returned',
      date,
      note,
      place: { placeKind: 'node', workspaceId: target, stakeholderType, title },
      patch: {
        workspaceId: target,
        segment: label,
        slug,
        agentMdPath: agentMdPath(dataDir, target, slug),
        subjectKind: 'own',
        subjectId: undefined,
        disclosure: 'open',
        stakeholderType,
        positionTitle: title,
        relation: title ?? '',
        // No former colleague any more: the leaving date, the position held then and both layers go.
        leftAt: undefined,
        leftFrom: undefined,
        internalProfile: undefined,
        publicProfile: undefined,
        publicTaskId: undefined,
        publicSavedAt: undefined,
        combinedAt: undefined,
        publicPosition: undefined,
      },
    });
  });
}
