/**
 * The sections of the feedback bundle (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.3).
 *
 * Every section is built per business tree from an existing query function (`QUERIES`) or repository;
 * nothing is computed again from raw rows. A section is a list of `TreeBlock`s, one per tree, so no
 * row of one business ever stands among another's. Building a bundle reads the store and writes nothing.
 *
 * What a section copies: of a stored record it names the fields it takes and never copies the record.
 * The fields are numbers, labels, ids, classes, times and versions. Free-form values (a feedback
 * event's before / after, an outcome's evidence, a rated value, an id typed by an agent) go through
 * `figures` / `labelOrNumber` / `idOrText` (redact.ts), which keep no text and no key that is not a
 * plain identifier; an edit of the profile, whose shape the interviewer chose, is carried as the
 * sections that changed and how many values each held (`profileChange`). A failure message is carried
 * as its class and its first line (`shortReason`), and not at all when it is of withheld research
 * (`reasonHidden`); the metrics then count such a failure under its class alone. A report that is figures by construction (the metrics report, the
 * knowledge metrics, the outcomes report, a rule's effect) is carried as its query computes it. The
 * tester's own reasons are carried as typed, and only where the existing training export would carry
 * the record (`ExportGate`): a reason on something upload-derived or internal stays out, as there.
 *
 * `texts` (the fuller level only): the texts of review issues and council findings, the failure message
 * in full of every record a standard section carries shortened (runs, attempts, tasks, research runs,
 * experiments, retros, persona-learning runs) and the decision lines of the training export, under the
 * export's rules as they are.
 *
 * Not carried, because the store does not hold them: a run's reasoning effort (it is in the
 * configuration, and on a persona panel read as its seat), the kind of request a run was started for
 * (`kind` here is the run's tag: normal, experiment, audit or council member), and idle time.
 */
import type { BifConfig } from '../config/schema.js';
import { councilMemberOf, councilReviewedTaskIds, councilRounds, type CouncilRound } from '../council/store.js';
import { escalationRequests, taskReruns } from '../escalation/context.js';
import { actorOf, listFeedback, type FeedbackEvent } from '../feedback/events.js';
import { ratingsWithSignals } from '../feedback/signals.js';
import { BUDGET_RUN_ID, budgetStatus } from '../harness/budget.js';
import { knowledgeMetrics, knowledgeSignals } from '../knowledge/metrics.js';
import { compareExperiment, listExperiments } from '../learning/experiments.js';
import { rulesWithEffect } from '../learning/lessons/engine.js';
import { LessonPrivacy } from '../learning/lessons/privacy.js';
import { collectLessonSignals, failureClass, policyActionKey, safePart, treeIds } from '../learning/lessons/signals.js';
import { lessonRepos } from '../learning/lessons/store.js';
import { listOutcomes, outcomeReport } from '../learning/outcomes.js';
import { auditMisses, auditSummary, listAudits } from '../learning/reviewerAudit.js';
import { issueRecurrence, listReviewIssues } from '../learning/reviewIssues.js';
import { runTags } from '../learning/runTags.js';
import { panelViews } from '../market/panelView.js';
import { METRICS_GROUP_BYS, metricsReport, type MetricsGroupBy } from '../metrics/report.js';
import { usageByRun } from '../metrics/usage.js';
import { personaLearningRepos } from '../personas/store.js';
import { listPolicyEvents } from '../policy/policyEvents.js';
import { STOPPED_REQUEST_RESPONSE } from '../research/stop.js';
import { exportTrainingData } from '../scoring/export.js';
import { withholding, type Withholding } from '../stakeholders/withheld.js';
import type { Store } from '../store/db.js';
import { usageRepos } from '../store/usageRepos.js';
import type { Rating } from '../types.js';
import { collectInteractions, interactionGate, interactionStats, openInteractions } from '../userPersona/interactions.js';
import { userPersonaSettings } from '../userPersona/settings.js';
import { audiencesOf, descendants, scopeOf } from '../workspace/tree.js';
import { isHidden } from '../stakeholders/personas.js';
import { countLeaves, figures, idOrText, labelOrNumber, plainKeys, redactConfiguration, redaction, shortReason, testerActor, type Redaction } from './redact.js';

export type BundleLevel = 'standard' | 'with_texts';

/** The rows of one business tree in a section, as named tables. */
export type TreeBlock = { tree: string; tables: Record<string, unknown[]> };

/**
 * The query functions the sections call. They are the functions the retro, the lessons engine and the
 * metrics view call (the completeness test checks they are the same functions, and which section calls
 * which); a test may pass wrapped copies to see the calls.
 */
export const QUERIES = {
  collectLessonSignals, listFeedback, ratingsWithSignals, listReviewIssues, issueRecurrence, listOutcomes, outcomeReport, listPolicyEvents,
  knowledgeSignals, knowledgeMetrics, auditMisses, listAudits, auditSummary, listExperiments, compareExperiment, rulesWithEffect, usageByRun,
  metricsReport, councilRounds, councilReviewedTaskIds, panelViews, collectInteractions, openInteractions, interactionStats, interactionGate,
  escalationRequests, taskReruns, budgetStatus, exportTrainingData,
};
export type Queries = typeof QUERIES;

export type SectionContext = {
  store: Store;
  config: BifConfig;
  level: BundleLevel;
  /** Inclusive ISO bounds on the time of a row; a row without a time is kept. */
  since?: string;
  until?: string;
  q: Queries;
  /** Whether the training export carries a record (computed once per bundle, on first use). */
  gate: ExportGate;
  withheld: Withholding;
  /** The whole-bundle rules (compiled once per bundle): a section asks them which keys of a free-form record say something. */
  redaction: Redaction;
};

type Tables = Record<string, unknown[]>;
type Builder = (ctx: SectionContext, root: string) => Tables;

// ---------------------------------------------------------------------------
// helpers

/** The object without its undefined values (so a row says only what it has). */
function row<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const inWindow = (ctx: Pick<SectionContext, 'since' | 'until'>, at: string | undefined): boolean =>
  !at || ((!ctx.since || at >= ctx.since) && (!ctx.until || at <= ctx.until));

const windowOf = (ctx: Pick<SectionContext, 'since' | 'until'>): { since?: string; until?: string } => ({
  ...(ctx.since ? { since: ctx.since } : {}),
  ...(ctx.until ? { until: ctx.until } : {}),
});

const msBetween = (from: string | undefined, to: string | undefined): number | undefined => {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms : undefined;
};

/** A failure as a row carries it: its class and the first line of its message; `hidden` (withheld research): nothing, the row's status says that it failed. */
const failure = (reason: string | undefined, hidden = false): { failureClass?: string; failureReason?: string } =>
  reason && !hidden ? row({ failureClass: failureClass(reason), failureReason: shortReason(reason) }) : {};

