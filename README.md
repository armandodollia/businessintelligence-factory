<img src="assets/icon.svg" width="64" height="64" alt="">

# Business Intelligence Factory

A local app that researches a business for you with a team of coding-agent CLIs (Claude Code,
Codex, OpenCode). It interviews you about the business, sends agents to research the market and
competitors (including walking through their signup, pricing and checkout flows in a browser),
checks every result with an adversarial reviewer, builds evidence-backed findings and
recommendations, puts those to simulated customer personas, and ranks them. You rate everything the
agents produce, and those ratings feed back into weights and prompts.

Everything runs on your machine: a Node server with a SQLite database, a harness MCP server that
the agent CLIs call into, and a small React web app. Design spec:
[docs/superpowers/specs/2026-11-12-business-intelligence-factory-design.md](docs/superpowers/specs/2026-11-12-business-intelligence-factory-design.md).

## Setup

1. **Node 25+**, then `npm install`.
2. **Config.** `cp bif.config.example.json bif.config.json` and edit it. The config sets:
   - `providers`: which CLIs are enabled, their command and the models agents may use.
   - `roles`: provider/model per role (orchestrator, interviewer, reviewer, synthesizer, persona,
     and workers per task type). Every role model must be listed under an enabled provider.
   - `loop`: review loop `maxRounds` / `passThreshold`, globally and per task type; `maxReasserts`
     (default 1) caps how often a reviewer may reassert an issue the worker pushed back on.
   - `limits`, `browser`, `identity`, `actionPolicy`, `scoring`, `server.port`, `dataDir`.
   - `user.id`: who you are in the feedback log (default `local-user`). Every rating, override,
     correction, answer and approval records this id; the API never takes it from a request.
   - `budgets` (optional): token / cost caps per workspace and per research pipeline, e.g.
     `"budgets": { "workspace": { "maxCostUsd": 50 }, "pipeline": { "maxTokens": 20000000 } }`. Past a
     cap no new agent run starts; a "Waiting on you" request asks to extend it by one more cap (deny
     to stop; raising the cap in config lifts a denial). Without `budgets` there are no caps.
   - optional `escalation` (`enabled`, `model` — default `roles.orchestrator`, `maxQuestions` ≤ 3,
     `maxPerTask`, default 2) and `telemetry` (`busEventRetentionDays`, default 30, 0 = keep;
     `otlp: { enabled, endpoint, headers, serviceName }`, off by default).
   - optional `knowledge` (knowledge store; every field has a default): `budgets` (tokens per
     response kind `search` 1200 / `card` 800 / `expand` 2000 / `briefing` 1500, per-role overrides —
     reviewer `expand` 3000, synthesizer `briefing` 4000 — and per-provider scale), `hardMaxTokens`
     (8000), `freshness` (`defaultDays` 90, `byEntityKind`), `extraction` (`maxTextChars`,
     `chunkTokens` 400, `maxChunkTokens` 600, `xlsxMaxRows`, `inlineMaxBytes`, `concurrency`),
     `captions` (`required`, `minChars` 20), `dedupe` (`candidateLimit` 3, `similarityFloor` 0.5 —
     Jaccard overlap of the word sets of the two normalized claims, 0–1; full-text bm25 only picks
     which stored facts are compared), `retention` (`pruneMinAgeDays`).

   Without a `bif.config.json` the built-in defaults are used. The Settings page edits the same file.
