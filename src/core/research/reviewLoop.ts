import type { BifConfig } from '../config/schema.js';
import { reviewerFor } from '../config/load.js';
import { AbortError } from '../events.js';
import type { RunOutcome } from '../harness/supervisor.js';
import { getRunOutputs, type ReviewIssue } from '../harness/tools/handlers.js';
import { loadPrompt, promptVersion } from '../prompts/index.js';
import { calibrationScope } from '../scoring/calibration.js';
import { escalationRerunSection, ESCALATION_KIND } from '../escalation/context.js'; // WP-D
import { policyDenialsSection } from '../policy/policyEvents.js'; // WP-D
import type { Finding, Role, Task, TaskType } from '../types.js';
import { sameTree } from '../workspace/tree.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type AgentKind, type ResearchDeps } from './deps.js';
import { applyTaskStatus, currentOutputIds, taskOutputs } from './outputs.js';
import { recordTaskEndOutcomes } from '../learning/outcomes.js';
import { maxReasserts, recordReviewRound, recordRevisionResponses, reviewerDisputeSection, workerDisputeSection } from '../learning/reviewIssues.js';
import { workerSystemPrompt, reviewerSystemPrompt } from './systemPrompts.js';
import { stakeholderTaskSection } from '../stakeholders/personas.js'; // stakeholder personas
import { defaultConfig } from '../config/schema.js'; // KS-2
import { liveObservations, reviewFactContext, type ReviewFactContext } from '../knowledge/factReview.js'; // KS-2
import type { ReviewSlice } from '../knowledge/readCommon.js'; // KS-4
import { briefingBudget, fitBriefing, promptReadsOf, synthesisBriefing, taskRecheckFactIds, workerBriefing, type BriefLine, type Briefing } from '../knowledge/briefing.js'; // KS-5
import type { PromptRead } from '../knowledge/promptReads.js'; // KS-5
import { servedLine } from '../knowledge/texts.js'; // KS-5
import { itemIsUploadDerived } from '../knowledge/provenance.js'; // flow records
import { experimentWorkerPrompt, isExperimentTask } from '../learning/runTags.js'; // learning loop WP-F
import { retireExperimentOutputs } from './outputs.js'; // learning loop WP-F
// Flow records: the reviewer sees a task's flows (steps, check answers) and review mentions.
import { activeChecklists, FlowCatalogError } from '../flows/catalog.js';
import { flowChecks } from '../flows/checks.js';
import { flowSteps } from '../flows/flows.js';
import { flowRepos } from '../flows/repos.js';
import type { Flow, FlowCheck, FlowStep, ReviewMention } from '../flows/types.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';

/** Issue description used when a reviewer run produced no valid `submit_review`. */
export const MALFORMED_REVIEW_ISSUE = 'reviewer produced no valid review';

/** Worker steps (initial work or a revision) are attempted at most this many times. */
export const WORKER_STEP_ATTEMPTS = 2;

/** Effective loop settings for a task type (per-task-type overrides win). */
export function loopSettings(type: TaskType, config: BifConfig): { maxRounds: number; passThreshold: number } {
  const o = config.loop.perTaskType[type];
  return {
    maxRounds: o?.maxRounds ?? config.loop.maxRounds,
    passThreshold: o?.passThreshold ?? config.loop.passThreshold,
  };
}

/** The role that executes a task: synthesis tasks need `save_recommendation`. */
export function roleForTask(task: Pick<Task, 'type'>): Role {
  return task.type === 'synthesize_recommendations' ? 'synthesizer' : 'worker';
}

const ARTIFACT_ID = /\bart_[0-9A-Z]{26}\b/g;

/** Longest output text (claim, summary, hypothesis) shown to a reviewer (chars, after redaction). */
const OUTPUT_TEXT = 1500;

export type ReviewContext = {
  /** Evidence artifact ids: of the task's current outputs (transitively) and cited in the deliverable. */
  evidence: string[];
  /** Prompt section with the content of the task's submitted outputs (empty when it has none). */
  outputs: string;
  /** Knowledge store KS-2: prior claims, confirmations / retractions and quotes shown (logged as a read). */
  knowledge?: ReviewFactContext;
  /** KS-5: the outputs section is a briefing (redacted, cut, fenced, budgeted); its read is logged on the run. */
  outputsRead?: PromptRead;
};

/**
 * What the reviewer gets besides brief, criteria and deliverable (spec §7.2, task-scoped only): the
 * content of the task's current findings, recommendations, personas, competitors, hypotheses and
 * flows (with their steps and check answers; outputs of earlier rounds that were re-submitted or cited
 * by id in the deliverable included), the review mentions it saved, the findings cited by those
 * recommendations, and the evidence artifact ids reachable from all of these (step screenshots and
 * the mentions' stored copies included). Nothing else of the workspace is included.
 */
