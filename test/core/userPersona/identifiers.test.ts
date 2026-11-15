/**
 * User persona, task 4 (design 2026-11-15-user-persona-design.md §3, §13): no identifier of the person.
 * With a configured user id (regex-special characters) and typed reasons that hold it, an email address
 * and a stored identity's password, none of them appears in a stored line, the persona row (but its
 * `subjectId`), a run or proposal, `userBrief`, the prompts of any role, or a request to an agent; the
 * learning prompt shows the reasons only after the identity redaction and the identifier redaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '../../../src/core/config/schema.js';
import { rolePromptText } from '../../../src/core/feedback/actions.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { acceptPersonaProposal, rejectPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { personaLearningToolHandlers } from '../../../src/core/personas/learn.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import type { Store } from '../../../src/core/store/db.js';
import { runUserPersonaLearning } from '../../../src/core/userPersona/learn.js';
import { userBrief, userPersonaOf } from '../../../src/core/userPersona/persona.js';
import { researchSetup } from '../helpers/research.js';

const T0 = '2026-11-14T10:00:00.000Z';
const USER = 'j.doe+bif';
const EMAIL = 'j.doe@example.test';
const SECRET = 'hunter2-SECRETPW';
const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
const REASONS = [`ask ${USER.toUpperCase()} or ${EMAIL} first`, `the login ${SECRET} was in the screenshot`, 'it rests on one source only'];

const opened: Store[] = [];
let minute = 0;
beforeEach(() => {
  minute = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const tick = () => vi.setSystemTime(new Date(Date.parse(T0) + ++minute * 60_000));
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);
const isUserLearning = (req: AgentRequest) => req.prompt.startsWith('# User persona learning');

/** Neither the configured id (any case), the email, the identity's secrets nor any email-like string. */
function clean(text: string, what: string) {
  expect(text.toLowerCase(), what).not.toContain(USER);
  expect(text, what).not.toMatch(EMAIL_LIKE);
  expect(text, what).not.toContain(SECRET);
}

function setup() {
  const t = researchSetup(opened, { extraHandlers: () => personaLearningToolHandlers(), config: (c) => (c.user = { id: USER }) });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  t.store.identities.insert({ id: 'idn_1', workspaceId: 'ws_a', site: 'acme.test', name: 'Test', email: 'qa-bot@acme.test', password: SECRET, createdAt: T0 });
  /** 12 exclusions by the person on 6 findings, each with one of REASONS. */
  const act = (prefix: string) => {
    for (let i = 0; i < 12; i++) {
      tick();
      recordFeedback(t.store, {
        workspaceId: 'ws_a', actor: USER, kind: 'include_override', targetType: 'finding', targetId: `${prefix}_${i % 6}`,
        afterJson: { include: false }, reason: REASONS[i % REASONS.length]!,
      });
    }
  };
  const refusals: string[] = [];
  /** The learning run first tries lines that identify the person (refused), then proposes a clean one; its assumption and why hold identifiers. */
  t.state.pick = (req) => {
    if (!isUserLearning(req)) return undefined;
    const personaId = /persona_id `(\w+)`/.exec(req.prompt)![1]!;
    const ids = [...req.prompt.matchAll(/^- (\S+) reject —/gm)].map((m) => m[1]!).slice(0, 3);
    const add = (text: string) => ({ action: 'add', field: 'evidence_standards', text, why: `${USER} said so, see ${EMAIL}`, evidence: ids });
    const submit = (text: string) => ({ persona_id: personaId, assumption: `Writes to ${EMAIL} as ${USER}.`, proposals: [add(text)] });
    return async (tc) => {
      for (const text of [`Copies ${EMAIL} on every summary.`, `Prefers what ${USER.toUpperCase()} prefers.`]) {
        try {
          await tc.call('submit_persona_learning', submit(text));
          refusals.push('accepted');
        } catch (e) {
          refusals.push((e as Error).message);
        }
      }
      await tc.call('submit_persona_learning', submit(`Does not act on a claim backed by one source (${minute}).`));
    };
  };
  const repos = personaLearningRepos(t.store);
  const learningRequests = () => t.requests.filter(isUserLearning);
  return { ...t, act, refusals, repos, learningRequests };
}

