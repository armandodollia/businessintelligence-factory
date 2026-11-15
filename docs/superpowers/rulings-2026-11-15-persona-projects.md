# Decisions taken without the user — persona projects 2–4 (2026-11-15)

The user asked for projects 2–4 to be built without check-ins. Each line is one decision taken during
the build, in the form: decision — why — what it costs if it is the wrong call. Decisions taken at
design time are marked "(my call)" in each design document under `docs/superpowers/specs/`.

## Project 2: persona learning in the retro

- gate.ts also exports `gateStats(signals): GateStats`; personaGate builds on it — plan gap — none
- `opts.maxAdjustments?: number` (default 8) on acceptPersonaProposal; routes pass the setting — keeps adjustments.ts config-free — callers that forget use the default
- branch in place rather than a worktree — same as project 1, single user — none.
- JSON columns are `stats`, `evidence`, `shown_signal_ids` (Repo maps field names; no `_json` suffix) — repo convention beats spec §11 wording — none.
- no workspace-delete cascade (nothing in src/core deletes workspaces) — spec §11 line unmet but inert — orphan rows if deletion is ever added.
- a revoked or replaced ruling gives no signal — the user changed their mind — fewer signals from users who re-rule often.
- Decisions and feedback events of persona learning are recorded in the persona's own workspace — the persona's node owns its history — differs from lessons, which use the caller's node.
- over budget, the run keeps the oldest signals and leaves the newest for the next retro; signalsThrough = newest shown signal's time; header ≤ half the budget; no shown signals → no run — makes "consumes what it was shown" true with time-based consumption — a busy persona needs several retros to work through a backlog.
- the Lessons page count of pending persona proposals is tree-wide (the retro is per tree) — carried into T6 dispatch with four cheap minors (empty edit, failed signals fetch, text > 400 → 400, lastRun shows the newest run with an assumption) — small extra route field.
- gate line reads "Enough for a change; the proposals below wait for your answer." when proposals are pending — clearer than the spec line in that state — wording only.
- a persona whose profile rests on an upload keeps its learning Decisions out of the default export (stricter than lessons) — sticky provenance — fewer rows in the default export.
- I2 — for the effect and the engine retire only, a signal whose personaVersion is known and lower than the persona version at the adjustment's last change is not counted; adjustments store that version (column added to migration 24, not yet shipped) — the engine should judge an adjustment only on output it influenced — fewer signals count, so retire proposals come later.
- M3 (retro role offers both submit tools to both runs) left — both handlers refuse the wrong call — prompt noise.

## Project 3: stakeholder personas

