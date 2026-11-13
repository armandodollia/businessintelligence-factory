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

## Knowledge store KS-8 — measurements (2026-11-13)

Script: `scripts/measure-knowledge.ts` (`npx tsx scripts/measure-knowledge.ts [prompts|search|all]`), on
`feat/learning-loop` after the KS-8 merge. Apple M5 Pro, Node 25.8, `node:sqlite`, temp data dir.

**Prompt tokens** (characters / 4) on a seeded four-node tree (company, two divisions, one slice); one
finding in five unverified; `backfillKnowledge` run; prompts built for the Payments division. Same
method as the KS-5 measurement. "Before" is the pre-KS-5 prompt (KS-5 measurement); "after" is
re-measured on the final branch and matches KS-5's figures exactly.

| Findings | Orchestrator, deep dives | Orchestrator, synthesis | Synthesizer (work prompt) |
|---|---|---|---|
| 100 | 3,397 → 1,688 | 5,578 → 1,629 | 3,290 → 3,190 |
| 1,000 | 30,082 → 1,690 | 52,154 → 1,631 | 32,045 → 4,002 |

The orchestrator prompt no longer grows with the store; the synthesizer's grows only up to its
4,000-token briefing budget.

**`search` latency at 10,000 chunks**, through `knowledgeRead` (the tool path: scope, budget, envelope,
`retrieval_events` row), caller = Payments division. Store: 10,083 passages from 72 Markdown documents
ingested through the real extract → chunk → FTS path (18.0 M characters, 400-token chunks), 1,000
facts, spread over the four nodes. Synthetic worst case: a 90-word vocabulary, so every query term
matches nearly every chunk. 40 queries (one word, subject + word, three words, a quoted phrase, and a
query with no AND match that falls back to OR) × 5 runs after a warm-up pass; n = 200 per scope.

| Scope | p50 | p95 | max |
|---|---|---|---|
| node (default; includes the "more matches elsewhere" note) | 74 ms | 88 ms | 110 ms |
| tree | 23 ms | 28 ms | 34 ms |

The first measurement on the merged branch was node p50 1,089 ms / p95 1,442 ms and tree p50 378 ms /
p95 432 ms. Two fixes, with no change in behaviour (KS-8 commit "perf(search)"):

- The passage query looked up the artifact a chunk is shown under with
  `a.id = c.artifact_id OR t.duplicate_of = c.artifact_id`, which can use no index. It scanned the
  artifacts for every FTS match. Now: the canonical by primary key, then the duplicates only for an
  artifact that has any.
- A fact hit's entity label (`getEntity` + `entityIsUploadOnly`) was computed per hit. Node scope builds
  about 550 hits per call (the page plus the two 250-row pools of the "elsewhere" note), so it is now
  computed once per entity per call.

What remains in node scope is mostly the "elsewhere" note, which builds the tree and node pools as full
hits. It could count ids only, if this matters later.

**Store size on disk** for that store: SQLite database 28.7 MB after a WAL checkpoint (text, chunks,
FTS indexes, 1,000 facts, scopes); stored files 18.1 MB; 46.8 MB in total. That is about 2.8 KB of
database per passage, or 1.6× the extracted text.
