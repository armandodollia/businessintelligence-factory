# Persona Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the retro only, turn the user's reactions to persona output into proposed persona adjustments that the user accepts or rejects.

**Architecture:** Signals are computed on read from the feedback and rating logs. A deterministic gate (Wilson lower bound) picks personas; one `retro`-role agent run per qualifying persona proposes adjustments through `submit_persona_learning`; the user's decision writes the adjustment, bumps the persona version and recompiles agent.md. New code lives in `src/core/personas/`; persona research code stays in `src/core/market/`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-persona-learning-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- Every read and write is checked against the business tree (`rootOf`); another tree's id answers 404 / "not found".
- A learning run is never shown upload-derived text; text shown to an agent is fenced as untrusted data, as `flows/round.ts` and `lessons/retro.ts` do.
- Nothing outside a user decision on a proposal writes `persona_adjustments`; nothing outside `runRetro` calls `runPersonaLearning`.
- The actor comes from config (`actorOf`), never from a request body.
- Reasons: redacted and capped at 2,000 characters; reuse `cleanReason` from `src/core/flows/feedback.ts`.
- Defaults (spec §12): minSignals 6, minDistinctItems 4, disagreeFloor 0.3, windowDays 180, maxPersonasPerRetro 5, maxProposalsPerPersona 3, minEvidence 3, maxAdjustments 8, minEffectSignals 6.
- Id prefixes: `pad_` adjustment, `ppr_` proposal, `plr_` learning run. Marker: `A-` + 6 upper-case hex, unique.
- Tests never spawn a real CLI; use the fakes in `test/core/helpers`.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. A persona with pending proposals and new signals: skipped by the next retro, signals not consumed (Task 4 test).
2. The user reacts twice to the same verdict (disagree, then agree): one signal, the latest (Task 2 test).
3. A persona re-saved by research after an adjustment was accepted: adjustments stay in agent.md (Task 3 test).
4. A signal resting on an upload-derived flow: shown to the run as id and polarity only, and still counted by the gate (Task 4 test).
5. Accepting a proposal twice, or accepting after the adjustment was retired: 409, no second version bump (Task 3 test).

## File Structure

- `src/core/personas/types.ts` — `PersonaSignal`, `PersonaAdjustment`, `PersonaProposal`, `PersonaLearningRun`, `GateResult`.
- `src/core/personas/store.ts` — `personaLearningRepos(store)`.
- `src/core/personas/settings.ts` — `personaLearningSettings(config)`.
- `src/core/personas/signals.ts` — collecting signals.
- `src/core/personas/gate.ts` — Wilson bound and the gate.
- `src/core/personas/adjustments.ts` — decisions, effect, markers.
- `src/core/personas/learn.ts` — the learning run, its tool handler, the engine step.
- `src/core/prompts/persona_learning.md`
- `src/api/personaLearningRoutes.ts`
- `web/src/views/personas/Learning.tsx`, `web/src/logic/personaLearning.ts`
- Tests: `test/core/personas/*.test.ts`, `test/api/personaLearningRoutes.test.ts`, `test/web/personaLearning.test.tsx`.

---

### Task 1: Storage, types, settings

**Files:** create `src/core/personas/{types,store,settings}.ts`; modify `src/core/store/migrations.ts` (migration 24), `src/core/store/repos.ts` (`newId` prefixes if it keeps a list), `src/core/config/schema.ts` (`personaLearning` block, model check in `superRefine`), `src/core/feedback/events.ts` (kinds `persona_learning_accept`, `persona_learning_reject`, `persona_adjustment_retire`; target types `persona_proposal`, `persona_adjustment`); tests `test/core/personas/schema.test.ts`, and the shape-pinning tests that list migrations / config keys (`test/core/migrationOrder.test.ts` and any other that fails).

**Interfaces — Produces:**

