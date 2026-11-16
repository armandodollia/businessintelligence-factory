/**
 * Stakeholder personas: the wording and pure helpers of the Stakeholders page and of the reads on a
 * recommendation (design 2026-11-15-stakeholder-personas-design.md §7, §8, §15). `useStakeholders` and
 * `useStakeholderReads` (hooks.ts) hold the state and the user's actions; `views/Stakeholders.tsx` and
 * `views/stakeholders/*` render.
 */
import { plural } from './flows.js';
import type {
  HiddenStakeholderView,
  OpenStakeholderView,
  RealDecision,
  StakeholderPlaces,
  StakeholderPositionInput,
  StakeholderPositionsView,
  StakeholderQuestionGroup,
  StakeholderType,
  StakeholderView,
  StakeholdersView,
} from './types.js';

/** The intro of the question round (§15, exact copy). */
export const QUESTIONS_INTRO = 'The tool has drafted a picture of each of these. It will show you after you answer, so your answers are your own.';
/** Said once while the node still has hidden stakeholders. */
export const KEPT_OUT_NOTE = 'Research on these stakeholders is kept out of the activity log until you answer, skip or choose to see it.';
/** What a task, run, decision or request of withheld own-stakeholder research shows instead of its content (§7). */
export const WITHHELD_TEXT = 'Withheld until you answer the stakeholder questions';

/** Mirrors `REAL_DECISIONS` (src/core/stakeholders/types.ts). */
export const REAL_DECISIONS: readonly RealDecision[] = ['approved', 'approved_with_conditions', 'rejected', 'deferred'];

/** "approved_with_conditions" → "approved with conditions" (stances, decisions, field names). */
export const words = (key: string): string => key.replace(/_/g, ' ');

/** "Questions for you (3 stakeholders)". */
export const questionsHeading = (groups: StakeholderQuestionGroup[]): string =>
  `Questions for you (${plural(groups.filter((g) => g.persona).length, 'stakeholder')})`;

export const isHiddenView = (v: StakeholderView): v is HiddenStakeholderView => v.disclosure === 'hidden';
export const isOpenView = (v: StakeholderView): v is OpenStakeholderView => v.disclosure === 'open';

/** The answers worth sending: only questions the user typed something into (blank answers are never sent). */
export function answersToSend(groups: StakeholderQuestionGroup[], drafts: Record<string, string>): Array<{ questionId: string; text: string }> {
  const out: Array<{ questionId: string; text: string }> = [];
  for (const g of groups) {
    for (const q of g.questions) {
      const text = drafts[q.id]?.trim();
      if (text) out.push({ questionId: q.id, text });
    }
  }
  return out;
}

/**
 * Whether something served by the API is withheld research: a task, run, run-events page or request
 * with `withheld: true`, or a Decision payload `{ tool?, withheld: true }`.
 */
export const isWithheld = (x: unknown): boolean => !!x && typeof x === 'object' && (x as { withheld?: unknown }).withheld === true;

/** The payload of `GET .../stakeholders`, or null for anything not shaped like one (e.g. an older server). */
export function asStakeholdersView(data: unknown): StakeholdersView | null {
  const v = data as Partial<StakeholdersView> | null | undefined;
  return v && typeof v === 'object' && Array.isArray(v.own) && Array.isArray(v.competitors) ? (v as StakeholdersView) : null;
}

// ---------------------------------------------------------------------------
// positions: people who leave, move, are promoted or demoted, or return

/** Mirrors `STAKEHOLDER_TYPES` (src/core/stakeholders/types.ts). */
export const STAKEHOLDER_TYPES: readonly StakeholderType[] = ['leader', 'manager', 'investor', 'board', 'owner', 'team', 'system', 'regulator', 'partner', 'other'];

type PositionChange = StakeholderPositionInput['change'];

/** What the user can record, in the page's words. */
export const CHANGE_LABELS: Record<PositionChange, string> = {
  left: 'Left the company',
  moved: 'Moved to another team or division',
  promoted: 'Promoted',
  demoted: 'Demoted',
  returned: 'Returned',
};
/** What the user records for a former colleague who went on to another company. */
export const MOVED_ON_LABEL = 'Moved to another company';
/** The changes of an own stakeholder that has not left, in the order the form offers them. */
export const OWN_CHANGES: readonly Exclude<PositionChange, 'returned'>[] = ['left', 'moved', 'promoted', 'demoted'];

/** What a profile field of a former colleague rests on. */
export const BASIS_LABELS: Record<NonNullable<OpenStakeholderView['profile'][string]['basis']>, string> = {
  internal: 'from what we knew',
  public: 'from public sources',
  both: 'from both',
  inferred: 'concluded from both',
};

/** "Where to" values that are no competitor id. */
export const NOT_LISTED = 'not-listed';
export const ELSEWHERE = 'elsewhere';

const NO_PLACES: StakeholderPlaces = { competitors: [], nodes: [] };
/** The places of the tree, empty when the server sent none. */
export const placesOf = (view: StakeholdersView | null | undefined): StakeholderPlaces => view?.places ?? NO_PLACES;

/** Today on this machine as YYYY-MM-DD (the server refuses a later day). */
export function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A former colleague: a stakeholder with a leaving date (at a competitor, or parked). */
export const isFormerColleague = (v: Pick<OpenStakeholderView, 'leftAt'>): boolean => !!v.leftAt;
/** An own stakeholder that still works here: the only kind that can leave, move, or be promoted or demoted. */
export const isCurrentOwn = (v: Pick<OpenStakeholderView, 'subjectKind' | 'leftAt'>): boolean => v.subjectKind === 'own' && !v.leftAt;

