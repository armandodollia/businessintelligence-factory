import { renderTemplate } from '../prompts/index.js';
import type { Audience, Phase, TaskType, Workspace } from '../types.js';
import { audiencesOf, scopeOf } from '../workspace/tree.js';

/** Default pipeline, in order (`mapping` is optional and not included). */
export const ALL_PHASES: Phase[] = [
  'market_research',
  'competitor_discovery',
  'deep_dives',
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
  flow_ranking: [],
  synthesis: ['symptom_hypotheses', 'synthesize_recommendations'],
  persona_panel: ['persona_panel'],
  scoring: [],
};

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
