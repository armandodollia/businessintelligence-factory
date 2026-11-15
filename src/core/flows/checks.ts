/**
 * Check answers of a flow (design 2026-11-14-flow-records-and-ranking-design.md §10.1, §10.4): one
 * row per flow version, checklist and item (`flow_checks`).
 *
 * - A walkthrough answers the items a walkthrough can see (`answeredBy` walkthrough or both) of the
 *   flow's active general checklist and of its type's active specific checklist; each value is
 *   scored by the item's rule (`saveCheckAnswers`, origin 'walkthrough'). Reviews-only items, and
 *   'both' items the walkthrough did not answer, are answered from review mentions; a walkthrough
 *   pass of a 'both' item becomes `disputed` when enough complaints contradict it
 *   (`applyReviewChecks`; origin 'reviews', or the walkthrough's row kept with the dispute layered on).
 * - The user's correction (`correctCheck`, origin 'user') is never overwritten by a walkthrough.
 * - Answers belong to one flow version: a new version starts unanswered.
 * - A new checklist version keeps the answers of items whose key, kind and pass rule are unchanged
 *   (`carryAnswers`, called by `decideChecklist`); the flows left with unanswered items need a re-walk.
 * - Recorded values and notes are agent-written text that may quote the product: stored redacted
 *   and fence-stripped.
 *
 * Import cycle note: `./catalog.ts` imports `carryAnswers` from here and this module imports
 * `activeChecklists` / `FlowCatalogError` from there (and `./flows.ts` and `./reviews.ts`, which
 * import catalog). All are used at call time only, so the cycle is safe in any load order; keep it
 * that way (no top-level use of these imports).
 */
import { redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { rootOf } from '../workspace/tree.js';
import { activeChecklists, FlowCatalogError } from './catalog.js';
import type { FlowsSettings } from './config.js';
import { FlowInputError, flowSteps } from './flows.js';
import { flowRepos } from './repos.js';
import { mentionCounts, mentionsFor } from './reviews.js';
import type { CheckAnswer, Checklist, ChecklistItem, Flow, FlowCheck } from './types.js';

export type CheckAnswerInput = {
  checklist: 'general' | 'specific';
  key: string;
  value: 'yes' | 'no' | number | string | null /* null = not applicable */;
  steps?: number[];
  note?: string;
};
export type MissingCheck = { checklist: 'general' | 'specific'; key: string; question: string };

export const CHECK_ANSWERS: readonly CheckAnswer[] = ['pass', 'fail', 'na', 'recorded', 'reported_problem', 'no_signal', 'disputed'];

const nowIso = () => new Date().toISOString();

/** The flow, when it belongs to the caller's business tree; the same refusal for unknown and foreign ids. */
function flowInTree(store: Store, workspaceId: string, flowId: string): Flow {
  const flow = typeof flowId === 'string' ? flowRepos(store).flows.get(flowId) : undefined;
  if (!flow || flow.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowInputError(`flow '${flowId}' not found in this business tree`);
  return flow;
}

/** Agent-written text: the tree's identity secrets redacted, fence sequences removed, trimmed. */
function cleanText(store: Store, workspaceId: string, s: string): string {
  return stripFences(redactServed(store, workspaceId, s)).trim();
}

/**
 * True when a stored row holds a walkthrough's (or the user's) answer. A row computed from reviews
 * alone (`no_signal` / `reported_problem` of a 'both' item the walkthrough has not answered) does not.
 */
function walkthroughAnswered(c: FlowCheck): boolean {
  return c.origin !== 'reviews' || (c.answer !== 'no_signal' && c.answer !== 'reported_problem');
}

/** Items a walkthrough can answer that have no walkthrough or user answer for the flow on `checklist`. */
function unanswered(store: Store, flowId: string, checklist: Checklist): ChecklistItem[] {
  const answered = new Set(
    flowRepos(store)
      .flowChecks.list({ flowId, checklistId: checklist.id })
      .filter(walkthroughAnswered)
      .map((c) => c.itemKey),
  );
  return checklist.items.filter((i) => i.answeredBy !== 'reviews' && !answered.has(i.key));
}

/** Scores a (cleaned) value by the item's rule; throws `FlowInputError` naming what the item takes. */
function score(item: ChecklistItem, value: unknown): { answer: CheckAnswer; value?: unknown } {
  if (value === null) return { answer: 'na' };
  const refuse = (takes: string): never => {
    throw new FlowInputError(`'${item.key}' takes ${takes} (or null for not applicable); got ${JSON.stringify(value) ?? 'nothing'}`);
  };
  switch (item.kind) {
    case 'yes_no': {
      if (value !== 'yes' && value !== 'no') refuse("'yes' or 'no'");
      const pass = item.pass?.answer;
      return { answer: pass === undefined ? 'recorded' : value === pass ? 'pass' : 'fail', value };
    }
    case 'count': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) refuse('a whole number of 0 or more');
      const max = item.pass?.max;
      return { answer: max === undefined ? 'recorded' : (value as number) <= max ? 'pass' : 'fail', value };
    }
    case 'one_of': {
      const allowed = item.options ?? item.pass?.options;
      if (typeof value !== 'string' || !value || (allowed && !allowed.includes(value))) refuse(allowed ? `one of ${allowed.join(', ')}` : 'a non-empty text');
      const passing = item.pass?.options;
      return { answer: passing === undefined ? 'recorded' : passing.includes(value as string) ? 'pass' : 'fail', value };
    }
    case 'recorded':
      if (!(typeof value === 'string' && value !== '') && !(typeof value === 'number' && Number.isFinite(value))) refuse('a value (a text or a number)');
      return { answer: 'recorded', value };
  }
}

