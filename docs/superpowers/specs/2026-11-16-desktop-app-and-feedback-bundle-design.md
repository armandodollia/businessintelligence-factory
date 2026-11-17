# Desktop app and feedback bundle — design

Date: 2026-11-16. Status: requested by the owner on 2026-11-16 (a packaged app for macOS and one for
Windows, to send to beta testers, with a feedback bundle that includes every analytic the retro uses).
Decisions the owner did not state are marked **(my call)**. Two questions are open and do not block
the build: whether builds are signed, and who tests on Windows (§9).

## 1. Intent

A beta tester installs one application, starts it, and uses BIF on their own machine with their own
agent CLI subscription. There is no central server. When asked, the tester saves one file, the
feedback bundle, and sends it to the owner, who can read one bundle or many together.

## 2. Goals, non-goals, anti-goals

Goals

1. A macOS application (`.dmg`, Apple silicon and Intel) and a Windows installer (`.exe`, x64) built
   from one codebase by one command and by a hosted build.
2. No developer tools needed on the tester's machine: no Node install, no `npm`, no build step.
3. A first-run check that says which agent CLIs are installed and signed in and what is missing,
   without spending model usage.
4. The tester's data in the per-user application folder, kept across updates.
5. A feedback bundle: one file with every figure and signal the retro, the lessons engine and the
   metrics view read, plus what is needed to interpret them (versions, configuration without
   secrets), and nothing of the tester's research content by default.
6. A reader that turns one or many bundles into a report.
7. `npm start` in a checkout keeps working exactly as today.

Non-goals

- Bundling the agent CLIs or their logins. They are the tester's own.
- Automatic updates **(my call: a beta build is replaced by installing the next one)**.
- A central collection service. The tester sends the file by their own means.
- Linux packages.

Anti-goals

- A bundle that contains uploads, upload-derived text, stored site passwords, the tester's research
  findings or the names of the businesses researched, unless the tester chose the fuller level.
- A bundle written anywhere but where the tester chose, or sent anywhere by the application.
- A packaged app that silently loads the tester's everyday browser profile or other CLI settings
  (the existing isolation rules hold).
- A Windows build described as working before real agent runs were made on Windows.

## 3. Feedback bundle

### 3.1 What it is

One file, `bif-feedback-<date>-<short id>.json.gz`: gzip-compressed JSON with named sections. The
tester makes it on a "Send feedback" page: choose the period (default: everything), the level, add an
optional note, see the preview (each section with its row count and size, and the first rows on
demand), then "Save". In the desktop app a save dialog chooses the place; in the browser version the
file downloads. The application sends nothing. The preview and the saved file are built separately:
the saved file has its own bundle id and holds the rows that exist when "Save" is pressed.

### 3.2 Levels

- **Standard (default):** numbers, labels, ids, classes, timings, versions and the tester's own
  feedback (ratings with their reasons, accept / reject decisions with their reasons, corrections).
  No research content: no finding, recommendation, persona or stakeholder text, no review-issue
  text, no prompts sent to agents, no agent output, no evidence, no interview text. A failure is
  carried as its class and the first line of its message (at most 200 characters); the full message
  is only in the fuller level.
- **With review texts (opt-in):** adds the text of review issues and council findings, failure
  messages in full, and the decision lines of the existing training export. The existing export
  rules apply unchanged: uploads, upload-derived text and internal stakeholder records stay out.

In both levels: business and node names are replaced by their ids; the tester is recorded as
`tester` (the configured user id is not written); stored site passwords are redacted with the
existing redaction; configuration is written without secrets (`telemetry.otlp.headers`, identity
passwords) and without `dataDir` or other machine paths; file paths in failure messages are cut to
their last segment. The tester's reasons are their own words and are included as typed, after the
same redaction; the page says so next to the note field. One exception: a reason typed on a record
that is itself internal or derived from an upload (a record the default training export would not
carry) is withheld, because it may repeat upload text. The row then says `reasonWithheld: true`
in place of the reason.

