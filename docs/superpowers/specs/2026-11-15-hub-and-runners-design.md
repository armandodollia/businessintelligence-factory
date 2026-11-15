# Shared hub and local runners — design

Date: 2026-11-15. **Status: draft, waiting for the user's approval. Nothing here is built.**

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

## 2. Goals, non-goals, anti-goals

Goals

1. One store for the company. Every action is recorded under the person who did it.
2. An agent run executes on a person's machine, with the CLI and login installed there.
3. Scheduled work is handed to a person's machine too.
4. Single-machine use keeps working exactly as today, with no sign-in and no second program.
5. Adding a hub-side runner later needs no new mechanism.

Non-goals

- Working offline on a laptop and syncing later.
- Several companies on one hub. One hub serves one company.
- Company single sign-on **(my call)**; see §14.
- The hub-side API-key runner itself. This design leaves room for it and does not build it.

Anti-goals

- One person's subscription silently doing everyone's work.
- Private text reaching the machine of someone who may not read it: uploads, the hidden research on
  own-company stakeholders, stored site passwords.
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

## 7. People and access

- Tables: `people` (id, sign-in name, password hash), `sessions`, `memberships` (person, business
  tree, role), `runners`.
- Roles per business tree **(my call)**: `owner` (everything, including members, budgets and hidden
  stakeholders), `member` (run research, decide, give feedback), `viewer` (read only).
- One more role for the hub as a whole, **hub admin** (the first account) **(my call)**: changes the
  hub's settings (providers, limits), invites people and sees total cost. Any signed-in person may
  create a business and becomes its owner.
- A business a person is not a member of answers 404, as another tree does today. Routes addressed by
  an id with no business in the path (a run, a request, an evidence copy, a rating, an experiment)
  look up the business first and apply the same check.
- The acting person comes from the session and is passed into the core functions that record or use
  it. Several core modules read `actorOf(config)` directly today (learning for personas and the user
  persona, stakeholder statements, calibration, the feedback actions' fallback); each gets the person
  as a parameter. `actorOf(config)` remains only as the person of `local` mode.
- Sessions use a same-site cookie, and every changing request is checked for its origin, replacing
  today's rule that only local hosts may call the server.
- Sign-in **(my call)**: the owner creates an invite link; the person sets a password. No outside
  identity service is contacted.

## 8. What changes when several people act

- **The persona of you.** Already one per person. In hub mode the retro learns for every member, and a
  run carries the brief of its initiator.
- **Requests from agents** (approvals, logins, captchas) go to the initiator; any member may answer;
  the answer is recorded under who gave it. Budget extensions need the owner.
- **Segment persona learning.** Reactions of all members are pooled, each recorded with its person:
  the persona models the market, not a member **(my call)**.
- **Stakeholder question round.** Open question for the user, see §14.
- **Live updates.** Events are sent only to sessions with access to the business they belong to; the
  stream of all businesses' events is limited to the businesses of the person asking.
- **Withheld research.** The hidden research on own-company stakeholders stays withheld from every
  member, the owner included, until the question round is done, as today.

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

New tables: `people`, `sessions`, `memberships`, `runners`, `run_jobs`. New columns: `agent_runs`
gets `initiator`, `runner_id`; requests and approvals get `addressed_to`.

Settings: `server.mode`, `server.publicUrl`, `server.tls` or `server.trustProxy`,
`server.allowInsecure`; `runners.leaseSeconds` 60, `runners.heartbeatSeconds` 15,
`runners.maxLostLeases` 3. Per-machine settings live in `runners`.

## 11. API

- Sign-in: `POST /api/session`, `DELETE /api/session`, `POST /api/invites`, `POST /api/invites/:code`.
- Members: `GET/POST/DELETE /api/workspaces/:id/members`.
- Machines: `POST /api/runners/pairing`, `GET /api/runners`, `PATCH/DELETE /api/runners/:id`.
- Runner protocol (runner key required): `POST /runner/hello`, `GET /runner/jobs` (held open),
  `POST /runner/jobs/:id/lease`, `POST /runner/jobs/:id/lines`, `POST /runner/jobs/:id/end`,
  `POST /runner/jobs/:id/tool` (the gateway's forward).

## 12. What people see

- A sign-in page; a "My machines" page (paired machines, connected or not, what each can run, the
  scheduled-work switch and limits, today's load).
- On a business: a Members page for the owner.
- On runs and tasks: who started it, which machine ran it, or what it is waiting for.

## 13. Order of building

1. **The seam.** `RunExecutor` and `LocalExecutor`, the supervisor computing the result from raw
   exit data, per-executor limits. No change in behaviour; the existing test suite passes unchanged.
2. **People.** `server.mode: hub` with sign-in, hub admin, memberships, the acting person passed
   through the core, access checks on every route and on live events. Runs still start on the hub
   machine (useful on its own: several people on one machine's CLI login).
3. **Runners.** Pairing, the job and lease protocol, output streaming, cancel, the local tool gateway,
   evidence upload, the local browser, OCR jobs; the hub's agent endpoint closed to the network.
4. **Routing.** Initiator, eligibility, waiting, scheduled work with limits, private runs, the brief
   rule, the pipeline lock rule, usage per person and machine.
5. Later, separately: the hub-side API-key runner.

Each step is its own plan and merge.

## 14. Open questions for the user

1. **Where does the hub run, and who looks after it?** A machine in the office, a company server, or
   a rented one. This decides how the encrypted connection is set up and who can reach it from home.
2. **Stakeholders when colleagues are the stakeholders.** With several members, a member may be one of
   the researched own-company stakeholders. Proposal: only the owner sees and answers the hidden
   question round; opened own-company stakeholder personas are visible to the owner and to members the
   owner names. Is that the right default?
3. **Who sees which business?** Proposal: membership per business, as in §7. The alternative is that
   every signed-in person sees every business.

## 15. Verification

Unit tests per module; the existing suite unchanged after step 1; a protocol test with a fake runner
(lease loss, cancel, restart, a token used through the wrong runner); access tests per route for
owner, member, viewer and non-member; a two-process test on one machine (hub and runner over
loopback with encryption); one real run through a runner with the Claude CLI on the cheapest model.