export function reviewContext(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task, role: Role = 'reviewer'): ReviewContext {
  const { store } = deps;
  const outputs = taskOutputs(store, task);
  const current = currentOutputIds(store, task, outputs);
  const findings = outputs.findings.filter((f) => current.has(f.id));
  const recs = outputs.recommendations.filter((r) => current.has(r.id));
  const personas = outputs.personas.filter((p) => current.has(p.id));
  const competitors = outputs.competitors.filter((c) => current.has(c.id));
  const hypotheses = outputs.hypotheses.filter((h) => current.has(h.id));
  const flows = outputs.flows.filter((f) => current.has(f.id));
  const mentions = taskMentions(store, task);
  const ids = new Set<string>();
  for (const f of findings) for (const a of f.evidence) ids.add(a);
  const own = new Set(findings.map((f) => f.id));
  const cited: Finding[] = [];
  for (const r of recs) {
    for (const fid of r.findingIds) {
      if (own.has(fid) || cited.some((c) => c.id === fid)) continue;
      const f = store.findings.get(fid);
      // Recommendations may cite findings of any node of the same business tree.
      if (f && sameTree(store, task.workspaceId, f.workspaceId)) cited.push(f);
    }
  }
  // Hypotheses cite findings (any node of the tree) and/or artifacts.
  for (const h of hypotheses) {
    for (const e of h.evidence) {
      const f = store.findings.get(e);
      if (!f) ids.add(e);
      else if (sameTree(store, task.workspaceId, f.workspaceId) && !own.has(f.id) && !cited.some((c) => c.id === f.id)) cited.push(f);
    }
  }
  for (const f of cited) for (const a of f.evidence) ids.add(a);
  for (const p of personas) for (const field of Object.values(p.profile)) for (const a of field.evidence) ids.add(a);
  for (const c of competitors) for (const a of c.evidence) ids.add(a);
  // Flow records: each flow's step screenshots; each review mention's stored copy.
  const stepsOf = new Map(flows.map((f) => [f.id, flowSteps(store, f.id)]));
  for (const steps of stepsOf.values()) for (const s of steps) if (s.artifactId) ids.add(s.artifactId);
  for (const m of mentions) ids.add(m.artifactId);
  if (task.result !== undefined) for (const m of JSON.stringify(task.result).matchAll(ARTIFACT_ID)) ids.add(m[0]);

  // --- KS-5: the outputs are a briefing: every text redacted, then cut, then fenced; fitted to the role's
  // briefing budget (left-out ids are named: the reviewer may `expand` them, they are in its slice). ---
  const ws = task.workspaceId;
  const line = (text: string, n: number) => servedLine(store, ws, text, n);
  const lines: BriefLine[] = [];
  const add = (title: string, items: BriefLine[]) => {
    if (items.length) lines.push({ text: `### ${title}`, refs: [], upload: false, heading: true }, ...items);
  };
  const findingLine = (f: Finding, source = ''): BriefLine => ({
    text:
      `- [${f.id}] ${line(f.subject, 200)}: ${line(f.claim, OUTPUT_TEXT)}` +
      `${Object.keys(f.criteria).length ? ` (criteria: ${JSON.stringify(f.criteria)})` : ''} (evidence: ${f.evidence.join(', ')})${source}`,
    refs: [{ id: f.id, kind: 'fact' }], upload: f.uploadDerived === true,
  });
  const record = (id: string) => [{ id, kind: 'record' }];
  add('Findings saved by this task', findings.map((f) => findingLine(f)));
  add('Recommendations saved by this task', recs.map((r) => ({
    text: `- [${r.id}] ${line(r.title, 200)}: ${line(r.summary, OUTPUT_TEXT)}\n  criteria: ${JSON.stringify(r.criteria)}\n  cites findings: ${r.findingIds.join(', ')}`,
    refs: record(r.id), upload: false,
  })));
  add('Findings cited by these recommendations / hypotheses', cited.map((f) => findingLine(f, f.workspaceId !== task.workspaceId ? ` (source ${f.workspaceId})` : '')));
  add('Personas saved by this task', personas.map((p) => ({
    text: `- [${p.id}] ${line(p.slug, 120)} (${line(p.segment, 120)}; audience ${p.audience ?? 'external'})\n${Object.entries(p.profile)
      .map(([k, v]) => `  - ${k}: ${line(v.value, 400)} (confidence ${v.confidence}; evidence: ${v.evidence.join(', ')})`)
      .join('\n')}`,
    refs: record(p.id), upload: false,
  })));
  add('Competitors saved by this task', competitors.map((c) => ({
    text:
      `- [${c.id}] ${line(c.name, 200)}${c.site ? ` (${line(c.site, 200)})` : ''}: threat ${c.threat}, directness ${c.directness}, ` +
      `comparison ${JSON.stringify(c.comparison)} (evidence: ${c.evidence.join(', ')})`,
    refs: record(c.id), upload: false,
  })));
  add('Symptom hypotheses saved by this task', hypotheses.map((h) => {
    const symptom = store.symptoms.get(h.symptomId);
    return {
      text: `- [${h.id}] symptom ${h.symptomId}${symptom ? ` (${line(symptom.title, 200)})` : ''}: ${line(h.hypothesis, OUTPUT_TEXT)} (confidence ${h.confidence}%; evidence: ${h.evidence.join(', ')})`,
      refs: [...record(h.id), ...(symptom ? record(symptom.id) : [])], upload: false,
    };
  }));
  // Flow records (design 2026-11-14 §8.2, §12.1): each flow with its steps and its check answers.
  // A flow's line also lists the review mentions its check answers rest on (any task's): an answer drawn
  // from an upload-derived mention makes the review run upload-exposed (flow design §8.4).
  add('Flows saved by this task', flows.map((f) => {
    const cited = [...new Set(flowChecks(store, f.id).flatMap((c) => c.mentionRefs))];
    const refs = [
      { id: f.id, kind: 'flow' },
      ...(stepsOf.get(f.id) ?? []).flatMap((s) => (s.artifactId ? [{ id: s.artifactId, kind: 'artifact' }] : [])),
      ...cited.map((id) => ({ id, kind: 'review_mention' })),
    ];
    return { text: flowReviewText(store, ws, f, stepsOf.get(f.id) ?? []), refs, upload: refs.some((r) => itemIsUploadDerived(store, r.id)) };
  }));
  add('Review mentions saved by this task', mentions.map((m) => ({
    text: mentionReviewText(store, ws, m),
    refs: [{ id: m.id, kind: 'review_mention' }, { id: m.artifactId, kind: 'artifact' }],
    upload: itemIsUploadDerived(store, m.id),
  })));
  const sections: string[] = [];
  let outputsRead: PromptRead | undefined;
  if (lines.length) {
    const env = { store, config: deps.config ?? defaultConfig };
    const b = fitBriefing(env, {
      title: '## Submitted outputs',
      lines,
      budget: briefingBudget(env, role, task.model.provider),
      query: `review outputs: task ${task.id} round ${task.round}`,
      label: 'outputs',
    });
    if (b.section) sections.push(b.section);
    outputsRead = b.read;
  }
  // --- end KS-5 ---
  // --- knowledge store KS-2: lifecycle of the outputs, confirmations / retractions, verified quotes ---
  const knowledge = reviewFactContext(store, deps.config ?? defaultConfig, task, findings);
  for (const a of knowledge.evidence) ids.add(a);
  if (knowledge.section) sections.push(knowledge.section);
  // --- end KS-2 ---
  return {
    evidence: [...ids],
    outputs: sections.join('\n\n'),
    ...(knowledge.results.length ? { knowledge } : {}),
    ...(outputsRead ? { outputsRead } : {}),
  };
}