Known limits of the redaction: a file path that has spaces, is not quoted and is not under a folder
the tool knows (the data folder, the browser profile, the home folder, the temporary folder) loses
its home folder but keeps what follows its first space (a Windows path too; an accepted limit); a
relative path is left as it is; a name shorter than four characters is replaced only as a whole word
in its own case; and a single lower-case word stored under a label field (`action`, `status`, `kind`
and the like) is kept as a label.

As built after the council's first round (2026-11-16):

- **Keys.** A record whose shape is not the tool's (a before / after value, an outcome's evidence,
  a digest, statistics) keeps a key only when it is a plain identifier (a letter, then up to 39
  letters, digits or underscores) that no redaction rule flags; any other key is written `key_1`,
  `key_2`, … per record. An edit of the profile, whose shape the interviewer chose, carries no part
  of the profile: only which top-level sections changed and how many values each held before and
  after. The whole-bundle redaction (names, the user id, stored passwords, paths) applies to the
  keys of every section as to the values. One ruling: a key that is a plain identifier is, outside
  `texts`, replaced by a name only when the whole key is that name, because the field names of the
  bundle are such identifiers and a business unit called "Research" must not turn `researchRunId`
  into a key no reader knows. The keys of the manifest are fixed names and stay.
- **Withheld research.** No failure reason of a withheld run or task (stakeholder design §7) reaches
  a bundle at either level, by any section: such a run, task, arm task of an experiment, experiment
  or research run says that it failed and nothing more; a retro or persona-learning run likewise
  when its agent run is withheld or it learns about a stakeholder not yet opened. The metrics
  section counts the failed runs of withheld research under their failure class alone.
- **Web addresses.** At the standard level a web address in any carried text (a failure's first
  line, a reason or note the tester typed, a key) is written `<url>`; the fuller level keeps them.
  An address is known by its scheme (`http`, `https`, `ws`, `wss`, `ftp`) or a leading `www.`; a
  bare host name is not recognised.
- **The period** bounds every table whose rows have a time, the recurrence of review issues
  included. The exceptions are named in `docs/feedback-bundle.md`.
- **Failure messages in full** (the fuller level) are carried for every record whose failure a
  standard section shortens: runs, attempts, tasks, research runs, experiments, retros and
  persona-learning runs, under the withholding above.

As built after the council's second round (2026-11-16):

- **A word of a name.** The name rules know the names of the businesses and their nodes and the
  scope names of the nodes. Besides each whole name, each distinctive word of a name is replaced
  by the node's id on its own, as a whole word in any case ("the report for Quillfeather" when
  the business is "Quillfeather Logistics"). A word is distinctive when it has four characters or
  more and a letter, is not in the list of common words (`src/core/feedbackBundle/commonWords.ts`:
  everyday English and the words many business names share, about four hundred), and is not a word
  the tool itself writes (its labels, phases and own things) or of a configured model. In the key of a free-form record such a word
  counts also inside a longer identifier (`zephyrineShare`): the key is written `key_1`, … (in
  `texts`, the word in it is replaced). Limits: a common word of a name ("Logistics", "Group") is
  not replaced on its own; a distinctive word inside a longer word of a text is not replaced; a
  field name of the bundle is left as it is. Names of competitors, stakeholders and personas are
  not known to the name rules: they are research content, which no standard section copies, and
  in a reason the tester typed they stay as typed.
- **Names and the tool's own figures.** A name rule changes no id, label, phase, task type, tool
  or event name, model or provider name, `tester` or placeholder. A letter, a digit or `_` on
  either side of a name or of a word of one means it is inside a longer word or identifier, and
  nothing is replaced there (`arun_01…`, `phase_skipped`). A string that is an id as a whole (a
  stored id, or ids and labels joined by colons, such as a council round id) is not searched for
  names. The tool's own words are built from the constants that define its labels, and from the
  model and provider names of the configuration; a business whose name is one of them is not
  replaced by that word alone. Of the manifest only the note is searched for names.
- **Labels.** A value kept as a label under a label field has no dot: a host name
  (`rival-site.example`) is dropped like any other text.