/** Replaces the stored answer of (flow, checklist, item) unless it is the user's; true when written. */
function writeCheck(store: Store, row: FlowCheck, opts: { overUser: boolean }): boolean {
  const checks = flowRepos(store).flowChecks;
  const key = { flowId: row.flowId, checklistId: row.checklistId, itemKey: row.itemKey };
  const existing = checks.list(key)[0];
  if (existing?.origin === 'user' && !opts.overUser) return false;
  checks.delete(key);
  checks.insert(row);
  return true;
}

/**
 * Validates each answer against the active checklist item and stores it (origin 'walkthrough'). Returns what is still unanswered.
 *
 * The batch is all or nothing: one refused answer (unknown key, wrong value for the item's kind, a
 * reviews-only item, a step the flow does not have, an item answered twice) saves none and throws a
 * `FlowInputError` naming the answer. An answer the user corrected is left as it is (not counted in
 * `saved`). `missing` lists the walkthrough items of both active checklists still without an answer.
 */
export function saveCheckAnswers(
  store: Store,
  workspaceId: string,
  flowId: string,
  answers: CheckAnswerInput[],
): { saved: number; missing: MissingCheck[] } {
  const flow = flowInTree(store, workspaceId, flowId);
  if (!Array.isArray(answers)) throw new FlowInputError('answers must be an array of { checklist, key, value, steps?, note? }');
  const lists = activeChecklists(store, workspaceId, flow.flowTypeId);
  const stepNumbers = flowSteps(store, flow.id).map((s) => s.seq);
  const stepRange = stepNumbers.length ? `steps 1-${Math.max(...stepNumbers)}` : 'no steps';
  const now = nowIso();

  const seen = new Set<string>();
  const rows = answers.map((a, i): FlowCheck => {
    try {
      if (!a || typeof a !== 'object') throw new FlowInputError('an answer is { checklist, key, value, steps?, note? }');
      if (a.checklist !== 'general' && a.checklist !== 'specific') throw new FlowInputError("checklist must be 'general' or 'specific'");
      const checklist = a.checklist === 'general' ? lists.general : lists.specific;
      if (!checklist) {
        const type = flowRepos(store).flowTypes.get(flow.flowTypeId);
        throw new FlowInputError(`flow type '${type?.key ?? flow.flowTypeId}' has no active specific checklist; answer the general checklist only`);
      }
      const item = checklist.items.find((it) => it.key === a.key);
      if (!item) {
        throw new FlowInputError(`unknown item '${String(a.key)}' in the ${a.checklist} checklist; its items are: ${checklist.items.map((it) => it.key).join(', ')}`);
      }
      if (item.answeredBy === 'reviews') throw new FlowInputError(`'${item.key}' is answered from reviews, not by a walkthrough; leave it out`);
      const seenKey = `${a.checklist}:${item.key}`;
      if (seen.has(seenKey)) throw new FlowInputError(`'${item.key}' is answered twice in this batch`);
      seen.add(seenKey);
      const steps = a.steps ?? [];
      if (!Array.isArray(steps)) throw new FlowInputError('steps must be a list of step numbers');
      for (const s of steps) {
        if (!stepNumbers.includes(s)) throw new FlowInputError(`step ${JSON.stringify(s)} does not exist; this flow has ${stepRange}`);
      }
      const value = typeof a.value === 'string' ? cleanText(store, workspaceId, a.value) : a.value;
      const scored = score(item, value);
      const row: FlowCheck = {
        flowId: flow.id,
        checklistId: checklist.id,
        itemKey: item.key,
        answer: scored.answer,
        stepRefs: [...new Set(steps)].sort((x, y) => x - y),
        mentionRefs: [],
        origin: 'walkthrough',
        updatedAt: now,
      };
      if (scored.value !== undefined) row.value = scored.value;
      const note = typeof a.note === 'string' ? cleanText(store, workspaceId, a.note) : '';
      if (note) row.note = note;
      return row;
    } catch (e) {
      if (e instanceof FlowInputError) throw new FlowInputError(`answer ${i + 1}: ${e.message}`);
      throw e;
    }
  });

  return store.transaction(() => {
    let saved = 0;
    for (const row of rows) if (writeCheck(store, row, { overUser: false })) saved++;
    const missing: MissingCheck[] = [];
    for (const [name, checklist] of [['general', lists.general], ['specific', lists.specific]] as const) {
      if (!checklist) continue;
      for (const item of unanswered(store, flow.id, checklist)) missing.push({ checklist: name, key: item.key, question: item.question });
    }
    return { saved, missing };
  });
}

