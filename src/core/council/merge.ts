import type { ReviewIssue } from '../harness/tools/handlers.js';
import type { IssueAction } from '../harness/tools/registry.js';
import { REASSERT_SIMILARITY, REPEAT_SIMILARITY, issueSimilarity } from '../learning/reviewIssues.js';
import type { CouncilMember, CouncilStage, Lens } from './settings.js';

/**
 * The merge of one council round (design 2026-11-16-review-council-design.md §6 steps 3–5): the members'
 * reviews become one review by fixed rules. There is no chair model; the same input always gives the same
 * result, and nothing here reads or writes the store.
 *
 * Readings of the design this file settles (each has a test in test/core/council/merge.test.ts):
 * - Only members with a valid review (`state: 'reviewed'`) contribute issues, questions and follow-ups.
 * - Only blocking members decide (council review of 2026-11-16, C1). Whether an issue is upheld is settled
 *   from what the blocking members with a score sent, and from nothing else: its class, the outputs it is
 *   about, the earlier issue it repeats, whether it says something new after a pushback, how many raised
 *   it, and which outputs an upheld rewrite discards. So the blocking members' issues are grouped first,
 *   exactly as they would be were they alone. A non-blocking member's issue is then attached to the group
 *   it is the same defect as (its name, its evidence, its words), or stands by itself as advice. Taking
 *   every non-blocking member out of a round changes neither `pass`, nor a counted score, nor which issues
 *   are upheld. One consequence: the outputs of an issue blocking members raised (`where`) are those the
 *   blocking members named, so a non-blocking member cannot widen a rewrite or a deletion.
 * - Evidence or nothing (3.3) is checked per member, before issues are grouped (C2): a member's blocking
 *   or substantive issue that names neither an output nor evidence is that member's question. It is no
 *   vote for the same defect another member did show, and it borrows nobody's evidence.
 * - A merged issue's text carries every member's wording (C6): the lead text (of the most severe class
 *   among the blocking members), then `Also raised by <name>: <text>` for each other member whose words
 *   are not a near-repeat (`SAME_TEXT_SIMILARITY`) of words already there. Two different points about one
 *   output can be taken as one defect, and the worker must still read both. `wordings` holds the texts
 *   apart: a later round compares a member's words with each of them (and with the whole text, which is
 *   what members are shown), so a repeat of any one wording is a repeat.
 * - Same defect (3.1; ruling of 2026-11-16) is decided in `cluster`: two issues of different members
 *   are one defect when both reuse the id of the same earlier issue they were shown (in whatever words and
 *   about whatever output: members are new runs each round, and each says in its own words that the issue
 *   still stands); or when they name a common output and are loosely alike in words; or, where at least one
 *   names no output, when the words alone are close. Issues that name outputs and share none are never one
 *   defect unless the id says so, and issues that reuse the ids of different earlier issues never are. An
 *   issue joins the group whose issue under the same id it meets first, else the group whose first issue it
 *   is most like.
 * - Same defect is judged within one kind of issue: blocking and substantive issues together, nits among
 *   themselves, scope issues among themselves. One member's nit is never merged into another member's
 *   substantive issue, so "who raised it" always means "who wanted it answered". Issues with different
 *   actions (fix, delete, rewrite) are not merged either, and a member is in a group once.
 * - A reasserted dispute (3.4; ruling of 2026-11-16) blocks only when it says something new: the issue
 *   names an output or evidence (else it is a question by 3.3) and the words of at least one blocking member
 *   that raised it are not a mere repeat of the earlier text (`SAME_TEXT_SIMILARITY`). Citing other evidence
 *   under the same words is a repeat: the member was asked to say why the worker's reason does not hold.
 * - "Raised in an earlier round" (3.5; ruling of 2026-11-16) is decided by `earlierIdOf`. Members are new
 *   runs each round, so from round 2 their prompt lists the issues of earlier rounds with their ids. An
 *   issue is an earlier one when it reuses an id it was shown (in whatever words: the member was asked to say
 *   what in the current deliverable shows it); or when it is about the same output and loosely like it in
 *   words; or when the words alone are close. Because the id alone decides, the harness never gives a
 *   member's new issue an id of an earlier round (`submit_review` in harness/tools/handlers.ts).
 * - A member's low score stands (step 4; ruling of 2026-11-16) only when that member raised an issue that
 *   is upheld. Otherwise it is unsupported and counts as the pass score, so a round never fails with
 *   nothing the worker has to answer, and `blockOn`, 3.4 and 3.5 alone decide which findings block.
 * - An issue an upheld rewrite replaced (3.7) is recorded under `dropped` with rule `rewrite`, the
 *   rewrite's id and the standing it had before (C4: a rewrite replaces advice too, and only an issue the
 *   council upheld was reasserted). The member of an upheld one still has a reason for its score: the
 *   rewrite answers the defect it raised. When that rewrite is itself replaced by a wider one, the id is
 *   that of the rewrite that stands.
 * - `round` is which review of the current deliverable this is, not the loop's round number (C3): the
 *   caller counts the valid reviews since the worker last did the `work` step (`council/round.ts`).
 * - With no counted score (no blocking member has a valid review) the round does not pass and its score is 0.
 */