- **A request closed by "Stop research"** is stored as `denied` with the stop's response. Its row in
  `requests` says `closedBy: 'stop'`; the reader counts such requests apart from the denials by the
  person and leaves their wait out of the median.

### 3.3 Sections

Each section is the output of an existing query, per business tree, never re-derived:

| Section | Source |
|---|---|
| `manifest` | bundle format version, app version, database schema version, platform and architecture, Node version, agent CLI names and versions as detected, period, level, the tester's note, row counts per section |
| `configuration` | the effective configuration, redacted as in §3.2 |
| `trees` | per business tree: ids, depth, counts of nodes, tasks, findings, recommendations, personas (no names) |
| `runs` | agent runs: role, provider, model, kind (normal, experiment, audit or council member, with the experiment, audit or council round it belongs to), task type, round, number of attempts, status, exit code, failure class and the first line of the failure message, start, end, duration, prompt version; per-run usage and cost; and each attempt of a run with its timings, exit code and whether it was rate limited. The store keeps no effort, request kind or idle time per run, so the bundle has none: effort appears where it is stored (persona panel reads, the configuration) |
| `tasks` | tasks: type, status, rounds, failure class, whether a council reviewed it, timings |
| `reviewRounds` | review-issue history: per issue the class, round, status (fixed, pushed back, upheld, withdrawn), reviewer model; council rounds: members, lenses, scores, states, counts of upheld / advisory / dropped / questions |
| `outcomes` | decision outcomes with their labels |
| `lessonSignals` | every signal the lessons engine collects (`collectLessonSignals`): role, category, unit, source |
| `lessons` | lesson rules with their effect figures, proposals and how they were decided, retro records with their digest counts |
| `feedback` | the feedback log (kind, target type, target id, before / after values that are numbers or labels, reason) and ratings (target, criterion, agent value, tester value, reason); a reason is withheld (`reasonWithheld: true`) where §3.2 says so |
| `policy` | policy events: kind, action class, counts |
| `knowledge` | the knowledge-store metrics and signals as the metrics view computes them |
| `metrics` | the metrics report per tree: by week, and by role, task type, model and prompt version |
| `audits` | reviewer-audit results and experiment summaries |
| `personas` | persona learning runs and proposals (counts, decisions), panel figures (rounds, unavailable, marked against the baseline), user-persona gate figures; no persona text |
| `escalations` | escalations: task type, how many questions, how answered |
| `budgets` | budget events: caps reached, extensions asked and decided |
| `requests` | requests to the person: kind, how long they waited, how answered (no text), `closedBy: 'stop'` on one that "Stop research" closed |
| `texts` | only at the fuller level: review-issue and council-finding texts by id, full failure messages, the training export lines |

A test enumerates what the retro digest, `collectLessonSignals` and `metricsReport` read and fails
when one of their sources has no section, so a signal added later cannot be left out unnoticed.

### 3.4 The reader

`npm run feedback:report -- <files or folders>` reads bundles and writes one Markdown report: per
tester (bundle id) and combined: runs and failures by class, pass rate and rounds to pass, cost and
tokens by role and model, the most frequent lesson-signal categories, rating agreement, council and
panel figures, requests and how long they waited, versions and platforms. It refuses a file whose
format version it does not know and says so.

## 4. The packaged app

### 4.1 Shape

An Electron shell around the existing server **(my call: the tool is already a local server with a
web app; a window around it reuses everything, and one toolchain builds both platforms)**.

- The shell starts the server as a child process and opens a window on its address
  (`http://127.0.0.1:<port>`). The port is chosen free at start. A second launch focuses the first.
- The server runs on a Node runtime that has what the code needs (Node 25, `node:sqlite`). If the
  Electron version in use carries such a Node, the shell runs the server with it; otherwise the
  matching Node binary is shipped inside the app and used **(the builder checks and reports which)**.
- The server code is compiled and bundled at build time (no `tsx` at run time). Prompts, the price
  table, migrations and the built web app are shipped as resources and found relative to the app,
  not the working directory.
- Quitting the app stops the server, which stops running agents and the research browser as today.

As built (server side):