describe('no identifier of the person', () => {
  it('lines, persona, runs, proposals, brief, prompts and requests hold none; reasons reach the learning prompt only redacted', async () => {
    const t = setup();
    t.act('fa');
    expect(await runUserPersonaLearning(t.deps, 'ws_a', { now: later() })).toMatchObject({ userLearningRuns: 1, userProposals: 1 });
    expect(t.refusals).toHaveLength(2);
    for (const r of t.refusals) expect(r).toMatch(/names or identifies the person/);

    // The learning prompt: every reason shown, redacted.
    const [req] = t.learningRequests();
    clean(req!.prompt, 'learning prompt');
    clean(req!.systemPrompt, 'learning system prompt');
    clean(JSON.stringify(req), 'learning request');
    expect(req!.prompt).toContain('reason: ask (redacted) or (redacted) first');
    expect(req!.prompt).toContain('reason: it rests on one source only');
    expect(req!.prompt).toContain('reason: the login [redacted] was in the screenshot'); // the identity redaction

    // Accepting with an edited text that names the person is refused; the clean text is accepted.
    const persona = userPersonaOf(t.store, 'ws_a', USER)!;
    const p1 = t.repos.proposals.list({ personaId: persona.id, status: 'pending' })[0]!;
    for (const text of [`Copies ${EMAIL} on summaries.`, `Asks ${USER} first.`]) {
      expect(() => acceptPersonaProposal(t.store, USER, 'ws_a', p1.id, { text, maxAdjustments: 12 })).toThrow(/names or identifies the person/);
    }
    acceptPersonaProposal(t.store, USER, 'ws_a', p1.id, { maxAdjustments: 12, reason: `fine, tell ${EMAIL}` });

    // A second round: the user rejects with a reason holding the email; the next prompt shows it redacted.
    t.act('fb');
    await runUserPersonaLearning(t.deps, 'ws_a', { now: later() });
    const p2 = t.repos.proposals.list({ personaId: persona.id, status: 'pending' })[0]!;
    rejectPersonaProposal(t.store, USER, 'ws_a', p2.id, { reason: `no; ask ${EMAIL} or ${USER}` });
    t.act('fc');
    await runUserPersonaLearning(t.deps, 'ws_a', { now: later() });
    const prompts = t.learningRequests().map((r) => r.prompt);
    expect(prompts).toHaveLength(3);
    for (const [i, p] of prompts.entries()) clean(p, `learning prompt ${i + 1}`);
    expect(prompts[2]).toContain('their reason: no; ask (redacted) or (redacted)');
    for (const r of t.learningRequests()) clean(JSON.stringify(r), 'learning request');

    // Stored: the persona (but its subjectId), every line, run and proposal.
    const row = t.store.personas.get(persona.id)!;
    expect(row.subjectId).toBe(USER);
    const { subjectId: _id, ...rest } = row;
    clean(JSON.stringify(rest), 'persona row');
    const lines = t.repos.adjustments.list({ personaId: persona.id });
    expect(lines).toHaveLength(1);
    for (const l of lines) clean(l.text, 'line');
    for (const run of t.repos.runs.list({ personaId: persona.id })) clean(run.assumption ?? '', 'run assumption');
    for (const p of t.repos.proposals.list({ personaId: persona.id })) {
      clean(p.text, 'proposal text');
      clean(p.rationale, 'proposal why');
      clean(p.finalText ?? '', 'proposal final text');
    }
    for (const d of t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { tool?: string }).tool === 'submit_persona_learning')) {
      clean(JSON.stringify(d.payload), 'learning decision');
    }

    // The brief and the prompts of every role.
    const brief = userBrief(t.store, 'ws_a', USER)!;
    expect(brief).toContain('Does not act on a claim backed by one source');
    clean(brief, 'brief');
    for (const role of ROLES) {
      const text = rolePromptText(t.config, role, calibrationScope(t.store, t.config, 'ws_a'));
      clean(text, `${role} prompt`);
      if (role === 'orchestrator' || role === 'synthesizer' || role === 'interviewer') expect(text).toContain(brief);
    }
  });
});
