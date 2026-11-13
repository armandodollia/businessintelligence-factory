import { PERSONA_FIELDS, type PersonaField } from '../scoring/criteria.js';
import type { Persona } from '../types.js';

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
};

/** YAML-safe scalar: plain when harmless, double-quoted (JSON string syntax is valid YAML) otherwise. */
function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.\-/()]*$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
}

/**
 * Compiles a persona profile into a system prompt (`agent.md`) loadable by any configured CLI.
 * Output: YAML frontmatter (`name`, `description`, `version`, `simulated: true`, `audience`), an
 * identity paragraph, one section per `PERSONA_FIELDS` entry, then fixed instructions (stay in
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