/** The figures of a free-form value, under keys that say nothing (`figures`, with the bundle's rules for what a key may be). */
const fig = (ctx: Pick<SectionContext, 'redaction'>, value: unknown): unknown => figures(value, undefined, ctx.redaction.flags);

/**
 * Whether the failure reason of a record is of withheld research (stakeholder design §7) and so stays
 * out of every section at both levels: a withheld run or task says that it failed, never why. One
 * rule per kind of record, used by the section that carries the short reason and by `texts`.
 */
const reasonHidden = {
  task: (ctx: SectionContext, taskId: string | undefined): boolean => (taskId ? ctx.withheld.task(ctx.store.tasks.get(taskId)) : false),
  /** A research run speaks for its tasks: hidden when one of them is withheld. */
  researchRun: (ctx: SectionContext, r: { id: string; workspaceId: string }): boolean =>
    ctx.store.tasks.list({ workspaceId: r.workspaceId, runId: r.id }).some((t) => ctx.withheld.task(t)),
  /** An experiment re-runs its source task: hidden when that task or one of its arm tasks is withheld. */
  experiment: (ctx: SectionContext, e: { sourceTaskId: string; arms: Array<{ taskIds: string[] }> }): boolean =>
    [e.sourceTaskId, ...e.arms.flatMap((a) => a.taskIds)].some((id) => reasonHidden.task(ctx, id)),
  /** A retro or a persona-learning run: hidden when its agent run is withheld. */
  agentRun: (ctx: SectionContext, agentRunId: string | undefined): boolean => ctx.withheld.run(agentRunId),
  /** A persona-learning run also when it learns about a stakeholder the person has not opened. */
  learningRun: (ctx: SectionContext, r: { personaId: string; agentRunId?: string }): boolean => {
    const persona = ctx.store.personas.get(r.personaId);
    return ctx.withheld.run(r.agentRunId) || (!!persona && isHidden(persona));
  },
};

/**
 * An edit of the profile as the bundle carries it. The profile's shape is the interviewer's, so
 * nothing of the edited part is copied, not even as figures: only which top-level sections changed
 * (a name that is not a plain identifier becomes `key_1`, …) and how many values each held before
 * and after.
 */
function profileChange(ctx: Pick<SectionContext, 'redaction'>, before: unknown, after: unknown): Array<{ section: string; leavesBefore: number; leavesAfter: number }> {
  const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const b = record(before);
  const a = record(after);
  const sections = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const names = plainKeys(sections, ctx.redaction.flags);
  return sections.map((k, i) => ({ section: names[i]!, leavesBefore: countLeaves(b[k]), leavesAfter: countLeaves(a[k]) }));
}

/**
 * Whether the existing training export carries a record, under its rules as they are: a feedback event
 * is carried when the default export has its line; a rating when the default export joins it to a line,
 * or when no export joins it at all and nothing it rests on is upload-derived, exposed or withheld; a
 * Decision is private when only the export with uploads has its line. Computed from the export itself
 * (run with and without uploads; the output with uploads is only compared, never written).
 */
export class ExportGate {
  private byWorkspace = new Map<string, { feedback: Set<string>; ratings: Set<string>; allRatings: Set<string>; decisions: Set<string>; privateDecisions: Set<string>; lines: unknown[] }>();
  private privacyCache?: LessonPrivacy;
  private privateTasks = new Map<string, boolean>();
  constructor(
    private readonly store: Store,
    private readonly q: Pick<Queries, 'exportTrainingData'>,
  ) {}

  private of(workspaceId: string) {
    let v = this.byWorkspace.get(workspaceId);
    if (!v) {
      type Line = { type?: string; decision?: { id: string }; ratings?: Array<{ id: string }>; feedbackEvent?: { id: string } };
      const parse = (jsonl: string): Line[] => jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
      const kept = parse(this.q.exportTrainingData(workspaceId, { store: this.store }));
      const all = parse(this.q.exportTrainingData(workspaceId, { store: this.store }, true));
      const decisionIds = (ls: Line[]) => new Set(ls.flatMap((l) => (l.type === 'decision' && l.decision ? [l.decision.id] : [])));
      const ratingIds = (ls: Line[]) => new Set(ls.flatMap((l) => (l.ratings ?? []).map((r) => r.id)));
      const decisions = decisionIds(kept);
      v = {
        feedback: new Set(kept.flatMap((l) => (l.type === 'feedback_event' && l.feedbackEvent ? [l.feedbackEvent.id] : []))),
        ratings: ratingIds(kept),
        allRatings: ratingIds(all),
        decisions,
        privateDecisions: new Set([...decisionIds(all)].filter((id) => !decisions.has(id))),
        lines: kept.filter((l) => l.type === 'decision'),
      };
      this.byWorkspace.set(workspaceId, v);
    }
    return v;
  }

  get privacy(): LessonPrivacy {
    this.privacyCache ??= new LessonPrivacy(this.store);
    return this.privacyCache;
  }

  /** The feedback event's reason may be carried (the default export has the event). */
  feedback(e: Pick<FeedbackEvent, 'id' | 'workspaceId'>): boolean {
    return this.of(e.workspaceId).feedback.has(e.id);
  }

  /** The same for a feedback event known by its id only, among the nodes of its tree. */
  feedbackId(workspaceIds: readonly string[], eventId: string): boolean {
    return workspaceIds.some((ws) => this.of(ws).feedback.has(eventId));
  }

  /** The rating's reason may be carried. A rating made from a feedback event (`feedbackRatings`) follows its event. */
  rating(r: Pick<Rating, 'id' | 'workspaceId' | 'targetId' | 'agentRunId'>): boolean {
    const w = this.of(r.workspaceId);
    if (r.id.startsWith('fbk_')) return w.feedback.has(r.id);
    if (w.ratings.has(r.id)) return true;
    if (w.allRatings.has(r.id)) return false;
    return !r.targetId.split(':').some((id) => this.privacy.blocked(id)) && !this.privacy.blocked(r.agentRunId);
  }

  /** The Decision is left out of the default export for uploads, upload exposure or as an internal record. */
  privateDecision(workspaceId: string, decisionId: string | undefined): boolean {
    return !!decisionId && this.of(workspaceId).privateDecisions.has(decisionId);
  }