export type CouncilIssueIn = ReviewIssue & { action?: IssueAction; where?: string[] };

export type MemberReview = {
  member: CouncilMember;
  /** `reviewed`: a valid review. `no_score`: its run gave none. `unavailable`: not started. `not_waited`: a non-blocking member cancelled at the end of the round. */
  state: 'reviewed' | 'no_score' | 'unavailable' | 'not_waited';
  reason?: string;
  runId?: string;
  score?: number;
  issues: CouncilIssueIn[];
  questions: string[];
  followUps: string[];
  /** Ids the member named that were taken off its issues before the merge (`CouncilResult.members[].droppedIds`). */
  droppedIds?: DroppedIds;
};

/**
 * Ids a member named that count for nothing (design §5.1 rule 4, "evidence or nothing"): in `where`, ids
 * that are not outputs of the task; in `evidence`, ids outside the task's review slice.
 */
export type DroppedIds = { where?: string[]; evidence?: string[] };

/**
 * An issue as the council puts it together. `wordings`: the members' own texts that `description` carries,
 * the lead's first; absent when it is one member's text.
 */
export type WordedIssue = CouncilIssueIn & { wordings?: string[] };

/** `upheld`: the worker must answer it and it fails the round. `advisory`: shown to the worker, does not block. */
export type MergedIssue = WordedIssue & { raisedBy: string[]; standing: 'upheld' | 'advisory' };

export type MergeInput = {
  stage: CouncilStage;
  /**
   * Which review of the task's current deliverable this is: 1 when it has had no valid review since the
   * worker last did the `work` step. Not the loop's round number (a re-run after an escalation starts the
   * work again in a later round). The late-issue rule (design §6 step 3.5) applies from 2.
   */
  round: number;
  reviews: MemberReview[];
  /**
   * Issues of earlier rounds (any member), under their stable ids. `unlisted`: the members were not shown
   * it (an advisory issue, one a rewrite replaced, one the review dropped after a pushback), so an issue
   * with the same id carries that id by chance and only its words and outputs can make it this issue.
   */
  earlier: Array<{ id: string; description: string; where?: string[]; unlisted?: boolean; wordings?: string[] }>;
  /** Ids of issues the worker pushed back on. */
  disputed: Set<string>;
};

export type CouncilResult = {
  pass: boolean;
  /** The lowest counted score: the round's score wherever one number is needed. */
  score: number;
  /** Upheld first. Ids are unique in the round; an issue raised in an earlier round keeps its id. */
  issues: MergedIssue[];
  /**
   * What the worker is not asked to answer: nits, scope issues, and issues an upheld rewrite replaced
   * (`replacedBy`: its id; `standing`: what the issue was before the rewrite replaced it).
   */
  dropped: Array<{ issue: WordedIssue; raisedBy: string[]; rule: 'nit' | 'scope' | 'rewrite'; replacedBy?: string; standing?: MergedIssue['standing'] }>;
  questions: Array<{ text: string; raisedBy: string[] }>;
  followUps: Array<{ text: string; raisedBy: string[] }>;
  members: Array<{
    name: string;
    provider: string;
    model: string;
    lens: Lens;
    blocking: boolean;
    state: MemberReview['state'];
    reason?: string;
    runId?: string;
    /** What the member gave. */
    score?: number;
    /** What the round counts for it (blocking members with a valid review only). */
    countedScore?: number;
    /** The score was below the pass score with nothing to back it, and is counted as the pass score. */
    unsupportedScore?: boolean;
    /** Ids the member named that are not outputs of the task (`where`) or not in its review slice (`evidence`): not used. */
    droppedIds?: DroppedIds;
  }>;
};

