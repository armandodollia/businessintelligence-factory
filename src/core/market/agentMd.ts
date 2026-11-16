import type { PersonaAdjustment } from '../personas/types.js';
import { PERSONA_FIELDS, STAKEHOLDER_FIELDS, type PersonaField, type StakeholderField } from '../scoring/criteria.js';
import { isParked } from '../stakeholders/kinds.js';
import { OWN_STANCES, RIVAL_STANCES } from '../stakeholders/types.js';
import type { Persona, PersonaProfileField } from '../types.js';

/** Section heading in agent.md for each persona profile field (spec §8b). */
export const AGENT_MD_HEADINGS: Record<PersonaField, string> = {
  demographics: 'Demographics',
  socioeconomic: 'Socioeconomic status',
  personality_values: 'Personality and values',
  goals: 'Goals',
  needs: 'Needs',
  pain_points: 'Pain points',
  jobs_to_be_done: 'Jobs to be done',
  buying_behavior: 'Buying behavior',
  channels_media: 'Channels and media',
  alternatives_switching: 'Current alternatives and switching costs',
  tech_attitude: 'Attitude to technology',
  voice: 'Voice (how you talk)',
  segment_size_value: 'Segment size and value',
};

export type AgentMdOptions = {
  /** Name of the workspace scope (company, division or slice) the persona relates to. */
  scopeName?: string;
  /** The persona's active adjustments, oldest first (persona learning, design §10). */
  adjustments?: Array<Pick<PersonaAdjustment, 'marker' | 'version' | 'field' | 'text'>>;
};

/** The "Corrections" section: one bullet per adjustment, `- [<marker>.v<version>] (<field>) <text>`; none without adjustments. */
function correctionsSection(adjustments: AgentMdOptions['adjustments'] = []): string[] {
  if (!adjustments.length) return [];
  return [
    '',
    '## Corrections from people who know your segment',
    '',
    'Where a correction conflicts with the profile above, the correction wins.',
    '',
    ...adjustments.map((a) => `- [${a.marker}.v${a.version}]${a.field ? ` (${a.field})` : ''} ${a.text.replace(/\s+/g, ' ').trim()}`),
  ];
}

/** YAML-safe scalar: plain when harmless, double-quoted (JSON string syntax is valid YAML) otherwise. */
function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.\-/()]*$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
}

/**
 * Compiles a persona profile into a system prompt (`agent.md`) loadable by any configured CLI.
 * Output: YAML frontmatter (`name`, `description`, `version`, `simulated: true`, `audience`), an
 * identity paragraph, one section per `PERSONA_FIELDS` entry, the user's corrections (active persona
 * adjustments; omitted when there are none), then fixed instructions (stay in
 * character, be candid not agreeable, say when something is irrelevant to you). Internal personas
 * are framed as employees / internal users of the scope; external ones as (prospective) customers.
 */
export function compileAgentMd(persona: Persona, opts: AgentMdOptions = {}): string {
  const audience = persona.audience ?? 'external';
  const internal = audience === 'internal';
  const scope = opts.scopeName?.trim() || 'the business';
  const description = internal
    ? `Simulated internal persona (employee / internal user of ${scope}): ${persona.segment}`
    : `Simulated customer persona (external audience of ${scope}): ${persona.segment}`;

  const out: string[] = [
    '---',
    `name: ${yamlScalar(persona.slug)}`,
    `description: ${yamlScalar(description)}`,
    `version: ${persona.version}`,
    'simulated: true',
    `audience: ${audience}`,
    '---',
    '',
    `# ${persona.segment}`,
    '',
    internal
      ? `You are a member of this segment: ${persona.segment}. You work at or inside ${scope} — an employee or ` +
        `internal user of it, not a paying customer. You judge proposals as someone whose daily work they ` +
        `change: adoption means you would actually use it, "willingness to pay" means you would spend budget, ` +
        `time or political capital on it.`
      : `You are a member of this customer segment: ${persona.segment}. You are a current or prospective ` +
        `customer of ${scope}, judging proposals as someone who would have to choose, adopt and pay for them.`,
    '',
    'You are a simulated persona built from researched evidence. The profile below is who you are; ' +
      'confidence and evidence notes tell you how sure the research is about each part.',
  ];

  for (const field of PERSONA_FIELDS) {
    const f = persona.profile[field];
    out.push('', `## ${AGENT_MD_HEADINGS[field]}`, '');
    if (!f) {
      out.push('(unknown — not researched)');
      continue;
    }
    out.push(f.value.trim());
    const ev = f.evidence.length ? f.evidence.join(', ') : 'none';
    out.push('', `_Confidence: ${f.confidence} · Evidence: ${ev}_`);
  }

  out.push(...correctionsSection(opts.adjustments));

  out.push(
    '',
    '## Instructions',
    '',
    '- Stay in character at all times. Speak in the first person, with the vocabulary in your "Voice" ' +
      'section. Never say you are an AI or describe the research behind you.',
    '- Be candid, not agreeable. Do not be polite at the cost of honesty: if a proposal is weak, ' +
      'expensive, risky or annoying for someone like you, say so plainly and say why.',
    '- If something is irrelevant to you, say that it is irrelevant to you and score it accordingly ' +
      '(low appeal and adoption) instead of inventing interest.',
    '- Ground every judgment in your goals, needs, pain points, buying behavior and alternatives above. ' +
      'Where the profile is silent or low-confidence, say you are unsure rather than making things up.',
    '- When asked to evaluate a recommendation, answer by calling `submit_persona_feedback` exactly once ' +
      '(scores 1–5: appeal, adoption, willingness_to_pay, friction — higher friction = more friction).',
    '',
  );
  return out.join('\n');
}

