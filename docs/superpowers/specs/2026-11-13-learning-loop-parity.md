# Learning-loop parity: tracking, self-improvement, human feedback

Status: approved for build (2026-11-13). Source: gap audit of BIF against the
reference factory (AI-Immersion-eShop `.agent-metrics/*`, `scripts/pipeline`,
`scripts/qe`, `scripts/implement`). This spec is self-contained; the reference
repo is not needed.

## Goal

BIF must (a) log and track everything the reference factory logs (tokens, cost,
timings, failures, prompt text, review history, decision outcomes), (b) close the
self-improvement loop with measurable, reversible prompt changes, and (c) record
every piece of human-in-the-loop feedback durably — who, when, what, why, which
agent output and which prompt version — and feed it into calibration and export.

## Global rules (all work packages)

- Architecture rules unchanged: `src/core` never imports api/web; `web/src/logic`
  holds behaviour (hooks, API client), `web/src/views` is markup/CSS only and never
  calls fetch.
- Migrations: append-only. Each work package owns a fixed migration number
  (below) and appends exactly one migration entry in that slot with a leading
  comment `// <N>: learning loop WP-<X> — ...`. Never hard-code the total
  migration count in tests (use the array length / the latest version helper).
- Privacy rules unchanged: upload-derived text stays out of exports by default
  (sticky provenance, `src/core/scoring/export.ts`); calibration and lessons stay
  per business-tree root; nothing crosses trees.
- Human actor: BIF is single-user locally but sellable. Add `actor TEXT NOT NULL
  DEFAULT 'local-user'` wherever a human acts; the API takes the actor from a
  configurable `config.user.id` (default `local-user`), never from the request body.
- All new learning signals are proposals the user approves; nothing auto-edits
  prompts without an explicit user accept (record the accept as a decision).
- Each WP: TDD, vitest; `npm test`, `npm run typecheck`, `npm run build:web` green;
  commits on its own branch; update `README.md` and the main design spec
  (`docs/superpowers/specs/2026-11-12-business-intelligence-factory-design.md`)
  sections it changes.
- Hot shared files (`migrations.ts`, `repos.ts`, `types.ts`, `api/routes.ts`,
  `web/src/logic/api.ts`, `web/src/logic/types.ts`): add new code in new,
  clearly delimited blocks/functions; avoid reformatting or reordering existing
  code so parallel branches merge cleanly. Prefer new modules over growing
  existing ones.

## Wave 1 (parallel)

### WP-A — Feedback provenance and wiring (migration 14)

