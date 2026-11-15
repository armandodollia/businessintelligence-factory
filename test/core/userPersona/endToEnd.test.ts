/**
 * User persona, task 4 (design 2026-11-15-user-persona-design.md §15): end to end. Twelve actions on six
 * things through the real action functions change nothing until the retro; the retro proposes a line;
 * the user accepts it and the orchestrator's prompt carries it (a reviewer's does not); the user rejects
 * a second proposal with a reason and the next retro's learning prompt shows that rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '../../../src/core/config/schema.js';
import { rolePromptText, setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { DEFAULT_ACTOR } from '../../../src/core/feedback/events.js';
import { runRetro } from '../../../src/core/learning/lessons/retro.js';
import { acceptPersonaProposal, rejectPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Role } from '../../../src/core/types.js';
import { interactionGate, openInteractions } from '../../../src/core/userPersona/interactions.js';
import { USER_BRIEF_ROLES } from '../../../src/core/userPersona/learn.js';
import { userBrief, userPersonaOf } from '../../../src/core/userPersona/persona.js';
import { userPersonaSettings } from '../../../src/core/userPersona/settings.js';
import { lessonsHarness, lessonsSetup } from '../lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const LINE_1 = 'Does not act on a finding that rests on a single review site.';
const LINE_2 = 'Prefers to see the competitor with the highest threat first.';
const REASON = 'That is not how I decide what to look at first.';

const isUserLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# User persona learning');
/** Shown actions of a learning prompt by stance, in prompt order. */
const shown = (prompt: string, stance: string) => [...prompt.matchAll(new RegExp(`^- (\\S+) ${stance} —`, 'gm'))].map((m) => m[1]!);