/** Section heading in a stakeholder's agent.md for each stakeholder profile field (stakeholder design §5). */
export const STAKEHOLDER_AGENT_MD_HEADINGS: Record<StakeholderField, string> = {
  role_mandate: 'Role and mandate',
  goals_incentives: 'Goals and incentives',
  decision_criteria: 'Decision criteria',
  constraints: 'Constraints',
  risk_tolerance: 'Risk tolerance',
  dependencies: 'Dependencies (what you and this business need from each other)',
  known_positions: 'Known positions (past decisions and their reasons)',
  objections: 'Typical objections',
  information_needs: 'Information you need to decide',
  communication_style: 'Communication style (how you talk)',
  influence: 'Influence',
};

export type StakeholderMdOptions = {
  /** Name of the workspace scope (the node) the stakeholder relates to. */
  scopeName?: string;
  /** Name of the competitor, for a competitor's stakeholder. */
  competitorName?: string;
  adjustments?: AgentMdOptions['adjustments'];
};

const stances = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(', ');

/** One line without a closing full stop (stored texts placed inside a sentence). */
const inline = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');

/** What a profile field of a former colleague rests on, in words (positions design §6). */
function restsOn(basis: NonNullable<PersonaProfileField['basis']>, leftAt: string): string {
  if (basis === 'internal') return `internal knowledge (as of ${leftAt})`;
  if (basis === 'public') return 'public sources';
  return basis === 'both' ? 'both' : 'a conclusion from both';
}

/**
 * Compiles a stakeholder persona (`kind: 'stakeholder'`) into its agent.md (stakeholder design §6):
 * frontmatter (`name`, `description`, `version`, `simulated: true`, `kind: stakeholder`,
 * `stakeholder_type`, `subject`), an opening paragraph (own: "a stakeholder of <scope>: <relation>",
 * judging as someone who must approve, fund or supply; competitor: "at <competitor>, a rival of
 * <scope>", judging how they would respond), one section per `STAKEHOLDER_FIELDS` entry, the
 * corrections section of persona learning, then instructions to answer with `submit_stakeholder_read`.
 *
 * A former colleague (`leftAt`; positions design §6). At a competitor: frontmatter
 * `former_colleague: true`; after the opening paragraph, that until that date they worked at the node
 * in the position of `leftFrom` and know it as it was up to then and nothing later; and per section
 * what it rests on (`basis`) and any recorded `conflict`. Parked (`isParked`): compiled as an own
 * stakeholder, with a first line saying they left on that date and an opening line without the relation.
 */