/** Every stored answer of a flow version (all checklists, current and retired). */
export function flowChecks(store: Store, flowId: string): FlowCheck[] {
  return flowRepos(store).flowChecks.list({ flowId });
}

/**
 * The user's correction (origin 'user'); never overwritten by a walkthrough or by reviews.
 *
 * Any item of the general checklist or of the flow's type's checklists (of the flow's tree) can be
 * corrected, whoever answered it. The value, step and mention references of the prior answer are
 * kept; `note` replaces the prior note when given.
 */
export function correctCheck(store: Store, flowId: string, checklistId: string, itemKey: string, answer: CheckAnswer, note?: string): FlowCheck {
  const r = flowRepos(store);
  const flow = r.flows.get(flowId);
  if (!flow) throw new FlowInputError(`flow '${flowId}' not found`);
  const checklist = r.checklists.get(checklistId);
  if (!checklist || checklist.rootWorkspaceId !== flow.rootWorkspaceId || (checklist.flowTypeId !== undefined && checklist.flowTypeId !== flow.flowTypeId)) {
    throw new FlowInputError(`checklist '${checklistId}' does not apply to flow '${flowId}'`);
  }
  const item = checklist.items.find((i) => i.key === itemKey);
  if (!item) throw new FlowInputError(`unknown item '${itemKey}' in checklist '${checklistId}'`);
  if (!CHECK_ANSWERS.includes(answer)) throw new FlowInputError(`answer must be one of ${CHECK_ANSWERS.join(', ')}`);
  return store.transaction(() => {
    const prior = r.flowChecks.list({ flowId, checklistId, itemKey })[0];
    const row: FlowCheck = {
      flowId, checklistId, itemKey, answer, stepRefs: prior?.stepRefs ?? [], mentionRefs: prior?.mentionRefs ?? [], origin: 'user', updatedAt: nowIso(),
    };
    if (prior?.value !== undefined) row.value = prior.value;
    const cleaned = typeof note === 'string' ? cleanText(store, flow.workspaceId, note) : '';
    const keptNote = cleaned || prior?.note;
    if (keptNote) row.note = keptNote;
    writeCheck(store, row, { overUser: true });
    return row;
  });
}

/** Pass rule in a comparable form (option order does not matter). */
function ruleOf(item: ChecklistItem): string {
  const p = item.pass ?? {};
  return JSON.stringify([item.kind, p.answer ?? null, p.max ?? null, p.options ? [...p.options].sort() : null]);
}

/**
 * When a new checklist version becomes active: copies each flow's answers for items unchanged in key, kind and pass rule. Returns the flows left with unanswered items (they need a re-walk).
 *
 * Copied answers keep their origin (a user's correction stays the user's). An answer already on
 * `toChecklistId` is kept. `needRewalk` lists, in first-answer order, the flows that had answers on
 * `fromChecklistId` and now miss a walkthrough answer on `toChecklistId`; replaced flow versions are
 * left out (they are history and will not be walked again).
 */