/** Longest step field (action, observation, error) shown to a reviewer (chars, after redaction). */
const STEP_TEXT = 600;

/** Review mentions saved by the task, in its own workspace (not outputs with a round: all of them). */
function taskMentions(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): ReviewMention[] {
  return flowRepos(store).reviewMentions.list({ taskId: task.id }).filter((m) => m.workspaceId === task.workspaceId);
}

/** A check answer as shown to a reviewer: answer (value), its origin when not the walkthrough, steps, note. */
function checkText(c: FlowCheck, line: (s: string, n: number) => string): string {
  const value = c.value === undefined || c.value === null ? '' : ` (${line(typeof c.value === 'string' ? c.value : JSON.stringify(c.value), 300)})`;
  const parts = [`${c.answer}${value}`];
  if (c.origin !== 'walkthrough') parts.push(`from ${c.origin}`);
  if (c.stepRefs.length) parts.push(`steps ${c.stepRefs.join(', ')}`);
  if (c.mentionRefs.length) parts.push(`mentions ${c.mentionRefs.join(', ')}`);
  if (c.note) parts.push(`note: ${line(c.note, 300)}`);
  return parts.join('; ');
}

/**
 * One flow for the reviewer: header, steps in order, notable, the answers of its active checklists
 * and what is unanswered ("checklists unavailable" when the catalog cannot give them).
 */