/**
 * `claims`: the id of the earlier issue the members were shown that this issue reuses, if it reuses one.
 * `decides`: raised by a blocking member with a score, the only kind whose issues settle a standing.
 */
type Raised = { issue: CouncilIssueIn; by: CouncilMember; claims?: string; decides: boolean };
/** Issues taken to be one defect; the first one is what the words of later issues are compared with. */
type Cluster = Raised[];

/** Text similarity from which a reasserted issue only repeats the earlier text (it says nothing new). */
export const SAME_TEXT_SIMILARITY = 0.9;

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const actionOf = (i: CouncilIssueIn): IssueAction => i.action ?? 'fix';

/** Two issues can be about the same thing unless both name outputs and share none. */
function whereCompatible(a: string[] | undefined, b: string[] | undefined): boolean {
  return !a?.length || !b?.length || a.some((id) => b.includes(id));
}

/** Both issues name outputs and share one. */
function whereOverlaps(a: string[] | undefined, b: string[] | undefined): boolean {
  return !!a?.length && !!b?.length && a.some((id) => b.includes(id));
}

/**
 * Step 3.1 in words: whether two issues that reuse no earlier id in common are the same defect. On a
 * common output, loosely alike is enough; with an output named by one of them at most, the words must be
 * close; about different outputs, never. Returns the similarity, or `undefined` when they are not.
 */
function sameDefectInWords(a: CouncilIssueIn, b: CouncilIssueIn): number | undefined {
  if (!whereCompatible(a.where, b.where)) return undefined;
  const sim = issueSimilarity(a.description, b.description);
  return sim >= (whereOverlaps(a.where, b.where) ? REASSERT_SIMILARITY : REPEAT_SIMILARITY) ? sim : undefined;
}

/**
 * Step 3.1: groups issues of different members about the same defect, in the order they were raised (see
 * the header). `into`: groups that exist already, which the issues join or are added after.
 */
