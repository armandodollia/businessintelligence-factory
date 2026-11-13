# Business Intelligence Factory — Design

Date: 2026-11-12
Status: Draft for approval

## 1. Intent

A local, agent-driven strategy tool for senior business leaders. These users see **symptoms** (revenue down, churn up) and **strengths** (a product line growing) but rarely the causes. The tool:

1. Interviews the user about the business, how it makes money, what is going well and what is going badly — starting high-level, drilling toward causes over time.
2. Sends a team of agents onto the internet (through a dedicated, persistent research browser profile) to research direct competitors **and the user's own company with the same rigor**: walk their product flows, sign up, capture screenshots, archive articles, filings and documents, collect customer pain points and news.
3. Researches the business's target audiences and builds evidence-backed personas, compiled into persona agents (`agent.md`) that give simulated customer feedback on every recommendation.
4. Repeats research on a schedule and tracks what changed.
5. Produces a ranked list of where to point the company and what to build next, each item scored on multiple criteria and tied to evidence.
6. Logs every agent decision — what, why, alternatives, positive and negative signals — and lets the user rate every individual score, so prompts and flows improve over time (and, later, custom decision models can be trained on the data).

**Why:** the user wants this first for their own company, then as a sellable product for other companies' leaders. The decision/rating data is a core asset, not an afterthought.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**
- Run locally on the user's machine as a simple web app.
- Use the user's installed agent CLIs (Claude Code, Codex, OpenCode now; others via adapters) — no API keys required.
- Multi-workspace from day one (one workspace per business) so it can become a product.
- Orchestrator agent + workers + adversarial verification loop.
- Every finding backed by stored evidence (screenshots, archived copies, documents).
- Full decision log and per-criterion human rating.
- Recurring research jobs with change detection.
- Market research module: audience segments → persona profiles → persona agents → persona panel feedback on recommendations.
- Optional upload of internal company data (KPI exports, financials, decks) as evidence.

**Non-goals (v1)**
- Hosted / multi-tenant deployment, auth, billing.
- Training custom models (data is collected in a training-ready shape only).
- Polished UI design (UI is deliberately throwaway; behavior is not).
- Cloud browsers / per-customer browser extension.

**Anti-goals (failure even if it "works")**
- Findings or recommendations without evidence the user can open.
- Agent decisions that are not logged or not ratable.
- Agents silently expanding scope or chasing nits in review loops.
- Using the user's personal identity to create accounts on competitor sites.
- Irreversible real-world actions on third-party sites without user approval (§6.6).
- Simulated persona feedback presented or weighted as if it were real customer evidence.
- Core logic entangled with a specific CLI or with the UI markup.

## 3. Constraints

- macOS, Node 25 available; Claude Code 2.1.x, Codex 0.167.x, OpenCode 1.2.x installed.
- Browser access via a **separate, persistent research browser profile** — never the user's everyday profile. Backends (user's choice): a browser MCP plugin (e.g. Chrome DevTools / Playwright MCP with a dedicated `user-data-dir`; Claude-in-Chrome where the worker is Claude Code) or the T3 Code browser. Must be configurable per CLI.
- Agents run as headless CLI subprocesses (`claude -p --output-format stream-json`, `codex exec --json`, `opencode run`); each CLI differs in event format and MCP configuration.
- Concurrent browser use is limited (shared profile) — harness must ration tabs/sessions.
- **No usage/cost caps by default** (user decision). Optional per-workspace / per-pipeline token and cost caps can be configured (`budgets`, learning loop WP-B; §12). The harness always detects CLI rate-limit/usage-window errors and retries with back-off so runs don't fail.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Fixed pipeline run by the program | Predictable and resumable, but cannot adapt to unexpected discoveries |
| B | One lead CLI agent spawning its own sub-agents | Adaptive and fast to build, but sub-agent mechanics differ per CLI and are hard to bound, resume or log per decision |
| **C (chosen)** | **Orchestrator agent decides what and how many sub-agents to launch; the program executes, bounds and logs them; each result goes through an adversarial review loop** | Adaptive where it matters, CLI-agnostic, fully logged; more upfront work than A |