function flowReviewText(store: Store, ws: string, f: Flow, steps: FlowStep[]): string {
  const line = (text: string, n: number) => servedLine(store, ws, text, n);
  const subject = knowledgeRepos(store).entities.get(f.subjectEntityId);
  const type = flowRepos(store).flowTypes.get(f.flowTypeId);
  const out = [
    `- [${f.id}] ${line(subject?.name ?? f.subjectEntityId, 200)}: ${line(type?.name ?? f.flowTypeId, 200)}, variant "${line(f.variant, 200)}"` +
      `${f.isPrimary ? ' (primary)' : ''}, version ${f.version} (${f.lifecycle}): ${line(f.name, 200)}`,
    `  goal: ${line(f.goal, 400)}; ${f.reachedGoal ? 'reached' : `not reached (stopped: ${f.stopReason ?? 'unknown'})`}` +
      `${f.entryUrl ? `; entry: ${line(f.entryUrl, 300)}` : ''}`,
  ];
  for (const s of steps) {
    const parts = [`did: ${line(s.action, STEP_TEXT)}`];
    if (s.observation) parts.push(`saw: ${line(s.observation, STEP_TEXT)}`);
    if (s.asked.length) parts.push(`asked: ${s.asked.map((a) => line(a, 100)).join(', ')}`);
    if (s.error) parts.push(`error: ${line(s.error, STEP_TEXT)}`);
    if (s.pageUrl) parts.push(`page: ${line(s.pageUrl, 300)}`);
    parts.push(s.artifactId ? `screenshot: ${s.artifactId}` : 'no screenshot');
    out.push(`  step ${s.seq}: ${parts.join('; ')}`);
  }
  if (f.notable) out.push(`  anything else notable: ${line(f.notable, OUTPUT_TEXT)}`);
  let lists: ReturnType<typeof activeChecklists>;
  try {
    lists = activeChecklists(store, ws, f.flowTypeId);
  } catch (e) {
    // A broken catalog must not break the whole review step: the flow is still shown.
    if (!(e instanceof FlowCatalogError)) throw e;
    out.push('  check answers: checklists unavailable');
    return out.join('\n');
  }
  const { general, specific } = lists;
  const rows = flowChecks(store, f.id);
  const answered: string[] = [];
  const missing: string[] = [];
  for (const [name, list] of specific ? ([['general', general], ['specific', specific]] as const) : ([['general', general]] as const)) {
    for (const item of list.items) {
      const row = rows.find((c) => c.checklistId === list.id && c.itemKey === item.key);
      if (row) answered.push(`  - ${name}.${item.key} (${item.question}): ${checkText(row, line)}`);
      else if (item.answeredBy !== 'reviews') missing.push(`${name}.${item.key}`);
    }
  }
  out.push(answered.length ? '  check answers:' : '  check answers: none', ...answered);
  if (missing.length) out.push(`  not answered by the walkthrough: ${missing.join(', ')}`);
  return out.join('\n');
}

/** One review mention for the reviewer: polarity, quote, source and attribution. */
function mentionReviewText(store: Store, ws: string, m: ReviewMention): string {
  const line = (text: string, n: number) => servedLine(store, ws, text, n);
  const subject = knowledgeRepos(store).entities.get(m.subjectEntityId);
  const type = m.flowTypeId ? flowRepos(store).flowTypes.get(m.flowTypeId) : undefined;
  const attribution = type ? `flow type ${type.key}${m.checkKey ? `, check ${m.checkKey}` : ''}, confidence ${m.attributionConfidence}` : 'subject only';
  return (
    `- [${m.id}] ${line(subject?.name ?? m.subjectEntityId, 200)}: [${m.polarity}] "${line(m.quote, OUTPUT_TEXT)}" ` +
    `(${m.sourceType}${m.publishedAt ? `, ${m.publishedAt.slice(0, 10)}` : ', undated'}${m.rating !== undefined ? `, rating ${m.rating}` : ''}; ` +
    `${attribution}; stored copy ${m.artifactId}${m.sourceUrl ? `, ${line(m.sourceUrl, 300)}` : ''})`
  );
}

/** Evidence artifact ids of a task (see `reviewContext`). */
export function evidenceIds(deps: Pick<ResearchDeps, 'store'>, task: Task): string[] {
  return reviewContext(deps, task).evidence;
}

function bullets(items: string[]): string {
  return items.length ? items.map((s) => `- ${s}`).join('\n') : '- (none)';
}

function taskHeader(task: Task): string {
  const lines = [`Task id: ${task.id}`, `Task type: ${task.type}`];
  if (task.subject) lines.push(`Subject: ${task.subject}`);
  return lines.join('\n');
}

/**
 * Answers to the task's earlier user requests (registrations, approvals, ...), for every worker
 * prompt (initial work and revisions, also after a restart). Empty string when there are none.
 */
export function answeredRequestsSection(deps: Pick<ResearchDeps, 'store'>, task: Task): string {
  const answered = deps.store.userRequests
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && r.status !== 'pending')
    // WP-D: escalation answers are shown by `escalationRerunSection`.
    .filter((r) => r.kind !== ESCALATION_KIND);
  if (!answered.length) return '';
  return (
    '## Earlier requests to the user for this task (already answered)\n' +
    answered
      .map((r) => `- ${r.kind}${r.site ? ` on ${r.site}` : ''}: ${r.details}\n  → ${r.status}${r.response ? `: ${r.response}` : ''}`)
      .join('\n') +
    '\nUse these answers; do not ask again. The research browser profile keeps any session the user set up.'
  );
}

/** Prompt for the initial worker run. Includes answers to the task's earlier user requests (after a restart). */
export function workPrompt(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): string {
  return workPromptWithReads(deps, task).prompt;
}

/**
 * KS-5: the knowledge briefings of a worker / synthesizer run (synthesis tasks: usable facts and
 * symptoms; every task: the facts it must re-check and the card of its subject). Each is a read.
 */
