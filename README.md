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
   - `loop`: review loop `maxRounds` / `passThreshold`, globally and per task type.
   - `limits`, `browser`, `identity`, `actionPolicy`, `scoring`, `server.port`, `dataDir`.

   Without a `bif.config.json` the built-in defaults are used. The Settings page edits the same file.
3. **Log in to each enabled CLI** once in a terminal, so agent runs can use your existing auth:
   - `claude` (Claude Code), `codex` (Codex CLI), `opencode` (OpenCode; disabled in the example).
   - Check with `npm run smoke` (see [Smoke test](#smoke-test)).

### Research browser profile

Agents browse in a **dedicated, persistent research profile**, never your everyday browser profile.
It stays logged into the throwaway accounts the agents create.

- **MCP backend** (`"browser": {"backend": "mcp"}`, default): browser-using runs get the MCP
  servers listed in `browser.mcpServers`. Every `{{profileDir}}` in them is replaced with the
  absolute path of `browser.profileDir`, so point the browser server's profile flag at it:

  ```json
  "browser": {
    "backend": "mcp",
    "mcpServers": {
      "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--user-data-dir", "{{profileDir}}"] }
    },
    "profileDir": "data/browser-profile"
  }
  ```

  Chrome DevTools MCP works the same way, for example
  `{"command": "npx", "args": ["chrome-devtools-mcp@latest", "--user-data-dir", "{{profileDir}}"]}`.
  Always use `{{profileDir}}` (or an absolute path): agent CLIs run in their own per-run working
  directory, so a relative path would create a fresh, empty profile for every run. To log the
  profile into a site by hand, launch the same browser server once with that profile directory.
- **T3 backend** (`"backend": "t3"`): no browser MCP server is passed; agents are told to use the
  T3 Code browser tools. This only works when the agent CLIs run inside T3 Code with those tools
  available. The profile is then whatever T3 Code's browser uses.

`limits.maxBrowserRuns` (default 2) caps concurrent browser-using runs.

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
work on start and runs scheduled jobs (missed runs execute once on the next start).

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
  proposes tasks; the program validates them against the config limits and runs the workers.
- **Review loop.** Every worker result goes to a new reviewer run with minimal context, which scores
  it 0–10 and lists issues (`blocking | substantive | nit | scope_expansion`). Score ≥ `passThreshold`
  (default 8) → *verified*. Otherwise the worker fixes or pushes back (pushback on nits and scope
  expansion is expected and logged) and resubmits, up to `maxRounds` (default 3); then it stays
  *unverified* and is flagged with that status. Only verified findings feed recommendation
  synthesis; on the Findings page you can include an unverified finding (or exclude a verified
  one) with the "Use in recommendations" toggle.
- **Evidence rule.** Every finding cites at least one stored artifact: screenshots per flow step,
  archived pages, documents or uploads. Recommendations cite findings, so the UI can trace
  recommendation → findings → artifacts.
- **Action policy.** Agents may browse, sign up with disposable identities and walk checkout up to
  payment. Payment details, demo requests and contacting real people need your approval (the
  "Waiting on you" banner). Purchases are never made.
- **Personas are simulated.** Persona profiles are researched with evidence, compiled into persona
  prompts, and every recommendation is put to each persona. Their feedback is labelled *simulated*,
  shown in its own column, and has weight 0 in priority unless you change `scoring.personaWeight`.
- **Ratings and calibration.** Every criterion value on every item can be rated: agree, or disagree
  with your own value and reason (inline or in the Review queue). Priority is a weighted combination
  of recommendation criteria; the Strategy page edits the weights and offers weights refit from your
  priority overrides (never auto-applied). The Decision log page proposes prompt patches per role from
  your disagreements; you edit and approve them before they are written. Weight changes and patches
  are logged as decisions. The decision log plus ratings export as JSONL.
- **Scheduler and "What changed".** Recurring jobs per workspace (cron) re-run phases; each run is
  diffed against the previous run of the same phase (new findings, subjects no longer found, changed
  screenshots), shown on the Research page.

## Where data lives

Under `dataDir` (default `./data`, gitignored):

| Path | Contents |
|---|---|
| `data/bif.db` | SQLite: workspaces, interview, tasks, runs, findings, decisions, ratings, schedules, ... |
| `data/<workspaceId>/artifacts/` | screenshots, page snapshots, documents and uploads (content-addressed by sha256) |
| `data/<workspaceId>/personas/<persona>.md` | compiled persona prompts |
| `data/<workspaceId>/runs/<agentRunId>/` | per-run working directory (`cwd/`) and event log (`events.jsonl`) |
| `data/browser-profile/` | the research browser profile (`browser.profileDir`) |

Approved prompt patches are written to `src/core/prompts/calibration/<role>.md`
(override with `BIF_CALIBRATION_DIR`).

## Smoke test

`npx tsx scripts/smoke.ts` boots the real server on a temporary data dir and runs one real worker
per provider (call `log_decision`, then `submit_result`, through the real MCP server), then an
interview round-trip over HTTP with the claude CLI as interviewer. `worker [claude|codex|opencode]`
or `interview` runs a subset; models are set with `BIF_SMOKE_CLAUDE_MODEL`, `BIF_SMOKE_CODEX_MODEL`,
`BIF_SMOKE_OPENCODE_MODEL`. Latest results: [docs/smoke-results.md](docs/smoke-results.md).

## Known limitations

- **OpenCode is unverified end to end.** No live OpenCode run has succeeded yet. See
  [docs/smoke-results.md](docs/smoke-results.md).
- **OpenCode rate limits can hang a run until `limits.idleTimeoutMs`.** On the free tier OpenCode
  retries 429s internally without printing anything to stdout (stderr output is not guaranteed), so
  the idle watchdog ends the run (default 10 minutes), the run is marked failed (not rate-limit
  retried) and the task's one retry applies. Rate-limit text that OpenCode does print on stderr is
  detected, but it does not shorten the hang. Lower `idleTimeoutMs` if you use OpenCode's free tier.
- **Claude runs inherit your global Claude Code hooks and plugins**; isolating them breaks OAuth.
- **Config changes** to worker/browser limits and the port need a restart. When started with
  `BIF_DATA_DIR`/`PORT`, saving the config from the UI persists those overridden values.
- **Rate-limit back-off holds the worker slot** while waiting (up to 15 minutes).
- **"What changed" only compares artifacts that findings cite.**
- **User, scheduler and calibration decisions** are stored as orchestrator decisions with
  `payload.actor` telling them apart.
- **Local only, no authentication.**
- Review-gate history and open items per section: [docs/superpowers/verify-log.md](docs/superpowers/verify-log.md).

Created in [T3 Code](https://t3.codes).
