# Stakeholder Positions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stakeholder persona has a position history; the user can mark a person as left (to a competitor or elsewhere), moved, promoted, demoted or returned; a former colleague is followed on the web into a public layer kept apart from the internal layer, and an offline run combines both into the profile used for reads.

**Architecture:** New columns on `personas` and an append-only `stakeholder_positions` table (migration 28). Actions live in `src/core/stakeholders/positions.ts`. One helper, `holdsInternal`, replaces every "is this an own stakeholder, so offline" check. Follow research reuses the `competitor_stakeholders` task and `save_stakeholder` (new `follow` input). The combine run is an offline `retro` run answering with a new tool, `submit_combined_profile`, in `src/core/stakeholders/combine.ts`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-stakeholder-positions-design.md` (read it first; section numbers below refer to it). It builds on `docs/superpowers/specs/2026-11-15-stakeholder-personas-design.md`.

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- Every read and write is checked against the business tree; an id of another tree answers exactly like an unknown one (404).
- Internal knowledge about a former colleague never reaches a run with web access, a web request or an export: the follow research prompt holds only id, label, the position held here, the leaving date and where they went.
- `holdsInternal(persona)` is the only test for "this persona's text is internal": true unless `subjectKind === 'competitor'` and `leftAt` is unset. Runs carrying such a persona's agent.md, learning prompt or layers are offline (`offline: true`, model from `offlineModel`), and skipped with a harness Decision when no provider can run offline.
- `stakeholder_positions` is append-only (triggers), like `stakeholder_statements`.
- A follow save never touches the persona's `profile`, `status`, `taskId` or `version`.
- Evidence of a combined field is computed in code from the layers, never taken from the model.
- The actor comes from `actorOf(config)`, never from a request body. Tests never spawn a real CLI.
- Existing behaviour for personas that never changed position is unchanged; the existing suite passes without edits to its expectations, except where a test pins a type or a tool list that this plan extends.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. A former colleague at a competitor: no question round, no approval read, a rival read that runs offline, not counted in `maxPerCompetitor`, not listed to the interviewer as an own stakeholder (spec §6 table, each cell a test).
2. A parked former colleague takes part in no read and is not shown as an own stakeholder anywhere (`subjectKind !== 'competitor'` checks in `reads.ts`, `learn.ts`, `stakeholderRoutes.ts` must not treat `former` as own).
3. A follow research task that fails review: the persona is still usable, its profile unchanged, its public layer ignored by the combine run.
4. The follow section of the work prompt contains nothing from the profile, adjustments or statements (test asserts on the rendered section with distinctive marker strings in each).
5. A combined field with basis `internal`, `both` or `inferred` whose internal evidence is upload-derived stays out of the export by the existing provenance rule (test).
6. Slug conflicts on leaving, moving and returning answer 409 and change nothing (transaction rolled back, no history row, no file written).
7. History cannot be changed: UPDATE and DELETE on `stakeholder_positions` fail.

## File Structure

- `src/core/store/migrations.ts` — migration 28. `src/core/store/repos.ts` — new persona columns. `src/core/types.ts` — `Persona`, `PersonaProfileField`.
- `src/core/stakeholders/types.ts` — `StakeholderPosition`, constants. `src/core/stakeholders/store.ts` — `positions` repo.
- `src/core/stakeholders/positions.ts` — the actions, `holdsInternal`, `isFormerColleague`, `formerColleagues`, `positionsOf`.
- `src/core/stakeholders/combine.ts` — `runCombine`, `submitCombinedProfileHandler`. `src/core/prompts/stakeholder_combine.md`.
- `src/core/market/agentMd.ts` — former-colleague text. `src/core/stakeholders/personas.ts` — `follow`, `now_at`, the follow section.
- `src/api/stakeholderRoutes.ts`; `web/src/views/Stakeholders.tsx`, `web/src/views/stakeholders/*`, `web/src/logic/*`.
- Tests: `test/core/stakeholders/{positions,participation,follow,combine,positionsEndToEnd}.test.ts`, `test/api/stakeholderPositionRoutes.test.ts`, `test/web/stakeholderPositions.test.tsx`.

---

### Task 1: Storage, the four actions, who takes part in what

**Files:** modify `src/core/store/{migrations,repos}.ts`, `src/core/types.ts`, `src/core/stakeholders/{types,store,settings,reads,questions,statements,personas}.ts`, `src/core/personas/learn.ts`, `src/core/interview/interview.ts`, `src/core/market/agentMd.ts`, `src/core/config/schema.ts` (`stakeholders.maxFollowed`), `src/core/feedback/events.ts` (kind `stakeholder_position_change`, and wherever feedback kinds must be enumerated, e.g. `STANCE_BY_KIND` in `src/core/userPersona/interactions.ts`: stance `neutral`); create `src/core/stakeholders/positions.ts`; tests `test/core/stakeholders/{positions,participation}.test.ts`.

**Interfaces — Produces:**

```ts
// types.ts (core)
export interface PersonaProfileField { value: string; confidence: number; evidence: string[]; basis?: 'internal' | 'public' | 'both' | 'inferred'; conflict?: string }
// Persona gains: subjectKind?: 'own' | 'competitor' | 'former'; leftAt?: string; leftFrom?: LeftFrom; positionTitle?: string;
//   internalProfile?: Record<string, PersonaProfileField>; publicProfile?: Record<string, PersonaProfileField>;
//   publicTaskId?: string; publicSavedAt?: string; combinedAt?: string; publicPosition?: { text: string; evidence: string[] }
export type LeftFrom = { workspaceId: string; scopeName: string; stakeholderType: StakeholderType; title?: string; relation?: string };

// stakeholders/types.ts
export const POSITION_CHANGES = ['joined', 'moved', 'promoted', 'demoted', 'left', 'returned'] as const;
export interface StakeholderPosition { id: string; rootWorkspaceId: string; personaId: string; change: (typeof POSITION_CHANGES)[number];
  placeKind: 'node' | 'competitor' | 'elsewhere'; workspaceId?: string; competitorId?: string; companyName?: string;
  stakeholderType?: StakeholderType; title?: string; relation?: string; effectiveOn?: string; actor: string; note?: string; createdAt: string }

// stakeholders/positions.ts
export function isFormerColleague(p: Pick<Persona, 'kind' | 'leftAt'>): boolean;            // stakeholder with leftAt
export function holdsInternal(p: Pick<Persona, 'kind' | 'subjectKind' | 'leftAt'>): boolean;  // see Global Constraints
export function formerColleagues(store: Store, workspaceId: string): Persona[];               // of the node, not superseded, by slug
export function positionsOf(store: Store, personaId: string): StakeholderPosition[];          // newest first
export type PositionDeps = { store: Store; dataDir: string };
export type LeftInput = { date: string; to: { competitorId: string } | { newCompetitor: { name: string; site?: string } } | { elsewhere: { companyName?: string } };
  label?: string; title?: string; note?: string };
export type ChangeInput = { change: 'moved' | 'promoted' | 'demoted'; date: string; toWorkspaceId?: string; stakeholderType?: StakeholderType; title?: string; note?: string };
export type ReturnInput = { date: string; toWorkspaceId: string; stakeholderType?: StakeholderType; title?: string; note?: string };
export function markLeft(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: LeftInput): Persona;
export function changePosition(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: ChangeInput): Persona;
export function markReturned(deps: PositionDeps, actor: string, workspaceId: string, personaId: string, input: ReturnInput): Persona;
```

Errors are `StakeholderError` (existing, with `status`): 404 unknown or foreign persona / node / competitor, 409 hidden persona or slug conflict, 400 everything else (bad date, future date, `moved` without another node, wrong kind of persona for the action, empty label, text over the existing caps for labels 80 / relation 300 / note 2,000 characters). Texts are made one line with the existing `oneLine`, and notes cleaned with the existing `cleanReason`.

Rules: spec §4, §5, §6.

- [ ] Migration 28 (columns of spec §4, `stakeholder_positions` with no-update and no-delete triggers); repo column map; `stakeholderRepos(store).positions`.
- [ ] `markLeft`, including "attach" of a parked former colleague to a competitor (keeps `leftAt`, `leftFrom`, layers; writes a `left` row with the competitor). A new competitor is inserted with threat 1, directness 1, an empty comparison, no evidence, status `unverified`; check how `store.competitors` and `linkCompetitor`/entity linking are used by `save_competitor` and follow that for the knowledge store link.
- [ ] `changePosition`, `markReturned`. Moving rewrites agent.md at the new path (`agentMdPath(dataDir, workspaceId, slug)`) and moves the persona's open questions to the new node.
- [ ] The first change writes the `joined` baseline row. Each action records a `stakeholder_position_change` feedback event (`afterJson`: change, place kind, ids, date; no free text beyond the cleaned note as `reason`).
- [ ] Participation (spec §6): replace own-checks so that `former` is never treated as own. `reads.ts`: `readers` excludes `former`; `isOwn` becomes `holdsInternal`. `learn.ts`: offline when `holdsInternal`; a parked persona qualifies by statements only. `questions.ts`, `interview.ts`, `recordDecision`: own and not left only. `addNote` / `ownStakeholder`: allowed for former colleagues too. `save_stakeholder` caps: former colleagues do not count towards `maxOwn` or `maxPerCompetitor`.
- [ ] `compileStakeholderMd`: for a former colleague at a competitor, the paragraph of spec §6 and, per section, a line "_Rests on: internal knowledge (as of <leftAt>) | public sources | both | a conclusion from both_" plus "_Conflict: …_" when recorded; frontmatter `former_colleague: true`. A parked persona compiles as an own one with a first line saying they left on that date.
- [ ] Tests: every action, every refusal, rollback on conflict, the append-only triggers, each cell of the §6 table, agent.md text.

---

### Task 2: Follow research, the public layer, the combine run

**Files:** modify `src/core/stakeholders/personas.ts`, `src/core/harness/tools/registry.ts` (`save_stakeholder` gains `follow`, `now_at`; new tool `submit_combined_profile` for role `retro`), `src/core/prompts/competitor_stakeholders.md`, the code that plans and runs the stakeholders phase (`src/core/research/phases.ts`, `orchestrator.ts`), `src/core/scoring/export.ts`, wherever extra tool handlers are registered; create `src/core/stakeholders/combine.ts`, `src/core/prompts/stakeholder_combine.md`; tests `test/core/stakeholders/{follow,combine}.test.ts`.

**Interfaces — Produces:**

```ts
// personas.ts: save_stakeholder input gains  follow?: string (persona id)  and  now_at?: string (one line, ≤ 200 chars)
// combine.ts
export type CombineReport = { combined: number; skipped: Array<{ personaId: string; reason: string }> };
export function needsCombine(store: Store, p: Persona): boolean;   // former colleague, publicProfile set, publicSavedAt > (combinedAt ?? ''), public task ended verified | unverified
export async function runCombine(workspaceId: string, deps: ResearchDeps): Promise<CombineReport>;
export const submitCombinedProfileHandler: ExtraToolHandler;
```

Rules: spec §7.

- [ ] Follow section in `stakeholderTaskSection` for `competitor_stakeholders`: "Former colleagues to follow", at most `maxFollowed`, oldest `publicSavedAt` first (never followed first), fenced like the other lists; each line: persona id, label, "was <title or type> at <scope> until <date>", "now at <competitor name | company name | unknown>". Instruction: save what public sources show with `save_stakeholder` and `follow: <id>`; give `now_at` when a source shows the current company and title; never search for or send anything not in this list about them.
- [ ] `save_stakeholder` with `follow`: persona must be a former colleague of the caller's node, else refused; only in a `competitor_stakeholders` task; evidence ids checked as today; stores `publicProfile` (each field with `basis: 'public'`), `publicTaskId`, `publicSavedAt`, `publicPosition` when `now_at` is given; touches nothing else; logs a `score` Decision with label, type and confidences only (as today). A save without `follow` whose slug belongs to a former colleague is refused, naming `follow`.
- [ ] The stakeholders phase plans `competitor_stakeholders` when the node has competitors or former colleagues to follow (find where the phase's tasks are proposed and how the orchestrator is told; follow the existing pattern and keep the phase a no-op when stakeholders are disabled or `maxFollowed` is 0 and there are no competitors).
- [ ] `runCombine`, called after the stakeholders phase's tasks have ended (and safe to call again: nothing runs when nothing `needsCombine`). One offline run per persona: kind `retro`, role `retro`, system prompt `stakeholder_combine.md`, user prompt with both layers fenced as untrusted data (`fenceEvidence`), internal fields with "as of <leftAt>". An `asked` map by agent run id as in `reads.ts`. No offline provider: skipped, one harness Decision `stakeholder_combine_offline_unavailable`.
- [ ] `submit_combined_profile` handler: refuses a run not asked, another persona, a missing or extra field, a basis `public` or `both` for a field the public layer lacks. Evidence per field computed from the layers (spec §7.2). On success, in one transaction: `profile` replaced, version + 1, `combinedAt`, agent.md rewritten.
- [ ] Export: the Decision of `submit_combined_profile` and of its run is internal (`isInternalRecord`). Test Review Focus 5.
- [ ] Tests: the follow section's content (Review Focus 4), the follow save and its refusals, a failed follow task (Review Focus 3), combine with a fake agent, evidence computation, refusals, offline flag passed to `runAgent`, the skipped case, idempotence.

---

### Task 3: API and the page

**Files:** modify `src/api/stakeholderRoutes.ts` (and its deps: it needs `dataDir`; see how `routes.ts` mounts it), `web/src/views/Stakeholders.tsx`, `web/src/views/stakeholders/*`, `web/src/logic/{types,api or the existing stakeholders logic file}.ts`; tests `test/api/stakeholderPositionRoutes.test.ts`, `test/web/stakeholderPositions.test.tsx`.

Rules: spec §9, §10.

- [ ] `GET /stakeholders`: `own` holds own stakeholders that have not left; `competitors[].stakeholders` includes former colleagues there; new `former` array for parked ones. Open views gain `leftAt`, `leftFrom`, `positionTitle`, `publicPosition`, `hasPublicLayer`, `subjectKind` incl. `former`. A hidden view is unchanged.
- [ ] `GET /stakeholders/:personaId/positions` → `{ positions, internalProfile?, publicProfile? }` (404 for hidden: 409 as elsewhere for hidden content; follow the existing hidden rule: nothing of a hidden stakeholder but its label, type and questions is served).
- [ ] `POST /stakeholders/:personaId/position` with a zod body per change; maps to `markLeft` / `changePosition` / `markReturned`; answers the stakeholder view; `StakeholderError` statuses passed through.
- [ ] Page: per spec §10. Follow the existing components and test style of `web/src/views/stakeholders/`. Dates entered with a date input, default today. The form lists the tree's competitors, "A company not listed" (name, site) and "Elsewhere". Profiles of a former colleague in three tabs or sections: Combined (with the basis and conflict of each field), Internal, Public.
- [ ] Tests: each route incl. foreign tree 404 and hidden 409; the page renders an own stakeholder's position form, a former colleague's layers and the parked group, and posts the right body.

---

### Task 4: End to end, docs, smoke

**Files:** create `test/core/stakeholders/positionsEndToEnd.test.ts`; modify `README.md` (the stakeholders section), `scripts/smoke.ts` (mode `stakeholder-positions`), `docs/superpowers/specs/2026-11-15-stakeholder-positions-design.md` (an "As built" section listing any deviation).

- [ ] End to end with fake agents: own stakeholder revealed → marked left to a new competitor → stakeholders phase runs a follow save → combine run → a recommendation is read with rival stances offline → returned. Assert the history, both layers, the combined profile's bases, and that the export leaves out the internal records (Review Focus 1, 3, 5).
- [ ] An isolation test: two trees; every new route and action with the other tree's ids answers 404 and changes nothing.
- [ ] README: what the actions do, the two layers, what stays internal, `stakeholders.maxFollowed`.
- [ ] Smoke mode `stakeholder-positions` on the cheapest Claude model, following the structure of the existing `stakeholders` mode: seed a node with a revealed own stakeholder and a competitor, mark left, run the follow research and the combine run, check `publicProfile`, `combinedAt` and that every combined field has a basis. Do not run it (the controller runs it); make sure `npx tsx scripts/smoke.ts --help` or the mode list shows it.
