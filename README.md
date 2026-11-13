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
- **Review history and disputes.** Every review round's issues are kept (`review_issues`), with
  stable issue ids across rounds when the reviewer repeats an issue, and each issue's fate: `open`,
  `fixed`, `pushed_back`, `upheld` (reasserted after a pushback) or `withdrawn` (dropped after a
  pushback). The next reviewer sees the issues the worker pushed back on, with the worker's reason,
  and must accept or reassert each; after `loop.maxReasserts` reasserts the worker is told to fix it.
- **Decision outcomes.** Agent decisions get labels after the fact (`decision_outcomes`): `confirmed`
  (task verified), `over-scoped` / `missed-evidence` / `weak-review` (task unverified),
  `run-failed`, `missed-evidence` (output superseded by a later round), `stale` (a scheduled re-run
  changed or no longer found a finding), `user-rejected` (you excluded an output or rejected a unit
  proposal; excluding a verified output also marks the passing review `weak-review`),
  `reviewer-false-positive` (an issue dropped after a pushback) and `worker-miss` (an upheld issue
  the worker then fixed). The Decision log shows the counts per role, task type and prompt version
  (this workspace or the whole business tree).
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
  with your own value and reason (inline or in the Review queue). Ratings are kept as history:
  changing a rating adds a new row and the latest one is what the UI shows as your current rating
  (re-submitting an unchanged rating sends nothing). Priority is a weighted combination
  of recommendation criteria; the Strategy page edits the weights and offers weights refit from your
  priority overrides (never auto-applied). Worker pushbacks are ratable too (criterion `pushback`, 0–1:
  how justified it was). The Decision log page proposes prompt patches per role from
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
| `data/<workspaceId>/personas/<persona>.md` | compiled persona prompt (latest version; `<persona>.v<N>.md` keeps each version) |
| `data/<workspaceId>/runs/<agentRunId>/` | per-run working directory (`cwd/`) and event log (`events.jsonl`) |
| `data/<rootWorkspaceId>/calibration/<role>.md` | approved prompt calibration patches of one business tree |
| `data/browser-profile/` | the research browser profile (`browser.profileDir`) |

Approved prompt patches are per business: they are merged (appended, deduplicated) into
`data/<rootWorkspaceId>/calibration/<role>.md` of the workspace's tree root and only reach prompts
of that business tree — another company's prompts never see them. Nothing is written under `src/`.

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
- **Config changes** to worker/browser limits and the port need a restart. (`BIF_DATA_DIR`/`PORT`
  overrides are runtime-only and are not written into `bif.config.json` when you save settings.)
- **Rate-limit back-off holds the worker slot** while waiting (up to 15 minutes).
- **"What changed" only compares artifacts that findings cite.**
- **User, scheduler and calibration decisions** are stored as orchestrator decisions with
  `payload.actor` telling them apart.
- **Local only, no authentication.** The server rejects requests whose `Host` is not
  `127.0.0.1`/`localhost` (DNS rebinding), requires JSON (or multipart uploads) on state-changing
  requests and refuses non-local `Origin`s. Artifacts are served with `Content-Security-Policy:
  sandbox` and `nosniff`; HTML/SVG snapshots download instead of rendering. PDFs (filings) are the
  exception to the sandbox: browsers refuse to show a sandboxed PDF, so they open inline with
  `nosniff` only. Any other program on your
  machine can still call the API.
- Review-gate history and open items per section: [docs/superpowers/verify-log.md](docs/superpowers/verify-log.md).

Created in [T3 Code](https://t3.codes).