  /** A task one of whose Decisions is private, or whose id is blocked for quoting (`LessonPrivacy`). */
  privateTask(workspaceId: string, taskId: string | undefined): boolean {
    if (!taskId) return false;
    let v = this.privateTasks.get(taskId);
    if (v === undefined) {
      const w = this.of(workspaceId);
      v =
        this.privacy.blocked(taskId) ||
        this.store.agentRuns.list({ taskId }).some((run) => this.store.decisions.list({ agentRunId: run.id }).some((d) => w.privateDecisions.has(d.id)));
      this.privateTasks.set(taskId, v);
    }
    return v;
  }

  /** The decision lines of the default training export of a workspace, parsed. */
  decisionLines(workspaceId: string): unknown[] {
    return this.of(workspaceId).lines;
  }
}

// ---------------------------------------------------------------------------
// sections

const trees: Builder = ({ store }, root) => {
  const nodes = [store.workspaces.get(root)!, ...descendants(store, root)];
  const depth = new Map<string, number>([[root, 0]]);
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parent = store.workspaces.get(id)?.parentWorkspaceId;
    const d = parent ? depthOf(parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const rows = nodes.map((w) => ({
    id: w.id,
    parentId: w.parentWorkspaceId ?? null,
    depth: depthOf(w.id),
    level: scopeOf(w).level,
    audiences: audiencesOf(w),
    createdAt: w.createdAt,
    tasks: store.tasks.list({ workspaceId: w.id }).length,
    findings: store.findings.list({ workspaceId: w.id }).length,
    recommendations: store.recommendations.list({ workspaceId: w.id }).length,
    personas: store.personas.list({ workspaceId: w.id }).length,
  }));
  const sum = (k: 'tasks' | 'findings' | 'recommendations' | 'personas') => rows.reduce((n, r) => n + r[k], 0);
  return {
    nodes: rows,
    totals: [{ nodes: rows.length, depth: Math.max(...rows.map((r) => r.depth)), tasks: sum('tasks'), findings: sum('findings'), recommendations: sum('recommendations'), personas: sum('personas') }],
  };
};

const runs: Builder = (ctx, root) => {
  const { store, q, withheld } = ctx;
  const ids = treeIds(store, root);
  const usage = new Map(q.usageByRun(store, ids).map((u) => [u.runId, u]));
  const inTime = new Set<string>();
  const runRows = ids
    .flatMap((ws) => store.agentRuns.list({ workspaceId: ws }))
    .filter((r) => inWindow(ctx, r.startedAt))
    .map((run) => {
      inTime.add(run.id);
      const tags = runTags(store, run.id);
      const member = councilMemberOf(store, run.id);
      const u = usage.get(run.id);
      // A run of withheld research says that it failed, never why (stakeholder design §7).
      const served = withheld.servedRun(run);
      return row({
        id: run.id,
        workspaceId: run.workspaceId,
        taskId: run.taskId,
        role: run.role,
        provider: run.model.provider,
        model: run.model.model,
        kind: tags?.experimentId ? 'experiment' : tags?.auditId ? 'audit' : member ? 'council_member' : 'normal',
        experimentId: tags?.experimentId,
        arm: tags?.arm,
        auditId: tags?.auditId,
        councilRoundId: member?.roundId,
        councilMember: member?.member,
        lessonsOff: tags?.lessonsOff || undefined,
        taskType: run.taskType,
        round: run.round,
        attempts: run.attempts,
        status: run.status,
        exitCode: run.exitCode,
        ...failure(served.failureReason),
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: msBetween(run.startedAt, run.endedAt),
        promptVersion: run.promptVersion,
        usage: u
          ? {
              inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
              totalTokens: u.totalTokens, costUsd: u.costUsd, cliReportedCostUsd: u.cliReportedCostUsd, unpriced: u.unpriced,
            }
          : undefined,
      });
    });
  const attempts = ids
    .flatMap((ws) => usageRepos(store).agentRunAttempts.list({ workspaceId: ws }))
    .filter((a) => inTime.has(a.runId))
    .map((a) => {
      const served = withheld.servedAttempt(a);
      return row({
        id: a.id, runId: a.runId, attempt: a.attempt, startedAt: a.startedAt, endedAt: a.endedAt, durationMs: msBetween(a.startedAt, a.endedAt),
        exitCode: a.exitCode, rateLimited: a.rateLimited, backoffMs: a.backoffMs, ...failure(served.failureReason),
      });
    });
  return { runs: runRows, attempts };
};

const tasks: Builder = (ctx, root) => {
  const { store, q } = ctx;
  const ids = treeIds(store, root);
  const taskRows = ids.flatMap((ws) => {
    const council = q.councilReviewedTaskIds(store, ws);
    return store.tasks
      .list({ workspaceId: ws })
      .filter((t) => inWindow(ctx, t.createdAt))
      .map((t) => {
        const taskRuns = store.agentRuns.list({ taskId: t.id });
        const firstRunAt = taskRuns.map((r) => r.startedAt).sort()[0];
        const lastRunEndedAt = taskRuns.flatMap((r) => (r.endedAt ? [r.endedAt] : [])).sort().at(-1);
        return row({
          id: t.id, workspaceId: t.workspaceId, researchRunId: t.runId, phase: t.phase, type: t.type, status: t.status, round: t.round,
          submittedRound: t.submittedRound, step: t.step, needsBrowser: t.needsBrowser, provider: t.model.provider, model: t.model.model,
          // A withheld task says that it failed, never why.
          councilReviewed: council.has(t.id), runs: taskRuns.length, ...failure(t.failureReason, ctx.withheld.task(t)), createdAt: t.createdAt, firstRunAt, lastRunEndedAt,
          durationMs: msBetween(firstRunAt, lastRunEndedAt),
        });
      });
  });
  const researchRuns = ids
    .flatMap((ws) => store.researchRuns.list({ workspaceId: ws }))
    .filter((r) => inWindow(ctx, r.startedAt))
    .map((r) =>
      row({
        id: r.id, workspaceId: r.workspaceId, phase: r.phase, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
        durationMs: msBetween(r.startedAt, r.endedAt), scheduled: !!r.scheduleId, pipelineId: r.pipelineId,
        ...failure(r.failureReason, reasonHidden.researchRun(ctx, r)),
      }),
    );
  const pipelines = ids
    .flatMap((ws) => store.pipelines.list({ workspaceId: ws }))
    .filter((p) => inWindow(ctx, p.startedAt))
    .map((p) =>
      row({
        id: p.id, workspaceId: p.workspaceId, phases: p.phases, nextIndex: p.nextIndex, status: p.status, scheduled: !!p.scheduleId,
        startedAt: p.startedAt, endedAt: p.endedAt, durationMs: msBetween(p.startedAt, p.endedAt),
      }),
    );
  return { tasks: taskRows, researchRuns, pipelines };
};

/** A council round as figures: who sat, what each gave, and the counts of what the round made of it. */
function councilRoundRow(taskId: string, r: CouncilRound) {
  const upheld = r.result.issues.filter((i) => i.standing === 'upheld').length;
  return row({
    taskId, round: r.round, decisionId: r.decisionId, at: r.at, pass: r.result.pass, score: r.result.score, failed: r.failed !== undefined,
    upheld, advisory: r.result.issues.length - upheld, dropped: r.result.dropped.length, questions: r.result.questions.length,
    followUps: r.result.followUps.length,
    members: r.result.members.map((m) =>
      row({
        name: m.name, provider: m.provider, model: m.model, lens: m.lens, blocking: m.blocking, state: m.state, runId: m.runId, score: m.score,
        countedScore: m.countedScore, unsupportedScore: m.unsupportedScore,
      }),
    ),
  });
}

const reviewRounds: Builder = (ctx, root) => {
  const { store, q } = ctx;
  const ids = treeIds(store, root);
  const modelOf = (runId: string | undefined) => {
    const m = runId ? store.agentRuns.get(runId)?.model : undefined;
    return m ? `${m.provider}/${m.model}` : undefined;
  };
  const issues = q
    .listReviewIssues(store, { workspaceIds: ids, includeSynthetic: true, ...(ctx.since ? { since: ctx.since } : {}) })
    .filter((i) => inWindow(ctx, i.createdAt))
    .map((i) =>
      row({
        id: i.id, workspaceId: i.workspaceId, taskId: i.taskId, round: i.round, issueId: i.issueId, class: i.class, status: i.status,
        synthetic: i.synthetic, reviewerRunId: i.reviewerRunId, reviewerModel: modelOf(i.reviewerRunId), reviewDecisionId: i.reviewDecisionId,
        workerRunId: i.workerRunId, workerPromptVersion: i.workerPromptVersion, evidence: i.evidence.length, answered: i.responseReason !== undefined,
        createdAt: i.createdAt, resolvedAt: i.resolvedAt,
      }),
    );
  const recurrence = q.issueRecurrence(store, ids, { byPromptVersion: true, ...windowOf(ctx) }).map((g) => ({ ...g }));
  const council = ids.flatMap((ws) =>
    [...q.councilReviewedTaskIds(store, ws)].flatMap((taskId) =>
      q.councilRounds(store, taskId).filter((r) => inWindow(ctx, r.at)).map((r) => councilRoundRow(taskId, r)),
    ),
  );
  return { issues, recurrence, councilRounds: council };
};

const outcomes: Builder = (ctx, root) => {
  const { store, q } = ctx;
  const ids = treeIds(store, root);
  const rows = q
    .listOutcomes(store, { workspaceIds: ids, includeExperiments: true, ...(ctx.since ? { since: ctx.since } : {}) })
    .filter((o) => inWindow(ctx, o.createdAt))
    .map((o) =>
      row({
        id: o.id, workspaceId: o.workspaceId, decisionId: o.decisionId, subjectType: o.subjectType === undefined ? undefined : safePart(o.subjectType), subjectId: idOrText(o.subjectId), runId: o.runId,
        outcome: safePart(o.outcome), label: o.label, source: o.source, actor: testerActor(o.actor), taskId: o.taskId, targetType: o.targetType,
        targetId: idOrText(o.targetId), role: o.role, taskType: o.taskType, promptVersion: o.promptVersion, evidence: fig(ctx, o.evidenceJson),
        createdAt: o.createdAt,
      }),
    );
  // The outcomes report as the outcomes page computes it (not windowed: it counts every outcome of the tree).
  const report = q.outcomeReport(store, ids).rows.map((r) => ({ ...r }));
  return { outcomes: rows, report };
};

const lessonSignals: Builder = (ctx, root) => ({
  signals: ctx.q.collectLessonSignals(ctx.store, root, windowOf(ctx), ctx.config).map((s) =>
    row({
      role: s.role, category: s.category, unit: s.unit, source: s.source, taskId: s.taskId, agentRunId: s.agentRunId, promptVersion: s.promptVersion,
      refId: s.refId, createdAt: s.createdAt,
    }),
  ),
});

const lessons: Builder = (ctx, root) => {
  const { store, q, gate } = ctx;
  const ids = treeIds(store, root);
  const repos = lessonRepos(store);
  const rules = q.rulesWithEffect(store, root).map(({ rule, effect }) =>
    row({
      id: rule.id, role: rule.role, category: rule.category, marker: rule.marker, strength: rule.strength, version: rule.version, status: rule.status,
      source: rule.source, proposalId: rule.proposalId, createdAt: rule.createdAt, changedAt: rule.changedAt, endedAt: rule.endedAt,
      promptVersionBefore: rule.promptVersionBefore, promptVersionAfter: rule.promptVersionAfter, effect,
    }),
  );
  const proposals = repos.proposals
    .list({ rootWorkspaceId: root })
    .filter((p) => inWindow(ctx, p.createdAt))
    .map((p) => {
      const carried = !p.feedbackEventId || gate.feedbackId(ids, p.feedbackEventId);
      return row({
        id: p.id, role: p.role, action: p.action, category: p.category, ruleId: p.ruleId, source: p.source, retroId: p.retroId, status: p.status,
        evidence: p.evidence.length, stats: fig(ctx, p.stats), createdAt: p.createdAt, decidedAt: p.decidedAt, decisionId: p.decisionId,
        feedbackEventId: p.feedbackEventId,
        // The tester's reason, as typed, where the export would carry the decision's event.
        reason: p.reason && carried ? p.reason : undefined,
      });
    });
  const retros = repos.retros
    .list({ rootWorkspaceId: root })
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) =>
      row({
        id: r.id, status: r.status, triggeredBy: r.triggeredBy, windowStart: r.windowStart, windowEnd: r.windowEnd, agentRunId: r.agentRunId,
        digest: fig(ctx, r.digest), evidenceIds: r.evidenceIds.length, proposalIds: r.proposalIds,
        ...failure(r.failureReason, reasonHidden.agentRun(ctx, r.agentRunId)), createdAt: r.createdAt,
        endedAt: r.endedAt,
      }),
    );
  return { rules, proposals, retros };
};