1. Provenance on every human input:
   - `ratings`: add `actor`, `agent_run_id`, `prompt_version` (resolved from the
     rated target's decision/run at write time).
   - `user_requests`: add `resolved_at`, `actor`.
   - `unit_proposals`: add `decided_at`, `actor`, `decision_reason`,
     `original_payload` (pre-edit proposal kept verbatim on accept-with-edit).
   - New append-only `feedback_events` (id, workspace_id, actor, created_at, kind,
     target_type, target_id, before_json, after_json, reason, agent_run_id,
     prompt_version). Kinds at least: `include_override`, `profile_edit`,
     `proposal_accept`, `proposal_edit`, `proposal_reject`, `hypothesis_correction`,
     `request_answer`, `weights_change`, `prompt_patch_apply`.
   - Every existing human route writes a `feedback_events` row: include-overrides
     (findings, recommendations, personas, competitors, hypotheses), profile
     edits, proposal accept/edit/reject, request answers, weight changes,
     prompt-patch apply (replace the `'user'` pseudo run id / `'n/a'` version with
     the real actor and the patched role's current prompt version).
2. Wire feedback into learning:
   - Accept-with-edit becomes a correction signal (rating-equivalent row with the
     edit diff) usable by calibration.
   - Include-override = false on an output counts as a `disagree` on that output
     for calibration; = true on an unverified output counts as `agree`-override.
   - Give `unit_proposal` a scale so rejections rank in calibration top-N.
   - New route + UI to correct a symptom hypothesis (user correction, distinct
     from agent revisions) and to set hypothesis include-override.
   - Export (`export.ts`) gains: request answers, interview turns (linked to the
     interviewer run — add `agent_run_id` to `interview_turns`), feedback events,
     final review status. Upload-provenance exclusion applies to all of these.
   - Re-queue a rated target in the review queue when the agent revises it after
     the rating (new revision ≠ rated revision).
3. Decision-log UI shows actor/time/reason on each feedback item.

### WP-B — Usage, cost, timing, prompt store, versioned calibration (migration 15)

1. Token/cost per run: persist the adapters' `usage` RunEvents (claude, codex,
   opencode) from `src/core/harness/supervisor.ts` into a new `agent_usage` table
   (run_id, model, provider, input, output, cache_read, cache_write, cost_usd
   computed, cli_reported_cost_usd, price_version). Dated `pricing.json` under
   `src/core/harness/` (or config) with per-model prices and an effective date.
2. Timing and failures: `agent_runs` gains `attempts`, `failure_reason`, `round`,
   `task_type`; `research_runs` and `tasks` gain `failure_reason`. Retries and
   rate-limit back-offs append to an `agent_run_attempts` table.
3. Budgets (spec §71/§82 were never built): optional per-workspace and per-pipeline
   token/cost caps in config; supervisor refuses new runs past a cap and raises a
   `user_request` to extend.
4. Prompt store: `prompt_versions(hash PK, role, text, created_at)`; every
   `prompt_version` hash recorded anywhere must resolve to its text. Save the full
   task prompt as `prompt.md` in the run directory.
5. Versioned calibration: calibration patch files keep history
   (`calibration/<role>/<timestamp>.md` + `current` pointer, or a table) instead
   of overwrite; revert to a previous version via API/UI.
6. Calibration report and review pass rate grouped by `prompt_version`, with a
   per-version trend (agreement rate, mean delta, first-round pass rate).
7. API: `/api/costs` (per workspace, task, role, model, version), `/api/runs/:id/events`
   (paged view of `events.jsonl`), `/api/prompts/:hash`. Minimal UI: costs panel,
   run event viewer.

### WP-C — Decision outcomes, review-issue history, pushback scoring (migration 16)

1. `decision_outcomes` (id, decision_id, outcome, label, evidence_json, source,
   created_at). Sources/outcomes written automatically when: a task ends verified
   / unverified / failed; an output is superseded; a scheduled `what_changed` diff
   contradicts or changes a finding; the user overrides/excludes or rejects an
   output (consume WP-A's `feedback_events` if present, else hook the routes —
   coordinate via a single `recordOutcome` function). Labels in the spirit of the
   reference: `weak-review`, `over-scoped`, `missed-evidence`, `stale`,
   `user-rejected`, `confirmed`.
2. Review-issue history: append-only `review_issues` (task_id, round, issue_id,
   class, text, status: open/fixed/pushed_back/upheld/withdrawn, reviewer_run_id,
   created_at, resolved_at). Stop overwriting history in `tasks.review_issues`
   (keep the column for latest-round compatibility). Stable issue ids across
   rounds where the reviewer repeats an issue.
3. Disputes: when a worker pushes back (`respond_to_review`), the next round's
   reviewer sees the pushback and must accept or reassert; cap reasserts
   (configurable, default 1). If the next round drops an issue the worker pushed
   back on, record a reviewer false-positive outcome; if upheld and later fixed,
   record a worker miss.
4. Make `pushback` ratable in the decision queue.
5. `outcomes` report: per role / task type / prompt version counts of each label.
   API route + minimal UI table.

### WP-D — Escalations, policy history, event persistence (migration 17)

1. Structured escalations: when a task ends `unverified` or `failed`, an
   `escalation` agent role (new prompt in `src/core/prompts/`) writes 0–3
   multiple-choice questions with one recommended option, stored as
   `user_requests` (kind `escalation`, options JSON). Answering re-runs the task
   with the answers in prior-attempt context. UI to answer.
2. Policy-violation history: record every action-policy event (approval requested,
   granted, denied, blocked attempt, e.g. agent tried a forbidden action or tool
   call rejected by role scope) in `policy_events`; feed the requesting role's
   recent denials into its prompt (like the reference `get_lessons` on block).
3. Event persistence: tool-call validation errors and other bus events currently
   only on SSE get an append-only `bus_events` table (with retention config) so
   they are queryable later.
4. Optional OTLP export of the event bus behind a config flag (no new heavy deps
   if avoidable; skip with a note if it needs one).

## Wave 2 (after wave 1 is merged)

### WP-E — Lessons engine and retro (migration 18)
Per role, per tree root lesson rules built from machine signals (review-issue
classes from `review_issues`, decision outcome labels, worker failures, policy
denials) and human signals (feedback events, ratings): add a rule when a category
recurs in ≥3 tasks, strengthen on continued recurrence, retire after 10 clean
tasks, revert if the rate did not drop for the new prompt version (use WP-B's
per-version metrics). Max 15 rules per role, each with a tracking marker. Rules are
proposals the user accepts; accepted rules append to the role's prompt (prompt
version changes accordingly). Scheduled weekly retro job via the existing
scheduler: digest decisions, outcomes, feedback, costs; a `retro` agent proposes
prompt/calibration edits as pending items with evidence.

### WP-F — Reviewer audit and experiments (migration 19)
Reviewer audit: re-review N recently verified tasks with a different configured
model/provider; store `reviewer_audits`; misses become reviewer lessons (WP-E) and
decision outcomes. Experiments: `experiment_id`/`arm` on runs and decisions; run
the same task under prompt/model A and B (lessons off during experiments); compare
review pass rate, rounds, ratings, cost per arm. API + minimal UI.

### WP-G — Metrics view (migration 20 if needed)
Metrics API + view: pass rate, rounds to pass, failures, cost, rating agreement,
outcome labels, over time and per role / task type / prompt version / model.
