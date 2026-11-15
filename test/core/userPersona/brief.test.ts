/**
 * User persona, task 2 (design 2026-11-15-user-persona-design.md §9, §13, §16): the brief in the system
 * prompts of the orchestrator, synthesizer and interviewer of the tree, and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { ROLES } from '../../../src/core/config/schema.js';
import { DEFAULT_ACTOR } from '../../../src/core/feedback/events.js';
import { rolePromptText } from '../../../src/core/feedback/actions.js';
import { acceptPersonaProposal, retireAdjustment } from '../../../src/core/personas/adjustments.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { CalibrationScope } from '../../../src/core/prompts/index.js';
import { loadPrompt } from '../../../src/core/prompts/index.js';
import { escalationSystemPrompt } from '../../../src/core/escalation/escalation.js';
import { workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Role } from '../../../src/core/types.js';
import { USER_BRIEF_ROLES } from '../../../src/core/userPersona/learn.js';
import { ensureUserPersona, userBrief } from '../../../src/core/userPersona/persona.js';
import { researchSetup } from '../helpers/research.js';

const T0 = '2026-11-14T10:00:00.000Z';
const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

function setup(configure?: (c: BifConfig) => void) {
  const t = researchSetup(opened, configure ? { config: configure } : {});
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  t.store.workspaces.insert({ id: 'ws_a1', name: 'Acme Payments', sector: 'saas', parentWorkspaceId: 'ws_a', createdAt: T0 });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: T0 });
  let n = 0;
  /** Accepts one `add` line for `actor` in tree A (through the real accept function). */
  const accept = (text: string, field = 'priorities', actor = DEFAULT_ACTOR) => {
    const persona = ensureUserPersona(t.store, 'ws_a', actor);
    const p = personaLearningRepos(t.store).proposals.insert({
      id: `ppr_${++n}`, rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: persona.id, action: 'add', field, text,
      rationale: 'r', evidence: [], stats: {}, source: 'retro', status: 'pending', createdAt: T0,
    });
    return acceptPersonaProposal(t.store, actor, 'ws_a', p.id, { maxAdjustments: 12 }).adjustment;
  };
  const prompt = (role: Role, ws = 'ws_a', scope: CalibrationScope = calibrationScope(t.store, t.config, ws)) => rolePromptText(t.config, role, scope);
  /** Every role prompt, as the code before this build assembled it (no brief hook). */
  const before = (role: Role, ws = 'ws_a') => {
    const { userBrief: _ignored, ...bare } = calibrationScope(t.store, t.config, ws);
    return rolePromptText(t.config, role, bare);
  };
  return { ...t, accept, prompt, before };
}

const OTHERS: Role[] = ROLES.filter((r) => !USER_BRIEF_ROLES.includes(r));

describe('the brief in prompts', () => {
  it('is given to the orchestrator, synthesizer and interviewer only', () => {
    expect([...USER_BRIEF_ROLES]).toEqual(['orchestrator', 'synthesizer', 'interviewer']);
    expect(OTHERS).toEqual(['worker', 'reviewer', 'persona', 'escalation', 'retro']);
  });

  it('after accepting a line, the three roles of the tree end with the brief; other roles, other trees do not carry it', () => {
    const t = setup();
    t.accept('Prefers changes that can ship within a quarter over larger bets.');
    const brief = userBrief(t.store, 'ws_a', DEFAULT_ACTOR)!;
    expect(brief).toMatch(/^## The person you work for\n/);
    for (const role of USER_BRIEF_ROLES) {
      for (const ws of ['ws_a', 'ws_a1']) expect(t.prompt(role, ws).endsWith(`\n\n${brief}\n`)).toBe(true);
      expect(t.prompt(role, 'ws_b')).not.toContain('The person you work for');
    }
    for (const role of OTHERS) expect(t.prompt(role)).not.toContain('The person you work for');
    // The prompts as the runs build them.
    const scope = calibrationScope(t.store, t.config, 'ws_a');
    expect(loadPrompt('orchestrator', scope).text).toContain(brief);
    expect(loadPrompt('interviewer', scope).text).toContain(brief);
    expect(workerSystemPrompt(t.config, 'synthesizer', true, 'news_scan', scope)).toContain(brief);
    expect(workerSystemPrompt(t.config, 'worker', true, 'news_scan', scope)).not.toContain('The person you work for');
    expect(escalationSystemPrompt(t.config, scope)).not.toContain('The person you work for');
    expect(loadPrompt('persona_learning', scope).text).not.toContain('The person you work for');
    expect(loadPrompt('user_persona_learning', scope).text).not.toContain(brief);
  });

  it('the brief follows the lessons appendix and changes the prompt version', () => {
    const t = setup();
    const v0 = loadPrompt('orchestrator', calibrationScope(t.store, t.config, 'ws_a')).version;
    t.accept('Prefers short summaries.', 'communication');
    const v1 = loadPrompt('orchestrator', calibrationScope(t.store, t.config, 'ws_a')).version;
    expect(v1).not.toBe(v0);
  });

  it('Review Focus 5: with useInPrompts false, or with no active lines, the prompts are byte-identical to before this build', () => {
    const none = setup();
    ensureUserPersona(none.store, 'ws_a', DEFAULT_ACTOR); // a persona without lines
    for (const role of ROLES) expect(none.prompt(role)).toBe(none.before(role));

    for (const off of [(c: BifConfig) => void (c.userPersona = { useInPrompts: false }), (c: BifConfig) => void (c.userPersona = { enabled: false })]) {
      const t = setup(off);
      t.accept('Prefers changes that can ship within a quarter over larger bets.');
      for (const role of ROLES) expect(t.prompt(role)).toBe(t.before(role));
    }
  });

  it('retiring the line removes it from the prompts', () => {
    const t = setup();
    const line = t.accept('Prefers changes that can ship within a quarter over larger bets.');
    expect(t.prompt('orchestrator')).toContain('The person you work for');
    retireAdjustment(t.store, DEFAULT_ACTOR, 'ws_a', line.id);
    for (const role of ROLES) expect(t.prompt(role)).toBe(t.before(role));
  });

  it('two people: each prompt carries the brief of the configured person only', () => {
    const t = setup((c) => (c.user = { id: 'amy-person' }));
    t.accept('Prefers changes that can ship within a quarter over larger bets.', 'priorities', 'amy-person');
    t.accept('Does not act on a claim backed by one source.', 'evidence_standards', 'zed-person');
    const amy = t.prompt('orchestrator');
    expect(amy).toContain('Prefers changes that can ship');
    expect(amy).not.toContain('Does not act on a claim');
    t.config.user = { id: 'zed-person' };
    const zed = t.prompt('orchestrator');
    expect(zed).toContain('Does not act on a claim');
    expect(zed).not.toContain('Prefers changes that can ship');
  });

  it('no identifier of the person in the brief or the prompts', () => {
    const t = setup((c) => (c.user = { id: 'j.doe+bif' }));
    t.accept('Prefers changes that can ship within a quarter over larger bets.', 'priorities', 'j.doe+bif');
    for (const role of ROLES) {
      const text = t.prompt(role);
      expect(text).not.toContain('j.doe+bif');
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});
