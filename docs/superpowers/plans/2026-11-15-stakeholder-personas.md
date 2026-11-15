# Stakeholder Personas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stakeholder personas for the user's own nodes and for investigated companies, a leak-free question round for the user, statements the retro learns from, and simulated stakeholder reads of recommendations.

**Architecture:** Stakeholders are rows of `personas` with `kind: 'stakeholder'`. Research saves them through `save_stakeholder` in a new `stakeholders` phase (own: no browser). Own stakeholders stay `hidden` until a template-only question round is answered or skipped. Everything the user says about a stakeholder is an append-only statement; the persona learning run of project 2 consumes statements in the retro. New code lives in `src/core/stakeholders/`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-stakeholder-personas-design.md` (read it first; section numbers below refer to it). It builds on `docs/superpowers/specs/2026-11-15-persona-learning-design.md`.

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- Every read and write is checked against the business tree (`rootOf`); another tree's id answers 404 / "not found".
- While a persona is `hidden`, no API response contains its profile, relation, evidence, agent.md path, adjustments, proposals, signals or reads: only `{ id, label, stakeholderType, disclosure, questions }`.
- Question text is a fixed template filled with the stakeholder's label and nothing else. No model writes or selects questions.
- An `own_stakeholders` task never has a browser, whatever the planner asked.
- Nothing changes a stakeholder persona outside the retro's learning run and the user's decision on its proposals; storing a statement, an answer or a decision record changes no persona.
- Statements are append-only, internal, and excluded from exports by default (the rule for upload-derived text).
- Everything that judged "all personas of a node" before this plan judges segment personas only (`kind: 'segment'`).
- The actor comes from config (`actorOf`), never from a request body. Free text from the user: redacted, capped (answers and notes 4,000 characters; reasons 2,000 via `cleanReason`).
- Id prefixes: `stq_` question, `sst_` statement, `srd_` read. Defaults: maxOwn 8, maxCompetitors 3, maxPerCompetitor 3, maxReadsPerPanel 40.
- All stakeholder output is labelled simulated. Tests never spawn a real CLI.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. A stakeholder saved again by research while hidden, or after it was opened: disclosure never changes on a later save (Task 2 test).
2. The user answers only some questions of a stakeholder and submits: that stakeholder opens, unanswered questions become `skipped`, empty answers create no statement (Task 3 test).
3. A label that itself contains template-looking text or markup (`{label}`, `<b>`): rendered literally in the question, no second substitution (Task 3 test).
4. A decision record for a recommendation the stakeholder never read: stored as a statement, no reaction signal (Task 6 test).
5. A hidden persona reached through the project-2 routes (`persona-learning`, `personas/:id/signals`, proposal accept) or the existing personas list: not returned / 404 (Task 7 test).

## File Structure

- `src/core/stakeholders/types.ts` — `StakeholderType`, `StakeholderQuestion`, `StakeholderStatement`, `StakeholderRead`, stance enums.
- `src/core/stakeholders/store.ts` — `stakeholderRepos(store)`.
- `src/core/stakeholders/settings.ts` — `stakeholdersSettings(config)`.
- `src/core/stakeholders/personas.ts` — `segmentPersonas`, `stakeholderPersonas`, `isHidden`, `hiddenView`, `save_stakeholder` handler, stakeholder agent.md.
- `src/core/stakeholders/questions.ts` — templates, `ensureQuestions`, `answerQuestions`, `revealStakeholder`.
- `src/core/stakeholders/statements.ts` — `addNote`, `recordDecision`, `note_stakeholder` handler, `openStatements`.
- `src/core/stakeholders/reads.ts` — reads in the panel, `submit_stakeholder_read`, `reactToRead`.
- `src/core/prompts/{own_stakeholders,competitor_stakeholders,stakeholder_read}.md`
- `src/api/stakeholderRoutes.ts`; `web/src/views/Stakeholders.tsx`, `web/src/views/stakeholders/*`, `web/src/logic/stakeholders.ts`.
- Tests: `test/core/stakeholders/*.test.ts`, `test/api/stakeholderRoutes.test.ts`, `test/web/stakeholders.test.tsx`.

---

### Task 1: Storage, types, settings, segment-only reads

**Files:** create `src/core/stakeholders/{types,store,settings}.ts` and `personas.ts` (the three read helpers only); modify `src/core/store/migrations.ts` (25, 26), `src/core/store/repos.ts` (persona fields), `src/core/types.ts` (`Persona`, `Phase`), `src/core/scoring/criteria.ts` (`STAKEHOLDER_FIELDS`), `src/core/config/schema.ts` (`stakeholders` block; task types `own_stakeholders`, `competitor_stakeholders`), `src/core/research/phases.ts` (phase `stakeholders` after `deep_dives`), `src/core/feedback/events.ts`, `src/core/market/panel.ts`, `src/core/flows/round.ts`, the personas list route in `src/api/routes.ts`; tests `test/core/stakeholders/schema.test.ts`, shape-pinning tests.

**Interfaces — Produces:**

```ts
// types.ts (core/types.ts Persona gains:)
kind?: 'segment' | 'stakeholder' | 'user';           // DB default 'segment'
stakeholderType?: StakeholderType; subjectKind?: 'own' | 'competitor'; subjectId?: string; relation?: string;
disclosure?: 'hidden' | 'open';                       // DB default 'open'
// stakeholders/types.ts
export const STAKEHOLDER_TYPES = ['leader','manager','investor','board','owner','team','system','regulator','partner','other'] as const;
export type StakeholderType = (typeof STAKEHOLDER_TYPES)[number];
export const OWN_STANCES = ['approve','approve_with_conditions','reject','not_my_call'] as const;
export const RIVAL_STANCES = ['ignore','watch','copy','counter'] as const;
export const REAL_DECISIONS = ['approved','approved_with_conditions','rejected','deferred'] as const;
export interface StakeholderQuestion { id: string; rootWorkspaceId: string; workspaceId: string; personaId?: string; field: string; text: string;
  status: 'open' | 'answered' | 'skipped'; statementId?: string; createdAt: string; answeredAt?: string }
export interface StakeholderStatement { id: string; rootWorkspaceId: string; workspaceId: string; personaId?: string;
  source: 'question_answer' | 'note' | 'decision_record' | 'interview'; field?: string; text: string; questionId?: string; recommendationId?: string;
  decision?: (typeof REAL_DECISIONS)[number]; actor: string; createdAt: string; consumedByRunId?: string }
export interface StakeholderRead { id: string; rootWorkspaceId: string; workspaceId: string; recommendationId: string; personaId: string; personaVersion: number;
  stance: string; conditions: string[]; concerns: string[]; reasoning: string; wouldChangeMind: string; agentRunId: string; simulated: true; createdAt: string }
// store.ts
export function stakeholderRepos(store: Pick<Store,'db'>): { questions: Repo<StakeholderQuestion,'id'>; statements: Repo<StakeholderStatement,'id'>; reads: Repo<StakeholderRead,'id'> };
// settings.ts
export function stakeholdersSettings(config: Pick<BifConfig,'stakeholders'>): { enabled: boolean; maxOwn: number; maxCompetitors: number; maxPerCompetitor: number; maxReadsPerPanel: number };
// personas.ts
export function segmentPersonas(store: Store, workspaceId: string): Persona[];      // kind segment (or unset)
export function stakeholderPersonas(store: Store, workspaceId: string): Persona[];  // kind stakeholder
export function isHidden(p: Pick<Persona,'kind'|'disclosure'>): boolean;
```

`STAKEHOLDER_FIELDS` (criteria.ts), in this order: `role_mandate`, `goals_incentives`, `decision_criteria`, `constraints`, `risk_tolerance`, `dependencies`, `known_positions`, `objections`, `information_needs`, `communication_style`, `influence`.

Feedback kinds: `stakeholder_answers`, `stakeholder_reveal`, `stakeholder_note`, `stakeholder_decision_record`, `stakeholder_read_reaction`; target types `stakeholder`, `stakeholder_read`.

Migration 25: the six `personas` columns (spec §5) and the three tables (spec §12; `stakeholder_statements` refuses UPDATE of `text` and DELETE by trigger, like `feedback_events`, except setting `consumed_by_run_id`). Migration 26: every stored schedule / pipeline phase list that has `deep_dives` gains `stakeholders` right after it, once (copy the approach of migration 23).

- [ ] Write `schema.test.ts`: existing persona rows read back `kind: 'segment'`, `disclosure: 'open'`; repos round-trip every field; deleting a statement or updating its text throws, setting `consumedByRunId` works; settings defaults; config rejects `maxOwn: 0` and unknown keys; `PHASES` has `stakeholders` directly after `deep_dives`; migration 26 adds the phase once to a seeded schedule and leaves a schedule without `deep_dives` alone; `segmentPersonas` excludes a stakeholder row and `stakeholderPersonas` returns only it.
- [ ] Add tests that the persona panel (`runPersonaPanel`), the flow verdict round and the personas list route ignore a `stakeholder` persona.
- [ ] Run; expect failures. Implement. Update shape-pinning tests the change breaks.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(stakeholders): storage, types, phase and segment-only persona reads`.

### Task 2: Research — `save_stakeholder`, prompts, agent.md

**Files:** modify `src/core/stakeholders/personas.ts`, `src/core/market/agentMd.ts`, `src/core/market/personas.ts` (`writeAgentMd` dispatches on kind), `src/core/harness/tools/registry.ts` (tool, worker allow-list, description), `src/core/research/{phases,orchestrator,systemPrompts}.ts`, the prompts of the company audit and public filings task types (one line each), wherever extra tool handlers are assembled; create `src/core/prompts/{own_stakeholders,competitor_stakeholders}.md`; tests `test/core/stakeholders/{save,agentMd,noBrowser}.test.ts`.

**Interfaces — Produces:**

```ts
export const saveStakeholderHandler: (opts: MarketToolOptions) => ExtraToolHandler;
export function stakeholderToolHandlers(opts: MarketToolOptions): Partial<Record<ToolName, ExtraToolHandler>>;
export function stakeholderSlug(label: string, competitorSlug?: string): string; // 'stk-<slug>' | 'stk-<competitor>-<slug>'
export function compileStakeholderMd(persona: Persona, opts: { scopeName?: string; competitorName?: string; adjustments?: AgentMdOptions['adjustments'] }): string;
```

Tool input: `label` (1–120), `stakeholder_type`, `subject` (`'own'` or a competitor id), `relation` (1–300), `profile` (every `STAKEHOLDER_FIELDS` entry `{ value, confidence 0–1, evidence ≥ 1 }`). Rules: spec §6. Refuse: a competitor id not in the tree; evidence not in the tree; more than `maxOwn` own stakeholders or `maxPerCompetitor` for that competitor (updates of an existing slug always pass); `subject: 'own'` from a `competitor_stakeholders` task and the reverse. The Decision payload holds `tool`, `personaId`, `label`, `stakeholderType`, `subjectKind`, `version`, `confidence` per field — no values, no relation. First save of an own stakeholder: `disclosure: 'hidden'`; competitor: `'open'`; an update keeps the stored disclosure. `linkPersona` is called as for segment personas.

No browser: where the orchestrator turns a planned task into a stored task, `needsBrowser` is false when the type is `own_stakeholders`; add the same guard where the review loop starts the worker. `competitor_stakeholders` is planned only when the tree has competitors; the phase's task types and goal text go in `phases.ts`. Unassigned statements (`personaId` unset, not consumed) are listed in the `own_stakeholders` task prompt as fenced untrusted lines (function `unassignedStatementLines(store, workspaceId)` in `personas.ts`; Task 3 writes the statements, so read through `stakeholderRepos` here).

agent.md: opening paragraph and instructions per spec §6; one section per stakeholder field; the corrections section (heading and bullet format of project 2) when adjustments exist; frontmatter `kind: stakeholder`, `simulated: true`. `writeAgentMd` calls `compileStakeholderMd` for `kind: 'stakeholder'`.

- [ ] Write the tests: first own save is hidden, version 1, agent.md on disk has the label, the relation and all eleven section headings; a second save keeps `hidden`, and keeps `open` after it was opened; a competitor save is open and its agent.md says "a rival of"; each refusal; the Decision payload has no profile values; the cap counts stakeholders, not saves; an `own_stakeholders` task planned with `needs_browser: true` is stored and started with `needsBrowser: false`; the worker tool list for the two task types includes `save_stakeholder`; a segment persona's agent.md is unchanged by this task (snapshot of an existing fixture).
- [ ] Run; expect failures. Implement, including the two prompt files (what to read, what a stakeholder is at each layer of the tree, never search for a person not named in public evidence, save with `save_stakeholder`, finish with `submit_result`).
- [ ] `npm test`, `npm run typecheck`; commit `feat(stakeholders): save_stakeholder, research tasks without a browser for the own node, agent.md`.

### Task 3: Question round and statements

**Files:** create `src/core/stakeholders/{questions,statements}.ts`; modify `src/core/research/orchestrator.ts` (call `ensureQuestions` when the `stakeholders` phase ends), `src/core/harness/tools/registry.ts` (`note_stakeholder`, interviewer allow-list), `src/core/interview/interview.ts` (handler registration); tests `test/core/stakeholders/{questions,statements}.test.ts`.

**Interfaces — Produces:**

```ts
// questions.ts
export const PEOPLE_TEMPLATES: ReadonlyArray<{ field: string; text: string }>;   // spec §8, 4 entries, `{label}` placeholder
export const SYSTEM_TEMPLATES: ReadonlyArray<{ field: string; text: string }>;   // spec §8, 4 entries
export const NODE_QUESTIONS: ReadonlyArray<{ field: 'missing' | 'not_relevant'; text: string }>;
export function questionText(template: string, label: string): string;          // one literal replacement of `{label}`
export function ensureQuestions(store: Store, workspaceId: string): StakeholderQuestion[]; // creates for hidden, usable own stakeholders without questions; node questions once per batch
export function openQuestions(store: Store, workspaceId: string): Array<{ persona?: { id: string; label: string; stakeholderType: StakeholderType }; questions: StakeholderQuestion[] }>;
export function answerQuestions(store: Store, actor: string, workspaceId: string, input: { answers: Array<{ questionId: string; text: string }>; skip?: string[]; skipAll?: boolean }): { opened: string[]; statements: StakeholderStatement[] };
export function revealStakeholder(store: Store, actor: string, workspaceId: string, personaId: string): Persona;
// statements.ts
export class StakeholderError extends Error { constructor(message: string, readonly status: 400 | 404 | 409) }
export function addNote(store: Store, actor: string, workspaceId: string, input: { personaId?: string; text: string; field?: string }): StakeholderStatement;
export function recordDecision(store: Store, actor: string, workspaceId: string, input: { recommendationId: string; personaId: string; decision: (typeof REAL_DECISIONS)[number]; reasoning: string }): StakeholderStatement;
export function openStatements(store: Store, personaId: string): StakeholderStatement[]; // not consumed, oldest first
export const noteStakeholderHandler: ExtraToolHandler; // input { persona_id?, quote, field? }
```

Rules: spec §7–§9. Template wording exactly as in spec §8. `answerQuestions`: a stakeholder is "touched" when any of its questions is answered, or it is in `skip`, or `skipAll`; every touched stakeholder becomes `open` and its still-open questions become `skipped`; a non-empty (trimmed) answer creates a `question_answer` statement with the question's `field` and marks the question `answered`; an answer to a node question creates a statement without persona. One `stakeholder_answers` feedback event per call (`afterJson`: question ids answered, persona ids opened; no answer text). `revealStakeholder`: opens, skips its open questions, records `stakeholder_reveal`. `addNote` on a hidden persona is allowed (the user may tell the tool things before answering) and reveals nothing. `recordDecision` requires an own stakeholder of the recommendation's node and a non-empty reasoning. `note_stakeholder`: `quote` (whitespace-normalised) must occur in a user message of the node's interview transcript, else refused; stored with source `interview`. Text is redacted with the identity redaction and capped at 4,000 characters.

- [ ] Write `questions.test.ts`: for every template and a label, the question text equals the template with the label substituted and nothing else (loop over both template lists); a label `{label} <b>x</b>` appears literally once; a `team` gets the system templates; `ensureQuestions` twice creates nothing new; a not-yet-usable hidden stakeholder gets none; the Review Focus 2 case; `skipAll`; reveal; opening is one-way (a later `save_stakeholder` keeps `open`); answers from another tree's question → 404; no persona row other than `disclosure` changes (version, profile, agent.md untouched).
- [ ] Write `statements.test.ts`: note, decision record (validations), `note_stakeholder` accepts a real quote and refuses an invented one, statements are returned oldest first and exclude consumed ones, storing any statement leaves persona version and adjustments unchanged, text is capped and redacted.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(stakeholders): template question round, statements, interviewer note tool`.

### Task 4: Stakeholder reads

**Files:** create `src/core/stakeholders/reads.ts`, `src/core/prompts/stakeholder_read.md`; modify `src/core/market/panel.ts` (run reads after segment feedback), `src/core/harness/tools/registry.ts` (`submit_stakeholder_read`, persona allow-list); tests `test/core/stakeholders/reads.test.ts`.

**Interfaces — Produces:**

```ts
export type ReadsReport = { reads: number; missing: Array<{ recommendationId: string; personaId: string; reason: string }>; skippedByCap: number };
export async function runStakeholderReads(workspaceId: string, deps: ResearchDeps): Promise<ReadsReport>;
export const submitStakeholderReadHandler: ExtraToolHandler;
export function readsOf(store: Store, workspaceId: string, recommendationId: string): StakeholderRead[]; // open personas only
export function reactToRead(store: Store, actor: string, workspaceId: string, readId: string, reaction: 'agree' | 'disagree', reason?: string): FeedbackEvent;
```

Rules: spec §10. Personas: usable (`isOutputUsable`), `kind: 'stakeholder'`, not hidden; own first, then competitors, each ordered by slug; recommendations: usable ones of the node. The cap counts runs; pairs beyond it are counted in `skippedByCap` and recorded in one harness Decision. Stance must belong to the persona's set (`OWN_STANCES` for own, `RIVAL_STANCES` for competitor), else refused. Arrays ≤ 5 items of ≤ 300 characters; `reasoning` and `would_change_mind` ≤ 1,000. One retry for a run that ends without the tool, as the panel does. A new read replaces the persona's earlier read of that recommendation. `reactToRead` records `stakeholder_read_reaction` with `afterJson { reaction, personaId, personaVersion, recommendationId, stance }`. Disabled (`stakeholders.enabled: false`) → nothing runs.

- [ ] Write the tests with a fake agent: one read per (open stakeholder, recommendation); hidden and unusable stakeholders give none; stance outside the set refused; replacement on a second panel; the cap; retry then `missing`; the read stores the persona version; `readsOf` never returns a read of a persona that is hidden; `reactToRead` 404 across trees; the recommendation's `priority` and `personaFeedback` are unchanged by reads.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(stakeholders): simulated stakeholder reads in the panel`.

### Task 5: Learning from statements and reads

**Files:** modify `src/core/personas/{types,signals,learn}.ts`, `src/core/harness/tools/registry.ts` (`submit_persona_learning.field` accepts stakeholder fields), `src/core/prompts/persona_learning.md`, `src/core/scoring/export.ts`; tests `test/core/stakeholders/learning.test.ts`, extend `test/core/personas/signals.test.ts`.

**Interfaces — Consumes:** project 2's `collectPersonaSignals`, `runPersonaLearning`, `learningPrompt`, handler; Task 3 `openStatements`; Task 4 reads. **Produces:** `SignalSource` gains `'read_reaction' | 'decision_record'`; `PersonaLearningRun` gains `shownStatementIds: string[]` (column `shown_statement_ids`, migration 27).

Rules: spec §11. Signals: `read_reaction` (latest reaction per read; item `rec:<id>`; topic `read`); `decision_record` (per recorded decision that has a read by that persona of that recommendation, compared by the table in spec §11; the latest record per persona and recommendation). Eligibility for `kind: 'stakeholder'`: gate qualifies **or** at least one open statement; hidden personas are skipped. Ordering among qualifying personas: those with statements first, then by disagreements. The prompt lists open statements under their own heading, fenced, `<id> (<source>[, <decision>]) — <text>`, sharing the signals' half of the budget (statements first). Handler: evidence ids may be statement ids that were shown; an `add`/`replace` citing at least one statement passes the evidence rules; one citing none keeps project 2's rules. A run that ends `proposed` or `no_change` sets `consumedByRunId` on the statements it showed. A run that showed statements skips the upload-exposure refusal for its own prompt but its proposals, and the adjustments accepted from them, are `internal: true`. `field` may be any of `STAKEHOLDER_FIELDS` for a stakeholder persona and any of `PERSONA_FIELDS` for a segment persona; the other set is refused. Export: internal adjustments, their proposals, statements, questions and reads are excluded by default, under the same switch as upload-derived items.

- [ ] Write the tests: a stakeholder with one open statement and no reactions gets a run; a proposal citing that statement is stored `pending`, `internal`, and accepting it yields an internal adjustment in agent.md; statements are consumed after `proposed` and after `no_change`, not after `failed`; a hidden persona with statements is skipped and its statements stay open; a decision `rejected` against a read `approve` gives a `disagree` signal, `approved` against `approve_with_conditions` agrees, `deferred` and a missing read give none (Review Focus 4); a segment persona is unaffected by statements and still needs the gate; a segment field on a stakeholder proposal is refused; the export leaves out internal adjustments and statements by default and includes them with the switch.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(stakeholders): the retro learns from statements, read reactions and recorded decisions`.

### Task 6: API

**Files:** create `src/api/stakeholderRoutes.ts`; modify `src/api/routes.ts`, `src/api/personaLearningRoutes.ts` (hidden personas excluded / 404); tests `test/api/stakeholderRoutes.test.ts`.

**Interfaces — Produces:** the routes of spec §14. `GET …/stakeholders` returns `{ enabled, own: StakeholderView[], competitors: Array<{ competitorId, name, stakeholders: StakeholderView[] }> }` where a hidden view is `{ id, label, stakeholderType, disclosure: 'hidden', questions: number }` and an open view adds `relation`, `profile`, `version`, `status`, `statements` (count), `subjectKind`. Errors map `StakeholderError.status`.

- [ ] Write the tests: each route's happy path; the leak test — with one hidden stakeholder seeded with distinctive strings in every profile field, relation, an adjustment and a read, call every GET route of the API for that workspace (stakeholders, questions, personas list, persona-learning, signals, reads, recommendations) and assert none of the strings appears, then answer its questions and assert they do appear in `…/stakeholders`; Review Focus 5; actor from config; 404 across trees; the three feedback kinds of project 2's Task 5 note are not affected.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(stakeholders): routes, hidden personas never served`.

### Task 7: Pages

**Files:** create `web/src/views/Stakeholders.tsx`, `web/src/views/stakeholders/{Questions,Card,Reads}.tsx`, `web/src/logic/stakeholders.ts`; modify `web/src/logic/{api,types,hooks,router}.ts`, `web/src/views/App.tsx` (nav entry), `web/src/views/Strategy.tsx` (reads on a recommendation, reaction, "Record the real decision"); tests `test/web/stakeholders.test.tsx`.

Page per spec §15: the questions block (intro sentence as in the spec, per-stakeholder Skip and "Show what the tool found", Skip all, Send answers), open stakeholder cards (label, type, relation, fields with confidence and evidence, Add a note, the project-2 learning block), competitor stakeholders grouped by company. All persona output labelled simulated; user and agent text rendered as text.

- [ ] Write the web test: a hidden stakeholder renders only label, type and its questions; Send answers posts only non-empty answers; after the response the card shows the profile; Add a note posts; a recommendation shows a read with "simulated", agree/disagree with reason posts, Record the real decision posts `{ personaId, decision, reasoning }`.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(stakeholders): stakeholders page and reads on recommendations`.

### Task 8: End to end, isolation, docs, smoke

**Files:** `test/core/stakeholders/{endToEnd,isolation}.test.ts`, `scripts/smoke.ts` (mode `stakeholders`), `README.md`, `docs/smoke-results.md`, `src/core/scheduler/{diff,whatChanged}.ts` if run diffs list personas (stakeholders counted separately, hidden ones by count only).

- [ ] `endToEnd.test.ts`: fake research saves two own stakeholders (hidden) → phase end creates questions → answers → open → panel gives reads → the user records a real decision that contradicts a read → `runRetro` → a proposal citing the answer → accept → agent.md carries the correction and the persona version went up; nothing changed between the answer and the retro.
- [ ] `isolation.test.ts`: two trees; stakeholders, questions, statements, reads and learning of one never appear in the other's functions or routes.
- [ ] Smoke mode `stakeholders`: seeds a node with notes, runs `own_stakeholders` with a real CLI without a browser, checks a hidden stakeholder and its questions exist. Document how to run it; do not record a run you did not make.
- [ ] README section "Stakeholder personas": who counts, how they are built, the question round and why answers come first, statements, reads, what the retro does, settings.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(stakeholders): end-to-end and isolation tests, docs, smoke mode`.