const feedback: Builder = (ctx, root) => {
  const { store, q, gate } = ctx;
  const ids = treeIds(store, root);
  const events = ids
    .flatMap((ws) => q.listFeedback(store, { workspaceId: ws }))
    .filter((e) => inWindow(ctx, e.createdAt))
    .map((e) => {
      const carried = gate.feedback(e);
      // The edited part of a profile has the interviewer's shape: nothing of it is copied (`profileChange`).
      const profile = e.kind === 'profile_edit';
      return row({
        id: e.id, workspaceId: e.workspaceId, actor: testerActor(e.actor), createdAt: e.createdAt, kind: e.kind, targetType: e.targetType,
        targetId: idOrText(e.targetId),
        before: profile || e.beforeJson === undefined ? undefined : fig(ctx, e.beforeJson),
        after: profile || e.afterJson === undefined ? undefined : fig(ctx, e.afterJson),
        profileChange: profile ? profileChange(ctx, e.beforeJson, e.afterJson) : undefined,
        reason: carried ? e.reason : undefined, reasonWithheld: e.reason && !carried ? true : undefined, agentRunId: e.agentRunId,
        promptVersion: e.promptVersion,
      });
    });
  // Explicit ratings (`store.ratings`) and the rows made from include overrides, as calibration and the metrics view read them.
  const ratings = ids
    .flatMap((ws) => q.ratingsWithSignals(store, ws, store.ratings.list({ workspaceId: ws })))
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) => {
      const carried = gate.rating(r);
      return row({
        id: r.id, workspaceId: r.workspaceId, actor: testerActor(r.actor), targetType: r.targetType, targetId: idOrText(r.targetId),
        criterion: safePart(r.criterion), agentValue: labelOrNumber(r.agentValue), verdict: r.verdict, userValue: labelOrNumber(r.userValue),
        reason: carried ? r.reason : undefined, reasonWithheld: r.reason && !carried ? true : undefined, createdAt: r.createdAt,
        agentRunId: r.agentRunId, promptVersion: r.promptVersion,
      });
    });
  return { events, ratings };
};