/** "Former colleague, left 2026-10-31. Was Head of sales at Acme." */
export function formerLine(v: Pick<OpenStakeholderView, 'leftAt' | 'leftFrom'>): string {
  const was = v.leftFrom ? ` Was ${v.leftFrom.title || words(v.leftFrom.stakeholderType)} at ${v.leftFrom.scopeName}.` : '';
  return `Former colleague, left ${v.leftAt ?? ''}.${was}`;
}

/**
 * The "Position" line. An own stakeholder: its title (else its type) and since when (the day of the
 * last recorded change). A former colleague: the title and the company it is at now (the newest place
 * of the history that is no node of the tree), as far as known.
 */
export function positionLine(
  v: Pick<OpenStakeholderView, 'stakeholderType' | 'positionTitle' | 'leftAt'>,
  positions: StakeholderPositionsView['positions'],
): string {
  if (isFormerColleague(v)) {
    const place = positions.find((p) => p.placeKind !== 'node')?.placeName;
    const where = v.positionTitle && place ? `${v.positionTitle} at ${place}` : v.positionTitle || place;
    return `Position: ${where || 'not known'}`;
  }
  const since = positions[0]?.effectiveOn;
  return `Position: ${v.positionTitle || words(v.stakeholderType)}${since ? `, since ${since}` : ''}`;
}

/**
 * What to say under "What is public" about the stored public layer (nothing: an empty list): that it is
 * not used (the research that found it failed); that it is used although that research was not verified
 * (its review never passed); that it is newer than the combined profile.
 */
export function publicLayerNotes(
  view: Pick<StakeholderPositionsView, 'publicProfile' | 'publicLayerUsed' | 'publicLayerStatus' | 'publicSavedAt' | 'combinedAt'>,
): string[] {
  if (!view.publicProfile || view.publicLayerUsed === undefined) return [];
  if (!view.publicLayerUsed) return ['Not used: the research that found this failed'];
  return [
    ...(view.publicLayerStatus === 'unverified' ? ['Used, although the research that found this was not verified'] : []),
    ...((view.publicSavedAt ?? '') > (view.combinedAt ?? '') ? ['Not combined yet'] : []),
  ];
}

/**
 * The form of one change. `form` says which one the user opened: `change` (an own stakeholder left,
 * moved, was promoted or demoted), `movedOn` (a former colleague went on to another company: a
 * competitor, a company not listed or elsewhere) or `returned`.
 */
export interface PositionDraft {
  form: 'change' | 'movedOn' | 'returned';
  change: PositionChange;
  /** YYYY-MM-DD. */
  date: string;
  /** Left: a competitor id, `NOT_LISTED` or `ELSEWHERE`. */
  destination: string;
  companyName: string;
  site: string;
  /** Moved, promoted, demoted, returned: the node; '' stays at the current one. */
  toWorkspaceId: string;
  stakeholderType: StakeholderType;
  /** The type before the change: sent only when the user picked another. */
  currentType: StakeholderType;
  /** Left, moved on, returned: a new name for the stakeholder; '' keeps the one it has. */
  label: string;
  title: string;
  note: string;
}

/** A fresh form: today, the first competitor of the tree (else a company not listed), the stakeholder's type; a return to this node. */
export function newPositionDraft(form: PositionDraft['form'], v: Pick<OpenStakeholderView, 'stakeholderType'>, wsId: string, places: StakeholderPlaces): PositionDraft {
  return {
    form,
    change: form === 'returned' ? 'returned' : 'left',
    date: localToday(),
    destination: places.competitors[0]?.competitorId ?? NOT_LISTED,
    companyName: '',
    site: '',
    toWorkspaceId: form === 'returned' ? wsId : '',
    stakeholderType: v.stakeholderType,
    currentType: v.stakeholderType,
    label: '',
    title: '',
    note: '',
  };
}

/** The draft after the user picked what changed: a move goes to the first other node, a promotion or demotion stays. */
export function withChange(draft: PositionDraft, change: PositionChange, otherNodes: StakeholderPlaces['nodes']): PositionDraft {
  return { ...draft, change, toWorkspaceId: change === 'moved' ? (otherNodes[0]?.workspaceId ?? '') : '' };
}

/**
 * The body the form posts, or null while something it needs is missing. Blank optional texts are left
 * out. A new name is sent where the person goes to another company or returns: there its slug changes,
 * and another name is the way out when the server answers that the slug is in use (409).
 */
export function positionInput(draft: PositionDraft): StakeholderPositionInput | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return null;
  const text = <K extends string>(key: K, value: string) => (value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {});
  const { date } = draft;
  const rest = { ...text('title', draft.title), ...text('note', draft.note) };
  if (draft.change === 'left') {
    const name = draft.companyName.trim();
    let to: Extract<StakeholderPositionInput, { change: 'left' }>['to'];
    if (draft.destination === NOT_LISTED) {
      if (!name) return null;
      to = { newCompetitor: { name, ...text('site', draft.site) } };
    } else if (draft.destination === ELSEWHERE) {
      to = { elsewhere: name ? { companyName: name } : {} };
    } else if (draft.destination) {
      to = { competitorId: draft.destination };
    } else {
      return null;
    }
    return { change: 'left', date, to, ...text('label', draft.label), ...rest };
  }
  const type = draft.stakeholderType !== draft.currentType ? { stakeholderType: draft.stakeholderType } : {};
  if (draft.change === 'returned') {
    return draft.toWorkspaceId ? { change: 'returned', date, toWorkspaceId: draft.toWorkspaceId, ...text('label', draft.label), ...type, ...rest } : null;
  }
  if (draft.change === 'moved' && !draft.toWorkspaceId) return null;
  return { change: draft.change, date, ...(draft.toWorkspaceId ? { toWorkspaceId: draft.toWorkspaceId } : {}), ...type, ...rest };
}