function taskBriefings(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): Briefing[] {
  const env = { store: deps.store, config: deps.config ?? defaultConfig };
  const role = roleForTask(task);
  const provider = task.model.provider;
  const out: Briefing[] = [];
  if (task.phase === 'synthesis') out.push(synthesisBriefing(env, { workspaceId: task.workspaceId, role, provider }));
  const recheck = taskRecheckFactIds(deps.store, task);
  const worker = workerBriefing(env, {
    workspaceId: task.workspaceId, role, provider, recheckFactIds: recheck,
    ...(task.subject && task.phase !== 'synthesis' ? { subject: task.subject } : {}),
  });
  if (worker) out.push(worker);
  return out;
}

/** `workPrompt` and its prompt reads (KS-5). */
export function workPromptWithReads(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): { prompt: string; reads: PromptRead[] } {
  const briefings = taskBriefings(deps, task);
  const parts = [
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
    ...briefings.map((b) => b.section).filter(Boolean),
    stakeholderTaskSection(deps.store, deps.config ?? defaultConfig, task), // stakeholder personas ('' for other types)
  ].filter(Boolean);
  const answered = answeredRequestsSection(deps, task);
  if (answered) parts.push(answered);
  // WP-D: escalation re-run context and the role's recent policy denials (same business tree).
  parts.push(...wpdSections(deps, task));
  parts.push('Finish by calling `submit_result` with your deliverable.');
  return { prompt: parts.join('\n\n'), reads: promptReadsOf(...briefings) };
}

/** Prompt for a revision run: brief, criteria, current deliverable and the reviewer's issues. */
export function revisePrompt(task: Task, issues: ReviewIssue[], deps?: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>): string {
  return revisePromptWithReads(task, issues, deps).prompt;
}

/** `revisePrompt` and its prompt reads (KS-5). */
export function revisePromptWithReads(
  task: Task,
  issues: ReviewIssue[],
  deps?: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>,
): { prompt: string; reads: PromptRead[] } {
  const issueLines = issues.map((i) => {
    const ev = i.evidence?.length ? ` (evidence: ${i.evidence.join(', ')})` : '';
    return `- [${i.id}] (${i.class}) ${i.description}${ev}`;
  });
  const outputs = deps ? currentOutputsBriefing(deps, task) : undefined;
  const briefings = deps ? taskBriefings(deps, task) : [];
  const prompt = [
    loadPrompt('revise').text,
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
    `## Your current deliverable\n\`\`\`json\n${JSON.stringify(task.result ?? null, null, 2)}\n\`\`\``,
    `## Review issues\n${issueLines.join('\n') || '- (none)'}`,
    deps ? workerDisputeSection(deps.store, task, issues, maxReasserts(deps.config)) : '', // learning loop WP-C
    outputs?.section ?? '',
    ...briefings.map((b) => b.section),
    deps ? stakeholderTaskSection(deps.store, deps.config ?? defaultConfig, task) : '', // stakeholder personas
    deps ? answeredRequestsSection(deps, task) : '',
    ...(deps ? wpdSections(deps, task) : []), // WP-D
  ]
    .filter(Boolean)
    .join('\n\n');
  return { prompt, reads: promptReadsOf(outputs, ...briefings) };
}

// WP-D: prompt sections shared by work and revise prompts.
function wpdSections(deps: Pick<ResearchDeps, 'store'>, task: Task): string[] {
  return [
    escalationRerunSection(deps.store, task),
    policyDenialsSection(deps.store, task.workspaceId, roleForTask(task)),
  ].filter(Boolean);
}

/**
 * Revision prompt section: the task's current outputs and the superseded rule (outputs neither
 * re-saved in this revision nor cited by id in the resubmitted deliverable are superseded).
 */
export function currentOutputsSection(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): string {
  return currentOutputsBriefing(deps, task)?.section ?? '';
}

/**
 * KS-5: the current outputs as a briefing (texts redacted, then cut, then fenced; the worker budget, with
 * left-out ids named so they can still be cited) and its read: a revise run is a new run that is shown
 * the earlier run's stored text.
 */
