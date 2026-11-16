# Review Council Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For task types named in `council.stages`, the review step of the task review loop is done by several reviewer runs in parallel, each with one lens, from configured CLIs and models; the harness merges their reviews by fixed rules into one review per round.

**Architecture:** New code in `src/core/council/` (`settings.ts`, `lenses.ts`, `merge.ts`, `round.ts`, `store.ts`). `runTaskWithReview` calls `councilStep` instead of `reviewStep` when the task type is a council stage. Members are ordinary reviewer runs tagged as council members; one harness `review` Decision (`event: 'council_review'`) per round is what every downstream consumer reads.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-review-council-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- With no `council` block, or for a task type not in `council.stages`, behaviour is byte-identical to today: same runs, prompts, Decisions, statuses. The existing suite passes without changes to its expectations (except tests that pin tool schemas, config defaults or migration lists that this plan extends).
- A member is never replaced by another model. `reviewerFor` is not used for members.
- Merging is deterministic code. No model is asked to merge, rank or rule.
- A member sees only what today's reviewer sees (same tools, same review slice, same prompt inputs) plus the council section; never another member's output.
- Member runs are real reviewer runs: usage, cost, logs and budgets are per run, as today.
- Tests never spawn a real CLI.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. A run with one council stage and other task types: the others produce exactly the Decisions and runs they produce on `main`.
2. Every consumer of "the task's review" reads the council review and not a member's: `recordReviewRound` / the review-issue history, `latestReviews` in `research/outputs.ts`, `taskLastReviewDecision` and outcomes, the reviewer audit's candidates (council-reviewed tasks are skipped), escalation's view of the task's runs, the decision queue, the export.
3. A member's nit or scope issue, or a score below the pass score with no blocking or substantive issue, can never make a round fail (tests per rule of spec §6).
4. `onUnavailable: "fail"`: the task ends `unverified` with the member named, and no revise run is started. `"report"`: the round goes on; with no blocking member left it is treated as `fail`.
5. A restart in the middle of a council round: the round is run again and the earlier partial member runs do not count twice.
6. A non-blocking member never delays or decides a round; its cancelled run leaves a clean record.
7. Issue ids stay stable across council rounds, and disputes work as with a single reviewer.

## File Structure

- `src/core/config/schema.ts` — `council` block and validation. `src/core/config/load.ts` — `configWarnings` for unavailable members.
- `src/core/council/settings.ts` — `councilFor(config, taskType)`.
- `src/core/council/lenses.ts` — lens texts, `councilSection(member, passScore, round)`.
- `src/core/council/merge.ts` — pure merge of member reviews.
- `src/core/council/round.ts` — `councilStep`. `src/core/council/store.ts` — member-run tags, reading the round records.
- `src/core/prompts/council_member.md` — the member rules (spec §5.1).
- `src/core/harness/tools/registry.ts`, `handlers.ts` — `submit_review` extension. `src/core/harness/adapters/*` — `effort`.
- `src/api/councilRoutes.ts`; `web/src/views/CouncilTable.tsx` and where a task's review is shown.
- `.claude/skills/council/SKILL.md`.
- Tests: `test/core/council/{settings,merge,round,downstream}.test.ts`, `test/api/councilRoutes.test.ts`, `test/web/councilTable.test.tsx`.

---

### Task 1: Configuration, lenses, the member's review, the merge

**Files:** modify `src/core/config/{schema,load}.ts`, `src/core/harness/tools/{registry,handlers}.ts`, `src/core/harness/adapters/{claude,codex,opencode}.ts` and the supervisor's request type as far as `effort` needs; create `src/core/council/{settings,lenses,merge}.ts`, `src/core/prompts/council_member.md`; tests `test/core/council/{settings,merge}.test.ts`, adapter tests for `effort`.

**Interfaces — Produces:**