- `npm run build:server` writes `dist/server/`: `main.js` (the server and every package it uses, in
  one file), `prompts/`, `pricing.json`, `web/`, a `package.json` with the version, and
  `node_modules/` with the research browser (§4.4). There are no migration files: the database
  schema is in the code. `node dist/server/main.js` runs from any working directory and finds its
  resources next to itself; `BIF_RESOURCES_DIR` names another resources directory.
- The shell passes the application folder as `BIF_APP_DIR` and may pass the app version as
  `BIF_APP_VERSION` (else the version in the shipped `package.json` is used).
- With `BIF_APP_DIR` the server listens on a free port, and prints one line `BIF_PORT=<port>` on its
  standard output before any other line about listening. `PORT` still sets a fixed port; `PORT=0`
  asks for a free one in a checkout too, with the same line.
- `GET /api/health` answers the version and what the server found in its resources (the version of
  a prompt, the price table's version, whether the web app is served); 503 with the reasons when a
  resource is missing.

As built (the shell, `desktop/`):

- **The runtime.** The pinned Electron (45.3.2) carries Node 24.22.2, not Node 25. `node:sqlite`
  works on it, the bundled server runs on it and the whole test suite passes on it
  (`npm run test:desktop-runtime`), so the shell runs the server with the app's own program as Node
  (`ELECTRON_RUN_AS_NODE`, with `ELECTRON_NO_ASAR` so its file functions are plain Node's) and no
  separate Node binary is shipped. Each build checks this before it packs anything. The price: the
  app runs on another Node version than a checkout does.
- **One instance.** A second launch brings the first window forward and ends; it starts no server.
- **The server's environment.** The `PATH` a terminal would have: on macOS and Linux read once from
  the person's login shell, on Windows from the registry (machine, then user), else the app's own
  `PATH` plus the usual install folders that exist. The read has a hard limit of eight seconds: a
  shell that has not answered by then (an interactive shell ignores the polite stop) is stopped by
  force with everything it started, by process id, and what it printed until then is used, else
  the usual folders. `PORT`, `BIF_CONFIG`, `BIF_DATA_DIR` and `BIF_RESOURCES_DIR` are not passed
  on; on Windows under any case of their names.
- **What the server passes on to the programs it starts.** `ELECTRON_RUN_AS_NODE` and
  `ELECTRON_NO_ASAR` are for the app's own program. An agent CLI (a run, the OCR call, a command of
  the setup check) is started without them, so that it, and any Electron program an agent starts,
  runs as itself. A process started with the program the server itself runs on keeps them, because
  that program cannot run a script without them: the shipped research browser, and on Windows an
  agent CLI that is a script with no Node of its own. A checkout has neither variable and is
  unaffected (`childEnv` in `src/core/harness/platform.ts`).
- **Stopping.** The shell asks: it writes the line `BIF_SHUTDOWN` to the server's standard input and
  closes it, waits up to fifteen seconds, and only then stops the process tree it started. The
  server reads its input only when the shell set `BIF_SHUTDOWN_ON_STDIN=1`; the end of the input
  counts as the same request, so a server whose shell was killed stops by itself (that nobody reads
  its output any more does not end it: a line it cannot print is dropped).
- **One shutdown.** However often and by whatever way a shutdown is asked for (a second SIGINT or
  SIGTERM, the shutdown line after a signal), there is one: every later request waits for the one
  that runs, the signal handlers stay registered, and nothing ends the process before the agents
  are stopped (`src/core/runtime/shutdown.ts`). The kill grace and the shutdown limit are options
  of the server entry (`runEntry`), so the forced stop is tested with a real server process.
- **Quitting stops the agents.** The server's shutdown (the shutdown line, the end of its input,
  SIGTERM, SIGINT; so also Ctrl-C in a checkout) first stops every agent CLI it started, each with
  the processes that CLI started: a polite stop, five seconds of grace, then by force. It waits for
  them, then stops the research browser and closes. A shutdown that takes longer than twelve seconds
  stops what is left by force and exits. A run stopped this way is not closed out: its record still
  says `running` and its task is untouched, exactly as a crash would leave them, so the recovery of
  the next start (`resumeInterrupted`) fails the run, queues the task again and continues the
  research. From the moment the shutdown begins the supervisor starts no run and reports no run as
  ended. A reading of a scan or image that is in flight (the OCR call) is not stopped by this: the
  server waits for it within the same twelve seconds.
