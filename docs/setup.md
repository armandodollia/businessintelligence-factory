# Setup and running

How to install BIF, sign in to the agent command-line tools (CLIs), set up the research browser,
and start the server. For every configuration key, see [configuration.md](configuration.md).

## Install

1. Install **Node 25 or later**, then run `npm install`.
2. Copy the example configuration and edit it:

   ```sh
   cp bif.config.example.json bif.config.json
   ```

   Without a `bif.config.json` the built-in defaults are used. The Settings page edits the same file.
   The keys are described in [configuration.md](configuration.md).
3. **Log in to each enabled CLI** once in a terminal, so agent runs can use your existing sign-in:
   - `claude` (Claude Code),
   - `codex` (Codex CLI),
   - `opencode` (OpenCode; disabled in the example file).

   Check that they work with `npm run smoke` (see [smoke-tests.md](smoke-tests.md)).

## Running

| Command | What it does |
|---|---|
| `npm start` | API + harness MCP + built web app on `http://127.0.0.1:4317` |
| `npm run dev` | same, restarting on source changes |
| `npm run web` | Vite dev server for the web app (proxies `/api` and `/mcp` to port 4317); run alongside `npm start` |
| `npm run build:web` | builds `web/dist`, which `npm start` serves at `/` |
| `npm test` / `npm run typecheck` | tests (vitest) and type checks |
| `npm run smoke` | real-CLI smoke test (spends a little real model usage) |

Environment overrides for `npm start`:

| Variable | Overrides |
|---|---|
| `BIF_CONFIG` | the config file path (default `bif.config.json` in the working directory) |
| `BIF_DATA_DIR` | `dataDir` |
| `PORT` | `server.port` |

`BIF_DATA_DIR` and `PORT` apply at runtime only. They are not written into `bif.config.json` when
you save settings.

The server binds to `127.0.0.1` only and has no authentication (see
[privacy-and-export.md](privacy-and-export.md#local-only-server)). While it runs it:

- resumes interrupted work on start: an interrupted pipeline continues its current and remaining
  phases, and a scheduled one then records "what changed";
- runs scheduled jobs; missed runs execute once on the next start.

Changes to worker or browser limits and to the port need a restart.

## Research browser profile

Agents browse in a **dedicated, persistent research profile**, never your everyday browser profile.
It stays logged into the throwaway accounts the agents create. The `browser` block chooses how.

### MCP backend, shared server (the default)

`"backend": "mcp"`, `"mode": "shared"`. The harness starts **one** browser MCP server
(`browser.shared`) the first time a run needs a browser. Every browser-using run connects to it over
HTTP (`http://127.0.0.1:<port>/mcp`, MCP server name `browser`). All runs share one browser on one
persistent profile. Each agent is told to open its own tab, work only there and close it when done.
The default is a pinned Playwright MCP:

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

Placeholders in `args` (and in the optional `env` map of `browser.shared`):

| Placeholder | Value |
|---|---|
| `{{profileDir}}` | absolute `browser.profileDir` |
| `{{port}}` | `browser.shared.port` (0 picks a free port) |
| `{{outputDir}}` | a folder under the OS temp dir where screenshots land (agents can pass those files to `save_artifact`) |

`browser.shared.path` defaults to `/mcp`.

The server runs in its own process group and logs to `data/browser/shared-server.log`. It is
restarted if it dies and stopped when the app stops. A leftover from a crash is killed at the next
start. It opens a visible Chrome window. That window is also where you log the research profile
into a site by hand when an agent asks you to.

### MCP backend, per-run servers

`"mode": "per_run"`. Each browser-using run spawns `browser.mcpServers` itself (stdio), with
`{{profileDir}}` substituted as above. A profile can be open in only one browser at a time, so this
mode caps `limits.maxBrowserRuns` at 1 (with a startup warning). Always use `{{profileDir}}` (or an
absolute path): CLIs run in a per-run working directory, so a relative path would create a fresh,
empty profile for every run.

With backend `mcp` and no browser configured (no `shared` in shared mode, empty `mcpServers` in
per-run mode) the app warns at startup and `propose_tasks` rejects tasks with `needs_browser`.

### T3 backend

`"backend": "t3"`. No browser MCP server is passed; agents are told to use the T3 Code browser
tools. This only works when the agent CLIs run inside T3 Code with those tools available.

The harness cannot choose or check the browser profile in this mode: agents use whatever profile T3
Code's browser is running with. The same rule still applies, so it must be a **dedicated research
profile, never your everyday one**. Before using this backend:

- run the app from a T3 Code project or environment set aside for research, whose browser is signed
  into nothing personal (no personal email, banking, password manager or SSO sessions);
- check by opening the T3 Code browser and confirming it has none of your own sessions or saved
  passwords;
- if you cannot guarantee that, use the MCP backend with `{{profileDir}}`, where the harness enforces
  the separate profile itself.

### Browser concurrency

`limits.maxBrowserRuns` (default 2) caps concurrent browser-using runs.

## Agent CLI isolation

Each CLI is started so that it sees only BIF's tools, as far as the CLI allows.

- **Codex** runs with its own `CODEX_HOME` (`data/cli-state/codex-home`): a generated, empty
  `config.toml` and `auth.json` symlinked to yours (`$CODEX_HOME` or `~/.codex`). So your Codex MCP
  servers, plugins and hooks are not loaded; only `bif` (and `browser`) are passed with `-c`. Sign in
  with `codex login` as usual. The link is a symlink so a token refresh made during a run lands in
  your own file. It is re-created before every run if missing or replaced.
- **OpenCode** reads only the generated `.bif-opencode.json` (`OPENCODE_CONFIG`), with project
  configs disabled and the global config dir redirected to `data/cli-state/opencode-config`.
  Credentials stay in OpenCode's data dir, so logins keep working.
- **Claude Code** gets `--strict-mcp-config` (only `bif` and `browser`), but still loads your global
  hooks and plugins (see [known-limitations.md](known-limitations.md)).
- **Run tokens** (the per-run MCP credential) never go on a command line. Claude Code and OpenCode
  read them from a generated config file in the run directory; Codex from the `BIF_MCP_TOKEN`
  environment variable (sent as a bearer header to `/mcp`).
- `save_artifact` with `file_path` only accepts files inside the run's working directory or the OS
  temp dir (outside the data dir), after resolving symlinks.
