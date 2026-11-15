import { renderTemplate } from '../prompts/index.js';
import type { Audience, Phase, TaskType, Workspace } from '../types.js';
import { audiencesOf, scopeOf } from '../workspace/tree.js';

/** Default pipeline, in order (`mapping` is optional and not included). */
export const ALL_PHASES: Phase[] = [
  'market_research',
  'competitor_discovery',
  'deep_dives',
  'stakeholders',
  'flow_ranking',
  'synthesis',
  'persona_panel',
  'scoring',
];

/** Phases that run without an orchestrator agent (delegated to `ResearchDeps.phaseRunners`). */
export const RUNNER_PHASES: ReadonlySet<Phase> = new Set(['flow_ranking', 'persona_panel', 'scoring']);

/** Task types the orchestrator may propose in each phase. */
export const PHASE_TASK_TYPES: Record<Phase, TaskType[]> = {
  mapping: ['map_business_units'],
  market_research: ['audience_segments', 'persona_profile', 'customer_pain_points', 'news_scan'],
  competitor_discovery: ['discover_competitors', 'news_scan'],
  deep_dives: ['flow_walkthrough', 'flow_reviews', 'news_scan', 'public_filings', 'customer_pain_points', 'own_company_audit'],
  stakeholders: ['own_stakeholders', 'competitor_stakeholders'],
  flow_ranking: [],
  synthesis: ['symptom_hypotheses', 'synthesize_recommendations'],
  persona_panel: ['persona_panel'],
  scoring: [],
};

/**
 * Task types whose workers must not reach the web at all, whatever the planner asked (stakeholder
 * design §6, §16: own stakeholder research reads only what the store already holds): no browser, and
 * the run is offline (the CLI's web and shell tools denied by the adapter). Applied where a planned
 * task is stored and where the review loop starts its worker.
 */
export const OFFLINE_TASK_TYPES: ReadonlySet<TaskType> = new Set(['own_stakeholders']);

/** Whether a worker of a task of `type` must run offline (`RunOptions.offline`). */
export function taskIsOffline(type: TaskType): boolean {
  return OFFLINE_TASK_TYPES.has(type);
}

/**
 * Task types whose runs work in private (stakeholder design §7, task 6 fix round 2): own stakeholder
 * research may not reach the user except through the question round, and may store nothing but
 * stakeholders. Its runs cannot ask the user anything (`request_user_action`, `request_approval`,
 * escalation), and a non-reviewer run may call only `PRIVATE_TASK_TOOLS`.
 */
export const PRIVATE_TASK_TYPES: ReadonlySet<TaskType> = new Set(['own_stakeholders']);

/** What a non-reviewer run of a private task may call: save stakeholders, finish, answer its review, log, and read. */
export const PRIVATE_TASK_TOOLS: ReadonlySet<string> = new Set([
  'save_stakeholder', 'submit_result', 'respond_to_review', 'log_decision',
  'read_artifact', 'read_workspace', 'search', 'get_card', 'expand', 'list_changes',
]);

/** Whether runs of a task of `type` may ask the user (user requests, escalation). */
export function taskMayAskUser(type: TaskType): boolean {
  return !PRIVATE_TASK_TYPES.has(type);
}

/**
 * Why a run of a task of `type`, in `role`, may not call `tool` ('' when it may). Reviewer runs keep
 * their review tools (none of them asks the user or stores content).
 */
export function taskToolRefusal(type: TaskType, role: string, tool: string): string {
  if (!PRIVATE_TASK_TYPES.has(type) || role === 'reviewer' || PRIVATE_TASK_TOOLS.has(tool)) return '';
  if (tool === 'request_user_action' || tool === 'request_approval' || tool === 'submit_escalation') {
    return `tool '${tool}' is not available in a ${type} task: you cannot ask the user anything here (the user answers ` +
      'their own questions about stakeholders separately). Finish with what you have: save the stakeholders you can support and call submit_result.';
  }
  return `tool '${tool}' is not available in a ${type} task: it may save only stakeholders (save_stakeholder). ` +
    'Finish with what you have and call submit_result.';
}

/** Whether a task of `type` runs with a browser when `asked` (never for an offline task type). */
export function taskNeedsBrowser(type: TaskType, asked: boolean): boolean {
  return asked && !taskIsOffline(type);
}

/**
 * Phase goal templates. Placeholders: `{{scope}}` (scope description), `{{audiences}}`.
 * Render with `phaseGoal(phase, workspace)`.
 */