```ts
// types.ts
export type SignalSource = 'verdict_reaction' | 'override' | 'feedback_rating' | 'profile_rating' | 'include';
export type PersonaSignal = { id: string; source: SignalSource; personaId: string; personaVersion?: number; polarity: 'agree' | 'disagree';
  itemKey: string; topic: string; detail: string; reason?: string; refs: string[]; at: string };
export type GateStats = { n: number; agree: number; disagree: number; items: number; lower: number };
export type GateResult = GateStats & { qualifies: boolean; missing: string[] };
export type AdjustmentStatus = 'active' | 'retired';
export interface PersonaAdjustment { id: string; rootWorkspaceId: string; workspaceId: string; personaId: string; field?: string; marker: string;
  text: string; version: number; status: AdjustmentStatus; source: 'retro' | 'engine' | 'user'; proposalId?: string; actor: string;
  stats: Partial<GateStats>; internal: boolean; createdAt: string; changedAt: string; endedAt?: string }
export type ProposalAction = 'add' | 'replace' | 'retire';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';
export interface PersonaProposal { id: string; rootWorkspaceId: string; workspaceId: string; personaId: string; runId?: string; action: ProposalAction;
  adjustmentId?: string; field?: string; text: string; rationale: string; evidence: string[]; stats: Partial<GateStats>; source: 'retro' | 'engine';
  status: ProposalStatus; finalText?: string; createdAt: string; decidedAt?: string; actor?: string; reason?: string; decisionId?: string; feedbackEventId?: string }
export type LearningRunStatus = 'running' | 'proposed' | 'no_change' | 'failed';
export interface PersonaLearningRun { id: string; rootWorkspaceId: string; personaId: string; retroId?: string; status: LearningRunStatus;
  signalsThrough: string; shownSignalIds: string[]; stats: GateStats; assumption?: string; agentRunId?: string; failureReason?: string; createdAt: string; endedAt?: string }
// store.ts
export function personaLearningRepos(store: Pick<Store, 'db'>): { adjustments: Repo<PersonaAdjustment,'id'>; proposals: Repo<PersonaProposal,'id'>; runs: Repo<PersonaLearningRun,'id'> };
// settings.ts
export type PersonaLearningSettings = { enabled: boolean; minSignals: number; minDistinctItems: number; disagreeFloor: number; windowDays: number;
  maxPersonasPerRetro: number; maxProposalsPerPersona: number; minEvidence: number; maxAdjustments: number; minEffectSignals: number; model: ModelRef };
export function personaLearningSettings(config: Pick<BifConfig, 'personaLearning' | 'lessons' | 'roles'>): PersonaLearningSettings; // model default: lessonsSettings(config).retro.model
```

Note `running` and `shownSignalIds` are additions to spec §11 the handler in Task 4 needs (`shown_signal_ids_json` column).

- [ ] Write `schema.test.ts`: migration 24 creates the three tables; `marker` is unique; each repo round-trips a row with every field; `personaLearningSettings({})` returns the defaults above; config rejects `disagreeFloor: 1.5` and an unknown key; a model of a disabled provider is rejected.
- [ ] Run it; expect failures for missing modules.
- [ ] Implement migration 24 (tables per spec §11 plus `shown_signal_ids_json`; index each on `(root_workspace_id, persona_id)`), repos following `src/core/learning/lessons/store.ts`, the zod block following `lessonsConfigSchema` (strict; ranges: counts int ≥ 1, `disagreeFloor` 0–1, `maxProposalsPerPersona` 0–5, `maxAdjustments` 1–20), settings, feedback kinds.
- [ ] Update shape-pinning tests the change breaks (they pin intended shape; change only the pinned lists).
- [ ] `npm test`, `npm run typecheck`; commit `feat(personas): storage, types and settings for persona learning`.

### Task 2: Signals and the gate

**Files:** create `src/core/personas/signals.ts`, `src/core/personas/gate.ts`; tests `test/core/personas/{signals,gate}.test.ts`.

**Interfaces — Consumes:** Task 1 types, `listFeedback`, `store.ratings`, `isRatingStale` + `judgmentIndex` (`src/core/feedback/provenance.ts`), `flowRepos` (`src/core/flows/repos.ts`). **Produces:**

```ts
export function collectPersonaSignals(store: Store, personaId: string, window?: { since?: string; until?: string }): PersonaSignal[]; // oldest first
export function openSignals(store: Store, settings: PersonaLearningSettings, personaId: string, now: Date): PersonaSignal[];
export function wilsonLower(k: number, n: number, z?: number): number; // z default 1.96; n = 0 → 0
export function personaGate(signals: PersonaSignal[], settings: PersonaLearningSettings): GateResult;
```