export function carryAnswers(store: Store, fromChecklistId: string, toChecklistId: string): { carried: number; needRewalk: string[] } {
  const r = flowRepos(store);
  const from = r.checklists.get(fromChecklistId);
  const to = r.checklists.get(toChecklistId);
  if (!from || !to || from.rootWorkspaceId !== to.rootWorkspaceId) {
    throw new FlowCatalogError(`checklists ${fromChecklistId} and ${toChecklistId} are not both in one business tree`, 404);
  }
  const before = new Map(from.items.map((i) => [i.key, ruleOf(i)]));
  const unchanged = new Set(to.items.filter((i) => before.get(i.key) === ruleOf(i)).map((i) => i.key));
  return store.transaction(() => {
    let carried = 0;
    const flowIds: string[] = [];
    for (const row of r.flowChecks.list({ checklistId: from.id })) {
      if (!flowIds.includes(row.flowId)) flowIds.push(row.flowId);
      if (unchanged.has(row.itemKey) && r.flowChecks.insertIgnore({ ...row, checklistId: to.id })) carried++;
    }
    const needRewalk = flowIds.filter((id) => {
      const flow = r.flows.get(id);
      return flow !== undefined && flow.lifecycle !== 'replaced' && unanswered(store, id, to).length > 0;
    });
    return { carried, needRewalk };
  });
}

/**
 * Recomputes every reviews / both item of the flow's active checklists from mentions. Never touches origin 'user' answers.
 *
 * Per item, from the counting (`mentionCounts`) negative mentions of the flow's subject, type and
 * item ("complaints"); `mentionRefs` lists them:
 * - `answeredBy: 'reviews'`, or 'both' with no walkthrough answer: `reported_problem` when there are
 *   at least `minMentionsForCheck` complaints, else `no_signal` (origin 'reviews'). Reviews alone
 *   never write a pass.
 * - 'both' with a walkthrough answer: that answer stands (origin, value and steps kept); a `pass` is
 *   `disputed` while the threshold is met. `disputed` is only ever layered on a walkthrough pass, so
 *   a walkthrough row that reads `disputed` stands for a pass: once the complaints drop below the
 *   threshold (aged out, fewer counting) it returns to `pass`.
 *
 * Safe to run repeatedly (a row is rewritten only when its answer or mentions change); run it again
 * after walkthrough answers are saved, since a walkthrough save replaces the row.
 */
export function applyReviewChecks(store: Store, workspaceId: string, flowId: string, settings: FlowsSettings, now: Date = new Date()): void {
  const flow = flowInTree(store, workspaceId, flowId);
  const { general, specific } = activeChecklists(store, workspaceId, flow.flowTypeId);
  const checks = flowRepos(store).flowChecks;
  store.transaction(() => {
    const updatedAt = nowIso();
    for (const checklist of specific ? [general, specific] : [general]) {
      for (const item of checklist.items) {
        if (item.answeredBy === 'walkthrough') continue;
        const existing = checks.list({ flowId: flow.id, checklistId: checklist.id, itemKey: item.key })[0];
        if (existing?.origin === 'user') continue;
        const complaints = mentionsFor(store, workspaceId, { subjectEntityId: flow.subjectEntityId, flowTypeId: flow.flowTypeId, checkKey: item.key })
          .filter((m) => m.polarity === 'negative' && mentionCounts(m, settings, now))
          .map((m) => m.id);
        const reported = complaints.length >= settings.minMentionsForCheck;
        let row: FlowCheck;
        if (item.answeredBy === 'both' && existing?.origin === 'walkthrough') {
          const walked = existing.answer === 'disputed' ? 'pass' : existing.answer;
          row = { ...existing, answer: walked === 'pass' && reported ? 'disputed' : walked, mentionRefs: complaints, updatedAt };
        } else {
          row = {
            flowId: flow.id, checklistId: checklist.id, itemKey: item.key, answer: reported ? 'reported_problem' : 'no_signal',
            stepRefs: [], mentionRefs: complaints, origin: 'reviews', updatedAt,
          };
        }
        if (existing && existing.origin === row.origin && existing.answer === row.answer && JSON.stringify(existing.mentionRefs) === JSON.stringify(row.mentionRefs)) continue;
        writeCheck(store, row, { overUser: false });
      }
    }
  });
}