export function compileStakeholderMd(persona: Persona, opts: StakeholderMdOptions = {}): string {
  const scope = opts.scopeName?.trim() || 'the business';
  const rival = persona.subjectKind === 'competitor';
  const competitor = opts.competitorName?.trim() || 'a competitor';
  const label = persona.segment;
  const relation = inline(persona.relation);
  const leftAt = persona.leftAt || undefined;
  const formerRival = rival && leftAt !== undefined;
  const parked = leftAt !== undefined && isParked(persona);
  // Where the person worked: the node's scope name when they left (the node may be renamed later).
  const from = inline(persona.leftFrom?.scopeName) || scope;
  const description = rival
    ? `Simulated stakeholder persona of ${competitor}, a rival of ${scope}: ${label}`
    : `Simulated stakeholder persona of ${scope}: ${label}`;

  const out: string[] = [
    '---',
    `name: ${yamlScalar(persona.slug)}`,
    `description: ${yamlScalar(description)}`,
    `version: ${persona.version}`,
    'simulated: true',
    'kind: stakeholder',
    ...(persona.stakeholderType ? [`stakeholder_type: ${persona.stakeholderType}`] : []),
    `subject: ${rival ? 'competitor' : 'own'}`,
    ...(formerRival ? ['former_colleague: true'] : []),
    '---',
    '',
    `# ${label}`,
    '',
    ...(parked ? [`You left ${from} on ${leftAt}: what follows is who you were there until then.`, ''] : []),
    rival
      ? `You are ${label} at ${competitor}, a rival of ${scope}${relation ? `: ${relation}` : ''}. You judge proposals of ` +
        `${scope} as someone at ${competitor} who decides how ${competitor} responds to them: ignore them, watch them, ` +
        'copy them or counter them.'
      : // A parked persona's relation holds its title at the new company, not what the node needed from it.
        `You are ${label}, a stakeholder of ${scope}${relation && !parked ? `: ${relation}` : ''}. You judge proposals as someone who ` +
        'must approve, fund or supply them.',
    ...(formerRival ? ['', ...formerColleagueParagraphs(persona, from, leftAt)] : []),
    '',
    'You are a simulated stakeholder built from researched evidence. The profile below is who you are; ' +
      'confidence and evidence notes tell you how sure the research is about each part.',
  ];

  for (const field of STAKEHOLDER_FIELDS) {
    const f = persona.profile[field];
    out.push('', `## ${STAKEHOLDER_AGENT_MD_HEADINGS[field]}`, '');
    if (!f) {
      out.push('(unknown — not researched)');
      continue;
    }
    out.push(f.value.trim());
    const ev = f.evidence.length ? f.evidence.join(', ') : 'none';
    out.push('', `_Confidence: ${f.confidence} · Evidence: ${ev}_`);
    if (formerRival) {
      if (f.basis) out.push('', `_Rests on: ${restsOn(f.basis, leftAt)}_`);
      const conflict = (f.conflict ?? '').replace(/\s+/g, ' ').trim();
      if (conflict) out.push('', `_Conflict: ${conflict}_`);
    }
  }

  out.push(...correctionsSection(opts.adjustments));

  out.push(
    '',
    '## Instructions',
    '',
    '- Stay in character at all times. Speak in the first person, in the style of your "Communication style" ' +
      'section. Never say you are an AI or describe the research behind you.',
    '- Be candid, not agreeable. Judge every proposal against your mandate, goals, decision criteria, constraints and ' +
      'risk tolerance above; say plainly what you would refuse and why.',
    '- Where the profile is silent or low-confidence, say you are unsure rather than making things up.',
    rival
      ? `- When asked to read a recommendation of ${scope}, answer by calling \`submit_stakeholder_read\` exactly once: ` +
        `how ${competitor} would respond (stance: ${stances(RIVAL_STANCES)}), what would worry you, your reasoning and ` +
        'what would change your mind.'
      : '- When asked to read a recommendation, answer by calling `submit_stakeholder_read` exactly once: your stance ' +
        `(${stances(OWN_STANCES)}), the conditions you would set, your concerns, your reasoning and what would change ` +
        'your mind. Say `not_my_call` when the decision is not yours.',
    '',
  );
  return out.join('\n');
}

/**
 * The two paragraphs after the opening one in the agent.md of a former colleague at a competitor: where
 * they worked until when and in which position, that their knowledge of it ends there, and how to read
 * the "Rests on" line of each section.
 */
function formerColleagueParagraphs(persona: Persona, from: string, leftAt: string): string[] {
  const held = persona.leftFrom;
  const title = inline(held?.title);
  const relation = inline(held?.relation);
  const type = held?.stakeholderType ?? persona.stakeholderType ?? 'other';
  return [
    `Until ${leftAt} you worked at ${from}${title ? ` as ${title}` : ''}, one of its stakeholders (${type})${relation ? `: ${relation}` : ''}. ` +
      `You know its plans, its people and its way of deciding as they were up to ${leftAt}, and nothing that changed there later.`,
    '',
    'Each section below says what it rests on: internal knowledge from your time there, public sources since you left, both, or a ' +
      'conclusion from both. Where the two disagree, the section says so.',
  ];
}
