# Verify log

Section gates: Codex gpt-6.1-sol + Claude Opus 5.5, both must score ≥ 8/10, max 3 rounds.

## Section A — PASSED round 1 (Opus 9, Sol 8)
- Sol substantive (JSON null roundtrip) fixed in 6ac94a9.

## Section B — NOT PASSED after 3 rounds (Opus 9/9/9, Sol 7/7/7)
Each Sol round found new substantive issues; all from rounds 1–2 were fixed (2df5a17, e113cb9).
Round 3 Sol findings, handled after cap:
- Relative `dataDir` breaks CLI `--mcp-config`/`-C` paths → fixed post-cap (see commit "fix: section B post-cap").
- Rate-limit error followed by exit 0 treated as success → fixed post-cap.
- "Task retried once on subprocess failure, orchestrator informed" (Review Focus 1) → ruled a task-level concern; routed to Section C Task 8/9 (review loop / orchestrator), verified in Section C gate.
Open nits (Opus r3): watchdog may fire during process-group reap; rate-limit retry repeats side effects (duplicate findings) — Section C must dedupe or tolerate; orphaned process groups after server crash — Task 9 resumeInterrupted must fail `running` runs and revoke tokens.

## Section C — NOT PASSED after 3 rounds (Sol 6/7/7, Opus 8/8/8)
Rounds 1–2 substantive issues all fixed (2e8a273, 16bed89). Round 3 remaining (replay/dedupe edge cases: finding/proposal corrections dropped by dedupe, resolved user-request replay, non-atomic propose_tasks replay, paraphrased replays after rate-limit retry) → fixed post-cap without re-gate (commit "fix: section C post-cap"); covered again by the final whole-branch review.

## Section D — NOT PASSED after 3 rounds (Sol 6/7/7, Opus 8/8/9)
Rounds 1–2 substantive issues fixed (fa6bf6d, 311c632). Round 3 remaining (recommendation revisions not logged as new decisions; weight fit ignoring persona term) + Opus nits → fixed post-cap (commit "fix: section D post-cap"), covered by final review.

## Section E — NOT PASSED after 3 rounds (Sol 7/7/8, Opus 8/9/7)
Rounds 1–2 substantive issues fixed (35fd436, ac6e7fb). Round 3 remaining → fixed post-cap (commit "fix: section E post-cap"): artifact serving security headers (archived third-party HTML could run on the app origin and reach PUT /api/config), Host/Origin guard against DNS rebinding, workspace-switch state leak in calibration UI, schedule-specific "what changed" baseline.

## Final whole-branch review
- Round 1: Opus 6, Sol 6 (1 blocking: per-run browser MCP vs single research profile; spec gaps in output review status, pipeline resume, model defaults, calibration isolation, competitors, export provenance). Fixed in three parallel groups (e7d5739, 71e9fb0/b80a31a, 1d599e6).
- Fix-wave re-review: Opus 8, Sol 6 (blocking privacy leak in export). Targeted passes 4ac0c64, 4426636, be6f531.
- Final scoped verification of provenance fixes: **Opus 8, Sol 8 — passed.** Last minor (reuse records in export judgments) fixed in 18b9146.
