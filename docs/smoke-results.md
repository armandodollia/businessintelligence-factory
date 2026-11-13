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

## Results

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
- Re-run everything with `npx tsx scripts/smoke.ts`; `worker [providers...]`, `browser [providers...]`
  or `interview` runs a subset.
  The script exits non-zero when any check fails.
