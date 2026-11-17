# Real-CLI smoke results

Run on 2026-11-12 with `BIF_SMOKE_TIMEOUT_MS=240000 npx tsx scripts/smoke.ts` (macOS, Node 25).
CLI versions: claude 2.1.322, codex-cli 0.167.2, opencode 1.2.27.

The script boots the real server (temporary data dir and config, free port on 127.0.0.1) and:

- **worker smoke**: per provider, one real worker run through the Supervisor. The agent must call
  `log_decision` and then `submit_result` through the real MCP endpoint (`/mcp/<token>`). PASS needs
  run status `done`, a `log_decision` Decision for that run, and the submitted result `{"smoke":"ok"}`.
- **interview smoke**: a second server; `POST /api/workspaces`, then one `POST .../interview`
  message with the real claude CLI as interviewer, then `GET .../interview` must show the user turn
  plus exactly one stored agent turn.

## Final state (KS-8, `feat/learning-loop`, 2026-11-13)

Last real-CLI run on the final branch (knowledge-store KS-0…KS-8 and learning-loop wave 2 merged):
`BIF_SMOKE_TIMEOUT_MS=400000 npx tsx scripts/smoke.ts knowledge claude codex` (claude 2.1.322,
codex-cli 0.167.2).

| Check | Result | Detail |
|---|---|---|
| knowledge/codex (gpt-6.1-sol) | **PASS**, 7 of 7 steps | 72.7 s, 16 bif tool calls, 9 `retrieval_events`, `promptStoreGaps` `[]`, $0.1749; step 6 at `max_tokens` 250: 6 pages, header on 1, 1 piece cut, 0 placeholders, 8 of 8 passages whole, 0 characters never served; step 7: quote rejected once, then saved "Enterprise plan has custom pricing" |
| knowledge/claude (haiku) | **PASS**, steps 1–6; step 7 **not exercised** | 23.6 s, 15 calls, 10 `retrieval_events`, `promptStoreGaps` `[]`, $0.0140; step 6 identical to codex (8 of 8 whole, 0 characters never served). Step 7 (rejected quote, then recovery) was not exercised, not failed: haiku read the page first and saved the true Enterprise claim directly, without trying the colleague's quote, so the harness had no quote to reject. That is the same agent choice recorded under "Found and fixed while re-running" below. The script's own line for this run says FAIL because it requires a rejection; read it as "not exercised". |
| worker / browser / interview (claude, codex) | PASS on 2026-11-12 (below) | not re-run at KS-8: those paths did not change |
| opencode | not run | free tier 429, Copilot models 404 (below) |

Status per area:

- Knowledge read tools, duplicate handshake, verified quotes, position paging and the cursor check
  value hold with both real CLIs. The `relation` field also accepts a JSON-encoded value.
- The full chain (interview → two scheduled runs → what changed → synthesis → export, with the
  briefing reads, outcomes, lesson signals and metrics) is covered with the fake adapter by
  `test/core/knowledge/endToEnd.test.ts`. It is not part of the real-CLI smoke.
- Measurements (prompt tokens, `search` latency at 10,000 chunks, store size):
  `docs/superpowers/verify-log.md`.

## Flow records and ranking smoke (`feat/flows`, 2026-11-14)

Run on 2026-11-14 with `BIF_SMOKE_TIMEOUT_MS=300000 npm run smoke -- flows claude` and
`BIF_SMOKE_TIMEOUT_MS=400000 npm run smoke -- flows codex` (macOS, Node 25; claude 2.1.322, codex-cli
0.167.2). One run per provider.

Per provider the script boots the real server and runs two parts:

- **Worker.** It seeds a workspace, a competitor ("Pinecrest Tasks", fictional), a research run, a
  `flow_walkthrough` task and three text notes captured by that task, one per screen of the sign-up.
  One real worker runs with the real `flow_walkthrough` system prompt and no browser. It must call
  `read_flow_catalog`, read the notes with `read_artifact`, save the flow with `save_flow` (one step
  per screen, each citing its note), answer at least three checks with `save_flow_checks` and
  `submit_result` the flow id.
- **Persona.** It seeds a second workspace with its own company and the same competitor, a verified
  sign-up flow of each and one verified persona, then runs the real ranking round (`runFlowRanking`)
  with that provider as the persona (`flows.model`), one broad sitting and no focused follow-up.

Both parts are judged from the store: the flow, its steps and walkthrough answers; the persona's
verdict row (pair, persona, stage, reason) and the ranking it produces.