```ts
// council/settings.ts
export const LENSES = ['evidence', 'brief', 'reasoning', 'privacy', 'value', 'rewrite'] as const;
export type Lens = (typeof LENSES)[number];
export type CouncilMember = { name: string; provider: ProviderId; model: string; effort?: string; lens: Lens; blocking: boolean };
export type CouncilStage = { rounds: number; passScore: number; blockOn: 'any' | 'majority' | 'all'; onUnavailable: 'fail' | 'report'; members: CouncilMember[] };
export function councilFor(config: Pick<BifConfig, 'council'>, taskType: TaskType): CouncilStage | undefined;   // undefined: single reviewer, as today
export function memberUnavailable(config: Pick<BifConfig, 'providers'>, m: CouncilMember): string | undefined; // reason, or undefined when it can be started

// council/lenses.ts
export function councilSection(member: CouncilMember, stage: Pick<CouncilStage, 'passScore'>, round: number): string; // appended to the reviewer system prompt

// council/merge.ts
export type MemberReview = { member: CouncilMember; state: 'reviewed' | 'no_score' | 'unavailable' | 'not_waited'; reason?: string; runId?: string;
  score?: number; issues: CouncilIssueIn[]; questions: string[]; followUps: string[] };
export type CouncilIssueIn = ReviewIssue & { action?: 'fix' | 'delete' | 'rewrite'; where?: string[] };
export type MergedIssue = CouncilIssueIn & { raisedBy: string[]; standing: 'upheld' | 'advisory' };
export type MergeInput = { stage: CouncilStage; round: number; reviews: MemberReview[];
  earlier: Array<{ id: string; description: string; where?: string[] }>;       // issues of earlier rounds (any member)
  disputed: Set<string> };                                                     // ids of issues the worker pushed back on
export type CouncilResult = { pass: boolean; score: number; issues: MergedIssue[];            // upheld first
  dropped: Array<{ issue: CouncilIssueIn; raisedBy: string[]; rule: 'nit' | 'scope' }>;
  questions: Array<{ text: string; raisedBy: string[] }>; followUps: Array<{ text: string; raisedBy: string[] }>;
  members: Array<{ name: string; provider: string; model: string; lens: Lens; blocking: boolean; state: MemberReview['state']; reason?: string;
    runId?: string; score?: number; countedScore?: number; unsupportedScore?: boolean }> };
export function mergeCouncil(input: MergeInput): CouncilResult;
```

Rules: spec §4, §5, §6 (merge steps 3.1–3.7, 4, 5).

- [ ] `council` in the config schema (strict objects; `cli` accepted for `provider`), defaults, errors of spec §4, start-up warnings for unavailable members. A config without `council` parses to the same object as today.
- [ ] `effort`: read `--help` of the installed `claude`, `codex` and `opencode` CLIs (and their docs if needed) to find each one's reasoning-effort setting; pass it when the member has `effort`; for a provider with no such setting make `effort` a configuration error naming the provider. Report exactly which flag each adapter uses and how you confirmed it. Runs without `effort` build the same command as today.
- [ ] `submit_review` gains the optional fields of spec §5.5 (`action`, `where` per issue; `questions`, `follow_ups`). They are stored in the Decision payload. A single reviewer may send them; nothing reads them outside a council.
- [ ] `council_member.md` and `councilSection`: the rules of spec §5.1 in the member's words, the member's lens (§5.2), §5.3 for `value`, §5.4 for `rewrite`, the pass score, and from round 2 the scope rule of §6 step 3.5.
- [ ] `mergeCouncil`: pure, no store. Same-defect merge uses `issueSimilarity` from `learning/reviewIssues.ts` with its repeat threshold; issues with disjoint non-empty `where` are never merged. One test per rule and per `blockOn` value, the unsupported-score rule, non-blocking members, and a property-style test that a review made only of nits, scope issues, questions and follow-ups never makes `pass` false.

---

### Task 2: The council round in the review loop, and everything downstream

**Files:** create `src/core/council/{round,store}.ts`; modify `src/core/research/reviewLoop.ts`, `src/core/learning/{reviewIssues,outcomes,reviewerAudit,runTags}.ts`, `src/core/research/outputs.ts`, `src/core/escalation/escalation.ts`, `src/core/scoring/{decisionQueue,export}.ts`, the revise prompt building (how advisory issues and questions are shown), a migration if a tag table needs it; tests `test/core/council/{round,downstream}.test.ts`.

**Interfaces — Produces:**