- **The window.** One window on `http://127.0.0.1:<port>`: context isolation, a sandbox, no Node
  integration, no preload script, no `webview`, no permission granted, no request to any other
  origin. A link to another web address opens in the system browser; so does a link that asks for
  a new window, the server's own files among them. Closing the window quits the app. The window's
  options and the rules of its session are in `desktop/window.ts`, without Electron imports, and
  tests bind them; the shell adds nothing to them.
- **The first page** is the Settings page, which holds the setup check, until a configuration file
  exists and the check says research can start. It is the Settings page too when the check could
  not be read or did not answer in time: only a check that passed opens the home page.
- **Saving a file.** The shell asks where before anything is written, and writes nothing when no
  place is chosen.
- **Menu.** File: "Send feedback", "Open data folder" (the application folder), "Settings".
- **The first thing on the Settings page** is the setup check ("This computer"); the configuration
  editor follows it.

As built (stopping research from the app; in a checkout too):

- The Research page shows "Stop research" while a research run of the business is running. It asks
  once ("Running agents are stopped. You can start again later; finished work is kept.") and then
  calls `POST /api/workspaces/:id/research/stop`.
- The route stops the research of that business and of no other (`stopResearch` in
  `src/core/research/orchestrator.ts`): what runs for it through a pipeline, a continuation after a
  restart or a re-run after an answered escalation is aborted on the path a cancelled research
  takes, so each agent run is stopped by the supervisor (its record: `failed`, reason `aborted`) and
  no task is changed by the abort. The stop is then recorded: the business's running research runs
  and pipelines become `failed` (the runs with the reason `stopped by the user`), and the tasks of
  the stopped research that were in work, in review or waiting for the person go back to `queued`
  with their step and round. Only tasks of the stopped research are touched: those of the research
  runs that were running, and those run again outside a pipeline when the stop came. A task that
  waited for the person has its pending requests closed (`denied`, response `research was
  stopped`), so no later answer can put it back in work without an agent; such a closed request is
  not recorded as a denial by the person, and the question of an escalation stays open. Nothing is
  deleted, no task is failed, and no task status is announced, so no escalation agent starts. It
  answers what it stopped (`requeuedTasks`, `closedRequests`); with nothing running, `stopped:
  false`. The person's action is recorded (`research_stop`).
- The stop is recorded only after all the stopped work has ended, however many agents were in
  flight and in whatever order they end: a run that waited for a worker slot ends at once, a
  started one when its process is gone, and the task loop waits for every one of them before it
  ends (so does a council round for its members). The wait is bounded by the supervisor: a started
  CLI gets the polite stop, after the kill grace the forced one, and its run then ends. A task whose
  run ended by itself just before the stop reached it is where its loop left it (finished, or queued
  again in its next step). A pipeline does not begin its next phase once it is stopped, and research
  that a restart was about to continue never begins when the stop comes first.
- From the stop until it is recorded, research of that business cannot be started: a start is
  refused as while research runs (`409`), and a schedule tries again on its next tick. So what is
  recorded as stopped is what ran when the stop came, never research started in between. A second
  "Stop research" while the first is at work is the same stop and gets the same answer.
- Afterwards "Start research" starts a new pipeline. The queued tasks of the stopped run stay with
  that run: nothing runs them again, and a restart of the app does not continue stopped research
  (unlike research interrupted by quitting, which the next start continues).
- Not stopped by it: an interview, an experiment (its arm tasks stay in work and it runs to its
  end), a reviewer audit, a retro, and an escalation agent that is already running. A schedule of the business stays as it is: its next occurrence
  starts research again.

### 4.2 Where things live

| | macOS | Windows |
|---|---|---|
| Data (`dataDir`) | `~/Library/Application Support/Business Intelligence Factory/data` | `%APPDATA%\\Business Intelligence Factory\\data` |
| Configuration | `…/bif.config.json` in the same folder | same |
| Logs (server output) | `…/logs/` | same |

