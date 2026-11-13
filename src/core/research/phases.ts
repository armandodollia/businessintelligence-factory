import { renderTemplate } from '../prompts/index.js';
import type { Phase, TaskType, Workspace } from '../types.js';

/** Default pipeline, in order. */
export const ALL_PHASES: Phase[] = [
  'market_research',
  'competitor_discovery',
  'deep_dives',
  'synthesis',
  'persona_panel',
  'scoring',
];

/** Phases that run without an orchestrator agent (delegated to `ResearchDeps.phaseRunners`). */
export const RUNNER_PHASES: ReadonlySet<Phase> = new Set(['persona_panel', 'scoring']);

/** Task types the orchestrator may propose in each phase. */
export const PHASE_TASK_TYPES: Record<Phase, TaskType[]> = {
  market_research: ['audience_segments', 'persona_profile', 'customer_pain_points', 'news_scan'],
  competitor_discovery: ['discover_competitors', 'news_scan'],
  deep_dives: ['flow_walkthrough', 'news_scan', 'public_filings', 'customer_pain_points', 'own_company_audit'],
  synthesis: ['symptom_hypotheses', 'synthesize_recommendations'],
  persona_panel: ['persona_panel'],
  scoring: [],
};

/**
 * Phase goal templates. Placeholders: `{{scope}}` (scope description), `{{audiences}}`.
 * Render with `phaseGoal(phase, workspace)`.
 */
export const PHASE_GOALS: Record<Phase, string> = {
  market_research:
    'Understand the market of {{scope}}: identify the target audience segments ({{audiences}}) from the interview, ' +
    'competitor positioning, reviews, forums, social, industry reports and analyst coverage; build an ' +
    'evidence-backed persona profile per segment; collect customer pain points and relevant market news.',
  competitor_discovery:
    'Discover the competitors of {{scope}}: direct and indirect competitors serving the same audiences ({{audiences}}), ' +
    'with positioning, target segments and why each matters. Every competitor must be backed by evidence.',
  deep_dives:
    'Deep-dive the most important competitors and the own company ({{scope}}): walk key flows (signup, onboarding, ' +
    'pricing, checkout, core flow) with a screenshot per step, scan news and public filings, and collect customer ' +
    'pain points. Apply the same task types to the own company via own_company_audit.',
  synthesis:
    'Link the interview symptoms of {{scope}} to research findings (symptom hypotheses) and synthesize ' +
    'evidence-backed recommendations, each referencing the findings that support it. Use verified findings only.',
  persona_panel: 'Put every recommendation for {{scope}} to each persona independently (simulated feedback).',
  scoring: 'Score and prioritise the recommendations for {{scope}}.',
};

/** Phase goal rendered for a workspace. */
export function phaseGoal(phase: Phase, ws: Pick<Workspace, 'name'>): string {
  return renderTemplate(PHASE_GOALS[phase], { scope: ws.name, audiences: 'external customers' });
}

/** Sorts phases into pipeline order (unknown phases keep their relative order at the end). */
export function orderPhases(phases: Phase[]): Phase[] {
  const order = [...ALL_PHASES];
  const idx = (p: Phase) => {
    const i = order.indexOf(p);
    return i === -1 ? order.length : i;
  };
  return [...new Set(phases)].sort((a, b) => idx(a) - idx(b));
}