export const PHASE_GOALS: Record<Phase, string> = {
  mapping:
    'Map the business units of {{scope}}: propose child nodes (divisions, product lines, regions, teams, internal ' +
    'platforms) from the interview, internal uploads and research (site, filings, org signals). Each unit is proposed ' +
    'with propose_business_unit: name, description, level, audiences, evidence and reasoning. The user accepts, edits ' +
    'or rejects each one.',
  market_research:
    'Understand the market of {{scope}}: identify the target audience segments ({{audiences}}) from the interview, ' +
    'competitor positioning, reviews, forums, social, industry reports and analyst coverage; build an ' +
    'evidence-backed persona profile per segment; collect customer pain points and relevant market news.',
  competitor_discovery:
    'Discover the competitors of {{scope}}: direct and indirect competitors serving the same audiences ({{audiences}}), ' +
    'with positioning, target segments and why each matters. Every competitor must be backed by evidence.',
  deep_dives:
    'Deep-dive the most important competitors and the own company ({{scope}}): list every flow each one offers that can ' +
    'be found (navigation, pricing and help pages, the product itself) and walk the key ones (sign-up, sign-in, ' +
    'onboarding, pricing, checkout, core flow) step by step with a screenshot per step (flow_walkthrough); collect ' +
    'public reviews and feedback about each of them (flow_reviews); scan news and public filings, and collect customer ' +
    'pain points. Apply the same task types to the own company via own_company_audit.',
  stakeholders:
    'Build the stakeholder personas of {{scope}}: the people, teams and systems whose approval, budget, data or ' +
    'work it depends on (own_stakeholders, from what the store already holds, never with a browser), and the ' +
    'leaders, owners and investors of its most important competitors from public sources (competitor_stakeholders; ' +
    'only when the business tree has competitors).',
  synthesis:
    'Link the interview symptoms of {{scope}} to research findings (symptom hypotheses) and synthesize ' +
    'evidence-backed recommendations, each referencing the findings that support it. Use verified findings only.',
  flow_ranking:
    'Rank the documented flows of {{scope}} per flow type: each persona judges pairs of flows as itself (simulated ' +
    'head-to-heads), blended with the checklist scores.',
  persona_panel: 'Put every recommendation for {{scope}} to each persona independently (simulated feedback).',
  scoring: 'Score and prioritise the recommendations for {{scope}}.',
};

/** `competitor_discovery` goal for scopes with internal audiences: competitors are alternatives. */
export const INTERNAL_COMPETITOR_GOAL =
  'Discover the alternatives to {{scope}}, alternatives: vendor tools, outsourcing, peer-company practices for this function. ' +
  'For each alternative give positioning, who uses it and why it matters, backed by evidence.';

/** Extra market-research instruction when internal audiences are in scope. */
export const INTERNAL_AUDIENCE_NOTE =
  ' Audience segments must also cover internal roles (employees and internal users of this function), researched from ' +
  'job postings, role descriptions, employee-review sites, industry surveys of the role, the interview and internal ' +
  'uploads (weighted highest); internal personas carry audience "internal".';

const AUDIENCE_TEXT: Record<Audience, string> = {
  external: 'external customers',
  internal: 'internal users and employees',
};

/** "the division "Payments" (card processing) of Acme" style scope description. */
export function scopeText(ws: Workspace): string {
  const s = scopeOf(ws);
  return `the ${s.level} "${s.name}"${s.description ? ` (${s.description})` : ''}`;
}

/** Phase goal rendered for a workspace's scope and audiences. */
export function phaseGoal(phase: Phase, ws: Workspace): string {
  const audiences = audiencesOf(ws);
  const internal = audiences.includes('internal');
  let template = PHASE_GOALS[phase];
  if (internal && phase === 'competitor_discovery') template = INTERNAL_COMPETITOR_GOAL;
  if (internal && phase === 'market_research') template += INTERNAL_AUDIENCE_NOTE;
  return renderTemplate(template, {
    scope: scopeText(ws),
    audiences: audiences.map((a) => AUDIENCE_TEXT[a]).join(' and '),
  });
}

/** Sorts phases into pipeline order; `mapping` (optional) always comes first. */
export function orderPhases(phases: Phase[]): Phase[] {
  const order: Phase[] = ['mapping', ...ALL_PHASES];
  const idx = (p: Phase) => {
    const i = order.indexOf(p);
    return i === -1 ? order.length : i;
  };
  return [...new Set(phases)].sort((a, b) => idx(a) - idx(b));
}