/** What a policy event's site says without naming a site: the tool's own markers keep their class. */
const siteClass = (site: string | undefined): string | undefined =>
  site === undefined ? undefined : site.startsWith('budget:') ? 'budget' : site.startsWith('knowledge:') ? safePart(site) : 'site';

const policy: Builder = (ctx, root) => {
  const { store, q, config } = ctx;
  const events = q
    .listPolicyEvents(store, { workspaceId: root, ...(ctx.since ? { since: ctx.since } : {}) })
    .filter((e) => inWindow(ctx, e.createdAt))
    .map((e) =>
      row({
        id: e.id, workspaceId: e.workspaceId, agentRunId: e.agentRunId, taskId: e.taskId, role: e.role, kind: e.kind,
        actionClass: policyActionKey(e.action, config), site: siteClass(e.site), requestId: e.requestId, createdAt: e.createdAt,
      }),
    );
  const counts = new Map<string, { kind: string; actionClass: string; count: number }>();
  for (const e of events) {
    const key = `${e.kind}\u0000${e.actionClass}`;
    const c = counts.get(key) ?? { kind: e.kind, actionClass: e.actionClass, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  return { events, counts: [...counts.values()] };
};

const knowledge: Builder = (ctx, root) => {
  const { store, q, config } = ctx;
  const filter = { workspaceId: root, scope: 'tree' as const, ...windowOf(ctx), config: { knowledge: config.knowledge }, dataDir: config.dataDir };
  const m = q.knowledgeMetrics(store, filter);
  const { byTool, byGroup, ...retrieval } = m.retrieval;
  return {
    store: [m.store],
    freshness: [m.freshness],
    ocr: [m.ocr],
    retrieval: [retrieval],
    retrievalByTool: byTool,
    retrievalByGroup: byGroup,
    usageTotal: [m.usage.total],
    usageByRole: m.usage.byRole,
    usageByModel: m.usage.byModel,
    usageByPromptVersion: m.usage.byPromptVersion,
    usageByTask: m.usage.byTask,
    // The machine signals the lessons engine reads (`knowledgeSignals`).
    signals: q.knowledgeSignals(store, filter),
  };
};

const GROUP_TABLE: Record<MetricsGroupBy, string> = { role: 'byRole', task_type: 'byTaskType', model: 'byModel', prompt_version: 'byPromptVersion' };

/**
 * The failures of the metrics report, each reason as its class and first line. The report groups the
 * runs by their whole reason, withheld research among them; a reason that is also the reason of a
 * withheld run is not carried: its runs are counted under the failure class alone, one row per class.
 */
function failuresByReason(ctx: SectionContext, root: string, failures: Array<{ reason: string; runs: number }>): unknown[] {
  const { store, withheld } = ctx;
  const hiddenReasons = new Set(
    treeIds(store, root).flatMap((ws) => store.agentRuns.list({ workspaceId: ws }).flatMap((r) => (r.failureReason && withheld.run(r.id) ? [r.failureReason] : []))),
  );
  const out: unknown[] = [];
  const byClass = new Map<string, number>();
  for (const f of failures) {
    if (hiddenReasons.has(f.reason)) byClass.set(failureClass(f.reason), (byClass.get(failureClass(f.reason)) ?? 0) + f.runs);
    else out.push({ ...failure(f.reason), runs: f.runs });
  }
  for (const [cls, runs] of byClass) out.push({ failureClass: cls, runs });
  return out;
}

const metrics: Builder = (ctx, root) => {
  const { store, q, config } = ctx;
  const report = (groupBy: MetricsGroupBy) =>
    q.metricsReport(store, { workspaceId: root, scope: 'tree', groupBy, bucket: 'week', ...windowOf(ctx), config: { knowledge: config.knowledge }, dataDir: config.dataDir });
  const first = report('role');
  const tables: Tables = {
    totals: [first.totals],
    experiments: [first.experiments],
    byWeek: first.series,
    failuresByReason: failuresByReason(ctx, root, first.failuresByReason),
    reviewIssuesByClass: first.reviewIssuesByClass,
    knowledgeByRole: first.knowledge.byGroup,
  };
  for (const groupBy of METRICS_GROUP_BYS) tables[GROUP_TABLE[groupBy]] = groupBy === 'role' ? first.groups : report(groupBy).groups;
  return tables;
};

const audits: Builder = (ctx, root) => {
  const { store, q, withheld } = ctx;
  const all = q.listAudits(store, { rootWorkspaceId: root }).filter((a) => inWindow(ctx, a.createdAt));
  const classCounts = (issues: Array<{ class: string }>) => {
    const out: Record<string, number> = {};
    for (const i of issues) out[safePart(i.class)] = (out[safePart(i.class)] ?? 0) + 1;
    return out;
  };
  const model = (m: { provider: string; model: string } | undefined) => (m ? `${m.provider}/${m.model}` : undefined);
  const auditRows = all.map((raw) => {
    const a = withheld.servedAudit(raw);
    return row({
      id: a.id, batchId: a.batchId, workspaceId: a.workspaceId, taskId: a.taskId, taskType: a.taskType, startedBy: a.startedBy,
      actor: testerActor(a.actor), scheduled: !!a.scheduleId, status: a.status, verdict: a.verdict, passThreshold: a.passThreshold,
      originalDecisionId: a.originalDecisionId, originalRunId: a.originalRunId, originalModel: model(a.originalModel),
      originalPromptVersion: a.originalPromptVersion, originalScore: a.originalScore, auditModel: model(a.auditModel), auditRunId: a.auditRunId,
      auditDecisionId: a.auditDecisionId, auditPromptVersion: a.auditPromptVersion, auditScore: a.auditScore, issues: a.auditIssues.length,
      issueClasses: classCounts(a.auditIssues), outcomeId: a.outcomeId, createdAt: a.createdAt, endedAt: a.endedAt,
    });
  });
  // The misses as the lessons engine reads them (`auditMisses`).
  const misses = q
    .auditMisses(store, { rootWorkspaceId: root, ...(ctx.since ? { since: ctx.since } : {}) })
    .filter((m) => inWindow(ctx, m.createdAt))
    .map((raw) => {
      const m = withheld.servedAuditMiss(raw);
      return row({
        auditId: m.auditId, workspaceId: m.workspaceId, taskId: m.taskId, taskType: m.taskType, role: m.role, promptVersion: m.promptVersion,
        originalModel: model(m.originalModel), originalScore: m.originalScore, auditModel: model(m.auditModel), auditScore: m.auditScore,
        classes: (m.classes as string[]).map((c) => safePart(c)), outcomeId: m.outcomeId, createdAt: m.createdAt,
      });
    });
  const experiments = treeIds(store, root)
    .flatMap((ws) => q.listExperiments(store, ws))
    .filter((e) => inWindow(ctx, e.createdAt))
    .map((e) => {
      const cmp = q.compareExperiment(store, e.id);
      return row({
        id: e.id, workspaceId: e.workspaceId, sourceTaskId: e.sourceTaskId, researchRunId: e.researchRunId, repeats: e.repeats, status: e.status,
        actor: testerActor(e.actor), ...failure(e.failureReason, reasonHidden.experiment(ctx, e)), createdAt: e.createdAt, endedAt: e.endedAt,
        arms: (cmp?.arms ?? []).map((a) =>
          row({
            arm: a.arm, model: model(a.model), promptVersion: a.promptVersion, workerPromptVersions: a.workerPromptVersions,
            reviewerModels: a.reviewerModels.map(model), finished: a.finished, verified: a.verified, passRate: a.passRate,
            firstRoundPassRate: a.firstRoundPassRate, meanRounds: a.meanRounds, reviewScores: a.reviewScores, meanReviewScore: a.meanReviewScore,
            userRatings: a.userRatings, cost: a.cost, costPerTask: a.costPerTask,
            // An arm task is a task: withheld research says that it failed, never why.
            tasks: a.tasks.map((t) =>
              row({ taskId: t.taskId, status: t.status, round: t.round, finalScore: t.finalScore, ...failure(t.failureReason, reasonHidden.task(ctx, t.taskId)) }),
            ),
          }),
        ),
      });
    });
  return { audits: auditRows, summary: [q.auditSummary(all)], misses, experiments };
};

const personas: Builder = (ctx, root) => {
  const { store, q, config, gate } = ctx;
  const ids = treeIds(store, root);
  const repos = personaLearningRepos(store);
  const kindOf = (personaId: string) => store.personas.get(personaId)?.kind ?? 'segment';
  const learningRuns = repos.runs
    .list({ rootWorkspaceId: root })
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) =>
      row({
        id: r.id, personaId: r.personaId, personaKind: kindOf(r.personaId), retroId: r.retroId, status: r.status, signalsThrough: r.signalsThrough,
        shownSignals: r.shownSignalIds.length, shownStatements: r.shownStatementIds.length, stats: fig(ctx, r.stats), agentRunId: r.agentRunId,
        ...failure(r.failureReason, reasonHidden.learningRun(ctx, r)), createdAt: r.createdAt, endedAt: r.endedAt,
      }),
    );
  const proposals = repos.proposals
    .list({ rootWorkspaceId: root })
    .filter((p) => inWindow(ctx, p.createdAt))
    .map((p) => {
      // An internal proposal (stakeholder statements) keeps the tester's reason out, as the export does.
      const carried = !p.internal && (!p.feedbackEventId || gate.feedbackId(ids, p.feedbackEventId));
      return row({
        id: p.id, workspaceId: p.workspaceId, personaId: p.personaId, personaKind: kindOf(p.personaId), runId: p.runId, action: p.action,
        adjustmentId: p.adjustmentId, evidence: p.evidence.length, stats: fig(ctx, p.stats), source: p.source, status: p.status,
        edited: p.finalText !== undefined && p.finalText !== p.text, internal: p.internal || undefined, createdAt: p.createdAt,
        decidedAt: p.decidedAt, reason: p.reason && carried ? p.reason : undefined, decisionId: p.decisionId,
      });
    });
  const adjustments = repos.adjustments
    .list({ rootWorkspaceId: root })
    .filter((a) => inWindow(ctx, a.createdAt))
    .map((a) =>
      row({
        id: a.id, workspaceId: a.workspaceId, personaId: a.personaId, personaKind: kindOf(a.personaId), version: a.version, status: a.status,
        source: a.source, proposalId: a.proposalId, stats: fig(ctx, a.stats), internal: a.internal || undefined, createdAt: a.createdAt,
        changedAt: a.changedAt, endedAt: a.endedAt, personaVersion: a.personaVersion,
      }),
    );
  // The persona panel as its page computes it (`panelViews`), as counts.
  const panel = ids.flatMap((ws) => {
    const recs = store.recommendations.list({ workspaceId: ws }).filter((r) => inWindow(ctx, r.createdAt));
    const views = q.panelViews(store, config, ws, recs);
    return recs.flatMap((rec) => {
      const v = views.get(rec.id);
      if (!v) return [];
      return [
        row({
          recommendationId: rec.id, workspaceId: ws, reactions: rec.personaFeedback.length, markedSameAsBaseline: v.leftOut,
          disagreement: v.disagreement, earlierRounds: v.earlierRounds.length,
          maxRound: Math.max(0, ...rec.personaFeedback.map((f) => f.round ?? 1), ...v.earlierRounds.map((r) => r.round)),
          unavailable: v.unavailable.length, limitReached: v.limitReached.length,
          baseline: v.baseline ? { current: v.baseline.current, earlier: v.baseline.earlier.length } : undefined,
          baselineUnavailable: v.baselineUnavailable !== undefined || undefined, baselineLimitReached: v.baselineLimitReached,
        }),
      ];
    });
  });
  const panelReads = ids
    .flatMap((ws) => store.personaPanelReads.list({ workspaceId: ws }))
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) => {
      const reaction = r.reaction as { seat?: { provider: string; model: string; effort?: string }; sameAsBaseline?: boolean };
      return row({
        id: r.id, workspaceId: r.workspaceId, recommendationId: r.recommendationId, kind: r.kind, personaId: r.personaId, round: r.round,
        agentRunId: r.agentRunId, seat: reaction.seat ? row({ provider: reaction.seat.provider, model: reaction.seat.model, effort: reaction.seat.effort }) : undefined,
        sameAsBaseline: reaction.sameAsBaseline, createdAt: r.createdAt,
      });
    });
  // The user persona's gate, as the You page computes it, for the configured person.
  const actor = actorOf(config);
  const settings = userPersonaSettings(config);
  const stats = q.interactionStats(q.collectInteractions(store, root, actor, windowOf(ctx)));
  const g = q.interactionGate(q.openInteractions(store, settings, root, actor, new Date()), settings);
  const userPersonaGate = [
    { enabled: settings.enabled, interactions: stats.total, byKind: stats.byKind, open: g.n, targets: g.targets, qualifies: g.qualifies,
      minInteractions: settings.minInteractions, minDistinctTargets: settings.minDistinctTargets },
  ];
  return { learningRuns, proposals, adjustments, panel, panelReads, userPersonaGate };
};