function cluster(raised: Raised[], into: Cluster[] = []): Cluster[] {
  const out = into;
  for (const r of raised) {
    let best: Cluster | undefined;
    let bestSim = -1;
    for (const c of out) {
      if (c.some((x) => x.by.name === r.by.name) || actionOf(c[0]!.issue) !== actionOf(r.issue)) continue;
      const claimed = c.find((x) => x.claims !== undefined)?.claims;
      if (r.claims !== undefined && claimed !== undefined) {
        // Both say which earlier issue they are: the id decides, whatever the words and the outputs.
        if (r.claims !== claimed) continue;
        best = c;
        break;
      }
      const sim = sameDefectInWords(c[0]!.issue, r.issue);
      if (sim !== undefined && sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) best.push(r);
    else out.push([r]);
  }
  return out;
}

/** One nit or scope issue for a cluster: its first wording, every member's name, evidence and outputs. */
function droppedIssue(c: Cluster): { issue: CouncilIssueIn; raisedBy: string[] } {
  const lead = c[0]!.issue;
  const issue: CouncilIssueIn = { id: lead.id, class: lead.class, description: lead.description };
  const evidence = uniq(c.flatMap((r) => r.issue.evidence ?? []));
  const where = uniq(c.flatMap((r) => r.issue.where ?? []));
  const action = c.map((r) => r.issue.action).find((a) => a !== undefined);
  if (evidence.length) issue.evidence = evidence;
  if (where.length) issue.where = where;
  if (action) issue.action = action;
  return { issue, raisedBy: uniq(c.map((r) => r.by.name)) };
}

/** The members of a cluster whose issues settle its standing: the blocking ones, or (advice only) all of them. */
const deciding = (c: Cluster): Cluster => (c.some((r) => r.decides) ? c.filter((r) => r.decides) : c);

/**
 * One blocking or substantive issue for a cluster (see the header on who decides and on wordings). From
 * the members that decide: the most severe class, the lead wording and the outputs. From every member:
 * its name, its evidence, and its words where they are not a near-repeat of words already there.
 */
function mergedIssue(c: Cluster): { issue: WordedIssue; raisedBy: string[] } {
  const core = deciding(c);
  const cls = core.some((r) => r.issue.class === 'blocking') ? 'blocking' : core[0]!.issue.class;
  const lead = core.find((r) => r.issue.class === cls)!;
  const wordings = [lead.issue.description];
  const also: string[] = [];
  for (const r of [...core, ...c.filter((x) => !core.includes(x))]) {
    if (r === lead || wordings.some((w) => issueSimilarity(w, r.issue.description) >= SAME_TEXT_SIMILARITY)) continue;
    wordings.push(r.issue.description);
    also.push(`Also raised by ${r.by.name}: ${r.issue.description}`);
  }
  const issue: WordedIssue = { id: lead.issue.id, class: cls, description: [lead.issue.description, ...also].join('\n') };
  const evidence = uniq([...core, ...c].flatMap((r) => r.issue.evidence ?? []));
  const where = uniq(core.flatMap((r) => r.issue.where ?? []));
  const action = c.map((r) => r.issue.action).find((a) => a !== undefined);
  if (wordings.length > 1) issue.wordings = wordings;
  if (evidence.length) issue.evidence = evidence;
  if (where.length) issue.where = where;
  if (action) issue.action = action;
  return { issue, raisedBy: uniq(c.map((r) => r.by.name)) };
}

/**
 * How alike a member's words are to an earlier issue: to its whole text (what members are shown) or to
 * the wording of any one member that raised it, whichever is closest.
 */
function likeEarlier(e: MergeInput['earlier'][number], text: string): number {
  return Math.max(...uniq([e.description, ...(e.wordings ?? [])]).map((w) => issueSimilarity(w, text)));
}

/**
 * The stable id of the earlier issue a cluster repeats, if any (see the header on "raised in an earlier
 * round"): an issue that reuses the id of an earlier issue the members were shown; else the most similar earlier issue among those about the
 * same output and loosely alike (`REASSERT_SIMILARITY`) and those whose words alone are close
 * (`REPEAT_SIMILARITY`).
 */
function earlierIdOf(c: Cluster, input: Pick<MergeInput, 'earlier'>): string | undefined {
  for (const { claims } of c) if (claims !== undefined) return claims;
  let best: string | undefined;
  let bestSim = 0;
  for (const { issue } of c) {
    for (const e of input.earlier) {
      const sim = likeEarlier(e, issue.description);
      const same = sim >= REPEAT_SIMILARITY || (sim >= REASSERT_SIMILARITY && whereOverlaps(e.where, issue.where));
      if (same && sim > bestSim) {
        best = e.id;
        bestSim = sim;
      }
    }
  }
  return best;
}

/** Questions and follow-ups: the same text from several members is listed once, with every name. */
function mergeTexts(entries: Array<{ text: string; by: string }>): Array<{ text: string; raisedBy: string[] }> {
  const out: Array<{ text: string; raisedBy: string[] }> = [];
  for (const e of entries) {
    const text = e.text.trim();
    if (!text) continue;
    const same = out.find((o) => issueSimilarity(o.text, text) >= REPEAT_SIMILARITY);
    if (!same) out.push({ text, raisedBy: [e.by] });
    else if (!same.raisedBy.includes(e.by)) same.raisedBy.push(e.by);
  }
  return out;
}

export function mergeCouncil(input: MergeInput): CouncilResult {
  const { stage, round } = input;
  const reviewed = input.reviews.filter((r) => r.state === 'reviewed');
  /** Blocking members with a score: the only ones whose score counts and who can uphold an issue. */
  const counting = new Set(reviewed.filter((r) => r.member.blocking && typeof r.score === 'number').map((r) => r.member.name));
  /** Ids of the earlier issues the members were shown: reusing one says "this is that issue". */
  const listed = new Set(input.earlier.filter((e) => !e.unlisted).map((e) => e.id));
  const raised = (...classes: Array<CouncilIssueIn['class']>): Raised[] =>
    reviewed.flatMap((r) =>
      r.issues
        .filter((i) => classes.includes(i.class))
        .map((issue): Raised => ({ issue, by: r.member, decides: counting.has(r.member.name), ...(listed.has(issue.id) ? { claims: issue.id } : {}) })),
    );
  const enough = (n: number): boolean =>
    stage.blockOn === 'any' ? n >= 1 : stage.blockOn === 'majority' ? n > counting.size / 2 : counting.size > 0 && n >= counting.size;

  // 3.2: nits and scope issues are not for the worker to answer; scope issues live on as follow-ups.
  const nits = cluster(raised('nit')).map(droppedIssue);
  const scope = cluster(raised('scope_expansion')).map(droppedIssue);

  const questions = reviewed.flatMap((r) => r.questions.map((text) => ({ text, by: r.member.name })));
  const followUps = [
    ...reviewed.flatMap((r) => r.followUps.map((text) => ({ text, by: r.member.name }))),
    ...scope.flatMap((s) => s.raisedBy.map((by) => ({ text: s.issue.description, by }))),
  ];

  // 3.3, per member and before anything is merged: an issue with nothing to point at is its member's
  // question. It joins no other issue, so it neither counts for one nor borrows its evidence.
  const shown: Raised[] = [];
  for (const r of raised('blocking', 'substantive')) {
    if (r.issue.where?.length || r.issue.evidence?.length) shown.push(r);
    else questions.push({ text: r.issue.description, by: r.by.name });
  }
  // 3.1: the issues of the members that decide are grouped as if those members were alone. What the other
  // members raised then joins a group it is the same defect as, or makes groups of its own (advice).
  const clusters = cluster(shown.filter((r) => !r.decides), cluster(shown.filter((r) => r.decides)));

  /** Members that raised an upheld issue: the only reason a low score stands (step 4). */
  const supported = new Set<string>();
  const standing: Array<{ issue: MergedIssue; decides: boolean; earlierId?: string }> = [];
  for (const c of clusters) {
    const { issue, raisedBy } = mergedIssue(c);
    const core = deciding(c);
    const decides = core.some((r) => r.decides);
    const earlierId = earlierIdOf(core, input);
    const disputed = earlierId !== undefined && input.disputed.has(earlierId) ? input.earlier.find((e) => e.id === earlierId) : undefined;
    const upheld =
      // Only blocking members uphold: what the others alone raised is advice.
      decides &&
      // 3.4: pushed back on, and raised again in the earlier words: nothing new is said.
      !(disputed && core.every((r) => likeEarlier(disputed, r.issue.description) >= SAME_TEXT_SIMILARITY)) &&
      // 3.5: from the second review of a deliverable, a substantive issue nobody raised before does not widen the round.
      !(round >= 2 && issue.class === 'substantive' && earlierId === undefined) &&
      // 3.6: enough blocking members raised it.
      enough(uniq(core.map((r) => r.by.name)).length);
    if (upheld) for (const r of core) supported.add(r.by.name);
    const entry: (typeof standing)[number] = { issue: { ...issue, raisedBy, standing: upheld ? 'upheld' : 'advisory' }, decides };
    if (earlierId !== undefined) entry.earlierId = earlierId;
    standing.push(entry);
  }

  // 3.7: an upheld rewrite replaces every other issue that is only about outputs it discards. Rewrites
  // are taken in order, and a replaced issue replaces nothing, so of two rewrites of the same outputs the
  // first stands. A rewrite that replaced issues can itself be replaced by a later, wider one.
  const replacedBy = new Map<MergedIssue, MergedIssue>();
  for (const { issue: r } of standing) {
    const discards = r.where;
    if (replacedBy.has(r) || r.standing !== 'upheld' || r.action !== 'rewrite' || !discards?.length) continue;
    for (const { issue: x } of standing) {
      if (x !== r && !replacedBy.has(x) && x.where?.length && x.where.every((id) => discards.includes(id))) replacedBy.set(x, r);
    }
  }
  /** The rewrite that stands in the place of a replaced issue: the one at the end of its chain of rewrites. */
  const standsFor = (issue: MergedIssue): MergedIssue | undefined => {
    let rewrite = replacedBy.get(issue);
    while (rewrite && replacedBy.has(rewrite)) rewrite = replacedBy.get(rewrite);
    return rewrite;
  };
  const kept = standing.filter((s) => !replacedBy.has(s.issue));
  const ordered = [...kept.filter((s) => s.issue.standing === 'upheld'), ...kept.filter((s) => s.issue.standing === 'advisory')];

  // Ids: an issue of an earlier round keeps its id; every other one gets an id no earlier issue had. The
  // issues blocking members raised are given theirs first (those a rewrite replaced too), so that no id of
  // theirs, and with it nothing the history records about a dispute, depends on what the others raised.
  const used = new Set(input.earlier.map((e) => e.id));
  const taken = new Set<string>();
  let n = 0;
  const freshId = (): string => {
    let id: string;
    do id = `I${++n}`;
    while (used.has(id) || taken.has(id));
    return id;
  };
  const stableId = (earlierId: string | undefined): string => {
    const id = earlierId !== undefined && !taken.has(earlierId) ? earlierId : freshId();
    taken.add(id);
    return id;
  };
  /** The id each standing issue has in the result (a replaced issue is found there through its rewrite). */
  const idOf = new Map<MergedIssue, string>();
  const replaced = standing.filter((s) => replacedBy.has(s.issue));
  for (const { issue, earlierId } of [...ordered.filter((s) => s.decides), ...replaced.filter((s) => s.decides), ...ordered.filter((s) => !s.decides)]) {
    idOf.set(issue, stableId(earlierId));
  }
  const issues = ordered.map(({ issue }): MergedIssue => ({ ...issue, id: idOf.get(issue)! }));
  const drop = (rule: 'nit' | 'scope') => (d: { issue: CouncilIssueIn; raisedBy: string[] }) => ({ issue: { ...d.issue, id: stableId(undefined) }, raisedBy: d.raisedBy, rule });
  const dropped: CouncilResult['dropped'] = [
    ...nits.map(drop('nit')),
    ...scope.map(drop('scope')),
    ...replaced.map(({ issue, earlierId }) => {
      const { raisedBy, standing: was, ...rest } = issue;
      return { issue: { ...rest, id: idOf.get(issue) ?? stableId(earlierId) }, raisedBy, rule: 'rewrite' as const, replacedBy: idOf.get(standsFor(issue)!)!, standing: was };
    }),
  ];

  // Step 4: scores.
  const members = input.reviews.map((r) => {
    const m = r.member;
    const row: CouncilResult['members'][number] = { name: m.name, provider: m.provider, model: m.model, lens: m.lens, blocking: m.blocking, state: r.state };
    if (r.reason !== undefined) row.reason = r.reason;
    if (r.runId !== undefined) row.runId = r.runId;
    if (r.droppedIds !== undefined) row.droppedIds = r.droppedIds;
    if (r.state !== 'reviewed' || typeof r.score !== 'number') return row;
    row.score = r.score;
    if (!m.blocking) return row;
    if (r.score < stage.passScore && !supported.has(m.name)) {
      row.countedScore = stage.passScore;
      row.unsupportedScore = true;
    } else {
      row.countedScore = r.score;
    }
    return row;
  });

  // Step 5: pass.
  const countedScores = members.flatMap((m) => (m.countedScore === undefined ? [] : [m.countedScore]));
  const pass =
    countedScores.length > 0 && countedScores.every((s) => s >= stage.passScore) && !issues.some((i) => i.standing === 'upheld');
  return {
    pass,
    score: countedScores.length ? Math.min(...countedScores) : 0,
    issues,
    dropped,
    questions: mergeTexts(questions),
    followUps: mergeTexts(followUps),
    members,
  };
}
