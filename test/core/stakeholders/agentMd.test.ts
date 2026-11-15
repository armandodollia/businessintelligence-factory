/**
 * Stakeholder personas, task 2 (design §6): a stakeholder's agent.md, and segment agent.md unchanged.
 */
import { describe, expect, it } from 'vitest';
import { compileAgentMd, compileStakeholderMd, STAKEHOLDER_AGENT_MD_HEADINGS } from '../../../src/core/market/agentMd.js';
import { PERSONA_FIELDS, STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import type { Persona } from '../../../src/core/types.js';

const own: Persona = {
  id: 'per_cfo', workspaceId: 'ws_a', slug: 'stk-chief-financial-officer', segment: 'Chief financial officer', version: 2,
  agentMdPath: '/x', kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: 'approves pricing changes',
  disclosure: 'hidden',
  profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.7, evidence: ['art_1'] }])),
};
const rival: Persona = { ...own, slug: 'stk-rival-pay-ceo', segment: 'CEO', subjectKind: 'competitor', subjectId: 'cmp_rival', relation: 'sets the strategy', disclosure: 'open' };

describe('compileStakeholderMd', () => {
  it('frames an own stakeholder, one section per field, frontmatter kind and simulated', () => {
    const md = compileStakeholderMd(own, { scopeName: 'Acme Payments' });
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)![1]!.split('\n');
    expect(fm).toContain('name: stk-chief-financial-officer');
    expect(fm).toContain('version: 2');
    expect(fm).toContain('simulated: true');
    expect(fm).toContain('kind: stakeholder');
    expect(md).toContain(
      'You are Chief financial officer, a stakeholder of Acme Payments: approves pricing changes. You judge proposals as ' +
        'someone who must approve, fund or supply them',
    );
    for (const f of STAKEHOLDER_FIELDS) {
      expect(md).toContain(`\n## ${STAKEHOLDER_AGENT_MD_HEADINGS[f]}\n`);
      expect(md).toContain(`${f} value`);
    }
    const instr = md.indexOf('## Instructions');
    expect(instr).toBeGreaterThan(md.indexOf(`## ${STAKEHOLDER_AGENT_MD_HEADINGS.influence}`));
    expect(md.slice(instr)).toContain('submit_stakeholder_read');
    expect(md.slice(instr)).toMatch(/approve_with_conditions/);
    expect(md).not.toContain('Corrections');
  });

  it('frames a competitor stakeholder as a rival and asks how they would respond', () => {
    const md = compileStakeholderMd(rival, { scopeName: 'Acme Payments', competitorName: 'Rival Pay' });
    expect(md).toContain('You are CEO at Rival Pay, a rival of Acme Payments: sets the strategy.');
    const tail = md.slice(md.indexOf('## Instructions'));
    expect(tail).toContain('submit_stakeholder_read');
    expect(tail).toMatch(/respond/);
    expect(tail).toMatch(/counter/);
  });

  it('carries the corrections section of persona learning', () => {
    const md = compileStakeholderMd(own, {
      adjustments: [{ marker: 'A-3F9C21', version: 1, field: 'decision_criteria', text: 'You want a payback under a year.' }],
    });
    const heading = '## Corrections from people who know your segment';
    const at = md.indexOf(heading);
    expect(at).toBeGreaterThan(md.indexOf(`## ${STAKEHOLDER_AGENT_MD_HEADINGS.influence}`));
    expect(at).toBeLessThan(md.indexOf('## Instructions'));
    expect(md).toContain('- [A-3F9C21.v1] (decision_criteria) You want a payback under a year.');
  });
});

describe('segment agent.md', () => {
  it('is unchanged by stakeholder personas', () => {
    const persona: Persona = {
      id: 'per_1', workspaceId: 'ws_a', slug: 'smb-finance', segment: 'SMB finance lead', version: 3, audience: 'external',
      agentMdPath: '/x', profile: Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.7, evidence: ['art_1'] }])),
    };
    const md = compileAgentMd(persona, {
      scopeName: 'Acme Payments',
      adjustments: [{ marker: 'A-3F9C21', version: 2, field: 'buying_behavior', text: 'You compare on total yearly cost.' }],
    });
    expect(md).toMatchSnapshot();
  });
});