const escalations: Builder = (ctx, root) => {
  const { store, q } = ctx;
  const rows = treeIds(store, root).flatMap((ws) =>
    store.tasks.list({ workspaceId: ws }).flatMap((task) => {
      const asked = q.escalationRequests(store, task).filter((r) => inWindow(ctx, r.createdAt));
      if (!asked.length) return [];
      const answered = asked.filter((r) => r.status === 'resolved');
      const chose = answered.filter((r) => r.optionsJson?.choice !== undefined);
      return [
        row({
          taskId: task.id, workspaceId: ws, taskType: task.type, taskStatus: task.status, questions: asked.length, answered: answered.length,
          dismissed: asked.filter((r) => r.status === 'denied').length, pending: asked.filter((r) => r.status === 'pending').length,
          choseRecommended: chose.filter((r) => r.optionsJson!.choice === r.optionsJson!.recommended).length,
          choseOther: chose.filter((r) => r.optionsJson!.choice !== r.optionsJson!.recommended).length,
          answeredInOwnWords: answered.length - chose.length, reruns: q.taskReruns(store, task).length,
          askedAt: asked.map((r) => r.createdAt).sort()[0], answeredAt: asked.flatMap((r) => (r.resolvedAt ? [r.resolvedAt] : [])).sort().at(-1),
        }),
      ];
    }),
  );
  return { escalations: rows };
};

