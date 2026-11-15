# Shared hub and local runners — design

Date: 2026-11-15. **Status: draft, revised after the user's answers of 2026-11-15; waiting for approval. Nothing here
is built.**

Decisions the user did not state are marked **(my call)**.

## 1. Intent

Several people in one company use the tool, and everything it finds is shared. The agent work keeps
running through the coding-agent CLI on each person's own machine, under that person's own
subscription, because subscriptions are far cheaper than API usage. This includes scheduled work.
Later the company can also add a runner on the hub that uses an API key.

What the user decided:

- Findings are shared for the company.
- Both ways of running agents are wanted eventually. First: keep local CLIs on subscriptions while the
  data is central.
- Scheduled jobs also run on local machines.
- Where the hub runs is not decided. It must be testable for free and able to grow later (§14).
- A person can choose to keep what they say about coworkers on their own machine only (§8a).
- Rows are separated by company, and roles are given at every level of the business tree (§7).

## 2. Goals, non-goals, anti-goals

Goals

1. One store. Every row belongs to one company and is never read or written from another. Every
   action is recorded under the person who did it.
2. An agent run executes on a person's machine, with the CLI and login installed there.
3. Scheduled work is handed to a person's machine too.
4. Single-machine use keeps working exactly as today, with no sign-in and no second program.
5. Adding a hub-side runner later needs no new mechanism.

Non-goals

- Working offline on a laptop and syncing later.
- Company single sign-on **(my call)**; see §14.
- The hub-side API-key runner itself. This design leaves room for it and does not build it.

Anti-goals

- One person's subscription silently doing everyone's work.
- Private text reaching the machine of someone who may not read it: uploads, the hidden research on
  own-company stakeholders, stored site passwords.
- A row of one company served to, or changed by, a person of another.
- What a person marked as private about a coworker leaving their machine.
- A hub that answers without sign-in, or over an unencrypted connection.
- A run's access token that works after the run, or from a machine the run was not given to.

## 3. Constraints

As in the earlier projects: Node 25, TypeScript ESM, `src/core` never imports from `src/api` or `web`;
no data crosses business trees; upload-derived text stays out of exports by default; third-party HTML
is untrusted; reviewers get minimal slices. In addition: the store stays one SQLite database opened by
one hub process.

## 4. Approaches considered

- **A. A hub that holds the data and a runner on each machine that starts the CLI (chosen).** Agents
  already reach the tool over HTTP with a per-run token and save evidence through its tools, so only
  the step that starts the CLI is tied to a machine. Findings are shared by construction.
- **B. One database file on a shared network drive.** SQLite corrupts on network file systems, several
  planners and schedulers would run at once, and nothing would record who did what.
- **C. Everyone runs the full app against a central database server.** Every module uses the
  synchronous SQLite API; this rewrites the storage layer and still leaves several planners racing.
- **D. Everyone keeps a full copy and copies are merged.** Stays local-first, but merging append-only
  logs, ids, duplicates and upload rules across machines is a large project and findings lag.

## 5. The parts

```
Person's machine                              Hub (company machine)
┌────────────────────────────────┐           ┌───────────────────────────────┐
│ runner                         │◄─ jobs ───│ store, evidence copies        │
│  ├ starts claude / codex /     │           │ web pages, sign-in            │
│  │  opencode (own login)       │─ lines ──►│ planning, review loop, retro  │
│  ├ local tool gateway ─────────┼─ tools ──►│ scheduler, budgets, run log   │
│  └ local browser               │           │                               │
└────────────────────────────────┘           └───────────────────────────────┘
        outbound connection only, encrypted
```

### 5.1 Two modes

`server.mode` is `local` (default) or `hub`.

- `local`: as today. The server listens on `127.0.0.1`, there is no sign-in, the person is
  `user.id`, and runs start in the server process.
- `hub`: people sign in, every route checks who is asking, and runs are handed to runners. The hub
  refuses to start in this mode without an encrypted connection (its own certificate, or a declared
  reverse proxy), except with an explicit `allowInsecure` for testing on one machine.

### 5.2 The seam in the code

Today `Supervisor.attemptCli` builds the command, starts the process, reads its output and kills it.
It becomes a call to a `RunExecutor`:

```ts
interface RunExecutor {
  attempt(job: RunJob, onLine: (stream: 'stdout' | 'stderr', line: string) => void, signal: AbortSignal): Promise<AttemptResult>;
}
```