```ts
// council/round.ts
export async function councilStep(deps: ResearchDeps, taskId: string, round: number, stage: CouncilStage):
  Promise<{ valid: boolean; score: number; issues: ReviewIssue[]; pass: boolean; failed?: string }>;   // failed: reason the task must end unverified now
// council/store.ts
export function isCouncilMemberRun(store: Pick<Store, 'db'>, agentRunId: string): boolean;
export function councilRounds(store: Store, taskId: string): Array<{ round: number; decisionId: string; result: CouncilResult }>;
```

Rules: spec §5 (first paragraph), §6 steps 1, 2, 6; §7; §8.

- [ ] `runTaskWithReview`: when `councilFor(config, task.type)` is set, use its `rounds` and `passScore` and call `councilStep`; pass is `result.pass` (not a score comparison); `failed` ends the task `unverified` with that failure reason and no revise run.
- [ ] `councilStep`: seat available members (each with `reviewerRunInput` plus `councilSection`), run in parallel, cancel non-blocking members once every blocking member has ended (each member needs its own abort signal chained to `deps.signal`), build `MemberReview`s (a run that is not `done` or has no valid `submit_review` is `no_score` and counts as unavailable for §7), call `mergeCouncil`, record the `council_review` harness Decision, and return the upheld issues as the round's issues with stable ids.
- [ ] Tag member runs (follow how audit runs are tagged in `learning/runTags.ts`). Make every consumer listed in Review Focus 2 read the council review as the round's one review. `recordReviewRound` needs the run to attach the history to: use the council round's Decision's run (decide and document which run that is; the Decision must exist even when every member was unavailable).
- [ ] Revise prompt: upheld issues as today; then "Not blocking (answer if useful)" with the advisory issues, and "Questions from reviewers" — the worker need not `respond_to_review` to those. An upheld rewrite is shown first, with the instruction to discard the named outputs and redo them as proposed.
- [ ] Restart mid-round (Review Focus 5) and abort (`deps.signal`) behave as for a single reviewer.
- [ ] Tests: every Review Focus item; a fake-agent council of three with scripted reviews through two rounds to `verified`; to the round limit → `unverified` and the escalation sees the open issues; both `onUnavailable` settings; disputes across rounds; the audit skipping a council-reviewed task; the export of a council-reviewed task.

---

### Task 3: API, page, the development skill, docs, smoke

**Files:** create `src/api/councilRoutes.ts`, `web/src/views/CouncilTable.tsx`, `.claude/skills/council/SKILL.md`, `test/api/councilRoutes.test.ts`, `test/web/councilTable.test.tsx`, `test/core/council/endToEnd.test.ts`; modify the route mounting, the web view that shows a task's review (and `Settings.tsx` for the read-only council), `README.md`, `bif.config.example.json` or wherever the example configuration lives, `scripts/smoke.ts` (mode `council`).

Rules: spec §9, §10, §11.

- [ ] `GET /api/tasks/:id/council` → `{ stage?: { rounds, passScore, blockOn, onUnavailable }, rounds: [...] }` from `councilRounds`; tree-checked like the other task routes; 404 for unknown.
- [ ] `CouncilTable`: members down, rounds across; cells `7/10`, "no score", "unavailable", "not waited for"; below it the open issues with who raised each, the questions and the follow-ups. Shown where the task's last review is shown, only for council-reviewed tasks.
- [ ] Settings: the configured council, read-only, with each member marked available or not and why.
- [ ] `.claude/skills/council/SKILL.md` per spec §11: the source skill's structure with BIF's terms, the credit line and link to the source, and how to start members in this repository's workflow.
- [ ] README: what a council is, where it is worth its cost and where not (spec §3), the configuration with every key, what happens when a member is unavailable, the cost note (a council of N costs N reviewer runs per round), the credit.
- [ ] End-to-end test with fake agents: a run with a council stage and a non-council task type.
- [ ] Smoke mode `council`: one small task of a council stage with two Claude members on the cheapest two models (lenses `evidence` and `brief`), plus, when `BIF_SMOKE_COUNCIL_EXTRA=codex` or `opencode` is set, one member of that CLI; checks: members ran in parallel as separate runs with their own prompts, each prompt holds its lens and not the other's, one `council_review` Decision per round, the task's final status follows the council's result, and a second pass with a member whose model does not exist under `onUnavailable: "fail"` ends `unverified` naming the member with no other model started. Do not run it; the controller does.
