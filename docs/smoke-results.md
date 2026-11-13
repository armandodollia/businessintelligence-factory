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
- Re-run everything with `npx tsx scripts/smoke.ts`; `worker [providers...]` or `interview` runs a subset.
  The script exits non-zero when any check fails.