- `LocalExecutor` holds today's code, unchanged in behaviour. `local` mode uses only this.
- `RemoteExecutor` queues the job for a runner and relays what the runner sends back.

The executor only starts the process and reports what happened: raw output lines, then the exit
code, the signal and any error starting it. Everything else stays in the hub's supervisor: budget
checks, retries, issuing and revoking the run token, parsing output lines into events
(`adapter.parseLine`), deciding from those events whether the attempt was rate-limited or failed
(some CLIs exit 0 on an error), the scan of error output for rate limits, usage and cost, the run log
files, and every store write. The runner sends raw lines; the hub parses them **(my call)**, so there
is one parser version and the logs live in one place.

What moves with the job, and what does not:

- A `RunJob` carries the bare request: prompt, system prompt, provider, model, offline, whether a
  browser is needed. The runner fills in its own paths, its own CLI command, its own state folders and
  login links, and its own browser tool server. Nothing from the hub's `dataDir` or provider commands
  is sent.
- The idle watchdog stays on the hub, fed by the lines that arrive, paused while the run waits for a
  person. It starts when the job is leased, not when it is queued.
- Process ids are recorded only for local runs. After a restart the hub never signals a process for a
  run that was on a runner.
- The step that logs which prompt text a run read (`beforeStart`) happens when the job is leased, so a
  job that never runs logs nothing.
- Limits on parallel runs and browser runs are per runner in hub mode (each machine reports its own),
  so jobs waiting for an absent machine do not block other people's runs.
- The note about the browser in prompts, and the check that a proposed task may use a browser, follow
  what the job requires, not the hub's own browser settings.

### 5.3 The runner

A small program in this repository (`src/runner/`, started with `bif runner --hub <url>`). It reuses
`src/core/harness/adapters` to build the command for the local machine.

- **Pairing.** The person opens "My machines" in the web pages and gets a one-time code; the runner
  exchanges it for a runner key, stored in a file only that user can read. A person can remove a
  machine at any time.
- **Connection.** The runner only makes outbound requests to the hub (a held-open request for jobs,
  posts for output). No port is opened on the person's machine to the network.
- **What it reports.** Which CLIs are installed and logged in, which models it may use, whether a
  browser is available, and how many runs it takes at once.
- **Running a job.** It makes a working directory under its own data directory, builds the command
  with local paths, starts the CLI with a cleaned environment (a short allow-list of variables, not
  the whole environment), streams output lines to the hub in small batches, and deletes the working
  directory when the hub confirms the run has ended.
- **Stopping.** The hub can cancel a job; the runner stops the whole process group, as the supervisor
  does today.

### 5.4 The local tool gateway

The CLI does not talk to the hub directly. The runner listens on `127.0.0.1` and the CLI is pointed at
it, exactly as it is pointed at the local server today. The gateway forwards each tool call to the hub
over the runner's own encrypted, authenticated connection.

- The run token never travels in a URL across the network.
- `save_artifact` with a `file_path` (how screenshots are saved) is checked against the same
  allowed-folder rule on the runner, and the file's bytes are sent in place of the path.
- Tool calls that wait for a person (approvals, questions) keep working: the gateway holds the call
  open as the server does today.
- The offline rule is unchanged: it is enforced by how the CLI is started, on the runner.
- The gateway serves both forms the CLIs use today (token in the address for Claude and OpenCode, a
  bearer token for Codex) and maps each token to its job, since a runner may run several jobs.
- The list of tools and their schemas comes from the hub for each run, so a runner on an older
  version cannot offer the wrong tools. Image results and a cancelled call are passed through.
- A call that waits for a person can take hours. The gateway posts the call and then asks for the
  result in requests of at most 30 seconds each, so nothing depends on a connection that a proxy
  would cut.
- In hub mode the hub's own agent endpoint (`/mcp`) is not reachable from the network. Tool calls are
  accepted only through the runner protocol, which is what makes the token rule in §5.5 true.

### 5.5 Jobs and leases

Table `run_jobs`: the run, the people whose runners may take it (§6), requirements (provider, model,
browser, offline), state, the runner that holds it, lease expiry.