- branch in place rather than a worktree — single user — none.
- migration 26 adds the phase to schedules only, not to running pipelines (as migration 23 did) — changing a running pipeline's list shifts its next step — a pipeline in flight finishes without the phase.
- offline is enforced per adapter (deny web fetch/search and shell); an adapter that cannot enforce it refuses the run — the design's "nothing it reads can reach the web" must hold in code — own stakeholder research may be unavailable on a provider that cannot be restricted.
- reviewer and escalation runs of an offline task are offline too — they read the same internal content — reviewers of own stakeholder tasks cannot check anything on the web.
- Codex refuses offline runs (no single switch turns off its web and computer tools) — never run unrestricted — own stakeholder research needs a Claude or OpenCode worker model.
- implementer authorised for at most two real haiku runs to confirm MCP tools stay available under `--tools ""` — cannot be confirmed from help text — a few cents.
- the interviewer prompt lists the node's own stakeholders as id, label and type only (hidden ones included) and explains note_stakeholder — the label is shown to the user anyway; without ids every interview statement would be node-wide — the interviewer model sees labels of hidden stakeholders.
- when a submit leaves no hidden stakeholder with open questions in the node, open node-wide questions become skipped — avoids doubled node questions — an unanswered "anyone missing?" is not asked again until new stakeholders appear.
- a stakeholder left entirely blank on submit stays hidden with its questions open (blank answers count as not sent) — the user may come back to it — it opens only on answer, skip or reveal.
- note_stakeholder quotes need at least 12 characters — a one-word quote proves nothing — very short user remarks cannot be noted.
- stakeholder read Decisions use kind `persona_feedback` (told apart by payload.tool) — avoids a new Decision kind across the codebase — prompt metrics and provenance count reads together with segment feedback.
- the handler knows what a run was asked through an in-memory map filled at run start (new optional AgentRequest.onStart) — the dispatcher and runner share one process — a read submitted after a server restart is refused and retried at the next panel.
- the export summary gains an exclusion reason `internal` (statements, questions, reads, internal adjustments and their decisions) — counting them as uploads would give the wrong reason — one more reason in the summary.
- every `stakeholder_*` feedback event is left out of the default export — they describe internal relationships even when they hold only ids — fewer rows by default.
- while a node has a hidden stakeholder, the raw activity of its own_stakeholders tasks (run events, prompts, result summaries, review Decisions, evidence refs) is withheld from every API response and served again once none is hidden — the only way to keep researched content out of raw-activity pages — the user cannot inspect that research run until they answer, skip or reveal.
- a hidden stakeholder cannot be included/excluded through the include route (404) — the route returned the full record — an unverified hidden stakeholder gets no questions until it verifies.
- own_stakeholders runs cannot ask the user anything (request tools refused, no escalation) — the question round is the only channel, and a worker's question could quote research — a stuck own-stakeholder task fails instead of asking for help.
- own_stakeholders runs may save only stakeholders (allowlist of tools) — findings saved by other tools would be searchable while hidden — that research cannot add facts to the knowledge store.
- questions are created for every hidden own stakeholder that is not superseded or failed, not only usable ones — a hidden stakeholder can no longer be included by the user, so "usable" would be a dead end — the user may be asked about a stakeholder the reviewer did not verify.
- a reaction to a read that was since replaced is not shown on the new read (it stays in the log) — the new read is a different judgement — after a new panel the user sees no earlier reaction.
- runs of an own_stakeholders task are withheld while the task is unfinished as well as while the node has a hidden stakeholder — closes the window before the first save — the user cannot watch that research live.
- model choice for offline work goes through one helper; a provider that cannot run offline is swapped for one that can (reviewer may share the worker's provider when it is the only capable one), and the task is not planned when none can — reviews must be able to run — reviewer independence is weaker for these tasks on a one-provider setup.
- save_stakeholder is accepted only from the two stakeholder task types — other (online, unwithheld) tasks must not create hidden stakeholders — the company audit can no longer save a stakeholder it happens to find.
- stakeholders.enabled false skips the phase entirely; already hidden stakeholders can still be revealed from the page — a switch that only hides the round would trap them — none.
- reads by own stakeholders and learning runs for own stakeholder personas run offline; competitor stakeholder reads stay online-capable — agent.md and statements of own stakeholders are internal — those runs need an offline-capable model or are skipped with a recorded reason.
- every Decision of an own_stakeholders task counts as internal for the export — built on internal statements and uploads — fewer rows in the default export.
- decision_record compares against the persona's current read of the recommendation (left as is) — reads keep their id when replaced — a decision recorded before a newer read is compared with the newer one.
- a second real smoke run was made with files kept to see why run 2 ended unverified — never having seen a verified own-stakeholder task was a gap — $0.02.
- for an offline review the configured reviewer is used when it can run offline, and the worker's own model reviews only when it is the only capable model (fixed by the controller, tested) — the re-review found the configured reviewer ignored and self-review possible — none.

## Project 4: a persona of the user

- the user persona is one per person per tree (row carries the actor id in subjectId; slug from a hash) — the user said several people will share one store — a little extra code now; none if multi-person use never happens.
- only an answered approval request counts as accept/reject; other request kinds are neutral — logins and captchas say nothing about judgement — none.
- a change of scoring weights counts as an edit, not neutral — it is the clearest statement of priorities, and the distinct-targets gate stops weight tweaks qualifying alone — weight tweaks add to the action count.
- userPersona.enabled false also keeps the brief out of prompts — "off" should mean off — a user who wants the brief without further learning must leave enabled on.
- the default actor id (local-user) is not treated as an identifier in proposal text — it identifies nobody and would block ordinary words — none.
- user-persona learning runs are offline, like own-stakeholder learning — they need no web access and carry the user's typed reasons — skipped with a recorded reason when no provider can run offline.
- a synthesizer task inside a running experiment keeps the brief its arm was recorded with — same as lessons; experiments compare fixed prompt texts — a retired line stays in that experiment's prompts until it ends.
- a user-persona line the user edits is refused (400) when it holds their user id or an email-like string, not silently redacted — the user can rewrite it and sees why — an extra step for a user who typed their own name.
- Task 4 gets no separate task review; the final whole-branch review covers it with explicit attention — it is tests, docs and three one-line filters — a task-level finding is caught one step later.
- the retro learns only for people the tool can show proposals to (opts.actors, default the configured person) — a proposal nobody can decide blocks that person's later runs — actions recorded under an earlier user id are never learned from until a multi-person build serves that id.
- the gate line says "since the last learning run", not "since the last change" — consumption follows the last finished run — differs from the wording in spec §12 (spec updated).