const budgets: Builder = (ctx, root) => {
  const { store, q, config } = ctx;
  const ids = treeIds(store, root);
  const status = ids.flatMap((ws) => {
    const pipelines = store.pipelines.list({ workspaceId: ws });
    const all = [...q.budgetStatus(store, config, ws), ...pipelines.flatMap((p) => q.budgetStatus(store, config, ws, p.id).filter((s) => s.kind === 'pipeline'))];
    return all.map((s) =>
      row({
        workspaceId: ws, scope: s.kind, scopeId: s.id, cap: s.cap, extensions: s.extensions, effectiveCap: s.effectiveCap, spent: s.spent,
        exceeded: s.exceeded, denied: s.denied, pending: s.pendingRequestId !== undefined,
      }),
    );
  });
  // Each time a cap was reached the person was asked once (a request raised by the budget itself).
  const events = ids
    .flatMap((ws) => store.userRequests.list({ workspaceId: ws, agentRunId: BUDGET_RUN_ID }))
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) => {
      const [, scope, scopeId] = (r.site ?? '').split(':');
      return row({
        id: r.id, workspaceId: r.workspaceId, scope, scopeId, decision: r.status === 'resolved' ? 'extended' : r.status === 'denied' ? 'denied' : 'pending',
        askedAt: r.createdAt, decidedAt: r.resolvedAt, waitedMs: msBetween(r.createdAt, r.resolvedAt),
      });
    });
  return { status, events };
};

/**
 * Requests to the person. `status` is the stored one. A request that "Stop research" closed is stored
 * as `denied` with the stop's response (`STOPPED_REQUEST_RESPONSE`; the policy events tell it apart
 * the same way): its row says `closedBy: 'stop'`, so a reader does not count it as a denial by the
 * person. The response itself is never carried.
 */
const requests: Builder = (ctx, root) => ({
  requests: treeIds(ctx.store, root)
    .flatMap((ws) => ctx.store.userRequests.list({ workspaceId: ws }))
    .filter((r) => inWindow(ctx, r.createdAt))
    .map((r) =>
      row({
        id: r.id, workspaceId: r.workspaceId, taskId: r.taskId, agentRunId: r.agentRunId === BUDGET_RUN_ID ? BUDGET_RUN_ID : r.agentRunId,
        kind: r.kind, raisedBy: r.agentRunId === BUDGET_RUN_ID ? 'budget' : 'agent', status: r.status,
        closedBy: r.status === 'denied' && r.response === STOPPED_REQUEST_RESPONSE ? 'stop' : undefined,
        askedAt: r.createdAt, answeredAt: r.resolvedAt,
        waitedMs: msBetween(r.createdAt, r.resolvedAt), actor: r.status === 'pending' ? undefined : testerActor(r.actor),
      }),
    ),
});

/**
 * The fuller level's texts, each under the rules of the training export as they are (`ExportGate`):
 * a text of a task that has a private Decision, or that `LessonPrivacy` blocks, is named by id only.
 */