- States: `waiting` → `leased` → `running` → `ended`; `waiting` again if the lease is lost.
- A runner renews its lease every 15 seconds. A lease not renewed for 60 seconds is lost: the attempt
  ends as `runner_lost` and the job returns to `waiting` (at most 3 times). This is kept apart from
  the idle timeout, which still means "the agent stopped producing output" and is not retried.
- The run token is valid only while the job is leased, and only through the runner that holds the
  lease.
- Hub restart: leases are in the store. Runs in flight are ended and their tasks re-queued, as today;
  runners are told to stop jobs the hub no longer knows.

### 5.6 The browser and site logins

The browser runs on the runner's machine: the runner starts its own browser tool server with its own
profile, so each person's research browser keeps its own logins. Stored site passwords
(`get_identity`) are sent only to a run on the machine of a person who has access to that business.

### 5.7 Reading uploads (OCR)

OCR starts the Claude CLI outside the supervisor today and is not an agent run (no token, no tools;
the file goes in, a structured answer comes out). In hub mode it becomes its own small job kind on the
same lease mechanism. A file a person uploaded goes to that person's runners; a file an agent captured
goes to the runners that may take that agent's run.

## 6. Who runs what

Each run gets an **initiator**: the person whose action started the research, pipeline or interview.

| Kind of run | Goes to |
|---|---|
| Started by a person | that person's runners |
| Scheduled (lessons retro, segment persona learning, reviewer audit, scheduled pipelines) | the business owner's runners; then runners of members who accept scheduled work |
| Learning for a person's "persona of you" | that person's runners only |
| Escalation of a task | whoever may take that task's runs |
| An experiment arm | the runners of the person who started the experiment |
| Hidden research on own-company stakeholders, its reviews, reads and learning | the business owner's runners only |
| Reading an upload | the uploader's runners |

- A runner is eligible when it is connected, has the provider and model the run needs (or, where the
  hub may choose, an allowed alternative), can run offline if required, and has a browser if required.