Rules: spec §5 table and rules, §6. Sources read the persona's own workspace. `override` signals come from `flow_override` events with `afterJson.action === 'create'` and their `afterJson.verdicts[]` (`{ id, personaId, personaVersion, winnerFlowId }`, `winnerFlowId: null` = tie). Pair key: the two flows' `lineageId`s sorted and joined with `|` (fall back to the flow ids when a flow row is gone). `detail` examples: `"picked <winner flow title> over <loser flow title> (strength 2); you disagreed"`, `"rated appeal 4 for <rec id>; you set 2"` — built from titles, ids and enums only. `refs`: verdict id, both flow ids, or the recommendation id. `missing` lines, in this order and wording: `"<n> of <minSignals> reactions"`, `"<items> of <minDistinctItems> different things"`, `"disagreement not clearly above <floor as %>"`.

- [ ] Write `gate.test.ts`: `wilsonLower(5,6)` ≈ 0.436 (±0.005); `wilsonLower(0,0) === 0`; with defaults and 6 distinct items, 5 of 6 qualifies, 4 of 6 not, 5 of 8 qualifies, 10 of 20 not, 11 of 20 qualifies; 6 disagreements on 3 items does not qualify and `missing` is `['3 of 4 different things']`; an empty list gives all three missing lines.
- [ ] Write `signals.test.ts` (seed a workspace, persona, flows, verdicts, recommendation with persona feedback): one signal per source with the table's polarity, itemKey and topic; disagree then agree on one verdict → one `agree` signal; a ruling on a pair whose verdict also has a reaction → no `override` signal for that verdict; a ruling against a tie verdict → `disagree`; a stale rating is dropped; `include_override` cleared (null) → no signal; signals of another persona are not returned; `openSignals` drops signals at or before the latest `proposed`/`no_change` run's `signalsThrough`, keeps them after a `failed` run, and drops ones older than `windowDays`.
- [ ] Run; expect failures. Implement both modules.
- [ ] `npm test`, `npm run typecheck`; commit `feat(personas): reaction signals and the learning gate`.

### Task 3: Adjustments, decisions, agent.md

**Files:** create `src/core/personas/adjustments.ts`; modify `src/core/market/agentMd.ts`, `src/core/market/personas.ts` (`writeAgentMd` passes active adjustments); tests `test/core/personas/adjustments.test.ts`, extend `test/core/personas.test.ts` for the compiled section.

**Interfaces — Produces:**

```ts
// agentMd.ts
export type AgentMdOptions = { scopeName?: string; adjustments?: Array<Pick<PersonaAdjustment, 'marker' | 'version' | 'field' | 'text'>> };
// adjustments.ts
export class PersonaLearningError extends Error { constructor(message: string, readonly status: 400 | 404 | 409) }
export function activeAdjustments(store: Store, personaId: string): PersonaAdjustment[]; // oldest first
export function newMarker(store: Store): string;
export function acceptPersonaProposal(store: Store, actor: string, workspaceId: string, proposalId: string, opts?: { text?: string; reason?: string }): { proposal: PersonaProposal; adjustment: PersonaAdjustment; persona: Persona };
export function rejectPersonaProposal(store: Store, actor: string, workspaceId: string, proposalId: string, opts?: { reason?: string }): PersonaProposal;
export function retireAdjustment(store: Store, actor: string, workspaceId: string, adjustmentId: string, opts?: { reason?: string }): { adjustment: PersonaAdjustment; persona: Persona };
export type AdjustmentEffect = { before: Partial<GateStats>; since: GateStats };
export function adjustmentEffect(store: Store, adjustment: PersonaAdjustment): AdjustmentEffect; // `since`: gate numbers of signals after changedAt
```