Chosen by the user: C, with the orchestrator being an agent and an explicit adversarial loop (§7).

## 5. Architecture

```
core/        engine — no UI, no HTTP
  workspace/   businesses, profile, interview state
  interview/   intake + drill-down logic
  harness/     CLI adapters, run supervisor, MCP tool server, decision log, budgets
  research/    orchestrator flow, task model, review loop, evidence store
  market/      audience segments, persona profiles, agent.md compiler, persona panel
  internal/    optional internal data uploads (parsing, evidence registration)
  scoring/     criteria, priority weights, rating ingestion
  scheduler/   recurring jobs, diffing between runs
  store/       SQLite + filesystem artifact store
api/         local HTTP + JSON, SSE for live run events. Only thing the UI talks to.
web/
  logic/       UI behavior: plain TS modules/hooks (state, actions, API calls, SSE)
  views/       React components + CSS — markup and styling only, replaceable
config/      bif.config.(json|ts): providers, models, roles, loop limits, budgets
```

**Stack (builder's call, stated):** TypeScript on Node, SQLite (e.g. better-sqlite3 or node:sqlite), Vite + React for `web/`. Data root per workspace: `data/<workspace>/{db, artifacts/}`.

**UI separation rule:** everything a view does goes through `web/logic/` — e.g. `useInterview()`, `useResearchRun(runId)`, `useEvidence(findingId)`, `rateCriterion(itemId, criterion, verdict, value?, reason?)`. A redesign replaces `web/views/` and CSS only.

## 6. Harness

### 6.1 CLI adapters
One adapter per CLI implementing:
- `spawn(task, model, mcpConfig, workdir) → RunHandle`
- normalize stream events → common `RunEvent` (message, tool_call, tool_result, error, usage, done)
- inject MCP servers (harness tools + browser MCP) using that CLI's config mechanism
- report token/cost usage where the CLI exposes it

Start with Claude Code and Codex; OpenCode third. Every raw event stream is persisted (`runs/<id>/events.jsonl`) regardless of what the agent logs.

**Usage, cost and timing (learning loop WP-B).** Every `usage` event is stored in `agent_usage` (run, role, provider/model, prompt version, attempt, uncached input / output / cache-read / cache-write tokens, `cost_usd` computed from the dated, editable price table `src/core/harness/pricing.json` with its `price_version`, and the CLI's own `cli_reported_cost_usd`; effective cost = computed, else CLI-reported). Agent runs record `attempts`, `failure_reason`, `round` and `task_type`; every attempt (first try and each rate-limit retry, with its back-off) is a row in `agent_run_attempts`; tasks and research runs record `failure_reason`. The full task prompt is saved as `runs/<id>/prompt.md` (`prompt.attemptN.md` for a retry), and every prompt version hash resolves to its text in `prompt_versions`. **Budgets** (optional): before starting a run past a workspace or pipeline cap, the supervisor raises a `user_request` to extend it (approve = one more cap) and waits; a denial refuses runs of that scope until the cap is raised in config.

### 6.2 Harness MCP server (tools every agent gets)
- `log_decision({ what, why, alternatives[], signals_positive[], signals_negative[], confidence })`
- `save_artifact({ kind: screenshot|page_snapshot|document|text, ... }) → artifactId`
  (knowledge store: also `description` — required for screenshots and images —, `entity` (filed on the capture; with
  a `flow` it adds a `has_flow` edge), `applies_to`;
  returns `{ artifactId, sha256, captureId, extraction }`; every save records a capture; see
  `2026-11-13-knowledge-store-design.md` §8.1)
- `describe_artifact({ artifact_id, description })` (knowledge store)
- `save_finding({ claim, subject, criteria{...}, evidence: artifactId[] })` — **rejected if `evidence` is empty or references unknown artifacts**
  (knowledge store: also `relation` (`new` / `{confirms}` / `{replaces}`; omitted → duplicate handshake against current
  facts of the same entity), `entity`, `relations`, `applies_to`, `evidence_refs` with verified quotes, `ttl_days`;
  returns `entityId` when a fact is saved; see `2026-11-13-knowledge-store-design.md` §7.2–7.4)
- `confirm_finding({ finding_id, evidence })`, `retract_finding({ finding_id, reason, evidence })` — evidence must include
  an artifact this task saved with `save_artifact`; applied when the task is verified (knowledge store)
- `propose_tasks([...])` — orchestrator only (§7)
- `submit_result({...})` — worker deliverable
- `submit_review({ score, issues[] })` — reviewer only
- `respond_to_review({ issueId, action: fix|pushback, reason })` — worker only
- `request_user_action({ kind: register|login|captcha|other, site, instructions })` — pauses the task until the user resolves it in the UI
- `get_identity({ site })` — disposable email + generic name for account creation
- `request_approval({ action, site, details })` — required before gated actions (§6.6); blocks until the user approves/denies
- `save_persona({ segment, profile{...}, evidence })` — market research workers only
- `submit_persona_feedback({ recommendationId, scores{...}, concerns[], reasoning, would_change_mind })` — persona panel runs only
- `submit_escalation({ questions: [{ question, options[2–4], recommended, why }] (0–3) })` — escalation role only (§7.4)

Tools are scoped by role: a run only sees the tools its role permits.

### 6.3 Decision log
Every `log_decision`, every review score, every pushback, every task proposal is a row: `{ id, run_id, workspace_id, role, model, provider, kind, payload, created_at }`, linked to the artifacts/findings it concerns. Human ratings attach to these rows (§9). Stored so it can be exported as training data (JSONL) later.

### 6.4 Browser
- A dedicated, persistent research profile (stays logged into accounts the agents created). Never the user's everyday profile.
- Browser backend is an interface with two implementations to evaluate early: (a) browser MCP plugin with the dedicated profile — works for Claude Code, Codex and OpenCode workers; (b) T3 Code browser. **Spike first:** confirm (b) is reachable from CLI subprocesses spawned by the harness; if not, (a) is the default and (b) is used only when the harness itself runs inside T3 Code.
- Harness enforces a configurable max concurrent browser-using runs (default 2) and tells agents to open their own tabs and close them.
- Screenshots captured by agents are stored via `save_artifact` with URL, timestamp, flow name, step index and a note.

### 6.5 Identities / accounts
- Accounts on third-party sites use disposable emails and generic names from an identity pool (per workspace, stored with credentials locally).
- If a site requires phone, payment, KYC or blocks disposable email → `request_user_action(register)`; the user registers manually, then resumes; the agent continues in that browser session.
- Disposable email provider: builder's choice behind an interface (e.g. a provider with an inbox API, or a catch-all domain the user owns).

### 6.6 Action policy on third-party sites
| Allowed | Requires user approval (`request_approval`) | Never |
|---|---|---|
| Browse; sign up with disposable identities; accept standard ToS for those signups; start free trials that need no card; walk checkout up to (not including) payment | Entering payment details (the user enters them personally; agents never see or store card data); requesting demos; contacting sales/support or anything that reaches a real person | Completing a purchase autonomously |

The policy lives in config and in every worker prompt; the reviewer checks walkthroughs against it.

**Policy history (learning loop WP-D, migration 17).** Every action-policy event is appended to
`policy_events` with the business-tree root it happened in: `approval_requested`,
`approval_granted`, `approval_denied`, and `blocked` (a tool call rejected by role scope, or an
approval request whose action matches a `never` item). The requesting role's last five denials in
the same tree (one short line each) are added to its task prompt (workers, synthesizers,
orchestrator); `listPolicyEvents` (`src/core/policy/policyEvents.ts`) is the query API for the
lessons engine.

## 7. Research flow and adversarial loop

### 7.1 Orchestrator
- An agent run (model configurable) that receives the workspace profile, interview summary, prior findings, and the stage goal.
- Decides **what tasks** and **how many** sub-agents, and which configured model each uses, via `propose_tasks`. Each task: `{ type, brief, subject, model, needs_browser, acceptance_criteria }`.
- The program validates proposals against config limits (max parallel workers, max tasks per run, allowed models, budget) and executes them. Rejections are reported back to the orchestrator.
- The orchestrator may run in phases (e.g. discover competitors → deep dives → synthesis) and propose follow-up tasks based on results.

Phases (each a fresh orchestrator run; all state in the DB so long tasks and user waits survive restarts — builder's call): **market research → competitor discovery → deep dives (competitors + own company) → synthesis → persona panel → scoring**. Started by the user or the scheduler.

Task types (initial): `audience_segments`, `persona_profile`, `discover_competitors`, `flow_walkthrough` (signup, onboarding, pricing, checkout, core flow), `news_scan`, `public_filings`, `customer_pain_points` (reviews, forums, social), `own_company_audit` (same task types applied to the user's company), `symptom_hypotheses` (link interview symptoms to findings), `synthesize_recommendations`, `persona_panel` (one run per persona per recommendation batch).

### 7.2 Review loop (per worker task)
```
round = 1
worker completes task → submit_result
loop:
  spawn a NEW adversarial reviewer (fresh run, minimal context)
  reviewer → submit_review(score 0–10, issues[])
  if score ≥ pass_threshold (default 8): task = verified; stop
  if round == max_rounds (default 3): task = unverified; stop
  worker receives issues → for each: fix or pushback(reason) → resubmit
  round += 1
```
- **Minimal reviewer context:** only the task brief, acceptance criteria, the worker's current deliverable, and the referenced evidence artifacts. Not the worker's transcript, reasoning, other tasks, or prior review rounds — except the issues the worker pushed back on (issue + the worker's reason), see disputes below.
- **Review-issue history (learning loop WP-C):** every round's issues are appended to `review_issues` (`tasks.review_issues` keeps the latest round for the revise step). Issue ids are stable across rounds: a repeated issue keeps its id (the reviewer reuses the id of a disputed issue it was shown, or the text nearly matches). Status: `open | fixed | pushed_back | upheld | withdrawn`.
- **Disputes (learning loop WP-C):** the next round's reviewer sees each pushed-back issue with the worker's reason and must accept it (drop it → `withdrawn`, a reviewer-false-positive outcome) or reassert it (repeat it → `upheld`). An issue is put to the reviewer at most `loop.maxReasserts` times (default 1); after that the revise prompt tells the worker to fix it. Fixing an upheld issue records a worker-miss outcome.
- **Issue classification:** reviewer labels each issue `blocking | substantive | nit | scope_expansion`. Workers are instructed to push back (with reason) on `nit` and `scope_expansion`; pushback is logged as a decision. Reviewers are instructed not to fail work for nits or for not doing out-of-scope work.
- Reviewer model is configurable; default to a different provider than the worker where available (builder's call — reduces shared blind spots).
- **Unverified** results are kept, flagged in the UI with the last reviewer's objections, and excluded from recommendation synthesis unless the user overrides.
- `max_rounds` and `pass_threshold` are configurable globally and per task type.

### 7.4 Structured escalations (learning loop WP-D)
When a task ends `unverified` or `failed`, an `escalation` agent run (prompt `escalation.md`, model
`escalation.model`, default `roles.orchestrator`) gets the brief, criteria, outcome, last review
issues, run failures and deliverable, and calls `submit_escalation` with 0–3 multiple-choice
questions, each with 2–4 options and one recommended option. Each question is a `user_request` of
kind `escalation` (`options_json`); the task keeps its final status. When every question of the
escalation is answered (`POST /api/requests/:id/escalation-answer { choice, note? }`; dismiss =
deny) and at least one is not dismissed, the task re-runs through the review loop with a fresh
round budget — as a revision when the last review raised issues, else as new work — and its prompt
carries the previous outcome, the previous run's tool calls (prior-attempt summary) and the answers.
At most `escalation.maxPerTask` (default 2) escalations per task.

### 7.3 Evidence rule
Every finding references ≥1 stored artifact. Flow walkthroughs store an ordered screenshot per step. Articles are archived as full page snapshot + extracted text + source URL + retrieval time. Documents (PDF filings, reports) stored as original files. Recommendations reference findings; the UI can traverse recommendation → findings → artifacts.

## 8. Interview

- Chat-style, resumable, run by an agent (model configurable) with a structured target: business basics (sector, model, customers, revenue streams, size, geography), **what's going well**, **what's going badly**.
- Symptoms and strengths are captured as structured items, each high-level first (`"enterprise renewals down"`), with severity/trend/confidence criteria (ratable).
- Drill-down is offered, not forced: later sessions (and research findings) generate hypotheses per symptom; the interviewer asks targeted follow-ups.
- Output: workspace profile + list of symptoms and strengths, feeding the orchestrator.

## 8a. Internal data (optional)

- Users may upload internal material (KPI/CSV exports, financials, decks, PDFs). Entirely optional; the interview remains sufficient on its own.
- Uploads are stored locally as artifacts and can be cited as evidence for symptoms, strengths and findings (e.g. "renewals down 12% QoQ" backed by the export).
- Uploads are passed to agents only when relevant to a task; excluded from the training export unless the user opts in (builder's call).

## 8b. Market research and personas

1. **Audience research:** `audience_segments` workers identify target segments from the interview, competitor positioning/marketing, reviews, forums, social, industry/census reports and analyst coverage. Every claim cites evidence; output goes through the adversarial loop.
2. **Persona profile** per segment: demographics & socioeconomic status (income, education, role/seniority, location, household); personality & values; goals, needs, pain points; jobs-to-be-done; buying behavior (decision maker, budget, price sensitivity, purchase triggers, objections); channels & media; current alternatives & switching costs; tech attitude; voice (vocabulary/phrases taken from real reviews); estimated segment size & value to the business. Each field has evidence links and a confidence score; all are ratable.
3. **Compile to `agent.md`:** `data/<workspace>/personas/<persona>.md` — a system prompt that speaks as the persona, grounded in the profile and evidence, instructed to stay in character and not be agreeable. Loadable by any configured CLI. Regenerated (and versioned) when the profile changes.
4. **Persona panel:** every recommendation is put to each persona independently. Each returns appeal, likelihood to adopt, willingness to pay, perceived friction (1–5), top concerns, reasoning, and what would change its mind. Results attach to the recommendation with a panel summary highlighting segment disagreement.
5. **Labeling rule (builder's call, user did not object):** persona feedback is shown as **simulated**, in its own column beside evidence-backed scores, and does **not** affect priority by default; the user can give it a weight.

## 8c. Scope (whole company or a slice)

- A workspace has a **scope**: `company | division | slice` (e.g. a product line, region, team, or internal platform), with name + description, optionally linked to a parent company workspace whose profile and evidence it inherits read-only.
- A scope declares its **audiences**: `external` (customers), `internal` (employees/internal users), or both. All interview questions, research tasks and recommendations are framed to the scope.
- Personas carry `audience: external | internal`. Internal personas are researched from job postings/role descriptions, employee-review sites, industry surveys of the role, the interview, and internal uploads (weighted highest).
- For internal scopes, "competitors" means **alternatives**: vendor tools, outsourcing, and how peer companies run the same function. Competitor discovery and deep dives cover those.
- **Recursive business map:** workspaces form a tree of arbitrary depth (company → divisions → products → teams/internal platforms). Each node is a full workspace (scope, audiences, interview, research, personas, recommendations).
  - **Shared reading across the tree:** a node may read and cite profile, findings and artifacts of **any node in the same tree** (ancestors, siblings, cousins, descendants), always tagged with the source node. Orchestrator context includes ancestors' and siblings' profiles + finding titles; other nodes are reachable on demand. Nodes in different trees (different businesses) are never shared.
  - **Roll-up:** a node's views include descendants' symptoms, strengths and recommendations, tagged by source node; patterns recurring across ≥2 children are flagged as possible company-wide issues.
  - **Mapping step:** task type `map_business_units` (phase `mapping`, optional, runs before market research) proposes child nodes from interview, uploads and research (site, filings, org signals), each with name, description, audiences, evidence and reasoning (logged, ratable). The user accepts/edits/rejects each; accepted children can be mapped again.
  - Each node runs its pipeline independently; the user picks where to drill.

## 9. Scoring and rating

Criteria agents assign (each with reasoning + evidence links):

| On | Criteria |
|---|---|
| Symptom / strength | severity (or strength) 1–5, trend ↑/→/↓, cause confidence % |
| Competitor | threat 1–5, directness 1–5, per-area comparison vs. user (pricing, onboarding, UX, features) 1–5 |
| Finding | relevance 1–5, evidence reliability 1–5, novelty 1–5 |
| Recommendation | upside, difficulty, cost (range), time-to-value, risk, confidence, strategic fit, competitive urgency; **priority** = weighted combination |
| Persona profile | per-field confidence; segment size & value |
| Persona feedback | appeal, adoption likelihood, willingness to pay, friction (simulated; weight 0 by default) |

**Rating:** every criterion value on every item is individually ratable: agree, or disagree with the user's own value + optional reason. Both values are stored. Priority weights are user-adjustable and are themselves logged. Ratings are possible inline on each item and via a batch **review queue**. The reviewer agent's scores, the worker's pushbacks and the user's ratings are all signals in the decision log. Worker pushbacks are ratable decisions (criterion `pushback`, 0–1 fraction; the agent's value is 1, "needs no change").

## 10. Learning loop (v1)

- No model training in v1.
- A "calibration" job (manual trigger) summarizes rating disagreements per role/criterion/task type and proposes prompt changes (few-shot examples from corrected items, rubric clarifications). The user approves changes; prompts are versioned, and every run records the prompt version it used so improvements can be measured.
- Calibration appendices are versioned (WP-B): every approved patch, import and revert is a row in `calibration_versions` (per business tree root and role, with actor and the approval Decision); the live text stays in `calibration/<role>.md`, and any earlier version can be restored. Approve and revert each have one path (`applyPromptPatchAsUser` / `revertCalibrationAsUser`, `src/core/feedback/actions.ts`) that writes the version row, an `apply_prompt_patch` / `revert_calibration` Decision by the acting user (`agentRunId` = `config.user.id`, never a `user` pseudo id) at the role's resulting prompt version, and a `prompt_patch_apply` / `prompt_patch_revert` feedback event. Both prompt versions (before and after) are stored in `prompt_versions`, so every hash resolves.
- Per-prompt-version metrics (WP-B): rating agreement, mean delta, review pass rate, first-round pass rate, rounds and cost grouped by the prompt version of the run that produced the work, ordered by first use (trend).
- Priority weights can be refit from the user's ratings (simple regression), proposed to the user, not auto-applied.
- Export: decision log + ratings as JSONL for later model training.
- Feedback provenance (learning-loop parity WP-A, migration 14): every human input records who
  (`config.user.id`), when and why; ratings record the agent run and prompt version they judged; an
  append-only `feedback_events` log (`src/core/feedback/events.ts`) records include overrides,
  profile edits, unit proposal accept / edit / reject (the agent's original kept on edit), symptom
  hypothesis corrections, request and escalation answers, weight changes, prompt patch approvals and
  calibration reverts, before → after.
  Calibration counts exclusions as disagreements, inclusions of unverified outputs as agreements and
  unit proposal decisions on a 0–1 scale; items revised after a rating are re-queued for review. The
  export adds request answers, interview turns (linked to the interviewer run), feedback events and
  final review status, all under the upload exclusion.
- **Decision outcomes (learning loop WP-C):** `decision_outcomes` labels agent decisions — or a non-decision subject such as a fact version — after the fact, all through one writer (`recordOutcome(store, RecordOutcomeInput)`, `src/core/learning/outcomes.ts`): task end (`confirmed`; unverified → `over-scoped` / `missed-evidence` / `weak-review`; `run-failed`), superseded outputs (`missed-evidence`), scheduled "what changed" (`stale`: claim no longer found for a re-researched subject, or a cited screenshot changed; one isolated hook, `src/core/learning/whatChangedOutcomes.ts`, which the knowledge store replaces with fact lineage), user include overrides on findings / recommendations / personas / competitors / hypotheses and unit-proposal rejects (`user-rejected`, plus `weak-review` on the passing review when a verified output is excluded; `confirmed` when an unverified output is included) and review disputes (`reviewer-false-positive`, `worker-miss`); `changed` and `retracted` are reserved for fact lineage. User outcomes come from one place: an `onFeedback` listener registered at boot (`src/core/learning/feedbackOutcomes.ts`) maps `include_override` / `proposal_reject` feedback events to outcomes, keyed by the feedback event, so each action writes its outcome once. A row has `decision_id` and/or `subject_type` + `subject_id` (CHECK: one is set), `run_id` when known, and `source_key`: rows are unique per (subject — else decision —, outcome, source key) — e.g. a fact observation id, or for `stale` the caller's `<factId>|stale|<lastConfirmedAt>`. Each row copies the judged decision's role, prompt version and task type; the outcomes report (`GET /api/workspaces/:id/outcomes`, Decision log table) counts labels per role / task type / prompt version, per workspace or per business tree.

## 11. Scheduler

- Recurring jobs per workspace (e.g. weekly competitor flow re-walk, daily news scan), configured in the UI and stored in SQLite; run by the local server process while it is running (missed runs execute on next start).
- Each run is diffed against the previous run of the same job (new findings, changed screenshots/flows, changed pricing) and surfaced as "What changed".

## 12. Configuration

`bif.config` defines:
- **providers**: installed CLIs and how to call them
- **models**: allowed models per provider
- **roles**: default model for orchestrator, interviewer, each worker task type, reviewer, synthesizer
- **loop**: `max_rounds` (3), `pass_threshold` (8), per-task-type overrides, `maxReasserts` (1; review disputes)
- **limits**: max parallel workers, max concurrent browser runs, max tasks per run
- **budgets** (optional): `workspace` / `pipeline` caps (`maxTokens`, `maxCostUsd`); absent = no caps
- **browser** backend (MCP plugin with dedicated profile | T3 Code browser), identity/disposable-email provider
- **action policy** (§6.6)
- **persona weight** in priority (default 0)
- **escalation** (optional): enabled, model, max questions (≤ 3), max escalations per task (§7.4)
- **telemetry** (optional): `bus_events` retention in days; OTLP/HTTP JSON log export of the event
  bus (off by default; metadata only — ids, types, statuses, harness error text — never agent or
  user free text, so upload-derived text cannot leave through it)
- **knowledge** (optional, every field defaulted): response budgets per kind (search / card /
  expand / briefing) with per-role overrides and per-provider scale, `hardMaxTokens`, freshness
  TTLs, extraction and chunking limits, caption rule, duplicate-handshake settings, prune minimum
  age (knowledge store design §16; read through `knowledgeSettings`)

Editable in a simple settings page and as a file.

**Event persistence (WP-D).** Bus events that are not stored elsewhere (`tool_call` incl.
validation errors, `run_status`, `task_status`, and `user_request(_resolved)` as ids/kind/status)
are appended to `bus_events` (identity secrets redacted) and pruned after
`telemetry.busEventRetentionDays`; `run_event` stays in `events.jsonl` (its `usage` events in
`agent_usage`) and `decision` in `decisions`; review issues and outcomes are never copied onto the bus
rows (references only).

## 13. Web app (v1, minimal)

Pages: **Business map** (workspace tree, mapping proposals, roll-up and cross-cutting issues) · **Workspaces** · **Interview** (+ optional uploads) · **Audience & Personas** · **Research** (live runs: orchestrator plan, task tree, review rounds/scores, pending user actions and approvals) · **Findings & Evidence** (screenshot flows, archived articles, documents) · **Strategy** (ranked recommendations with per-criterion rating) · **Review queue** · **Decision log** · **Schedule** · **Usage & prompts** (costs and budgets per role / model / prompt version / task, prompt-version trend with prompt text, calibration history with revert, agent runs with a paged event viewer) · **Settings**.

## 14. Left to the builder

- Exact SQLite schema and migrations.
- Choice of browser MCP server and how it's injected per CLI.
- Disposable email provider.
- Page-snapshot format (MHTML/single-file HTML/PDF) and text extraction library.
- Prompt wording for each role (versioned files under `core/prompts/`).
- Build order — suggested: browser backend spike → harness + one adapter → evidence store + tools → review loop → orchestrator → interview (+ uploads) → market research & personas → scoring/rating + persona panel → UI → scheduler → second/third adapters.