- When no runner is eligible the job waits. The pages say what it is waiting for ("Waiting for a
  machine of the owner with Claude"). Nothing fails for lack of a machine.
- Scheduled jobs do not pile up: a job that came due several times while no machine was connected runs
  once (the scheduler already works this way).
- A run carries the "persona of you" brief of its initiator only when it runs on that person's own
  machine. A scheduled run that falls to another member's machine carries no brief **(my call)**, so
  nobody's brief reaches a colleague's machine.
- Today one pipeline runs per business at a time. A scheduled pipeline that is waiting for a machine
  does not hold that lock: work a person starts goes first and the scheduled pipeline continues
  afterwards **(my call)**.
- An interview turn answers in the same request today. In hub mode the interviewer runs on the
  machine of the person being interviewed; with no machine of theirs connected the page says so at
  once instead of waiting **(my call)**.
- Each person sets, per machine: accept scheduled work (off by default for members, on for owners),
  a daily limit on scheduled runs, and how many runs at once **(my call)**.
- A spare machine that is always on and signed in to someone's subscription is an ordinary runner.
- Later: a runner on the hub with an API key registers like any other runner and can be made the
  fallback for jobs that have waited longer than a set time.

## 7. Companies, people and access

### 7.1 Companies

A **company** is the top node of a business tree **(my call; the user may want one company to hold
several trees)**. A hub can hold several companies. A person can belong to more than one.

- Every table gets a `company_id`. Rows that today carry only a node id get it by migration from their
  node's top node.
- Code reaches the store only through a handle bound to one company. The handle adds the company to
  every read and refuses a write for another. There is no unbound handle in request or run code;
  start-up, migrations and the scheduler's "what is due" query are the only unbound uses.
- SQLite has no built-in row-level security, so this rule lives in the storage layer. A test walks
  every table and every repository method and fails when one can return or change a row of another
  company. A table added later without `company_id` fails that test.
- A run token is bound to its company, so an agent can never reach another company's rows.

### 7.2 Roles at every level

A role is given to a person at any node of the tree and applies to that node and everything below it.

- Roles **(my call)**: `owner` (everything at that level: members, budgets, schedules), `member` (run
  research, decide, give feedback), `viewer` (read only).
- A person with a role on a division sees and acts on that division and its slices. Sibling divisions
  and the levels above answer 404, except that the names of the levels above are shown so the person
  can see where they are.
- A role given lower down can raise, never lower, what a person may do there.
- Findings at a higher level that a lower node's work relies on (the company profile, shared facts)
  are readable from below **(my call)**; uploads and hidden stakeholder research of a higher level are
  not.
- The person who creates a company is its owner.

### 7.3 People and sign-in

- Tables: `people` (id, sign-in name, password hash), `sessions`, `roles` (person, node, role),
  `runners`.
- One more role for the hub as a whole, **hub admin** (the first account) **(my call)**: changes the
  hub's settings (providers, limits) and invites people. It gives no access to any company's data.
- Routes addressed by an id with no node in the path (a run, a request, an evidence copy, a rating, an
  experiment) look up the node first and apply the same check.
- The acting person comes from the session and is passed into the core functions that record or use
  it. Several core modules read `actorOf(config)` directly today (learning for personas and the user
  persona, stakeholder statements, calibration, the feedback actions' fallback); each gets the person
  as a parameter. `actorOf(config)` remains only as the person of `local` mode.
- Sign-in **(my call)**: an owner creates an invite link; the person sets a password. No outside
  identity service is contacted. Sessions use a same-site cookie, and every changing request is
  checked for its origin, replacing today's rule that only local hosts may call the server.

## 8. What changes when several people act

- **The persona of you.** Already one per person. In hub mode the retro learns for every member, and a
  run carries the brief of its initiator.
- **Requests from agents** (approvals, logins, captchas) go to the initiator; any member may answer;
  the answer is recorded under who gave it. Budget extensions need the owner.
- **Segment persona learning.** Reactions of all members are pooled, each recorded with its person:
  the persona models the market, not a member **(my call)**.
- **Stakeholder question round.** Each person with a role on the node gets their own round. A
  stakeholder opens for a person when that person has answered or skipped its questions; it stays
  hidden for the others until they have done the same **(my call)**. Answers are private by default
  (§8a).
- **A colleague who is a stakeholder.** An owner can mark a stakeholder persona as being about a
  person of the hub. It is then never shown to that person **(my call)**.
- **Live updates.** Events are sent only to sessions with access to the business they belong to; the
  stream of all businesses' events is limited to the businesses of the person asking.
- **Withheld research.** The hidden research on own-company stakeholders stays withheld from every
  member, the owner included, until the question round is done, as today.

## 8a. Keeping what you say about coworkers on your machine

The user decided that a person can keep the data they provide about coworkers on their own machine.

- **What it covers.** A person's answers in the stakeholder question round, their notes on a
  stakeholder, the reasons they record with a real decision, and stakeholder notes taken from their
  interview.
- **Where it lives.** In a small local store kept by the runner on that person's machine. The hub
  stores only that a private statement exists (its id, the stakeholder, the date), never its text.
- **How it gets there.** The page in the browser sends private text straight to the runner on
  `127.0.0.1`, not to the hub. With no runner of theirs connected, the page says the answer cannot be
  saved privately and offers to wait.
- **What uses it.** Runs on that person's machine: the runner adds the person's private statements to
  the prompt of a stakeholder read or a stakeholder learning run for that person.
- **What follows from it (my call).** Anything learned from private statements stays private too: the
  adjustments are a private layer on top of the shared stakeholder persona, and reads made with that
  layer are stored locally and shown only to that person. Colleagues see the shared persona and shared
  reads.
- **Default (my call).** Private. A person can share an answer, which sends it to the hub as a normal
  statement. Sharing cannot be undone by the tool once others' runs have read it.
- **Costs.** Private data is lost with the machine unless the person backs up the runner's folder.
  Shared stakeholder personas improve only from what people share.
- **Limit.** What a person types in the interview is stored on the hub as the interview record. Only
  the stakeholder notes taken from it can be kept local.

## 9. Privacy

- A runner receives prompts, and the person's CLI keeps its own transcripts. So a run may only be
  given to the machine of a person who is allowed to read everything in its prompt. The routing in §6
  follows from this.
- The feedback log, run logs and stored prompts of a business are readable by its members. This is
  acceptable for shared findings, with one exception that needs a rule: another member's "persona of
  you" lines appear in accept events and in learning prompts. In hub mode those are served only to
  that person and the owner **(my call)**.
- Usage and cost are recorded per runner and per person, so the pages can show whose subscription
  carried what.
- Whether a subscription may be used for unattended or shared work is set by each provider's terms.
  The user checks this; the tool only makes the load visible and limited.

## 10. Storage and settings

New tables: `people`, `sessions`, `roles`, `runners`, `run_jobs`, `private_statement_refs`. New
columns: `company_id` on every table; `agent_runs` gets `initiator`, `runner_id`; requests and
approvals get `addressed_to`. On the runner: a local store of private statements, private
adjustments and private reads.

Settings: `server.mode`, `server.publicUrl`, `server.tls` or `server.trustProxy`,
`server.allowInsecure`; `runners.leaseSeconds` 60, `runners.heartbeatSeconds` 15,
`runners.maxLostLeases` 3. Per-machine settings live in `runners`.

## 11. API

- Sign-in: `POST /api/session`, `DELETE /api/session`, `POST /api/invites`, `POST /api/invites/:code`.
- Roles at a node: `GET/POST/DELETE /api/workspaces/:id/roles`.
- Machines: `POST /api/runners/pairing`, `GET /api/runners`, `PATCH/DELETE /api/runners/:id`.
- Runner protocol (runner key required): `POST /runner/hello`, `GET /runner/jobs` (held open),
  `POST /runner/jobs/:id/lease`, `POST /runner/jobs/:id/lines`, `POST /runner/jobs/:id/end`,
  `POST /runner/jobs/:id/tool` (the gateway's forward).

## 12. What people see

- A sign-in page; a "My machines" page (paired machines, connected or not, what each can run, the
  scheduled-work switch and limits, today's load).
- On every node: a People page for its owners (who has which role here and below).
- On the stakeholder question round: a "keep on this machine" switch per answer, on by default.
- On runs and tasks: who started it, which machine ran it, or what it is waiting for.

## 13. Order of building

1. **The seam.** `RunExecutor` and `LocalExecutor`, the supervisor computing the result from raw
   exit data, per-executor limits. No change in behaviour; the existing test suite passes unchanged.
2. **Company separation.** `company_id` on every table, the company-bound store handle, the sweep
   test. Still one person and one machine.
3. **People and roles.** `server.mode: hub` with sign-in, hub admin, roles at every level, the acting
   person passed through the core, access checks on every route and on live events. Runs still start
   on the hub machine.
4. **Runners.** Pairing, the job and lease protocol, output streaming, cancel, the local tool gateway,
   evidence upload, the local browser, OCR jobs; the hub's agent endpoint closed to the network.
5. **Routing.** Initiator, eligibility, waiting, scheduled work with limits, private runs, the brief
   rule, the pipeline lock rule, usage per person and machine.
6. **Private notes on coworkers.** The runner's local store, the page sending private text to the
   runner, the private layer on stakeholder personas, per-person question rounds.
7. Later, separately: the hub-side API-key runner.

Each step is its own plan and merge.

## 14. Where the hub runs, and open questions

The hub is one program and one data folder. It needs an address the runners and browsers can reach
over an encrypted connection; moving it is copying the folder. Options checked on 2026-11-15 (third-
party pages; confirm on the providers' own pricing pages):

| Option | Cost | Notes |
|---|---|---|
| Your own machine on a private network (Tailscale) | Free for 6 users on the personal plan, which is for non-commercial use; $8 per user per month otherwise | Nothing exposed to the internet; connection already encrypted |
| Your own machine behind a tunnel (Cloudflare Tunnel with Access) | Free up to 50 users | Public address with a sign-in in front; needs a domain |
| A free cloud server (Oracle Cloud Always Free) | Free | Always on; idle servers are stopped; the free size was reportedly reduced in 2026 |
| A small rented server | About €5 a month | Simplest to operate; grows by resizing |

Recommendation: test on your own machine on a private network, then move the folder to a small rented
server when more than a handful of people use it. Beyond one company-sized team on one server, the
next step is a database server with built-in row-level security, which is a rewrite of the storage
layer and not part of this design.

Open questions for the user:

1. Is a company the top node of one business tree, or can one company hold several separate trees?
2. Is "private by default" right for what you say about coworkers, or should sharing be the default?

## 15. Verification

Unit tests per module; the existing suite unchanged after step 1; a protocol test with a fake runner
(lease loss, cancel, restart, a token used through the wrong runner); access tests per route for
owner, member, viewer and non-member at each level of a three-level tree; the company sweep test;
a test that private text never reaches the hub (the hub's store and logs searched for it); a
two-process test on one machine (hub and runner over
loopback with encryption); one real run through a runner with the Claude CLI on the cheapest model.