function currentOutputsBriefing(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): Briefing | undefined {
  const { store } = deps;
  const outputs = taskOutputs(store, task);
  const current = currentOutputIds(store, task, outputs);
  const line = (text: string) => servedLine(store, task.workspaceId, text, 200);
  const record = (id: string) => [{ id, kind: 'record' }];
  const lines: BriefLine[] = [
    ...outputs.findings.filter((f) => current.has(f.id)).map((f) => ({ text: `- finding ${f.id}: ${line(f.claim)}`, refs: [{ id: f.id, kind: 'fact' }], upload: f.uploadDerived === true })),
    ...outputs.recommendations.filter((r) => current.has(r.id)).map((r) => ({ text: `- recommendation ${r.id}: ${line(r.title)}`, refs: record(r.id), upload: false })),
    ...outputs.personas.filter((p) => current.has(p.id)).map((p) => ({ text: `- persona ${p.id}: ${line(p.slug)}`, refs: record(p.id), upload: false })),
    ...outputs.competitors.filter((c) => current.has(c.id)).map((c) => ({ text: `- competitor ${c.id}: ${line(c.name)}`, refs: record(c.id), upload: false })),
    ...outputs.hypotheses.filter((h) => current.has(h.id)).map((h) => ({ text: `- hypothesis ${h.id}: ${line(h.hypothesis)}`, refs: record(h.id), upload: false })),
    // Flow records: a flow neither re-saved (save_flow) nor cited is superseded like any output.
    ...outputs.flows.filter((f) => current.has(f.id)).map((f) => ({ text: `- flow ${f.id}: ${line(`${f.name} (variant: ${f.variant})`)}`, refs: [{ id: f.id, kind: 'flow' }], upload: false })),
    // KS-2: confirmations / retractions follow the same rule (re-call the tool, or cite the fact id). Ids only.
    ...liveObservations(store, task).map((o) => ({ text: `- ${o.kind === 'confirm' ? 'confirmation' : 'retraction'} of finding ${o.findingId}`, refs: [], upload: false })),
  ];
  if (!lines.length) return undefined;
  const env = { store, config: deps.config ?? defaultConfig };
  return fitBriefing(env, {
    title: '## Your current outputs',
    lines,
    outro: [
      'Outputs you neither re-save in this revision nor cite by id in your resubmitted deliverable are marked ' +
        'superseded and are not used. Save corrected outputs anew (e.g. a corrected claim) and leave wrong ones out.',
    ],
    budget: briefingBudget(env, roleForTask(task), task.model.provider),
    query: `current outputs: task ${task.id}`,
    label: 'outputs',
  });
}

/**
 * Reviewer prompt: ONLY the task brief, acceptance criteria, the current deliverable, the content of
 * the task's submitted outputs and their evidence artifact ids (spec §7.2: no worker transcript,
 * other tasks, or prior review rounds — except, learning loop WP-C, the issues the worker pushed back
 * on with its reasons, which the reviewer must accept or reassert).
 */