describe('the user persona end to end', () => {
  it('actions → nothing until the retro → proposal → accept → brief in the orchestrator\'s prompt only → a rejection with a reason teaches the next retro', async () => {
    const t = lessonsSetup(opened);
    const ws = [t.a.id, t.aChild.id];
    const competitors = Array.from({ length: 6 }, (_, i) =>
      t.store.competitors.insert({
        id: newId('cmp'), workspaceId: i % 2 ? t.aChild.id : t.a.id, name: `Rival ${i}`, threat: 3, directness: 3,
        comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: t.at(), updatedAt: t.at(), status: 'verified',
      }),
    );
    const prompts = () => Object.fromEntries(ws.flatMap((w) => ROLES.map((r) => [`${w}/${r}`, rolePromptText(t.config, r, calibrationScope(t.store, t.config, w))])));
    const prompt = (role: Role, w = t.a.id) => rolePromptText(t.config, role, calibrationScope(t.store, t.config, w));
    const before = prompts();
    const repos = personaLearningRepos(t.store);

    // --- twelve actions on six things, through the real action functions ---
    for (const c of competitors) {
      t.at();
      setIncludeOverride(t.store, 'competitor', c.id, false, { reason: 'it rests on a single review site' });
      t.at();
      rateCriterion({ workspaceId: c.workspaceId, targetType: 'competitor', targetId: c.id, criterion: 'threat', verdict: 'disagree', userValue: 1, reason: 'overstated' }, t);
    }
    const settings = userPersonaSettings(t.config);
    const now = () => new Date(Date.parse(t.at()) + 1);
    const open = openInteractions(t.store, settings, t.a.id, DEFAULT_ACTOR, now());
    expect(interactionGate(open, settings)).toEqual({ n: 12, targets: 6, qualifies: true, missing: [] });

    // --- nothing exists or changes before the retro ---
    expect(t.store.personas.list({ kind: 'user' })).toEqual([]);
    expect(repos.runs.list({ rootWorkspaceId: t.a.id })).toEqual([]);
    expect(repos.proposals.list({ rootWorkspaceId: t.a.id })).toEqual([]);
    expect(userBrief(t.store, t.a.id, DEFAULT_ACTOR)).toBeUndefined();
    expect(prompts()).toEqual(before);

    // --- the retro: one learning run per retro; it proposes LINE_1, then LINE_2, then nothing ---
    let learningRuns = 0;
    const h = lessonsHarness(t, (req) => {
      if (!isUserLearning(req)) return req.kind === 'retro' ? async (tc) => void (await tc.call('submit_retro', { summary: 'ok', proposals: [] })) : undefined;
      const n = ++learningRuns;
      const personaId = /persona_id `(\w+)`/.exec(req.prompt)![1]!;
      return async (tc) => {
        const proposals =
          n === 1 ? [{ action: 'add', field: 'evidence_standards', text: LINE_1, why: 'Every exclusion named a single review site.', evidence: shown(req.prompt, 'reject').slice(0, 3) }]
          : n === 2 ? [{ action: 'add', field: 'priorities', text: LINE_2, why: 'Includes the rivals it rates up.', evidence: shown(req.prompt, 'accept').slice(0, 3) }]
          : [];
        await tc.call('submit_persona_learning', { persona_id: personaId, assumption: 'Judges findings by their sources.', proposals });
      };
    });
    const learningPrompts = () => h.requests.filter(isUserLearning).map((r) => r.prompt);

    const first = (await runRetro(h.deps, t.a.id, { now: now() }))!;
    expect(first.digest).toMatchObject({ userInteractions: 12, userLearningRuns: 1, userProposals: 1 });
    const persona = userPersonaOf(t.store, t.aChild.id, DEFAULT_ACTOR)!;
    expect(persona).toMatchObject({ kind: 'user', workspaceId: t.a.id, version: 1 });
    const [p1] = repos.proposals.list({ personaId: persona.id });
    expect(p1).toMatchObject({ status: 'pending', action: 'add', field: 'evidence_standards', text: LINE_1 });
    // A pending proposal changes nothing yet.
    expect(repos.adjustments.list({ personaId: persona.id })).toEqual([]);
    expect(prompts()).toEqual(before);

    // --- accept (from the child node) → the orchestrator's prompt carries the line, a reviewer's does not ---
    t.at();
    const { adjustment } = acceptPersonaProposal(t.store, DEFAULT_ACTOR, t.aChild.id, p1!.id, { reason: 'yes, one site is not enough', maxAdjustments: settings.maxAdjustments });
    const line = `- [${adjustment.marker}.v1] (evidence_standards) ${LINE_1}`;
    for (const w of ws) {
      for (const role of USER_BRIEF_ROLES) expect(prompt(role, w)).toContain(line);
      for (const role of ROLES.filter((r) => !USER_BRIEF_ROLES.includes(r))) expect(prompt(role, w)).toBe(before[`${w}/${role}`]);
    }
    expect(prompt('reviewer')).not.toContain(LINE_1);
    expect(prompt('orchestrator', t.b.id)).not.toContain(LINE_1);

    // --- twelve more actions; the second retro proposes LINE_2; the user rejects it with a reason ---
    for (const c of competitors) {
      t.at();
      setIncludeOverride(t.store, 'competitor', c.id, true);
      t.at();
      rateCriterion({ workspaceId: c.workspaceId, targetType: 'competitor', targetId: c.id, criterion: 'directness', verdict: 'agree' }, t);
    }
    const second = (await runRetro(h.deps, t.a.id, { now: now() }))!;
    expect(second.digest).toMatchObject({ userLearningRuns: 1, userProposals: 1 });
    // The second run saw the line so far, and the accept as an action.
    expect(learningPrompts()[1]).toContain(LINE_1);
    expect(learningPrompts()[1]).toContain('persona_learning_accept');
    const p2 = repos.proposals.list({ personaId: persona.id, status: 'pending' })[0]!;
    expect(p2.text).toBe(LINE_2);
    t.at();
    rejectPersonaProposal(t.store, DEFAULT_ACTOR, t.a.id, p2.id, { reason: REASON });
    expect(userBrief(t.store, t.a.id, DEFAULT_ACTOR)).not.toContain(LINE_2);

    // --- twelve more actions; the third retro's prompt shows the rejection with its reason ---
    for (const c of competitors) {
      t.at();
      setIncludeOverride(t.store, 'competitor', c.id, false, { reason: 'single source again' });
      t.at();
      rateCriterion({ workspaceId: c.workspaceId, targetType: 'competitor', targetId: c.id, criterion: 'ux', verdict: 'disagree', userValue: 2 }, t);
    }
    const third = (await runRetro(h.deps, t.a.id, { now: now() }))!;
    expect(third.digest).toMatchObject({ userLearningRuns: 1, userProposals: 0 });
    const last = learningPrompts()[2]!;
    expect(last).toContain('## Proposals the person rejected before (newest first)');
    expect(last).toContain(`- add (priorities): ${LINE_2} — their reason: ${REASON}`);
    // The rejection is itself an action shown with its reason.
    expect(last).toMatch(new RegExp(`^- \\S+ reject — persona_learning_reject on persona_proposal ${p2.id}.*\\n  reason: ${REASON}`, 'm'));
    // The accepted line is still the only one in the brief.
    expect(userBrief(t.store, t.a.id, DEFAULT_ACTOR)).toBe(
      ['## The person you work for', '', 'Learned from their decisions in this tool. Follow it where it does not conflict with the evidence.', '', line].join('\n'),
    );
  });
});