Rules: spec §9, §10. Section heading and lead line exactly as in spec §10; one bullet per active adjustment `- [<marker>.v<version>] (<field>) <text>` (no `(<field>)` when unset); no section when there are none. Accept and retire run in one transaction: adjustment row, proposal row, persona `version + 1`, `writeAgentMd`, one feedback event, one Decision (`kind: 'decision'`, payload `{ tool: 'persona_learning', action, personaId, proposalId?, adjustmentId, personaVersion }`; follow `acceptLessonProposalAsUser` in `src/core/feedback/actions.ts` for the Decision's actor fields). `text` on accept: redacted with `servedLine`, max 400 characters, stored as `finalText` when it differs. Accepting an `add` when active adjustments already number `maxAdjustments` → 409. Proposal not `pending` → 409. `replace`/`retire` whose adjustment is not active → 409 and the proposal becomes `superseded`. `workspaceId` must be in the persona's tree, else 404.

- [ ] Write the tests: compiled agent.md has the section between the last profile section and `## Instructions`, and none without adjustments; accept `add` → active adjustment with a marker matching `/^A-[0-9A-F]{6}$/`, persona version +1, agent.md on disk contains the marker, one `persona_learning_accept` event carrying the reason, one Decision; accept with edited text stores `finalText` and uses it; accept `replace` bumps the adjustment version and the marker text reads `.v2`; accept `retire` and `retireAdjustment` end it and remove it from agent.md; reject changes nothing but the proposal and writes `persona_learning_reject`; second accept → 409 and the persona version is unchanged; accept of a proposal from another tree → 404; `save_persona` on the same slug afterwards keeps the adjustment in the new agent.md; a previously live flow verdict of the persona is no longer returned by `liveVerdicts` after an accept.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(personas): adjustments, user decisions and the corrections section of agent.md`.

### Task 4: The learning run and the retro

**Files:** create `src/core/personas/learn.ts`, `src/core/prompts/persona_learning.md`; modify `src/core/harness/tools/registry.ts` (tool `submit_persona_learning`, allowed for role `retro`, description), `src/core/prompts/index.ts` if prompt names are listed, `src/core/learning/lessons/retro.ts` (`runRetro` calls it; digest counts), wherever extra tool handlers are assembled in `src/api/main.ts`; tests `test/core/personas/learn.test.ts`, extend the retro test in `test/core/lessons/`.

**Interfaces — Produces:**

```ts
export type PersonaLearningReport = { personasEvaluated: number; personasQualified: number; personaLearningRuns: number; personaProposals: number };
export async function runPersonaLearning(deps: ResearchDeps, rootWorkspaceId: string, opts?: { now?: Date; retroId?: string }): Promise<PersonaLearningReport>;
export function learningPrompt(store: Store, config: BifConfig, persona: Persona, signals: PersonaSignal[]): { prompt: string; shown: string[] };
export const submitPersonaLearningHandler: ExtraToolHandler;
export function personaLearningToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>>;
```

Tool schema: spec §7 step 5 (`persona_id`, `assumption` ≤ 600, `proposals[]` with `action`, `adjustment_id?`, `field?` one of `PERSONA_FIELDS`, `text?` ≤ 400, `why` ≤ 400, `evidence: string[]`). Rules: spec §7, §8. Usable personas: `isOutputUsable`. Order of qualifying personas: disagreements descending, then persona id. The run row is inserted `running` with `shownSignalIds` before the agent starts; the handler finds the `running` row of `persona_id` in this tree whose `agentRunId` is unset or equals the caller's. Handler refusals: the eight conditions of spec §7 step 5, each with a message naming the limit. Engine step proposals have `source: 'engine'`, `action: 'retire'`, rationale `"Disagreement did not drop: <before %> of <n> before, <since %> of <n> since."`. `runRetro`: call inside its own try/catch after `evaluateLessons`; merge the report into `digest` counts of the retro row, including for a `skipped` retro. Disabled (`personaLearning.enabled: false`, or lessons / retro disabled): the function returns zeros and runs nothing.

Prompt file: tells the agent it corrects a simulated persona from the reactions of the person who knows the audience; to state one assumption; to propose only what several reactions support; to write each adjustment in the second person as a general statement and never copy a reason or evidence text; that agreements show what must not change; and to call `submit_persona_learning` exactly once, with no proposals when the reactions do not point one way.

- [ ] Write `learn.test.ts` with a fake agent: a qualifying persona gets one run, proposals stored `pending` with the gate numbers, run `proposed`, signals no longer open; a persona below the gate gets no run; a persona with a pending proposal is skipped and its signals stay open; more than `maxPersonasPerRetro` qualify → the ones with most disagreements run; zero proposals → `no_change` and signals consumed; agent ends without the tool → `failed`, signals stay open, the function resolves; each handler refusal (unknown evidence id, 4 proposals, 2 evidence ids, evidence from one item, one disagreement only, would exceed `maxAdjustments`, wrong persona, upload-exposed run); a signal resting on an upload-derived flow appears in the prompt without detail or reason and still counts in the gate; reasons in the prompt sit inside the untrusted fence; the engine step proposes `retire` when the rate since is not lower and at least 6 signals came since, once only; `enabled: false` → zeros.
- [ ] Extend the retro test: `runRetro` on a tree with a qualifying persona stores the four counts in `digest`, including when the retro is `skipped`; a throw inside persona learning leaves the retro result unchanged.
- [ ] Add a test that greps `src/` for callers: `runPersonaLearning` is referenced only in `learn.ts` and `lessons/retro.ts`; `adjustments.insert` / `adjustments.update` only in `adjustments.ts`.
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`; commit `feat(personas): persona learning run inside the retro`.

### Task 5: API and page

**Files:** create `src/api/personaLearningRoutes.ts`, `web/src/views/personas/Learning.tsx`, `web/src/logic/personaLearning.ts`; modify `src/api/routes.ts` (mount), `web/src/logic/{api,types,hooks}.ts`, `web/src/views/Personas.tsx`, `web/src/views/Lessons.tsx` (count and link); tests `test/api/personaLearningRoutes.test.ts`, `test/web/personaLearning.test.tsx`.

**Interfaces — Consumes:** Tasks 2–4. **Produces:** routes of spec §13. `GET …/persona-learning` returns

```ts
{ enabled: boolean; personas: Array<{ personaId: string; segment: string; version: number; gate: GateResult;
    adjustments: Array<PersonaAdjustment & { effect: AdjustmentEffect }>; proposals: PersonaProposal[]; // pending first, then decided, newest first, 20 at most
    lastRun?: Pick<PersonaLearningRun, 'id' | 'status' | 'assumption' | 'createdAt' | 'stats'> }> }
```

`GET …/personas/:personaId/signals` returns `{ signals: PersonaSignal[] }` newest first. Errors: `PersonaLearningError.status`; bodies `{ error }` like `flowRoutes.ts`.

Page: the block of spec §14 on each persona card — the reactions line, the missing lines or "Enough for a change at the next retro", the last assumption with its date, pending proposals with Accept / Edit / Reject and a reason box, active adjustments with before/since numbers and Retire, and a "show" toggle that loads the signals. Persona output stays labelled simulated. User text is rendered as text, never as HTML.

- [ ] Write the route tests: the GET shapes; accept, edit-accept, reject and retire happy paths; 404 for a proposal of another tree; 409 on a second accept; the actor is the configured one even when the body carries `actor`.
- [ ] Write the web test: the card shows the reactions line and missing lines from a fixture; Accept posts the edited text and reason; a decided proposal no longer shows buttons; the Lessons page shows "2 persona proposals waiting".
- [ ] Run; expect failures. Implement.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(personas): persona learning routes and page`.

### Task 6: Export, end to end, docs, smoke

**Files:** modify `src/core/scoring/export.ts` (treat persona learning Decisions and proposals as lesson proposals are treated), `scripts/smoke.ts` (mode `persona-learning`), `README.md`, `docs/smoke-results.md`; tests `test/core/personas/{endToEnd,isolation}.test.ts`.

- [ ] Write `endToEnd.test.ts`: seed flows, verdicts and 6 reactions (5 disagree) on 4 pairs → nothing changes at reaction time (persona version, agent.md, adjustments) → `runRetro` → pending proposal → accept → agent.md has the correction, version +1, verdicts not live → six later reactions with the same disagreement rate → next retro proposes an engine `retire`.
- [ ] Write `isolation.test.ts`: two trees with the same persona slug; signals, gate, runs, proposals and routes of one never return the other's rows.
- [ ] Export: add a test next to the existing export tests that persona learning rows follow the lesson-proposal rule; implement.
- [ ] Smoke mode `persona-learning`: seeds reactions, runs the retro with a real CLI, checks one `submit_persona_learning` call and its stored result. Document how to run it in `docs/smoke-results.md`; do not record a run you did not make.
- [ ] README: a "Persona learning" section — what counts as a signal, the gate in plain words with the defaults, that changes wait for the user, the settings.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web`; commit `feat(personas): export rule, end-to-end and isolation tests, docs, smoke mode`.