3. **Log in to each enabled CLI** once in a terminal, so agent runs can use your existing auth:
   - `claude` (Claude Code), `codex` (Codex CLI), `opencode` (OpenCode; disabled in the example).
   - Check with `npm run smoke` (see [Smoke test](#smoke-test)).

### Research browser profile

Agents browse in a **dedicated, persistent research profile**, never your everyday browser profile.
It stays logged into the throwaway accounts the agents create.

- **MCP backend, shared server** (`"backend": "mcp"`, `"mode": "shared"`, the default): the harness
  starts **one** browser MCP server (`browser.shared`) the first time a run needs a browser, and
  every browser-using run connects to it over HTTP (`http://127.0.0.1:<port>/mcp`, MCP server name
  `browser`). All runs share one browser on one persistent profile; each agent is told to open its
  own tab, work only there and close it when done. The default is a pinned Playwright MCP:

  ```json
  "browser": {
    "backend": "mcp",
    "mode": "shared",
    "shared": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.85", "--host", "127.0.0.1", "--port", "{{port}}",
               "--shared-browser-context", "--user-data-dir", "{{profileDir}}",
               "--output-dir", "{{outputDir}}", "--file-paths", "absolute"],
      "port": 0,
      "path": "/mcp"
    },
    "profileDir": "data/browser-profile"
  }
  ```

  Placeholders: `{{profileDir}}` = absolute `browser.profileDir`, `{{port}}` = `port` (0 picks a free
  port), `{{outputDir}}` = a folder under the OS temp dir where screenshots land (agents can pass
  those files to `save_artifact`). The server runs in its own process group, logs to
  `data/browser/shared-server.log`, is restarted if it dies, and is stopped when the app stops (a
  leftover from a crash is killed at the next start). It opens a visible Chrome window, which is
  also where you log the research profile into a site by hand when an agent asks you to.
- **MCP backend, per-run servers** (`"mode": "per_run"`): each browser-using run spawns
  `browser.mcpServers` itself (stdio), with `{{profileDir}}` substituted as above. A profile can be
  open in only one browser at a time, so this mode caps `limits.maxBrowserRuns` at 1 (with a startup
  warning). Always use `{{profileDir}}` (or an absolute path): CLIs run in a per-run working
  directory, so a relative path would create a fresh, empty profile for every run.
- With backend `mcp` and no browser configured (no `shared` in shared mode, empty `mcpServers` in
  per-run mode) the app warns at startup and `propose_tasks` rejects tasks with `needs_browser`.
- **T3 backend** (`"backend": "t3"`): no browser MCP server is passed; agents are told to use the
  T3 Code browser tools. This only works when the agent CLIs run inside T3 Code with those tools
  available. The harness cannot choose or check the browser profile in this mode: agents use
  whatever profile T3 Code's browser is running with. The same rule still applies, so it must be a
  **dedicated research profile, never your everyday one**. Before using this backend:
  - run the app from a T3 Code project or environment set aside for research, whose browser is
    signed into nothing personal (no personal email, banking, password manager or SSO sessions);
  - check by opening the T3 Code browser and confirming it has none of your own sessions or saved
    passwords;
  - if you cannot guarantee that, use the MCP backend with `{{profileDir}}`, where the harness
    enforces the separate profile itself.

`limits.maxBrowserRuns` (default 2) caps concurrent browser-using runs.

### Agent CLI isolation

- **Codex** runs with its own `CODEX_HOME` (`data/cli-state/codex-home`): a generated, empty
  `config.toml` and `auth.json` symlinked to yours (`$CODEX_HOME` or `~/.codex`), so your Codex MCP
  servers, plugins and hooks are not loaded; only `bif` (and `browser`) are passed with `-c`. Sign
  in with `codex login` as usual. The link is a symlink so a token refresh made during a run lands in
  your own file; it is re-created before every run if missing or replaced.
- **OpenCode** reads only the generated `.bif-opencode.json` (`OPENCODE_CONFIG`), with project
  configs disabled and the global config dir redirected to `data/cli-state/opencode-config`
  (credentials stay in OpenCode's data dir, so logins keep working).
- **Claude Code** gets `--strict-mcp-config` (only `bif` and `browser`), but still loads your global
  hooks and plugins (see Known limitations).
- **Run tokens** (the per-run MCP credential) never go on a command line: Claude Code and OpenCode
  read them from a generated config file in the run directory, Codex from the `BIF_MCP_TOKEN`
  environment variable (sent as a bearer header to `/mcp`).
- `save_artifact` with `file_path` only accepts files inside the run's working directory or the OS
  temp dir (outside the data dir), after resolving symlinks.

## Running

| Command | What it does |
|---|---|
| `npm start` | API + harness MCP + built web app on `http://127.0.0.1:4317` |
| `npm run dev` | same, restarting on source changes |
| `npm run web` | Vite dev server for the web app (proxies `/api` and `/mcp` to port 4317); run alongside `npm start` |
| `npm run build:web` | builds `web/dist`, which `npm start` serves at `/` |
| `npm test` / `npm run typecheck` | tests (vitest) and type checks |
| `npm run smoke` | real-CLI smoke test (spends a little real model usage) |

Environment overrides for `npm start`: `BIF_CONFIG` (config path), `BIF_DATA_DIR`, `PORT`.

The server binds to 127.0.0.1 only and has no authentication. While it runs, it resumes interrupted
work on start (an interrupted pipeline continues its current and remaining phases, and a scheduled one
then records "what changed") and runs scheduled jobs (missed runs execute once on the next start).

## Concepts

- **Workspaces and the business map.** A workspace is one business or one part of it. Its *scope* is
  `company`, `division` or `slice` (a product line, region, team or internal platform), with
  *audiences* `external` (customers), `internal` (employees) or both. Workspaces form a tree: the
  optional `mapping` phase proposes child units, which you accept, edit or reject. A node can read and
  cite anything in its own tree (tagged with the source), never another tree. Parents roll up their
  children's symptoms and recommendations and flag patterns seen in two or more children as possible
  company-wide issues.
- **Interview.** A resumable chat with an interviewer agent that fills the profile (basics, revenue
  model, customers, what is going well, what is going badly) and records symptoms with
  severity/trend/confidence. Uploads (CSV, PDFs, decks) are optional evidence.
- **Phases.** `mapping` (optional) → `market_research` → `competitor_discovery` → `deep_dives` →
  `synthesis` → `persona_panel` → `scoring`. Each research phase is a fresh orchestrator run that
  proposes tasks; the program validates them against the config limits and runs the workers. A task
  without a `model` uses the configured default for its type (`roles.workers.<type>`, else
  `roles.workers.default`; recommendation synthesis uses `roles.synthesizer`); explicit overrides are
  recorded as such in the task-proposal decision.
- **Review loop.** Every worker result goes to a new reviewer run with minimal context, which scores
  it 0–10 and lists issues (`blocking | substantive | nit | scope_expansion`). Score ≥ `passThreshold`
  (default 8) → *verified*. Otherwise the worker fixes or pushes back (pushback on nits and scope
  expansion is expected and logged) and resubmits, up to `maxRounds` (default 3); then it stays
  *unverified* and is flagged with that status. The task's findings, recommendations, personas,
  competitors and symptom hypotheses take its final status (*verified*, *unverified* or *failed*);
  outputs from an earlier round that the final submitted revision neither re-saved nor cited by id
  are *superseded* and never used (e.g. a "$10" finding corrected to "$20", or a claim dropped
  without replacement). The reviewer sees the content of the submitted outputs and their evidence
  ids. Only verified findings feed recommendation synthesis (from any node of the same
  business tree); on the Findings page you can include an unverified finding (or exclude a verified
  one) with the "Use in recommendations" toggle. Likewise only verified recommendations and personas
  go to the persona panel ("Use in persona panel" toggle on the Strategy and Personas pages);
  Strategy flags unverified recommendations with the last reviewer's objections and hides failed
  ones unless you include them ("Show failed" lists them). The Competitors page, the review queue and
  the interviewer's drill-down use only verified (or included) competitors and hypotheses.
- **Living facts.** A finding is a fact with a stable identity across runs (a lineage of versions).
  A later run *confirms* it, *replaces* it with a new version (price $10 → $12) or *retracts* it,
  instead of saving a duplicate; nothing is deleted. `save_finding` checks the store first: an
  identical current claim about the same entity (see Entities below) is confirmed automatically
  (citing an artifact saved in the task), and similar current facts of the business tree about that
  entity are returned without saving until the agent says `relation: "new"`, `{confirms}` or
  `{replaces}`; `confirm_finding` / `retract_finding` do the same explicitly. A confirmation or
  retraction must cite an artifact the task itself saved with `save_artifact` (every save is
  recorded, even of bytes already stored). These observations apply only when the task is verified
  (an unverified replacement stays an "unverified update" until you include it); a new version keeps
  the entity of the one it replaces. Quotes in `evidence_refs` are checked against the artifact's
  text — extracted on the spot if it was still waiting in the extraction queue. Only the current version of a fact feeds
  synthesis; the review queue lists a fact's live version, so a new version is rated again. The
  reviewer sees the prior claim, the facts a task confirms or retracts, and the verified quotes.
- **Review history and disputes.** Every review round's issues are kept (`review_issues`), with
  stable issue ids across rounds when the reviewer repeats an issue, and each issue's fate: `open`,
  `fixed`, `pushed_back`, `upheld` (reasserted after a pushback) or `withdrawn` (dropped after a
  pushback). The next reviewer sees the issues the worker pushed back on, with the worker's reason,
  and must accept or reassert each; after `loop.maxReasserts` reasserts the worker is told to fix it.
- **Decision outcomes.** Agent decisions get labels after the fact (`decision_outcomes`): `confirmed`
  (task verified), `over-scoped` / `missed-evidence` / `weak-review` (task unverified),
  `run-failed`, `missed-evidence` (output superseded by a later round), `stale` (a scheduled
  re-run saved a new fact on the same subject with another claim, or a screenshot the finding cites
  changed, or the fact passed its TTL without a re-check), `user-rejected` (you excluded an output — finding,
  recommendation, persona, competitor or symptom hypothesis — or rejected a unit proposal; excluding
  a verified output also marks the passing review `weak-review`), `confirmed` (you included an output
  the review did not verify), `reviewer-false-positive` (an issue dropped after a pushback) and
  `worker-miss` (an upheld issue the worker then fixed); for fact versions, `confirmed` (a verified
  confirmation), `changed` (replaced by a new version) and `retracted` (by a run, or `user-rejected`
  when you retract it). Your actions reach outcomes from one place: the feedback event
  each action records (see Feedback log) — so each action writes its outcome once, under your
  `user.id`. An outcome can also judge a non-decision subject (e.g. a fact version), and each one is
  written once per subject, outcome and source event. The Decision log shows the counts per role,
  task type and prompt version (this workspace or the whole business tree).
- **Entities and relations (knowledge store).** Every finding, competitor, persona, symptom and
  symptom hypothesis is filed under a named *entity* of its business tree (company, competitor,
  product, persona, topic, cause, …), matched by name or alias; separate trees never share one. A
  finding without an explicit `entity` is filed under the competitor / persona / company entity its
  subject names, else a unit's company name, else a topic. `save_artifact` can name an `entity` too
  (an artifact with a `flow` then links the entity to that flow). An entity is only created when a
  record is saved under it — never by a duplicate check or a confirmation. A near-duplicate name is saved anyway and
  shows up as a *merge suggestion*; merging or renaming an entity is your action (feedback events
  `entity_merge` / `entity_rename`) and keeps old names resolvable as aliases. Typed edges
  (`competes_with`, `offers`, `has_flow`, `causes`, …) each name the record that asserts them and
  count only while that record is usable. An entity name that only uploads mention is treated like
  upload text (the same export and exposure rules), and keeps that status as an alias after a merge.
- **Evidence rule.** Every finding cites at least one stored artifact of its business: screenshots
  per flow step, archived pages, documents or uploads. A confirmation or retraction cites an artifact
  its own task saved (see Living facts); a quote in `evidence_refs` must occur in the artifact's text;
  screenshots need a description (see Evidence text). Recommendations cite only usable findings (the
  current, verified or included version; a replaced, retracted or excluded fact is refused), so the UI
  can trace recommendation → findings → artifacts.
- **Evidence text (knowledge store).** Every save of an artifact (and every upload) is recorded as a
  capture (who, which run and task, URL, flow step), even when the bytes are identical to an earlier
  save. Text is extracted in-process from HTML, PDF, docx, pptx, xlsx, csv, markdown, JSON and text
  (small files at once, larger ones on a background queue that resumes after a restart), with
  identity passwords redacted, and split into searchable passages. A document with the same text as
  an earlier one of the business tree points at it instead of being indexed twice. Screenshots and
  images saved by agents need a `description` (≥ `knowledge.captions.minChars`, default 20
  characters); images without one (e.g. uploads) can be described later with `describe_artifact`.
- **Knowledge read tools (knowledge store).** Agents read the store through `search` (facts,
  document passages, artifacts, entity names, records; FTS ranking, labelled hits with ids, no
  bodies), `get_card` (a card computed from reviewed records for an entity or a node), `expand`
  (one id in detail), `read_artifact` (outline, extracted text, image, or the raw text file — paged)
  and `list_changes` (new, replaced, retracted and newly stale facts, changed cited pages);
  `read_workspace` returns a node's card and counts. A query sees its node, the node's sub-units and
  what it inherits from its parents; the rest of the business only with `scope: "tree"`; other
  businesses never (their ids answer exactly like unknown ids). A read by id returns the named item
  from any part of the business, labelled with its source, while what it lists around the item (card
  facts, relations, neighbours) follows the same node scope unless `scope: "tree"` is passed. Every
  response fits a token budget per role (`knowledge.budgets`, capped by `hardMaxTokens`) and continues
  with a `cursor` that never skips anything: a text page that ends mid-passage says `cut: true` and the
  next page continues from that character; a list item too large for a page is shortened (`cut: true`;
  `expand` gives it whole). Evidence text is redacted and served inside `<<<EVIDENCE … >>>` fences as
  untrusted data. Reviewers (and
  escalation agents) can only `expand` / `read_artifact` the ids of their task's review slice.
  Synthesizer and interviewer see usable facts only. Every read — and the store text a prompt carries,
  logged before the run starts — is recorded in `retrieval_events`; a run shown upload-derived text
  counts as upload-exposed.
  Nothing inside a business is confidential from another part of it: node scope is a relevance
  default, a node-scoped `search` says how many more matches exist elsewhere in the business (counts
  only), and around a symptom or cause entity the `causes` / `addresses` relations of the whole
  business are listed, each labelled with the part it comes from.
- **Knowledge in prompts and recurring runs (knowledge store).** Prompts no longer list every finding:
  each role gets a fixed-size briefing built from cards (orchestrator 1 500 tokens, worker 1 500,
  synthesizer 4 000; `knowledge.budgets`), which leaves items out by naming their ids, then by counts, and
  is logged as a read before the run starts. The orchestrator sees the node card, an entity index,
  changes since the last run of the schedule and the facts due for re-check (stale, or reaching their
  TTL before the schedule's next run), and may give each task `recheck_fact_ids`, which the worker's
  prompt shows with their claims; recurring runs therefore confirm, replace or retract facts instead of
  saving them again. At company level the orchestrator also sees the causal edges that cross parts of
  the business, from the same rule the cards use. Uploads appear in prompts as metadata only (id, type,
  size, date). The scheduled "What changed" comes from the run's applied fact changes (new, replaced
  old → new, retracted, confirmed count) plus the screenshot comparison, with text matching only for
  facts saved as `new` (see Scheduler).
- **Knowledge tracking (knowledge store).** When a run saves something citing ids it was shown by a
  read, those ids are marked used (`retrieval_uses`); hit rate = reads with a used result. Living facts
  write decision outcomes once each (`confirmed`, `changed`, `retracted`, `stale`, `user-rejected`, and
  `duplicate-saved` when you merge away a fact the agent saved as `new` after the duplicate check showed it
  a match, or retract it as a duplicate of another fact); the scheduled "what changed" records them once,
  through one path (see Scheduler). Blocked knowledge reads (outside a reviewer's slice, or another
  business's ids) are policy events. The export adds retrieval events and fact observations, under the
  upload rules (see Export and uploads).
  `GET /api/workspaces/:id/knowledge/metrics` (store size, freshness, hit and zero-result rates, retrieved /
  used tokens per role, task type, prompt version and model, share of input tokens that was retrieved
  knowledge) and `GET /api/workspaces/:id/knowledge/signals` (learning signals per role).
- **Knowledge view (knowledge store).** The *Knowledge* tab searches the store as you ("this part of
  the business" / "whole business"), lists entities and opens their cards, a fact's history and
  evidence (shown as plain text, never rendered), merge suggestions, stale facts, conflicts and
  unverified updates, and recent changes. Upload-derived items are marked with why the export leaves
  them out. Retracting a fact (optionally as a duplicate of another fact of the same business),
  applying an unverified update, changing where a fact applies, merging or renaming entities and
  rejecting a suggestion are your actions (feedback events, actor `user.id`). The storage report shows, per part and age, the stored files no record references;
  nothing is removed automatically. Pruning is your explicit action on files you pick, at least
  `knowledge.retention.pruneMinAgeDays` (default 90) days old: it is refused as a whole if any file
  is still cited (by any fact version, observation, record, the latest capture of a flow step, an
  upload list) and removes only the file — the description and extracted text stay, and capturing
  the same bytes again restores it. Each prune is logged (a decision and an `artifact_prune` feedback
  event).
- **Action policy.** Agents may browse, sign up with disposable identities and walk checkout up to
  payment. Payment details, demo requests and contacting real people need your approval (the
  "Waiting on you" banner). Purchases are never made.
- **Escalations.** When a task ends *unverified* or *failed*, an `escalation` agent may ask you up to
  three multiple-choice questions about it (one option recommended, preselected) in the "Waiting on
  you" banner. Once every question of that escalation is answered (not all dismissed), the task runs
  again through the review loop, with a fresh round budget, your answers and a summary of what its
  previous attempt did and why it failed review. At most `escalation.maxPerTask` escalations per task.
- **Policy history.** Every approval request, grant and denial and every blocked attempt (a tool call
  outside the role's scope, or an approval request for a *never* action) is recorded. Worker,
  synthesizer and orchestrator prompts list that role's last five denials in the same business tree,
  so agents stop retrying refused actions. `GET /api/workspaces/:id/policy-events`.
- **Event history.** Bus events that used to exist only on the live SSE stream (tool-call validation
  errors, run and task status changes, request traffic) are kept in `bus_events` for
  `telemetry.busEventRetentionDays` (`GET /api/workspaces/:id/bus-events`). With
  `telemetry.otlp.enabled` they are also sent as OTLP/HTTP JSON logs to `<endpoint>/v1/logs`
  (built-in `fetch`, no SDK dependency; ids, types and statuses only, no agent or user text).
- **Personas are simulated.** Persona profiles are researched with evidence, compiled into persona
  prompts, and every recommendation is put to each persona. Their feedback is labelled *simulated*,
  shown in its own column, and has weight 0 in priority unless you change `scoring.personaWeight`.
- **Ratings and calibration.** Every criterion value on every item can be rated: agree, or disagree
  with your own value and reason (inline or in the Review queue). Ratings are kept as history:
  changing a rating adds a new row and the latest one is what the UI shows as your current rating
  (re-submitting an unchanged rating sends nothing). Priority is a weighted combination
  of recommendation criteria; the Strategy page edits the weights and offers weights refit from your
  priority overrides (never auto-applied). Worker pushbacks are ratable too (criterion `pushback`, 0–1:
  how justified it was). The Decision log page proposes prompt patches per role from
  your disagreements; you edit and approve them before they are written. An approval keeps the
  role's calibration history (revertable on the Usage & prompts page) and is logged as a decision and
  a feedback event; weight changes and reverts are logged the same way. The decision log plus ratings
  export as JSONL.
- **Feedback log.** Every human action on agent output is also an append-only feedback event: who
  (`user.id`), when, what changed (before → after), why, and the agent run and prompt version that
  produced the item. Recorded actions: include overrides (findings, recommendations, personas,
  competitors, symptom hypotheses), profile edits, unit proposal accept / accept-with-edits / reject,
  symptom hypothesis corrections (Findings page), request and escalation answers, weight changes,
  prompt patch approvals and calibration reverts, and fact actions (scope change, retraction,
  accepting an unverified update). Ratings store the agent run and prompt version they judged. Feedback feeds calibration:
  excluding an output counts as a disagreement with it, including an unverified one as an agreement,
  and unit proposal rejections / edits are scaled disagreements on the proposing decision, so they
  rank among the prompt patch examples. When an agent revises an item after you rated it, the item
  returns to the review queue. The Decision log page lists the feedback with actor, time and reason.
  The export adds answered requests, the interview transcript (each turn linked to its interviewer
  run), feedback events and each output's final review status, under the upload rules below.
- **Export and uploads.** The JSONL export (`GET /api/workspaces/:id/export`) leaves out by default,
  unless `?includeUploads=1`:
  - everything that cites an internal upload or anything the knowledge store marks upload-derived (a
    fact confirmed with an upload, a later version of such a fact, a record citing one;
    `explainUploadDerived` says why);
  - every judgment of an **upload-exposed run**, that is a run that was *shown* upload-derived text by
    a read tool or its prompt, even if it cited none;
  - the **task of such a run**: its reviews, deliverable decisions and outputs;
  - later judgments that **cite one of those outputs**, treated like an upload: by id, through a
    record that cites it (a recommendation's findings), or because their task's outputs cite it (then
    all of that task's judgments go, as when a task's outputs cite an upload). So if a synthesis task
    saves a recommendation citing a fact from an exposed task, its judgments, persona feedback on that
    recommendation and your ratings of either are left out.

  Only citing excludes. A later run that is only shown one of those outputs is not exposed by that,
  its reads are exported, and a judgment citing only that task's other outputs is exported. Exposure
  is computed at each export from the retrieval log and never stored, so it cannot spread through
  cards or briefings. Each export reports what it left out, counted by cause: cites an upload, exposed
  run, task of an exposed run, references an output of such a task. The report comes in the
  `x-bif-export-summary` header and from `GET /api/workspaces/:id/export/summary`. The Decision log
  (like the Metrics page) computes it only when you press its button, because that runs the whole
  export, and shows it with an "including uploads" link. Known limit: uncited text paraphrased from such an output and carried on two tasks
  later is not caught.
- **Usage, cost and prompts.** Every agent run's token usage (input, output, cache read/write) is
  stored with its cost, computed from the dated price table `src/core/harness/pricing.json` (USD per
  1M tokens, editable — bump its `version` / `effectiveDate` when you change a price; the codex model
  price is a marked placeholder) next to the cost the CLI itself reports. Runs also record attempts,
  rate-limit back-offs, round, task type and why they failed. Every prompt version hash recorded
  anywhere (runs, decisions, usage, ratings, feedback events, outcomes, review issues) resolves to its
  full text. The **Usage & prompts** page shows costs per role / model / prompt version / task,
  budget status, a per-prompt-version trend (rating agreement, mean delta, review pass and
  first-round pass rate), the calibration history of each role (revert to any earlier version) and every agent run with a paged event viewer. API:
  `GET /api/costs[?workspaceId=]`, `GET /api/runs/:id`, `GET /api/runs/:id/events?offset=&limit=`,
  `GET /api/prompts/:hash`, `GET /api/workspaces/:id/agent-runs`,
  `GET /api/workspaces/:id/metrics/prompt-versions[?role=]`,
  `GET /api/workspaces/:id/calibration/versions[?role=]`,
  `POST /api/workspaces/:id/calibration/versions/:versionId/revert`.
- **Lessons and the weekly retro.** Per role and per business, BIF watches recurring problems: review
  issue classes per task type, negative decision outcomes, run failures (not rate limits or other
  infrastructure), policy denials, your exclusions / corrections / rating disagreements on an agent's
  output, knowledge-store signals (zero-result searches, unused reads, duplicates, missing captions,
  rejected quotes), reviewer-audit misses (below) and signals other features record (`recordLessonSignal`;
  a note is kept only when it names a task, run or item that is not upload-derived or exposed). When one recurs in 3
  tasks, a rule is **proposed** on the **Lessons** page; you accept or reject it (with an optional
  reason), and only an accepted rule is appended to that role's prompt, tagged with a tracking
  marker (`[L-7F3A2C.v1]`), so the prompt version changes and every run's stored prompt shows which
  rules it had. The page shows each rule's effect: the category's rate before the rule and under its
  current version, and per prompt version (with pass rate, rating agreement and cost). The engine
  then proposes to strengthen a rule that keeps recurring, retire one after 10 clean tasks, or revert
  one whose rate did not drop after 5 tasks; each is again yours to accept. At most 15 rules per role.
  Rules are written from templates, never from stored text; examples quote review issues only when
  they are not upload-derived and not from an upload-exposed run or task (the export's rule), else
  they name the id. Every Monday 06:00 (`lessons.retro.cron`) the scheduler runs a **retro** per
  business: the `retro` agent reads a digest of the week (task results, costs, outcomes, review
  issues, failures, denials, your feedback, knowledge signals, rules and pending proposals; fixed size,
  redacted, fenced, logged as a read before the run starts) and proposes prompt rules and
  calibration notes citing digest ids — pending until you accept each one. Accepts and rejects are
  feedback events (`lesson_accept` / `lesson_reject`) with your `user.id`; accepts are also
  Decisions. API: `GET /api/workspaces/:id/lessons`, `POST …/lessons/evaluate`,
  `POST …/lessons/proposals/:pid/accept|reject` (`{reason?}`), `POST …/lessons/rules/:rid/propose-retire`,
  `POST …/lessons/retro`. Config: `lessons` (`enabled`, `minTasks`, `retireAfterCleanTasks`,
  `minEffectTasks`, `maxRulesPerRole` ≤ 15, `retro: { enabled, cron, model, windowDays, maxProposals }`).
  `lessons.enabled: false` is a kill switch: no proposals, no retro, and accepted rules leave every
  prompt (the new prompt versions are recorded). Runs that must not see lessons (experiment arms,
  reviewer audits) carry a stored lessons-off flag, so they keep it after a restart, and they feed no
  lessons either: their outcomes, ratings, feedback, failures and denials are not signals (reviewer
  audit misses count once, as described below).
- **Reviewer audits and experiments (learning loop WP-F).** *Audits:* a different model (another
  enabled provider than the original reviewer when there is one; `audit.model` in config overrides)
  re-reviews the N most recently verified tasks of one business tree that were not audited yet, with
  the reviewer's input for the final round (same prompt, prompt reads logged before the run starts,
  reads limited to the task's review slice) but without lesson rules, so it judges independently of
  what the reviewer learned. An audit never changes the task. When the
  auditor fails work the reviewer passed (a *miss*), the passing review gets a `weak-review` decision
  outcome (source `reviewer_audit`) and the miss counts once per issue class and task as a reviewer
  lesson signal for its tree. An auditor without a
  valid review is `invalid`, not a miss. Start one from the **Audits & experiments** page or
  `POST /api/workspaces/:id/audits {n?, taskIds?}`; schedule them with a cron
  (`POST /api/workspaces/:id/audit-schedules {cron, n}`, run by the normal scheduler, the same way as
  the weekly retro).
  *Experiments:* re-run a finished task as arm A and arm B (worker model and / or a stored worker
  prompt version; 1–5 repeats) through the normal review loop, with lessons off
  (`POST /api/workspaces/:id/experiments`). Tasks that use the browser are refused unless
  `experiments.allowBrowser` is true; then the request must carry `confirmBrowser: true` and the page
  says that real-world actions repeat for each arm and each repeat. The page compares review pass rate, first-round pass
  rate, rounds, review scores, your ratings and cost per arm (`GET /api/experiments/:id`). Arm tasks
  sit in their own research run; their outputs are retired when they end (nothing reaches findings,
  knowledge or synthesis), they write no outcomes and never ask you questions. Experiment and audit
  runs and their decisions are tagged (`experiment_id`, `arm`, `audit_id`), stay out of the
  prompt-version metrics, outcome reports, calibration and prompt-patch examples (your ratings of
  them still count in the arm comparison), count against budgets like any run, follow the same
  upload-exposure and export rules, and their export lines carry the tags.
- **Metrics (learning loop WP-G).** The **Metrics** page charts review pass rate, first-round pass
  rate, rounds to pass, run failure rate, cost and rating agreement per day or week, with tables per
  role / task type / prompt version / model (pass, rounds, review issues, failures, ratings, outcome
  labels, cost), failures by reason, review issues by class and the knowledge-store metrics (human
  reads apart). Scope is this part or the whole business, never another business. Experiment and
  reviewer-audit runs are left out unless you tick "Include experiment and audit runs". A lessons
  table shows each lesson rule's effect per prompt version (the same figures as the **Lessons** page). The training-export exclusion summary is
  computed only when you press its button (it runs the whole export). API:
  `GET /api/workspaces/:id/metrics[?scope=tree|node&since=&until=&groupBy=role|task_type|prompt_version|model&bucket=day|week&includeExperiments=1]`.
- **Scheduler and "What changed".** Recurring jobs per workspace (cron) re-run phases; each run is
  diffed against the previous run of the same phase and schedule, shown on the Research page. The
  diff lists the facts the run replaced (old → new), retracted and confirmed (from its applied fact
  changes), new findings (text matching only for facts saved as `new`), subjects no longer found and
  changed screenshots. The same step records the decision outcomes once each through one path: the
  run's lineage outcomes, `contradicted` (a previous fact the run neither confirmed, replaced nor
  retracted, when it saved a new fact on the same subject with another claim), `changed` (a cited
  screenshot changed) and `stale` (past its TTL). Replaying the step after a restart adds nothing.

## Where data lives

Under `dataDir` (default `./data`, gitignored):

| Path | Contents |
|---|---|
| `data/bif.db` | SQLite, one database for every business: workspaces, interview, runs, decisions, outputs, the learning-loop tables and the knowledge store (tables by area: design spec §5.1) |
| `data/<workspaceId>/artifacts/` | screenshots, page snapshots, documents and uploads (content-addressed by sha256) |
| `data/<workspaceId>/personas/<persona>.md` | compiled persona prompt (latest version; `<persona>.v<N>.md` keeps each version) |
| `data/<workspaceId>/runs/<agentRunId>/` | per-run working directory (`cwd/`), event log (`events.jsonl`) and the full prompt (`prompt.md`; `prompt.attemptN.md` per rate-limit retry) |
| `data/<rootWorkspaceId>/calibration/<role>.md` | current approved prompt calibration of one business tree (every earlier version is kept in the database, `calibration_versions`) |
| `data/browser-profile/` | the research browser profile (`browser.profileDir`) |

Approved prompt patches are per business: they are merged (appended, deduplicated) into
`data/<rootWorkspaceId>/calibration/<role>.md` of the workspace's tree root and only reach prompts
of that business tree — another company's prompts never see them. Nothing is written under `src/`.

## Smoke test

`npx tsx scripts/smoke.ts` boots the real server on a temporary data dir and runs, per provider:

- a real worker run (`log_decision`, then `submit_result`, through the real MCP server);
- a shared-browser run;
- the **knowledge-store flow**.

It then does an interview round-trip over HTTP with the claude CLI as interviewer.

The knowledge flow uses the real worker system prompt, a real task and a verified fact seeded
from an earlier task. The worker:

1. saves a local HTML page with `save_artifact` and a description;
2. runs `search`;
3. `expand`s a passage;
4. saves a finding with a verified quote;
5. saves a near-duplicate and answers the duplicate check;
6. reads the page text page by page with `read_artifact` and the cursor;
7. recovers from a quote that fails verification.

Each step is judged from the store and the run's tool calls. The check covers:

- `retrieval_events` rows and `promptStoreGaps`;
- a replay of the paged reads, which checks that every passage was served whole;
- tokens and cost from `agent_usage`.

Run one part with `worker`, `browser`, `knowledge` or `interview`, optionally followed by providers
(`claude`, `codex`, `opencode`). Set models with `BIF_SMOKE_CLAUDE_MODEL`, `BIF_SMOKE_CODEX_MODEL`
and `BIF_SMOKE_OPENCODE_MODEL`, the per-run limit with `BIF_SMOKE_TIMEOUT_MS`, and keep the knowledge
smoke's temp dir with `BIF_SMOKE_KEEP=1`. Latest results: [docs/smoke-results.md](docs/smoke-results.md).

## Known limitations

- **OpenCode is unverified end to end.** No live OpenCode run has succeeded yet. See
  [docs/smoke-results.md](docs/smoke-results.md).
- **OpenCode rate limits can hang a run until `limits.idleTimeoutMs`.** On the free tier OpenCode
  retries 429s internally without printing anything to stdout (stderr output is not guaranteed), so
  the idle watchdog ends the run (default 10 minutes), the run is marked failed (not rate-limit
  retried) and the task's one retry applies. Rate-limit text that OpenCode does print on stderr is
  detected, but it does not shorten the hang. Lower `idleTimeoutMs` if you use OpenCode's free tier.
- **Claude runs inherit your global Claude Code hooks and plugins**; isolating them breaks OAuth.
- **Config changes** to worker/browser limits and the port need a restart. (`BIF_DATA_DIR`/`PORT`
  overrides are runtime-only and are not written into `bif.config.json` when you save settings.)
- **Rate-limit back-off holds the worker slot** while waiting (up to 15 minutes).
- **"What changed" only compares screenshots that findings or confirmations cite.**
- **User, scheduler and calibration decisions** are stored as orchestrator decisions with
  `payload.actor` telling them apart. User decisions (weight changes, prompt patch approvals and
  calibration reverts) record your `user.id` as the run id; approvals and reverts also record the
  role's resulting prompt version (worker / synthesizer: the base worker prompt without task-type
  extras; persona: the persona calibration appendix).
- **Local only, no authentication.** The server rejects requests whose `Host` is not
  `127.0.0.1`/`localhost` (DNS rebinding), requires JSON (or multipart uploads) on state-changing
  requests and refuses non-local `Origin`s. Artifacts are served with `Content-Security-Policy:
  sandbox` and `nosniff`; HTML/SVG snapshots download instead of rendering. PDFs (filings) are the
  exception to the sandbox: browsers refuse to show a sandboxed PDF, so they open inline with
  `nosniff` only. Any other program on your
  machine can still call the API.
- Review-gate history and open items per section: [docs/superpowers/verify-log.md](docs/superpowers/verify-log.md).

Created in [T3 Code](https://t3.codes).