| Check | Result | Detail |
|---|---|---|
| flows/claude (haiku) | **PASS**, 6 of 6 steps | 22.2 s, 11 bif tool calls, $0.0153, `promptStoreGaps` `[]`; flow saved as `sign_up`, primary, 3 steps each citing its note; 7 walkthrough answers (the three required ones `pass`), no refused call; the persona preferred the competitor (strength 3, confidence 0.9) with a reason about the own company's five fields and sales call |
| flows/codex (gpt-6.1-sol) | **PASS**, 6 of 6 steps | 49.9 s, 12 bif tool calls, $0.1197, `promptStoreGaps` `[]`; same flow shape (`read_flow_catalog` called twice); 10 walkthrough answers, no refused call; the persona preferred the competitor (strength 3, confidence 0.97) |
| flows/opencode | not run | not attempted in this run: OpenCode's free tier answered 429 at its last probe (2026-11-13, below) and no paid plan is used |

No agent confusion was flagged: no failed tool call, no new artifact saved, no repeated call.

## Persona learning smoke (`feat/persona-learning`, 2026-11-15)

Run on 2026-11-15 with `BIF_SMOKE_TIMEOUT_MS=300000 npm run smoke -- persona-learning claude` (macOS,
Node 25; claude 2.1.322). One run, claude only (the cheapest model, haiku). Codex and OpenCode were
not run.

How to run it: `npm run smoke -- persona-learning [providers]` (default `claude`; the mode runs only
when named, not as part of the default `all`). The script boots the real server and, per provider,
seeds a workspace with its own company and three fictional competitors, a verified sign-up flow of
each (2, 3, 5 and 7 fields asked), one verified persona and six of its verdicts on the six pairs (the
shorter form always wins). The user's reactions: one agree, five disagree, each with a reason about
the yearly cost mattering more than a short form. It then runs the real retro (`runRetro`) with that
provider as the persona learning model and the retro model. Judged from the store:

- **L1** exactly one learning run for the persona, `proposed` or `no_change`, its agent run `done`;
- **L2** exactly one successful `submit_persona_learning` call, its Decision, and a non-empty
  assumption;
- **L3** the stored proposals: at most 3, pending, of that run, evidence only among the signals the
  run was shown, an add or replace with at least 3 evidence ids and at most 400 characters of text;
- **L4** the persona unchanged (version 1, no adjustment) until the user decides.

