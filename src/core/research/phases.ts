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
 * Task types whose runs work in private (stakeholder design §7, task 6 fix round 2): own stakeholder
 * research may not reach the user except through the question round, and may store nothing but
 * stakeholders and copies of the public pages it relies on. Its runs cannot ask the user anything
 * (`request_user_action`, `request_approval`, escalation), and a non-reviewer run may call only
 * `PRIVATE_TASK_TOOLS`. Private is not offline: since the user's ruling of 2026-11-15 these runs may
 * use the web like any other research task.
 */
export const PRIVATE_TASK_TYPES: ReadonlySet<TaskType> = new Set(['own_stakeholders']);

/**
 * What a non-reviewer run of a private task may call: save stakeholders, store a copy of each public
 * page it relies on (to cite as evidence; `taskToolInputRefusal` narrows it to kind, mime, content and
 * source_url: no title, note, description, flow, step, applies_to or entity), finish, answer its
 * review, log, and read. No `describe_artifact`: a caption is the worker's own words.
 */
export const PRIVATE_TASK_TOOLS: ReadonlySet<string> = new Set([
  'save_stakeholder', 'save_artifact', 'submit_result', 'respond_to_review', 'log_decision',
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
  return `tool '${tool}' is not available in a ${type} task: it may save only stakeholders (save_stakeholder) ` +
    'and copies of the public pages it relies on (save_artifact). ' +
    'Finish with what you have and call submit_result.';
}

/** The only `save_artifact` options a private task's worker may pass (a copy of a public page, no words of its own). */
const PRIVATE_SAVE_OPTIONS: ReadonlySet<string> = new Set(['kind', 'mime', 'content', 'content_base64', 'file_path', 'source_url']);
/** The kinds a private task's page copy may have (a screenshot needs a caption: the worker's own words). */
const PRIVATE_SAVE_KINDS: ReadonlySet<string> = new Set(['page_snapshot', 'document']);

/**
 * Why a run of a task of `type`, in `role`, may not call `tool` with this (validated) `input` ('' when
 * it may). A private task saves only copies of public pages: `save_artifact` takes `kind`
 * (`page_snapshot` or `document`), `mime`, the content and an http(s) `source_url`, nothing else — no
 * title, note, description, flow, step, applies_to or entity (the handler derives the title from the
 * URL, `pageCopyTitle`).
 */
export function taskToolInputRefusal(type: TaskType, role: string, tool: string, input: unknown): string {
  if (!PRIVATE_TASK_TYPES.has(type) || role === 'reviewer' || tool !== 'save_artifact') return '';
  const i = (input ?? {}) as Record<string, unknown>;
  const why = (what: string) => `save_artifact in a ${type} task stores only copies of public pages you rely on: ${what}`;
  const extra = Object.keys(i).filter((k) => i[k] !== undefined && !PRIVATE_SAVE_OPTIONS.has(k)).sort();
  if (extra.length) {
    return why(`${extra.map((k) => `'${k}'`).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not accepted (pass only kind, mime, the content and source_url; the title is taken from the URL)`);
  }
  if (typeof i.kind !== 'string' || !PRIVATE_SAVE_KINDS.has(i.kind)) return why(`kind '${String(i.kind)}' is not accepted (use page_snapshot or document)`);
  if (!pageCopyTitle(i.source_url)) return why('source_url (the http or https address of the page) is required');
  return '';
}

/** The stored title of a private task's page copy: host and path of its http(s) source URL ('' when there is none). */
export function pageCopyTitle(sourceUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof sourceUrl === 'string' ? sourceUrl : '');
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
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
    'work it depends on (own_stakeholders, from what the store already holds and the public web; set needs_browser ' +
    'when it should browse), and the leaders, owners and investors of its most important competitors from public sources (competitor_stakeholders; ' +
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
