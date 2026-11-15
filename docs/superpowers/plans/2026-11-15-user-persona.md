# User Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One persona of the user per business tree, learned in the retro from their actions and typed reasons, decided line by line by the user, and given as a short brief to the orchestrator, synthesizer and interviewer.

**Architecture:** A `personas` row of `kind: 'user'` at the tree root whose content is its active adjustments (the mechanism of persona learning). Interactions are computed on read from the feedback log and ratings. A count gate decides whether the retro runs one learning agent, which proposes lines through the existing `submit_persona_learning` tool. New code lives in `src/core/userPersona/`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-user-persona-design.md` (read it first; section numbers below refer to it). It builds on `docs/superpowers/specs/2026-11-15-persona-learning-design.md`.

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- One user persona per business tree; every read and write is checked against the tree; another tree's id answers 404.
- Input is the tree's feedback log and ratings only: no interview text, no upload text. A learning run shown upload-derived text has its proposals refused.
- No identifier of the user (configured user id, name, email address) is stored in the persona, a line, a prompt or a request. Lines say "the person you work for".
- Nothing changes the persona outside a user decision on a proposal; nothing proposes outside `runRetro`.
- The brief goes to the orchestrator, synthesizer and interviewer only; never to workers, reviewers, personas, escalation or the retro.
- Defaults (spec §10): minInteractions 12, minDistinctTargets 6, minEvidence 3, maxProposals 3, maxAdjustments 12, maxPerField 3, windowDays 180, useInPrompts true.
- `USER_FIELDS`, in order: `priorities`, `quality_bar`, `evidence_standards`, `decision_style`, `risk_appetite`, `domain_knowledge`, `communication`, `recurring_corrections`.
- The user persona is never a segment or stakeholder persona: it takes part in no panel, round, question or read.
- The actor comes from config. Tests never spawn a real CLI.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. A tree where the user has only ever accepted things (no reasons, no rejections): the gate can qualify, the run may answer with no proposals, and nothing breaks (Task 2 test).
2. The user rejects a proposed line: the rejection is itself an interaction and is shown to the next run with its reason; the same line is not re-proposed word for word (Task 2 test for the prompt content).
3. The configured user id contains characters special in regular expressions, or equals a common word: the identifier check still redacts it and nothing else (Task 2 test).
4. A node below the root asks for the user persona: it gets the tree's persona; accept through a child node's route works (Task 3 test).
5. `useInPrompts: false`, or no active lines: the three roles' prompts are byte-identical to before this build (Task 2 test).

## File Structure

- `src/core/userPersona/settings.ts` — `userPersonaSettings(config)`.
- `src/core/userPersona/interactions.ts` — `Interaction`, `collectInteractions`, `openInteractions`, `interactionStats`, `interactionGate`.
- `src/core/userPersona/persona.ts` — `userPersonaOf`, `ensureUserPersona`, `userLines`, `userBrief`.
- `src/core/userPersona/learn.ts` — `runUserPersonaLearning`, prompt building.
- `src/core/prompts/user_persona_learning.md`
- `src/api/userPersonaRoutes.ts`; `web/src/views/You.tsx`, `web/src/logic/userPersona.ts`.
- Tests: `test/core/userPersona/*.test.ts`, `test/api/userPersonaRoutes.test.ts`, `test/web/you.test.tsx`.

---

### Task 1: Settings, interactions, gate, the persona row

**Files:** create `src/core/userPersona/{settings,interactions,persona}.ts`; modify `src/core/config/schema.ts` (`userPersona` block), `src/core/scoring/criteria.ts` (`USER_FIELDS`), `src/core/market/personas.ts` (`writeAgentMd` writes nothing for `kind: 'user'`); tests `test/core/userPersona/{interactions,persona}.test.ts`, shape-pinning tests.

**Interfaces — Produces:**

```ts
// settings.ts
export type UserPersonaSettings = { enabled: boolean; minInteractions: number; minDistinctTargets: number; minEvidence: number; maxProposals: number;
  maxAdjustments: number; maxPerField: number; windowDays: number; useInPrompts: boolean; model: ModelRef };
export function userPersonaSettings(config: Pick<BifConfig, 'userPersona' | 'personaLearning' | 'lessons' | 'roles'>): UserPersonaSettings; // model: personaLearningSettings(config).model
// interactions.ts
export type Stance = 'accept' | 'reject' | 'edit' | 'neutral';
export type Interaction = { id: string; kind: string; stance: Stance; target: string; topic: string; detail: string; reason?: string; refs: string[]; at: string };
export const STANCE_BY_KIND: Record<FeedbackKind, Stance | ((e: FeedbackEvent) => Stance)>;   // every feedback kind has an entry
export function collectInteractions(store: Store, rootWorkspaceId: string, window?: { since?: string; until?: string }): Interaction[]; // oldest first, whole tree
export function openInteractions(store: Store, settings: UserPersonaSettings, rootWorkspaceId: string, now: Date): Interaction[];  // non-neutral only
export type InteractionStats = { byKind: Record<string, Partial<Record<Stance, number>>>; total: number };
export function interactionStats(interactions: Interaction[]): InteractionStats;
export type InteractionGate = { n: number; targets: number; qualifies: boolean; missing: string[] };
export function interactionGate(open: Interaction[], settings: UserPersonaSettings): InteractionGate;
// persona.ts
export function userPersonaOf(store: Store, workspaceId: string): Persona | undefined;      // the tree's user persona, from any node
export function ensureUserPersona(store: Store, rootWorkspaceId: string): Persona;           // creates: kind 'user', slug 'user', segment 'The person you work for', profile {}, status 'verified', disclosure 'open'
export function userLines(store: Store, rootWorkspaceId: string): Array<{ field: string; lines: PersonaAdjustment[] }>; // active, in USER_FIELDS order
export function userBrief(store: Store, rootWorkspaceId: string): string | undefined;        // spec §9 block, or undefined when there are no lines
```

Rules: spec §5–§7, §9. Stance per kind follows spec §6; decide each feedback kind explicitly in `STANCE_BY_KIND` (a test asserts every member of `FEEDBACK_KINDS` has an entry, so a kind added later fails the test). Where one kind covers both outcomes (reactions with `afterJson.reaction`, include overrides with include true/false/null, decisions with an action field), use the function form. `target` is `<targetType>:<targetId>`; `topic` is the feedback kind, or `rating:<targetType>`. `detail` is built from kind, enums, numbers and ids only. Ratings: `agree` → `accept`, `disagree` → `edit`. Open: newer than the `signalsThrough` of the user persona's latest run that ended `proposed` or `no_change`, not older than `windowDays`, stance not `neutral`. Gate missing lines, in order: `"<n> of <minInteractions> actions"`, `"<targets> of <minDistinctTargets> different things"`. Brief text exactly:

```
## The person you work for

Learned from their decisions in this tool. Follow it where it does not conflict with the evidence.

- [<marker>.v<version>] (<field>) <text>
```

- [ ] Write `interactions.test.ts`: every feedback kind maps to a stance; one event of each of several kinds through the real action functions gives the expected stance, target and topic; events of a child node are included, another tree's are not; neutral ones are in `collectInteractions` and the statistics but not in `openInteractions`; the window and the consumption rule; gate: 12 on 6 targets qualifies, 11 does not with `['11 of 12 actions']`, 12 on 5 targets does not with `['5 of 6 different things']`.
- [ ] Write `persona.test.ts`: `ensureUserPersona` twice gives one row; `userPersonaOf` from a child node returns it; it is not returned by `segmentPersonas` or `stakeholderPersonas`; no agent.md file is written for it; `userBrief` is undefined without lines and matches the block above with two lines in field order; the persona panel, flow round and stakeholder reads ignore it.
- [ ] Run; expect failures. Implement. Update shape-pinning tests the config change breaks.
- [ ] `npm test`, `npm run typecheck`; commit `feat(user-persona): interactions, gate and the persona row`.

### Task 2: The learning run, the retro, the brief in prompts

**Files:** create `src/core/userPersona/learn.ts`, `src/core/prompts/user_persona_learning.md`; modify `src/core/personas/learn.ts` (the `submit_persona_learning` handler serves a `kind: 'user'` persona with the rules below; `runPersonaLearning` never picks it up), `src/core/harness/tools/registry.ts` (`field` accepts `USER_FIELDS`), `src/core/learning/lessons/retro.ts`, the place role system prompts are assembled (`src/core/prompts/index.ts` / `src/core/feedback/actions.ts` `rolePromptText` — wherever the lessons appendix is added), `src/core/scoring/export.ts` if needed; tests `test/core/userPersona/{learn,brief}.test.ts`, extend the retro test.

**Interfaces — Produces:**

```ts
export type UserLearningReport = { userInteractions: number; userLearningRuns: number; userProposals: number };
export async function runUserPersonaLearning(deps: ResearchDeps, rootWorkspaceId: string, opts?: { now?: Date; retroId?: string }): Promise<UserLearningReport>;
export function userLearningPrompt(store: Store, config: BifConfig, rootWorkspaceId: string, open: Interaction[]): { prompt: string; shown: string[]; through?: string };
export const USER_BRIEF_ROLES: ReadonlyArray<Role>; // ['orchestrator', 'synthesizer', 'interviewer']
```

Rules: spec §8, §9. Runs in `runRetro` after `runPersonaLearning`, in its own try/catch; its three counts go into the retro row's `digest`, including for a `skipped` retro. Not run when `userPersona.enabled` is false or lessons / the retro are disabled, or when the user persona has pending proposals. When the gate qualifies: `ensureUserPersona`, insert a `running` row in `persona_learning_runs` with `shownSignalIds` = the interaction ids shown, run the agent (role `retro`, no browser), and reuse `submit_persona_learning`. Budget, oldest-first, `signalsThrough` and "no shown interaction → no run" exactly as persona learning does (reuse its helpers; export them from `src/core/personas/learn.ts` if they are private). The prompt: the lines so far by field; rejected proposals (newest 5, with reason); the statistics; the open interactions grouped by topic, fenced; blocked ones (upload rule) as id and stance only.

Handler rules for a user persona: evidence ids must have been shown; at most `maxProposals`; `add` / `replace` need at least `minEvidence` interactions on at least 2 different targets (no disagreement rule); `field` is required for `add` and must be one of `USER_FIELDS`; active plus pending adds per field ≤ `maxPerField` and in all ≤ `maxAdjustments`; refused when the run was shown upload-derived text; proposal text is passed through the identity redaction and additionally refused when it contains the configured user id (compared as a literal, case-insensitive, whole token) or an email-like string. No engine step. Accept, reject and retire are the existing functions; accepting passes `maxAdjustments` from these settings, and writes no agent.md.

Brief in prompts: with `useInPrompts` and a non-empty `userBrief`, the block is appended after the lessons appendix for `USER_BRIEF_ROLES` only, for runs in that tree. Prompt versions follow from the text as today.

Prompt file: explains that the agent describes the person the tool works for from their actions; lines are third person ("Prefers …", "Does not act on …"), general, never quote a reason, never name or identify the person; agreements and acceptances show what already works; propose only what several actions on different things support; replace or retire a line that newer actions contradict; call `submit_persona_learning` exactly once, with no proposals when the actions do not point one way.

- [ ] Write `learn.test.ts` with a fake agent: below the gate → no run, no persona row created; at the gate → persona created, one run, proposals `pending`, interactions consumed up to the newest shown; pending proposals → skipped; each handler refusal (not shown id, 4 proposals, 2 evidence ids, one target, missing field, a segment field, fourth line in one field, thirteenth line, text containing the configured user id, text containing an email address, upload-exposed run); Review Focus 1, 2 and 3; reasons sit inside the untrusted fence; `runPersonaLearning` does not run for the user persona and `runUserPersonaLearning` does not touch segment personas; `enabled: false` → zeros.
- [ ] Write `brief.test.ts`: after accepting a line, the system prompts of orchestrator, synthesizer and interviewer for that tree end with the brief block; worker, reviewer, persona, escalation and retro prompts do not contain it; another tree's prompts do not contain it; Review Focus 5 (byte-identical prompts with `useInPrompts: false` and with no lines); retiring the line removes it from the prompts.
- [ ] Extend the retro test: the three counts are stored; a throw inside user persona learning leaves the retro result unchanged.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(user-persona): learning run in the retro and the brief in three roles' prompts`.

### Task 3: API and the You page

**Files:** create `src/api/userPersonaRoutes.ts`, `web/src/views/You.tsx`, `web/src/logic/userPersona.ts`; modify `src/api/routes.ts`, `src/api/personaLearningRoutes.ts` (accept / reject / retire accept the tree's user persona from any node of the tree; its proposals are counted in the Lessons pending count), `web/src/logic/{api,types,hooks,router}.ts`, `web/src/views/App.tsx`; tests `test/api/userPersonaRoutes.test.ts`, `test/web/you.test.tsx`.

**Interfaces — Produces:** `GET /api/workspaces/:id/user-persona` →

```ts
{ enabled: boolean; usedBy: string[]; useInPrompts: boolean; gate: InteractionGate; stats: InteractionStats;
  persona?: { id: string; version: number };
  fields: Array<{ field: string; lines: Array<PersonaAdjustment & { evidence: number }> }>;
  proposals: PersonaProposal[];        // pending first, then decided, newest first, 20 at most
  lastRun?: Pick<PersonaLearningRun, 'id' | 'status' | 'assumption' | 'createdAt'> }
```

`GET /api/workspaces/:id/user-persona/interactions?limit=&before=` → `{ interactions: Interaction[]; next?: string }` newest first, 50 per page by default, 200 at most.

Page per spec §12: the lines by field with Retire and a "show" toggle listing the interactions a line rests on (`detail`, stance, reason, date); pending proposals with the run's assumption, Accept / Edit / Reject and a reason box (reuse the proposal components of the persona learning page); the statistics line; the "Next retro: n of 12 actions" line or "Enough for the next retro". A nav entry "You". Text rendered as text.

- [ ] Write the route tests: shapes before any persona exists (no `persona`, empty fields, gate numbers) and after an accepted line; paging of interactions; Review Focus 4; 404 across trees; actor from config; the Lessons count includes a pending user-persona proposal.
- [ ] Write the web test: fields, lines and statistics render from a fixture; Accept with edited text and reason posts to the persona learning accept route; Retire posts; the "show" toggle loads interactions.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(user-persona): routes and the You page`.

### Task 4: End to end, isolation, docs, smoke

**Files:** `test/core/userPersona/{endToEnd,isolation,identifiers}.test.ts`, `scripts/smoke.ts` (mode `user-persona`), `README.md`, `docs/smoke-results.md`.

- [ ] `endToEnd.test.ts`: twelve actions on six targets through the real action functions → nothing exists or changes before the retro → `runRetro` → a pending proposal → accept → the orchestrator's system prompt for the tree carries the line, a reviewer's does not → the user rejects a second proposal with a reason → the next retro's prompt shows that rejection.
- [ ] `isolation.test.ts`: two trees; interactions, persona, lines, brief, runs and routes of one never return the other's.
- [ ] `identifiers.test.ts`: with a configured user id and reasons that contain an email address, neither appears in any stored line, in `userBrief`, or in the prompts of the three roles; the learning prompt shows reasons only after the existing redaction.
- [ ] Smoke mode `user-persona`: seeds actions, runs the retro with a real CLI, checks one `submit_persona_learning` call for the user persona. Document how to run it; record only runs really made.
- [ ] README section "A persona of you": what it learns from, the gate in plain words, that every line waits for the user, where the brief goes and how to switch it off, the settings.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(user-persona): end-to-end, isolation and identifier tests, docs, smoke mode`.