export function reviewPrompt(task: Task, evidence: string[], outputs = '', disputes = ''): string {
  return [
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
    `## Deliverable\n\`\`\`json\n${JSON.stringify(task.result ?? null, null, 2)}\n\`\`\``,
    outputs,
    disputes, // learning loop WP-C: pushed-back issues of the previous review (spec: disputes)
    `## Evidence artifact ids (inspect with read_artifact)\n${bullets(evidence)}`,
    'Call `submit_review` exactly once.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Human-readable failure of a run: exit code, supervisor reason, last error event. */
export function failureReason(res: RunOutcome): string {
  const lastError = [...res.events].reverse().find((e) => e.t === 'error');
  const parts = [`exit ${res.exitCode}`];
  if (res.reason) parts.push(res.reason);
  if (lastError?.t === 'error' && lastError.message !== res.reason) parts.push(lastError.message.slice(0, 500));
  return `run failed (${parts.join('; ')})`;
}

type StepOutcome = { ok: true } | { ok: false; reason: string };

/** One worker step (initial work or a revision), retried once with a fresh run on failure. */
async function workerStep(
  deps: ResearchDeps,
  taskId: string,
  kind: Extract<AgentKind, 'work' | 'revise'>,
  round: number,
  issues: ReviewIssue[],
): Promise<StepOutcome> {
  const { store, config } = deps;
  const initial = store.tasks.get(taskId)!;
  const role = roleForTask(initial);
  const system =
    experimentWorkerPrompt(store, taskId) ?? // learning loop WP-F: an experiment arm's worker prompt version
    workerSystemPrompt(config, role, initial.needsBrowser, initial.type, calibrationScope(store, config, initial.workspaceId, { taskId })); // stored lessons-off flag
  const version = promptVersion(system);
  let reason = '';
  for (let attempt = 1; attempt <= WORKER_STEP_ATTEMPTS; attempt++) {
    throwIfAborted(deps.signal);
    const task = store.tasks.get(taskId)!;
    // KS-5: the briefings in the prompt are reads, logged on the run before it starts.
    const { prompt, reads } = kind === 'work' ? workPromptWithReads(deps, task) : revisePromptWithReads(task, issues, deps);
    const res = await runAgent(deps, {
      kind, role, workspaceId: task.workspaceId, task, round, attempt, prompt, systemPrompt: system,
      model: task.model, needsBrowser: task.needsBrowser, promptVersion: version,
      ...(reads.length ? { promptReads: reads } : {}),
    });
    throwIfAborted(deps.signal);
    const outputs = getRunOutputs(store, res.agentRunId);
    // A revision only counts when every issue got a respond_to_review (fix | pushback).
    const answered = new Set(outputs.responses.map((r) => r.issueId));
    const unanswered = kind === 'revise' ? issues.map((i) => i.id).filter((i) => !answered.has(i)) : [];
    if (res.status === 'done' && outputs.result !== undefined && unanswered.length === 0) {
      if (attempt > 1) {
        recordHarnessDecision(
          store,
          { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role, model: task.model, promptVersion: version },
          'decision',
          { event: 'worker_retry_succeeded', step: kind, round, attempt },
          [task.id],
        );
      }
      return { ok: true };
    }
    reason =
      res.status === 'failed'
        ? failureReason(res)
        : outputs.result === undefined
          ? 'run ended without submit_result'
          : `run did not respond_to_review for issue(s) ${unanswered.join(', ')}`;
    // The failed run (AgentRun row + events.jsonl) is kept; this decision makes the failure visible.
    recordHarnessDecision(
      store,
      { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role, model: task.model, promptVersion: version },
      'decision',
      { event: 'worker_run_failed', step: kind, round, attempt, reason, exitCode: res.exitCode, willRetry: attempt < WORKER_STEP_ATTEMPTS },
      [task.id],
    );
  }
  return { ok: false, reason };
}

/**
 * Everything a reviewer run of `task` in `round` is started with besides its model: the reviewer system
 * prompt (with the business's calibration) and its version, the minimal review prompt (`reviewPrompt`,
 * with the open disputes of earlier rounds) and the prompt reads to log before the run starts.
 * Learning loop WP-F: reviewer audits use exactly this, so an auditor sees what the reviewer saw.
 */
export function reviewerRunInput(
  deps: Pick<ResearchDeps, 'store' | 'config'>,
  task: Task,
  round: number,
  lessons: { lessonsOff?: boolean } = {},
): { systemPrompt: string; promptVersion: string; prompt: string; promptReads: PromptRead[] } {
  const { store, config } = deps;
  const system = reviewerSystemPrompt(config, calibrationScope(store, config, task.workspaceId, { taskId: task.id, ...lessons }), task.type);
  const context = reviewContext(deps, task);
  // Knowledge store KS-2/KS-4: the prior claims and quotes in the reviewer's prompt are a read (design
  // §12), logged on the reviewer run before it starts (a crash mid-run cannot lose the row).
  const k = context.knowledge;
  const promptReads: PromptRead[] = [
    ...(k
      ? [{
          query: `review context: task ${task.id} round ${round}`, scope: 'tree', results: k.results,
          tokensReturned: k.tokens, truncated: k.truncated, uploadDerived: k.uploadDerived,
        }]
      : []),
    ...(context.outputsRead ? [context.outputsRead] : []), // KS-5: the outputs briefing
  ];
  return {
    systemPrompt: system,
    promptVersion: promptVersion(system),
    prompt: reviewPrompt(task, context.evidence, context.outputs, reviewerDisputeSection(store, task, round, maxReasserts(config))),
    promptReads,
  };
}

/** One reviewer run (always a NEW run). Malformed or failed reviews become score 0 + a blocking issue. */
async function reviewStep(
  deps: ResearchDeps,
  taskId: string,
  round: number,
): Promise<{ valid: boolean; score: number; issues: ReviewIssue[] }> {
  const { store, config } = deps;
  const task = store.tasks.get(taskId)!;
  const model = reviewerFor(task.model, config);
  const input = reviewerRunInput(deps, task, round); // learning loop WP-F: shared with reviewer audits
  const res = await runAgent(deps, {
    kind: 'review', role: 'reviewer', workspaceId: task.workspaceId, task, round, attempt: 1,
    prompt: input.prompt, systemPrompt: input.systemPrompt,
    model, needsBrowser: false, promptVersion: input.promptVersion,
    ...(input.promptReads.length ? { promptReads: input.promptReads } : {}),
  });
  const version = input.promptVersion;
  throwIfAborted(deps.signal);
  const review = getRunOutputs(store, res.agentRunId).review;
  // A review counts only if the reviewer run itself finished successfully.
  if (res.status === 'done' && review && Number.isFinite(review.score) && review.score >= 0 && review.score <= 10) {
    return { valid: true, score: review.score, issues: review.issues };
  }
  const issues: ReviewIssue[] = [{ id: 'I1', class: 'blocking', description: MALFORMED_REVIEW_ISSUE }];
  recordHarnessDecision(
    store,
    { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role: 'reviewer', model, promptVersion: version },
    'review',
    { event: 'synthetic_review', round, score: 0, issues, runStatus: res.status },
    [task.id],
  );
  return { valid: false, score: 0, issues };
}

function finish(deps: ResearchDeps, taskId: string, status: 'verified' | 'unverified' | 'failed', round: number): Task {
  const { store } = deps;
  // Learning loop WP-F: an experiment arm task leaves no results behind (its outputs are retired and it
  // writes no outcomes); its status, rounds and reviews are what the experiment compares.
  const experiment = isExperimentTask(store, taskId);
  const done = store.transaction(() => {
    const task = store.tasks.update(taskId, { status, round });
    // Findings, recommendations and personas of the task take its status; outputs of earlier rounds
    // that were not re-submitted become `superseded`.
    if (experiment) retireExperimentOutputs(store, task); // WP-F
    else applyTaskStatus(store, task, status);
    return task;
  });
  // Live refresh: output lists in the web app reload when a task's outputs got their final status.
  deps.events.emit({ type: 'task_status', workspaceId: done.workspaceId, taskId: done.id, status: done.status });
  if (!experiment) recordTaskEndOutcomes(store, done); // learning loop WP-C: task-end + superseded outcomes
  return done;
}

/**
 * Runs one task through the adversarial review loop (spec §7.2):
 * worker → `submit_result`; then per round a NEW reviewer run; `score >= passThreshold` →
 * `verified`; `round == maxRounds` → `unverified` (the task's findings take the same status);
 * otherwise a revision run answers EVERY issue (`respond_to_review`) and resubmits.
 *
 * A worker step whose run fails (non-zero exit, idle kill), ends without `submit_result` or (revise)
 * leaves an issue unanswered is retried once with a new run; a second failure marks the task
 * `failed`. Failed runs are kept and logged as harness Decisions (`worker_run_failed`, and
 * `worker_retry_succeeded` when the retry worked).
 *
 * The current step (`work | review | revise`), the round, the last submitted round and the last
 * review's issues are persisted on the Task, so a resumed task continues exactly where it stopped
 * (an interrupted revise is re-run as a revise with the same issues).
 * Throws `AbortError` when `deps.signal` aborts (task state is then left as is).
 */
export async function runTaskWithReview(task: Task, deps: ResearchDeps): Promise<Task> {
  const { store, config } = deps;
  const { maxRounds, passThreshold } = loopSettings(task.type, config);
  const id = task.id;
  const current = store.tasks.get(id) ?? task;
  let round = Math.max(1, current.round);
  // Tasks created before migration 7 have no step: a deliverable means it awaits review.
  let step: NonNullable<Task['step']> = current.step ?? (current.result === undefined ? 'work' : 'review');
  try {
    for (;;) {
      if (step === 'work' || step === 'revise') {
        const latest = store.tasks.get(id)!;
        const issues = step === 'revise' ? (latest.reviewIssues ?? []) : [];
        store.tasks.update(id, { status: 'running', round, step });
        const res = await workerStep(deps, id, step, round, issues);
        if (!res.ok) {
          store.tasks.update(id, { failureReason: res.reason }); // learning loop WP-B
          return finish(deps, id, 'failed', round);
        }
        if (step === 'revise') recordRevisionResponses(store, id, round); // learning loop WP-C: fixed / pushed_back
        step = 'review';
        store.tasks.update(id, { step, submittedRound: round });
        continue;
      }
      store.tasks.update(id, { status: 'reviewing', round, step: 'review' });
      const review = await reviewStep(deps, id, round);
      // learning loop WP-C: append the round to the review-issue history; issues carry stable ids.
      const issues = recordReviewRound(store, config, id, round, review);
      // Only a valid review from a successful reviewer run can pass (even with passThreshold 0).
      if (review.valid && review.score >= passThreshold) return finish(deps, id, 'verified', round);
      if (round >= maxRounds) return finish(deps, id, 'unverified', round);
      round++;
      step = 'revise';
      store.tasks.update(id, { status: 'running', round, step, reviewIssues: issues });
    }
  } catch (err) {
    if (err instanceof AbortError || (err as Error).name === 'AbortError') throw err;
    // Non-agent error (e.g. needs a browser but maxBrowserRuns is 0): the task cannot run.
    console.error(`[bif] task ${id} failed: ${(err as Error).message}`);
    store.tasks.update(id, { failureReason: (err as Error).message }); // learning loop WP-B
    return finish(deps, id, 'failed', round);
  }
}

// --- knowledge store KS-4: the reviewer slice (design §9 "reviewer", §12) -------------------------
/**
 * What a reviewer (or escalation) run of `task` may read through `expand` / `read_artifact`: the
 * task's current outputs, the findings its recommendations / hypotheses cite, the facts its outputs
 * replace, confirm or retract (`ReviewFactContext.factIds`), the task's flows (current outputs) and
 * review mentions, and the evidence artifacts of all of these (`reviewContext().evidence`: also step
 * screenshots and the mentions' stored copies) with their chunks. Everything else answers "not found" and is a
 * blocked attempt (`policy_blocked`). The dispatcher enforces it (harness/tools/handlers.ts).
 */
export function reviewSlice(deps: Pick<ResearchDeps, 'store'> & Partial<Pick<ResearchDeps, 'config'>>, task: Task): ReviewSlice {
  const { store } = deps;
  const context = reviewContext(deps, task);
  const outputs = taskOutputs(store, task);
  const current = currentOutputIds(store, task, outputs);
  const ids = new Set<string>([...current, ...(context.knowledge?.factIds ?? []), ...context.evidence]);
  for (const r of outputs.recommendations) if (current.has(r.id)) for (const f of r.findingIds) ids.add(f);
  for (const h of outputs.hypotheses) if (current.has(h.id)) for (const e of h.evidence) ids.add(e);
  for (const m of taskMentions(store, task)) ids.add(m.id); // flow records
  return { ids, artifactIds: new Set(context.evidence) };
}
// --- end KS-4 -------------------------------------------------------------------------------------