| Check | Result | Detail |
|---|---|---|
| persona-learning/claude (haiku) | **PASS**, 4 of 4 steps | 24.5 s, 2 bif tool calls (`submit_persona_learning` and the lessons retro's `submit_retro`), $0.0113, `promptStoreGaps` `[]`; gate n=6, 5 disagree, 6 items, 6 signals shown; retro digest `personasEvaluated` 1, `personasQualified` 1, `personaLearningRuns` 1, `personaProposals` 2; run `proposed` |
| persona-learning/codex, opencode | not run | not attempted |

The assumption it stated: "The persona treats a short sign-up form as the mark of a good flow, when
this segment judges a sign-up mainly by how clearly it shows the total yearly cost before
commitment, and it does not mind a lo…" (cut by the script's log). Its two proposals, each citing 3
reactions:

- add (buying_behavior): "You judge a sign-up by how clearly it states the total yearly cost before
  you commit, and you give a plan extra credit when it makes the yearly option visible u…" (cut by
  the script's log);
- add (pain_points): "You do not count extra form fields against a sign-up when the yearly price is
  clear; hidden charges and surprises on the invoice are what put you off."

No refused call, no failed tool call.

## Stakeholder personas smoke (`feat/stakeholders`, 2026-11-15)

Run three times on 2026-11-15 (once before the final fixes, twice after) with `BIF_SMOKE_TIMEOUT_MS=300000 npm run smoke -- stakeholders claude`
(macOS, Node 25.8.1; claude 2.1.322). Claude only, on the cheapest model (haiku). Codex and OpenCode
were not run as workers (Codex refuses offline runs by design).

How to run it: `npm run smoke -- stakeholders [providers]` (default `claude`; the mode runs only when
named). The script boots the real server and, per provider, seeds a node of a fictional freight
company with three internal notes (uploads: org notes on the CFO, the billing platform team, board
minutes), runs one `own_stakeholders` task through the real review loop (worker and reviewer
offline, no browser), then the phase-end step that creates the question round (`ensureQuestions`).
Judged from the store and each run's files:

- **S1** every run of the task offline: no tool call in `events.jsonl` outside the harness tools, and
  for a Claude run the tools its CLI offered (the `system/init` line of `stdout.log`) are all
  `mcp__bif__*`; a run on a provider that cannot run offline must be refused before it starts;
- **S2** at least one own stakeholder, all hidden, at most `maxOwn`, each citing the seeded notes;
- **S3** four open template questions per hidden stakeholder (text = template + label) and the two
  node questions;
- **S4** the task's research withheld while the stakeholders are hidden.

| Check | Result | Detail |
|---|---|---|
| stakeholders/claude (haiku), run 1 (before the final fixes) | **FAIL** as printed (S1); S2–S4 PASS | 52.5 s, $0.0163; reviewer routed to Codex and refused three times; task `unverified` |
| stakeholders/claude (haiku), run 2 (after the final fixes, default providers) | **PASS** S1–S4 | 138.4 s, 48 bif tool calls, $0.0378, `promptStoreGaps` `[]`; task `unverified` after 3 rounds |
| stakeholders/claude (haiku), run 3 (same build, files kept) | **PASS** S1–S4 | 81.5 s, 26 bif tool calls, $0.0212, `promptStoreGaps` `[]`; task `verified` in round 2 |
| stakeholders/codex, opencode | not run | not attempted |

What happened:

- **Run 1** found the defect the final fixes closed: with every provider enabled the reviewer was
  moved to Codex, which cannot run offline, so each review was refused before it started and the
  task ended `unverified`. Its S1 printed FAIL because the check judged the refused Codex runs by the
  Claude rule.
- **Runs 2 and 3 (after the fixes).** Providers are enabled as on a default install. Worker and
  reviewer both ran on claude/haiku, offline: each worker run's CLI offered 28 tools and each
  reviewer run's 5, all `mcp__bif__*`, with no built-in tool offered or called. No run was refused
  and every prompt version was stored.
- **S2:** three hidden own stakeholders, each citing the notes: Chief financial officer (leader),
  Board of directors (board), Billing platform team (team).
- **S3:** 14 questions: four per stakeholder, all equal to their template with the label, and the two
  node questions.
- **S4:** the task was withheld.
- **Review outcome differs between the two runs.** In run 2 the haiku reviewer still had open issues
  after three rounds, so the task and its stakeholders ended `unverified`. In run 3 the reviewer
  raised two substantive issues in round 1 (a "sole approver" claim and a 5% threshold the notes do
  not support), the worker fixed them, and the task was `verified` in round 2 with nits left open.
  Both are the review loop working as built; the difference is the model's variance on haiku.

### 2026-11-15: own-stakeholder research may use the web (`fix/own-stakeholders-web`)

After the user's ruling that own-stakeholder research may use the web, S1 changed: the worker run must
not be offline (a Claude worker's CLI was offered built-in tools; no run refused as offline). Browsing
is not required. S2–S4 are unchanged. Run once with
`BIF_SMOKE_TIMEOUT_MS=300000 npm run smoke -- stakeholders claude` (macOS, Node 25.8.1; claude 2.1.322,
codex-cli 0.167.2). Providers as on a default install, so the reviewer went to Codex. Printed:

```
[smoke] stakeholders claude (haiku) …
[smoke] PASS stakeholders/claude (haiku) 44.0s — task=verified; runs=worker:done,reviewer:done; promptStoreGaps=[]
[smoke]   tool calls=15; usage in=13949 out=6567 cost=$0.0669 (rows 2)
[smoke]   PASS S1 not offline: the worker was offered built-in tools (calls 0): worker claude/haiku done: offered=57 (29 built-in) built-in calls=1 (ToolSearch); reviewer codex/gpt-6.1-sol done: offered=unknown built-in calls=0
[smoke]   PASS S2 hidden own stakeholders (calls 3): task verified (round 1); own=3 hidden=3: Chief financial officer (leader, verified, cites notes=true); Board of directors (board, verified, cites notes=true); Billing platform team (team, verified, cites notes=true)
[smoke]   PASS S3 question round (calls 0): created=14; per stakeholder Chief financial officer=4, Board of directors=4, Billing platform team=4; node questions=2; texts are the templates=true
[smoke]   PASS S4 research withheld while hidden (calls 0): task withheld=true
[smoke]   confusion: read_workspace failed: invalid input for read_workspace: workspace_id: Invalid input: expected string, received undefined
```

The worker did not browse (its one built-in call was `ToolSearch`). The Codex reviewer ran and
verified the task in round 1. One `read_workspace` call without `workspace_id` was refused and the worker
went on.

## User persona smoke (`feat/user-persona`, 2026-11-15)

Run once on 2026-11-15 with `BIF_SMOKE_TIMEOUT_MS=300000 npm run smoke -- user-persona claude` (macOS,
Node 25.8.1; claude 2.1.322). Claude only, on the cheapest model (haiku). Codex and OpenCode were not
run.

How to run it: `npm run smoke -- user-persona [providers]` (default `claude`; the mode runs only when
named). The script boots the real server (providers enabled as in the default config, plus those
named, as in the stakeholders mode) and, per provider, seeds a node of a fictional tile company with
six fictional verified competitors. The configured person then takes twelve actions through the real
action functions: each competitor left out with a reason about thin or single-source evidence, and its
threat rated down from 4 to 2. It then runs the real retro (`runRetro`) with that provider as the
learning model and the retro model. Judged from the store and the run's files:

- **U1** exactly one learning run for the person's user persona, `proposed` or `no_change`, its agent
  run `done` in the `retro` role, and `userLearningRuns` 1 in the retro digest;
- **U2** the run offline: no tool call in `events.jsonl` outside the harness tools, and for a Claude
  run the tools its CLI offered (the `system/init` line of `stdout.log`) all `mcp__bif__*`;
- **U3** exactly one successful `submit_persona_learning` call, its Decision for the user persona,
  and a non-empty assumption;
- **U4** the stored proposals: at most 3, pending, of that run, an add with one of the user topics,
  evidence only among the actions the run was shown, an add or replace with at least 3 evidence ids
  on at least 2 different things and at most 400 characters, and no identifier of the person;
- **U5** no line and no brief (persona version 1, no adjustment) until the user decides.

| Check | Result | Detail |
|---|---|---|
| user-persona/claude (haiku) | **PASS**, 5 of 5 steps | 19.7 s, 2 bif tool calls (`submit_persona_learning` and the lessons retro's `submit_retro`), $0.0092, `promptStoreGaps` `[]`; gate n=12 on 6 things, 12 actions shown; retro `done`, digest `userInteractions` 12, `userLearningRuns` 1, `userProposals` 2; run `proposed` |
| user-persona/codex, opencode | not run | not attempted |

U2: the learning run's CLI offered 3 tools, none built in, and called only `submit_persona_learning`.

The assumption it stated: "The person you work for treats competitor claims as unproven until several
independent, dated sources back them. The tool tends to rate threats and include competitors on
single-source evidence, which…" (cut by the script's log). Its two proposals:

- add (evidence_standards), citing 9 actions: "Does not count a competitor as included or a threat on
  the strength of a single source; requires several independent, dated sources before a competitor
  claim is…" (cut by the script's log);
- add (risk_appetite), citing 6 actions: "Prefers under-calling a competitor's threat level to
  over-calling it when the support is thin, and expects threat ratings to be lowered to match the
  strength of…" (cut by the script's log).

No refused call, no failed tool call.

## Results (2026-11-12)

| Check | Result | Time | Detail |
|---|---|---|---|
| worker/claude (haiku) | PASS | 5.0s | status=done exit=0 attempts=1; log_decision=yes submit_result={"smoke":"ok","provider":"claude"} |
| worker/codex (gpt-6.1-sol) | PASS | 14.2s | status=done exit=0 attempts=1; log_decision=yes submit_result={"smoke":"ok","provider":"codex"} |
| worker/opencode (opencode/big-pickle) | **FAIL** | 240.0s | status=failed exit=143 attempts=1; log_decision=no submit_result=none; reason=aborted (smoke timeout) |
| interview/claude (haiku) via HTTP | PASS | 5.7s | POST interview=200; turns=2 (agent 1); coverage basics=true, customers=true; the agent called `update_profile` and replied with a follow-up question about the revenue model |

## Final review group A re-run (shared browser, CLI isolation, bearer token)

Run on 2026-11-12 after the group A fixes, same machine and CLI versions:
`npx tsx scripts/smoke.ts worker claude codex`, `... browser claude`, `... browser codex`,
`... interview`. OpenCode was not re-run (see below).

- **browser smoke**: boots the real server with the default shared browser (pinned
  `@playwright/mcp@0.0.85`, `--shared-browser-context` on the research profile, `--headless` added by
  the smoke). One browser worker run must open its own tab, go to `https://example.com`, take a
  screenshot, `save_artifact` the file (via `file_path`, which is now restricted to the run cwd / OS
  temp dir), close its tab and `submit_result` the artifact id. PASS needs status `done`, the artifact
  stored as a PNG in that workspace, and browser tool calls in the run's events.
- **codex isolation**: `codex mcp list --json` with the exact env (`CODEX_HOME=<data>/cli-state/codex-home`,
  `BIF_MCP_TOKEN`) and `-c` overrides the adapter builds for a run. Without isolation the same command
  on this machine lists 8 servers (user config and plugins: claude-code, code-review, codex_app,
  computer-use, cua_repl, node_repl, context7, exa); with it, only `bif`. The codex worker run itself
  passed with that isolated home (auth via the symlinked `auth.json`) and with the run token sent as a
  bearer header from the environment (not in argv).

| Check | Result | Time | Detail |
|---|---|---|---|
| worker/claude (haiku) | PASS | 4.3s | status=done exit=0 attempts=1; log_decision=yes submit_result={"smoke":"ok","provider":"claude"} |
| worker/codex (gpt-6.1-sol) | PASS | 16.5s | status=done exit=0 attempts=1; log_decision=yes submit_result={"smoke":"ok","provider":"codex"} |
| codex isolation (mcp servers a run loads) | PASS | 0.1s | servers=["bif"] |
| browser/claude (haiku) shared Playwright MCP | PASS | 10.1s | status=done exit=0 attempts=1; artifact image/png png=true; browser tool calls=4 [browser_tabs, browser_navigate, browser_take_screenshot] |
| browser/codex (gpt-6.1-sol) shared Playwright MCP | PASS | 22.5s | status=done exit=0 attempts=1; artifact image/png png=true; browser tool calls=4 [browser_tabs, browser_navigate, browser_take_screenshot] |
| interview/claude (haiku) via HTTP | PASS | 5.8s | POST interview=200; turns=2 (agent 1) |

Shared-browser tab isolation was also checked by hand without a model: two MCP clients on one shared
server; client B opened a tab and navigated it, and client A's current tab stayed on its own page
(Playwright MCP keeps the current tab per client session). No browser processes were left after
the server stopped.

## KS-8 knowledge-store smoke

Run on 2026-11-13 with `BIF_SMOKE_TIMEOUT_MS=400000 npx tsx scripts/smoke.ts knowledge claude codex`
(macOS, Node 25; claude 2.1.322, codex-cli 0.167.2, opencode 1.2.27).

Per provider the script seeds a workspace, a research run, an earlier **verified** task with one
current fact ("Northwind Widgets Team plan costs $49 per user per month.") and the run's own task,
writes a local static HTML pricing page of a fictional vendor to the temp dir, and runs one real
worker with the **real worker system prompt** (`workerSystemPrompt`, `worker.md` + policy) and a
task prompt with 7 steps: save the page (`save_artifact` with `file_path`, `source_url`,
`description`), `search` for the Team price, `expand` a passage, save a finding with a verified quote,
save a near-duplicate of the seeded fact ("handle whatever the tool answers"), read the whole text with
`read_artifact` mode `text` at `max_tokens: 150` following the cursor, and save a colleague's claim
with a quote the page does not contain ("if the harness rejects it, record what the page really says").
Each step is judged from the store (artifact + chunks, `retrieval_events`, `finding_evidence` quotes,
the `duplicate_handshake` decision, `fact_observations`) and from the run's tool calls (inputs from
the run events, ok / error from the dispatcher's bus events). Tokens and cost are summed from
`agent_usage`. `BIF_SMOKE_KEEP=1` keeps the temp dir.

### Results (KS-8 commit, after the description fixes below; step 6 at `max_tokens` 150)

| Step | claude (haiku) | codex (gpt-6.1-sol) |
|---|---|---|
| 1 `save_artifact` with description | PASS, 1 call (8 passages extracted) | PASS, 1 call |
| 2 `search` finds a page passage | PASS, 2 calls ("Team plan price", "free trial credit card") | PASS, 1 call |
| 3 `expand` a passage (`chk_`, `around: 1`) | PASS, 1 call | PASS, 1 call |
| 4 finding with verified quote | PASS, 1 call | PASS, 1 call |
| 5 near-duplicate → handshake → answer | PASS, 2 calls: handshake shown, re-sent with `{"confirms": <seeded id>}` | PASS, 2 calls (+1 `log_decision`): same |
| 6 paged read with cursor | PASS, 5 calls: 150 → "nothing fits" note → same cursor at 400 → 3 more pages | PASS, 4 calls: 150 → same cursor at 500 → 2 more pages |
| 7 rejected quote, recovery | PASS, 2 calls: `quote not found` → saved "Enterprise plan is priced on a custom basis…" with a real quote | PASS, 2 calls (+1 `log_decision`): same, "custom pricing" |
| run | `done`, 15 bif tool calls, 23.7 s | `done`, 15 bif tool calls, 70.0 s |
| `retrieval_events` | 9 (search 2, expand 1, save_finding 1, read_artifact 5) | 7 (search 1, expand 1, save_finding 1, read_artifact 4) |
| `agent_usage` | in 34, out 4 843, cache read 822 720, cache write 32 300; **$0.0147** | in 30 733, out 1 899, cache read 300 672; **$0.1805** |
| `promptStoreGaps` | `[]` | `[]` |

Neither agent saved the unsupported "$199" claim, neither retried the rejected quote, and both answered
the handshake with `confirms` (the correct answer: the page still says $49). Claude's large cache-read
figure is Claude Code's own system prompt and the user's global plugins re-read every turn (not
isolated, see Notes); its cost stays under 2 cents.

### Agent behaviour found, and the fixes (before → after)

First run, with the original tool descriptions (`max_tokens`: "Lower this response's token budget
(never raises it)"):

| | claude (haiku) | codex (gpt-6.1-sol) |
|---|---|---|
| all 7 steps | PASS | PASS |
| bif tool calls / `read_artifact` calls | 15 / 6 | 20 / 9 |
| time, cost | 27.4 s, $0.0170 | 94.9 s, $0.2032 |
| confusion | after "nothing of this page fits 150 tokens: repeat with this cursor and a larger max_tokens" it **repeated the identical call** (same cursor, 150) once before raising to 400 | raised only to 300, so each page carried the ~130-token artifact header plus one passage; the Plans passage came back **`cut: true`** (its last sentence missing) and the agent never noticed: it reported "read all 8 text pages" |

Fixes (tool descriptions only, `src/core/harness/tools/registry.ts`):

- `max_tokens` (every read tool): "Token budget of this response; values above your default budget are
  capped. Raise it (with the same cursor) when a response says nothing fit". The old wording read as if
  a larger value were not allowed.
- `read_artifact`: "Follow `cursor` for the next page; a passage marked `cut: true` was shortened to fit
  max_tokens: expand its chunk_id for the full text."
- `expand`: a passage with `cut: true` was shortened to fit: repeat with a larger `max_tokens`.

After: no repeated call (haiku 6 → 5 reads), codex raised the budget to 500 at once (9 → 4 reads,
20 → 15 calls, $0.203 → $0.181), and no passage was served cut. The behaviour the descriptions
promise is pinned by `test/core/knowledge/smokeContracts.test.ts` (same cursor + larger `max_tokens`
restarts at the same passage; a cut passage is flagged and `expand` returns all of it). Whether an
agent expands a `cut` passage was not observed live (none was cut in the after-run). One run per
provider per condition, so the numbers are indicative, not averages.

Minor, not fixed: haiku passed `finding_ids` in `submit_result` as a JSON-encoded string instead of
an array (the deliverable schema is free-form). Harmless here: cited ids are found by regex over the
serialized deliverable (`citedOutputIds`).

Design observations at the KS-8 commit (fixed by the paging ruling below): every `read_artifact` page repeats the artifact header
(title, URL, fenced description, ~130 tokens), so very small `max_tokens` pages carry mostly header; and
a page whose first passage does not fit returns a placeholder with `retry_cursor` while `cursor`
skips that passage, so an agent that follows only `cursor` would miss it (the placeholder note says to
use `retry_cursor`).

### Paging ruling: position paging, header on the first page (re-run of step 6)

The design thread ruled on the two design observations above: the artifact header goes on the
first page only, and `cursor` pages text by position so it never skips anything. In text reads a
passage that does not fit is served up to the budget, marked `cut: true` ("the next page continues
this passage"), and the next cursor continues from exactly that character. The placeholder and
`retry_cursor` are gone. In lists, an item larger than the page is shortened and marked `cut: true`;
`expand` of its id gives the full text. Tool descriptions now say "follow `cursor` until it is absent
and you have read everything".

Step 6 was changed so that the new behaviour shows live: `max_tokens` 250 (the header fits; a
passage does not), and the page gained one long FAQ answer (~900 characters) that cannot fit on
one page. The smoke now replays each agent's `read_artifact` calls (same caller key, so the agent's
cursors are valid) to see what every page served. It counts pages that carried the artifact header,
pieces marked `cut`, and placeholders, and checks that every passage was served whole once its
pieces are joined. Step 6 passes only if all of them were.

| Step 6, `max_tokens` 250 | claude (haiku) before | claude after | codex (gpt-6.1-sol) before | codex after |
|---|---|---|---|---|
| result | **FAIL** | PASS | **FAIL** | PASS |
| `read_artifact` calls | 7 (raised to 600 midway) | 6 (stayed at 250) | 9 (raised to 500) | 6 (stayed at 250) |
| pages carrying the artifact header | 7 of 7 | 1 of 6 | 9 of 9 | 1 of 6 |
| pieces marked `cut` / placeholders | 4 / 1 | 1 / 0 | 5 / 1 | 1 / 0 |
| passages served whole | 4 of 8 | **8 of 8** | 3 of 8 (expanded 4 cut passages by hand) | **8 of 8** |
| characters never served | 383 | **0** | 851 | **0** |
| whole run: bif tool calls, cost | 17, $0.0167 | 16, $0.0153 | 24, $0.1732 | 17, $0.1936 |

"Before" ran on the KS-8 commit above, and "after" on the ruling's commit (final run: all 7 steps
PASS for both providers, no confusion flagged, `promptStoreGaps` `[]`). Earlier "after" runs found
the issues listed below. The long passage now spans two pages, and each agent read on with the
cursor at the same `max_tokens`. Neither repeated a call or raised the budget.

Found and fixed while re-running:

- **Haiku forged a cursor.** On one run the server returned `{"o":7}`, but haiku sent
  `{"o":7,"p":1}`, made by continuing the pattern of the previous cursor `{"o":6,"p":194}`. The
  harness accepted it and one character was skipped. The tool results kept in `stdout.log` confirm
  that the server's own cursors were correct. Cursors now carry a check value. A hand-edited cursor is
  rejected with "invalid cursor: pass the `cursor` of the previous response exactly as returned, or
  repeat the call without one". In the next claude runs every cursor was sent back unchanged.
- **Haiku sent `relation: "\"new\""`** (a JSON-encoded string) and got only "relation: Invalid input".
  It then tried `{"confirms": <the Team-plan fact>}` for the Enterprise claim; the quote check rejected
  that save. `relation` now accepts a JSON-encoded value, and a wrong value gets "relation must be
  "new", {"confirms": "<fact id>"} or {"replaces": "<fact id>"}". The schema agents see is unchanged.
- In one claude run haiku read the page first and saved the true Enterprise claim directly,
  without trying the colleague's quote, so step 7 was not exercised. The judge also wrongly counted the claim
  "…the page does not state a $199 price" as saving the $199 claim; that check is fixed.

Pinned by `test/core/knowledge/smokeContracts.test.ts`:

- At `max_tokens` 100 to 2000, every passage is served whole across the pages.
- `cut` only on the last item of a page, and the next page continues that passage.
- The header is on the first page only; a first page too small for it gets a shortened header with `header_cut: true`.
- No piece shows any part of a secret, and every piece is one whole fence.
- One retrieval row per page lists every passage it served.
- Raw mode and `expand` with neighbours page the same way.
- Lists:
  - every evidence item and every search hit is visited;
  - a cut card line can be expanded to the full claim.
- Hand-edited cursors and cursors from another request are rejected.

### OpenCode (KS-8): not run

Re-probed on 2026-11-13 with `opencode run --print-logs --format json -m <model> "Reply with the word hi"`
(opencode 1.2.27):

| Model | Error |
|---|---|
| `opencode/big-pickle` (default) | `AI_APICallError`, `statusCode` 429: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go" (retried internally, nothing on stdout) |
| `opencode/deepseek-v4.1-flash-free` | the same 429 "Free usage limit reached" |
| `github-copilot/claude-haiku-4.5` | `AI_APICallError` / `APIError`, `statusCode` 404: "Not Found: 404 page not found" (`isRetryable: false`) |

No paid OpenCode plan was used. Same state as 2026-11-12 (below).

## OpenCode failure

Not a harness bug that we could isolate; the provider never produced a model response on this machine:

- Running `opencode run --print-logs --format json -m opencode/big-pickle "Reply with the word hi"`
  directly logs `AI_APICallError: Free usage limit reached` (HTTP 429) from the OpenCode free tier.
- OpenCode retries 429s internally and prints nothing on stdout while it does, so the run looks idle
  and only ends when the smoke timeout aborts it (or, in normal operation, the supervisor's
  `limits.idleTimeoutMs` watchdog). The adapter's rate-limit back-off never sees an error event.
- The GitHub Copilot models offered by `opencode models` returned 404/400 integrator errors during
  Section B and were not retried here.

So the OpenCode success path is still verified only against the handcrafted fixture
(`test/fixtures/opencode-stream.jsonl`). To retry with a working model:
`BIF_SMOKE_OPENCODE_MODEL=<provider/model> npx tsx scripts/smoke.ts worker opencode`.

## Stakeholder positions (2026-11-15)

`npx tsx scripts/smoke.ts stakeholder-positions claude`, Claude haiku, real CLI. Two runs.

| Run | Result | Time | Cost | Notes |
|---|---|---|---|---|
| 1 (before the final fixes) | PASS 5/5 | 64.4 s | $0.0760 | The combine run's first `submit_combined_profile` was refused because the model sent `conflict: null`; its second call was accepted. `null` is now read as "no conflict". |
| 2 (merged state) | PASS 5/5 | 68.1 s | $0.0605 | One `submit_combined_profile`, accepted. |

Checked: marking a stakeholder as left to a competitor keeps the internal layer (11 of 11 fields);
the follow research saves the public layer (11 fields, each citing a captured page) and leaves the
persona's profile, status and version untouched; neither the worker's nor the reviewer's prompt holds
the internal phrase; the combine run is offline, is shown both layers and answers once; every combined
field has a basis and the evidence of its layers (run 2: 4 public, 7 both, 6 noted conflicts). In both
runs the follow worker's attempt to `expand` the persona was answered "not found", as intended.
Not run on Codex or OpenCode.

## Review council (2026-11-16)

`npx tsx scripts/smoke.ts council claude`, two members (Claude haiku with lens `evidence`, Claude
sonnet with lens `brief`), real CLI. Two runs, before and after the fixes of the branch's own council
review.

| Run | Result | Time | Cost |
|---|---|---|---|
| 1 | PASS 6/6 | 41.3 s | $0.0902 |
| 2 (merged state) | PASS 6/6 | 35.1 s | $0.0899 |

Checked: each member ran as its own reviewer run on its own model, in parallel; each member's prompt
holds its lens and no other; one council review per round; the task's status follows the council's
result; the council route serves the rounds; a member whose model does not exist ends the task
unverified, named, with no other model started in its place. Not run: Codex or OpenCode members in
the tool (`BIF_SMOKE_COUNCIL_EXTRA`), and a round that fails and goes to revision on a real CLI.

The branch itself was reviewed with the development council skill: correctness (Claude fable),
acceptance (Codex CLI, gpt-6-astra, read-only), test-value (Claude sonnet). Round 1: 7, 7, 8.
Round 2: 9, 9, 9.

## Persona panel (2026-11-16)

`npx tsx scripts/smoke.ts persona-panel claude`: three personas on two seats (Claude haiku and
sonnet) with a baseline, one recommendation, then its summary changed and the panel run again, then a
third run on unchanged text. Real CLI. Two runs.

| Run | Result | Time | Cost |
|---|---|---|---|
| 1 | PASS 6/6 | 60.8 s | $0.1791 |
| 2 (merged state) | PASS 6/6 | 55.7 s | $0.1749 |

Checked: one run per persona on its own seat with its own profile and no other persona's; the
baseline ran with no persona and is stored apart from the persona feedback; each round-2 prompt lists
the reader's own earlier concerns and no other reader's, and shows the text it read before and the
current text; rulings are stored with the concerns they are about and the earlier round is kept; a
third run on unchanged text starts no run; the recommendations route serves the panel. In run 1 one
persona's first answer was refused for a missing field and its second accepted. Not run: seats on
Codex or OpenCode, an unavailable seat on a real CLI, flow verdict runs on seats.

The branch was reviewed with the council skill: correctness (Claude fable), acceptance (Codex CLI,
gpt-6-astra, read-only), test-value (Claude sonnet). Round 1: 9, 8, 8. Round 2: 9, 9, 9.

## Desktop app and feedback bundle (2026-11-16)

Real runs through the packaged app, each with a throwaway application folder and a short PATH, as a
person starting it from Finder or the Start menu would get.

| Where | What | Result |
|---|---|---|
| macOS, Apple silicon | App built (`npm run dist:mac`), launched, second launch, quit by the menu's event, by SIGTERM and by killing the shell | Passed; no process left; the real application folder was never written |
| macOS, Apple silicon | One interview turn through the app, every role on Claude haiku | `done` in 9 to 11 s, about $0.004 |
| macOS, Apple silicon | Feedback bundle saved from that data and read with `npm run feedback:report` | Read back; no business name, user name or path in the file |
| Windows 11 x64 | Test suite and the suite on the app's runtime | Passed (2,647 passed, 10 skipped at the time) |
| Windows 11 x64 | Installer built (`npm run dist:win`) without Developer Mode or elevation, installed quietly, started, removed | Passed; the uninstall removes the app and the installer copy it kept |
| Windows 11 x64 | Setup check with the PATH read from the registry | Found Claude Code and Codex, signed in |
| Windows 11 x64 | One interview turn on Claude haiku; a second one interrupted by quitting | First `done` in 6.9 s; the interrupted agent's process tree was gone after the quit and the next start cleaned up |
| Windows 11 x64 | Feedback bundle saved and read | Read back; no business name, user name or path in the file |

Earlier on the same Windows machine, before the app existed: `worker claude` and `browser claude`
smoke modes passed.

Not tried: a signed build; the Intel macOS build (built, not launched); the app's Start-menu shortcut
and the installer's normal (not quiet) run; research phases, Codex or OpenCode through the app; the
hosted build workflow.

The branch was reviewed with the council skill: correctness (Claude fable), acceptance (Codex CLI,
gpt-6-astra, read-only), privacy (Claude opus), test-value (Claude sonnet).

| Member | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| correctness | 8/10 | 7/10 | 9/10 |
| acceptance | 8/10 | 9/10 | not seated |
| privacy | 7/10 | 9/10 | 9/10 |
| test-value | 8/10 | 9/10 | not seated |

Round 3 seated only the two members whose areas had changed since round 2.

## Notes

- Claude runs inherit the user's global Claude Code hooks and plugins (no flag isolates them without
  breaking OAuth); the smoke passed regardless.
- Re-run everything with `npx tsx scripts/smoke.ts`; `worker [providers...]`, `browser [providers...]`,
  `knowledge [providers...]`, `flows [providers...]` or `interview` runs a subset.
  The script exits non-zero when any check fails.