The folder is shown on the Settings page with an "Open folder" button. A checkout started with
`npm start` keeps `./data` and `./bif.config.json`.

As built: the packaged server makes the application folder its working directory, so a relative
path in the configuration (the research browser's profile, `data/browser-profile`) lands in it, as
it lands in the checkout for `npm start`. The data folder is always `<application folder>/data`: the
configuration's `dataDir` is not used by the packaged app. The server writes no log file itself: the
shell writes the server's output to the logs folder. In a checkout the Settings page shows the data
folder, and "Open folder" opens it.

The shell writes the server's output and its own lines to `logs/server.log`; a file past 5 MB
becomes `server.previous.log` at the next start. What the window itself stores (its cache and
settings) is in `shell/` inside the application folder. `BIF_APP_DIR` names another application
folder; `npm run desktop:dev` uses `data/desktop-dev` of the checkout.

### 4.3 First run

A setup screen, shown until it passes and available later from Settings:

- for each agent CLI (Claude Code, Codex, OpenCode): found or not (and where), its version, signed in
  or not as far as can be told without a model call, and one line on how to install or sign in;
- Chrome found or not (the research browser needs it);
- the configuration is written from what was found: providers enabled only when found, roles on the
  first provider found, and beta defaults: a cost cap per pipeline and per workspace **(my call:
  25 USD per pipeline, 100 USD per workspace; the tester can change them)**;
- with no agent CLI found the app still opens, and says that research cannot start.

The same check is available in a checkout as `npm run doctor`.

As built (`src/core/setup/doctor.ts`, `GET /api/setup`, `POST /api/setup/apply`):

- **Found:** the configured command is looked up on `PATH`, then in the usual install folders of
  the platform (among them `~/.local/bin`, Homebrew, `~/.opencode/bin`, the Node versions of nvm;
  on Windows the npm folder under `%APPDATA%` and `%USERPROFILE%\.local\bin`). A command found
  outside `PATH` is written to the configuration with its path.
- **Version:** `<command> --version`. A command that is found but does not run is reported with
  the reason.
- **Signed in:** Claude Code by `claude auth status --json` (only its `loggedIn` field is kept),
  Codex by `codex login status` plus whether its `auth.json` exists (runs of this app read the
  login from that file), OpenCode by the count of credentials in `opencode auth list`. No check
  starts a model or reads what is in a login file. None can tell whether the service still accepts
  the login, or whether the plan has usage left. A CLI whose status command does not answer is
  "not known", and counts as usable.
- **Chrome:** whether the file exists where the research browser looks for it. It is not started.
- **The configuration:** a role whose provider was not found moves to the first provider found, on
  that provider's first model. The configuration requires every role to name an enabled provider
  with a model, so two cases are not as the list above says: with no agent CLI found the providers
  stay as they were (the configuration would not load otherwise), and with only OpenCode found,
  which has no model until the person lists one, it is enabled and the roles are left as they are.
  In both the check says that research cannot start. The cost caps are added where the
  configuration has none.
- **Whether research can start** is judged against the configuration in use: the CLI of every
  role's provider must be found, run and not be signed out, the provider must be enabled and list
  the role's model. One ready CLI is not enough when a role names another. The summary says which
  provider is missing and why, when writing the configuration would move its roles, and for a CLI
  without a model (OpenCode until the person lists one) that a model must be chosen in Settings.
  The kept check is judged again each time it is read, so a change of the roles shows without a
  new check.
- The configuration is written only when no file exists, or when the person asks to replace it; then
  it starts from the configuration in use and keeps its other settings.
- The check is kept between requests ("Check again" runs it anew); the feedback bundle's manifest
  takes the agent CLIs and their versions from it.

### 4.4 The research browser

Today it is started with `npx @playwright/mcp@<pinned>`, which needs npm on the machine. In the
packaged app the pinned package is shipped inside the app and started with the app's Node runtime.
The dedicated research profile lives under the data folder as today.

As built: the pinned version is a dependency in `package.json`, and the build copies it with the two
packages it needs into the shipped resources. When the configured command is `npx [-y]
@playwright/mcp@<the shipped version>`, the server runs the shipped script with its own Node
runtime and the same remaining arguments. Any other command, package or version in the
configuration is used as written. A checkout ships nothing and keeps starting the browser with
`npx`.

### 4.5 Builds

- `npm run dist:mac` and `npm run dist:win` on a machine of that platform; a hosted workflow builds
  both on a version tag and attaches the files to a draft release.
- Unsigned by default. Signing and notarisation are switched on by environment variables in the
  hosted build when the owner provides an Apple Developer identity or a Windows certificate. The
  tester guide says how to open an unsigned build on each platform.
- The app version is the package version; the bundle manifest and the Settings page show it.

As built: `npm run dist:mac` and `npm run dist:win` build the web app and the server, check the
runtime, write the shell to `dist/shell` and run electron-builder with
`desktop/electron-builder.yml`; the installers are in `dist/installers`. An architecture given as an
argument is built alone (`npm run dist:mac -- --arm64`, for a quick check); without one, both macOS
architectures, and x64 on Windows. The app icon is `assets/icon.png` (1024 by 1024 pixels, made once
from `assets/icon.svg`); the builder makes the platform formats from it. After the build the script
checks that every file of `dist/server` is in the app and that the app archive holds the shell alone.
Unsigned means: no certificate is looked for on the building machine, the macOS app gets an ad-hoc
signature (Apple silicon runs nothing without one) and the Windows installer is not signed. The
variables that switch signing on are listed at the head of `desktop/build.ts`. The hosted workflow
is `.github/workflows/desktop.yml`; it also runs the test suite on the runtime the app ships.

## 5. Windows

What changes in the code so the tool can run on Windows:

- **Stopping a run and everything it started.** POSIX: the process group, as today. Windows: the
  process tree by `taskkill /T` (then `/F` after the grace period).
- **Crash recovery.** The check that a leftover process is ours (start time by `ps`) gets a Windows
  form.
- **Codex login.** The private Codex home links to the tester's `auth.json` by symbolic link today.
  Windows: a hard link when both are on one volume, else a copy that is copied back after a run when
  it changed **(the builder confirms what the Codex CLI on Windows needs)**.
- **Starting CLIs.** Commands that are script shims on Windows are started through the shell with
  arguments quoted safely, or resolved to their real executable.
- **Paths.** Every place that compares or builds paths by hand (the allowed-folder rule of
  `save_artifact`, the last-segment cut) is checked for back-slashes and drive letters.

The test suite runs on Windows in the hosted build. Real agent runs on Windows are not verified by
this project (§9); the tester guide and the release notes say so.

## 6. What stays as it is

The server still listens on the local machine only, with no sign-in. Telemetry stays off by default.
The isolation of agent CLIs, the research profile rule, the export rules and every privacy rule are
unchanged.

## 7. Verification

- Feedback bundle: unit tests per section; the completeness test of §3.3; a leak test (a tree seeded
  with marker strings in every text field, an upload, a site password, business names and the user
  id: none appears in a standard bundle; upload markers appear in neither level); the reader on two
  bundles; a bundle made from this machine's real data and read back.
- App: the bundled server starts from a directory that is not the repository and serves the health
  route and the pages; a packaged macOS app is built, launched, answers on its port, writes its data
  to the application folder and stops its server on quit; one real agent run through the packaged
  app on the cheapest Claude model.
- Windows: the test suite on the hosted Windows build; the installer is built there. No real run.

## 8. Order of building

1. The feedback bundle, the page and the reader (independent of packaging).
2. The server made packageable: compiled build, resources, the application folder, a free port, the
   shipped research browser, the setup check and `doctor`.
3. The shell, the installers, the hosted build, the tester guide.
4. Windows changes in the harness, and the test suite on Windows.

## 9. Open questions (not blocking)

1. Signing: an Apple Developer account (99 USD a year) and a Windows code-signing certificate make
   the installers open without warnings. Without them testers approve the app by hand.
2. A Windows tester or machine for real agent runs.
