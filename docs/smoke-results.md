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
| knowledge/claude (haiku) | steps 1–6 PASS, step 7 **not exercised** (reported FAIL) | 23.6 s, 15 calls, 10 `retrieval_events`, `promptStoreGaps` `[]`, $0.0140; step 6 identical to codex (8 of 8 whole, 0 characters never served). Haiku read the page first and saved the true Enterprise claim directly, without trying the colleague's quote, so no quote was rejected — the same agent choice recorded under "Found and fixed while re-running" below. The harness behaved correctly. |
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

## Notes

- Claude runs inherit the user's global Claude Code hooks and plugins (no flag isolates them without
  breaking OAuth); the smoke passed regardless.
- Re-run everything with `npx tsx scripts/smoke.ts`; `worker [providers...]`, `browser [providers...]`,
  `knowledge [providers...]` or `interview` runs a subset.
  The script exits non-zero when any check fails.