const texts: Builder = (ctx, root) => {
  const { store, q, gate, withheld } = ctx;
  const ids = treeIds(store, root);
  const blocked = (...refs: Array<string | undefined>) => refs.some((id) => gate.privacy.blocked(id));
  const reviewIssues = q
    .listReviewIssues(store, { workspaceIds: ids, includeSynthetic: true, ...(ctx.since ? { since: ctx.since } : {}) })
    .filter((i) => inWindow(ctx, i.createdAt))
    .map((i) => {
      const hidden =
        gate.privateDecision(i.workspaceId, i.reviewDecisionId) || gate.privateDecision(i.workspaceId, i.responseDecisionId) ||
        gate.privateTask(i.workspaceId, i.taskId) || blocked(i.id, i.reviewerRunId, i.workerRunId, ...i.evidence);
      return hidden ? { id: i.id, withheld: true } : row({ id: i.id, text: i.text, response: i.responseReason });
    });
  const councilFindings = ids.flatMap((ws) =>
    [...q.councilReviewedTaskIds(store, ws)].flatMap((taskId) =>
      q.councilRounds(store, taskId).filter((r) => inWindow(ctx, r.at)).map((r) => {
        if (gate.privateDecision(ws, r.decisionId) || gate.privateTask(ws, taskId) || blocked(r.decisionId)) return { decisionId: r.decisionId, taskId, round: r.round, withheld: true };
        return row({
          decisionId: r.decisionId, taskId, round: r.round, failed: r.failed,
          issues: r.result.issues.map((i) => row({ id: i.id, class: i.class, standing: i.standing, raisedBy: i.raisedBy, text: i.description, wordings: i.wordings })),
          dropped: r.result.dropped.map((d) => row({ id: d.issue.id, class: d.issue.class, rule: d.rule, raisedBy: d.raisedBy, text: d.issue.description })),
          questions: r.result.questions, followUps: r.result.followUps,
          memberReasons: r.result.members.flatMap((m) => (m.reason ? [{ name: m.name, reason: m.reason }] : [])),
        });
      }),
    ),
  );
  const failures: unknown[] = [];
  const fail = (kind: string, id: string, message: string | undefined, hidden: boolean) => {
    if (message) failures.push(hidden ? { kind, id, withheld: true } : { kind, id, message });
  };
  for (const ws of ids) {
    for (const run of store.agentRuns.list({ workspaceId: ws })) {
      if (!inWindow(ctx, run.startedAt)) continue;
      fail('run', run.id, run.failureReason, withheld.run(run.id) || gate.privateTask(ws, run.taskId) || blocked(run.id));
    }
    for (const a of usageRepos(store).agentRunAttempts.list({ workspaceId: ws })) {
      if (!inWindow(ctx, a.startedAt)) continue;
      fail('attempt', a.id, a.failureReason, withheld.run(a.runId) || gate.privateTask(ws, store.agentRuns.get(a.runId)?.taskId) || blocked(a.runId));
    }
    for (const t of store.tasks.list({ workspaceId: ws })) {
      if (!inWindow(ctx, t.createdAt)) continue;
      fail('task', t.id, t.failureReason, withheld.task(t) || gate.privateTask(ws, t.id));
    }
    for (const r of store.researchRuns.list({ workspaceId: ws })) {
      if (inWindow(ctx, r.startedAt)) fail('research_run', r.id, r.failureReason, reasonHidden.researchRun(ctx, r));
    }
    for (const e of q.listExperiments(store, ws)) {
      if (inWindow(ctx, e.createdAt)) fail('experiment', e.id, e.failureReason, reasonHidden.experiment(ctx, e) || gate.privateTask(ws, e.sourceTaskId));
    }
  }
  // The other records whose failure a standard section shortens: retros and persona-learning runs.
  for (const r of lessonRepos(store).retros.list({ rootWorkspaceId: root })) {
    if (inWindow(ctx, r.createdAt)) fail('retro', r.id, r.failureReason, reasonHidden.agentRun(ctx, r.agentRunId) || blocked(r.id, r.agentRunId));
  }
  for (const r of personaLearningRepos(store).runs.list({ rootWorkspaceId: root })) {
    if (inWindow(ctx, r.createdAt)) fail('persona_learning_run', r.id, r.failureReason, reasonHidden.learningRun(ctx, r) || blocked(r.id, r.agentRunId, r.personaId));
  }
  const decisionLines = ids.flatMap((ws) => gate.decisionLines(ws)).filter((l) => inWindow(ctx, (l as { decision?: { createdAt?: string } }).decision?.createdAt));
  return { reviewIssues, councilFindings, failures, decisionLines };
};

/** The per-tree sections, in file order. */
export const SECTION_BUILDERS = {
  trees, runs, tasks, reviewRounds, outcomes, lessonSignals, lessons, feedback, policy, knowledge, metrics, audits, personas, escalations, budgets, requests, texts,
} satisfies Record<string, Builder>;

export type TreeSectionName = keyof typeof SECTION_BUILDERS;

/** The roots of the business trees, in the order they were made. */
export function treeRoots(store: Store): string[] {
  return store.workspaces.list().filter((w) => !w.parentWorkspaceId).map((w) => w.id);
}

/** The context of one bundle: the query functions (default: the real ones) and the per-bundle caches. */
export function sectionContext(
  deps: { store: Store; config: BifConfig },
  opts: { level: BundleLevel; since?: string; until?: string },
  q: Queries = QUERIES,
): SectionContext {
  return {
    store: deps.store, config: deps.config, level: opts.level, q, gate: new ExportGate(deps.store, q), withheld: withholding(deps.store),
    // The fuller level keeps web addresses in the texts it carries; the standard level writes `<url>`.
    redaction: redaction(deps, { keepUrls: opts.level === 'with_texts', keepCompetitorNames: opts.level === 'with_texts' }),
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
  };
}

/** One per-tree section: a block per business tree. */
export function buildSection(ctx: SectionContext, name: TreeSectionName): TreeBlock[] {
  return treeRoots(ctx.store).map((root) => ({ tree: root, tables: SECTION_BUILDERS[name](ctx, root) }));
}

/** Every section of a bundle at the context's level (`texts` only at the fuller level), unredacted. */
export function buildSections(ctx: SectionContext): Record<string, unknown> {
  const out: Record<string, unknown> = { configuration: redactConfiguration(ctx.config) };
  for (const name of Object.keys(SECTION_BUILDERS) as TreeSectionName[]) {
    if (name === 'texts' && ctx.level !== 'with_texts') continue;
    out[name] = buildSection(ctx, name);
  }
  return out;
}

/** Rows of a section: the rows of its tables over every tree; 1 for a section that is one record. */
export function sectionRows(section: unknown): number {
  if (!Array.isArray(section)) return 1;
  return (section as TreeBlock[]).reduce((n, b) => n + Object.values(b.tables ?? {}).reduce((m, t) => m + t.length, 0), 0);
}

/** The first `limit` rows of a section, each with its tree and table. */
export function firstRows(section: unknown, limit: number): unknown[] {
  if (!Array.isArray(section)) return [section];
  const out: unknown[] = [];
  for (const b of section as TreeBlock[]) {
    for (const [table, rows] of Object.entries(b.tables ?? {})) {
      for (const r of rows) {
        if (out.length >= limit) return out;
        out.push({ tree: b.tree, table, row: r });
      }
    }
  }
  return out;
}
