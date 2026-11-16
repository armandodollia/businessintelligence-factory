# Stakeholder personas and positions

A proposal only matters if the people and systems it depends on say yes. For each node BIF keeps
simulated personas of its stakeholders, learns them from what you say, and shows how each would read
a recommendation.

Code: `src/core/stakeholders/`. Settings: [configuration.md](configuration.md#stakeholders). Designs:
[stakeholder personas](superpowers/specs/2026-11-15-stakeholder-personas-design.md),
[stakeholder positions](superpowers/specs/2026-11-15-stakeholder-positions-design.md).

## Who counts

Everyone whose approval, decision or data the node depends on: the people who run the company
(leaders, managers), investors, the board and other owners, regulators and partners, and, lower in
the tree, the team or system above and sister teams and systems. Types: `leader`, `manager`,
`investor`, `board`, `owner`, `team`, `system`, `regulator`, `partner`, `other`.

They are built for your own node (*own*) and for the most important competitors (*competitor*:
leaders, owners, investors, parent company).

A stakeholder is a persona of kind `stakeholder` with:

- a label (a role, team or system; a person's name only when it is in public evidence);
- a relation ("approves pricing changes");
- eleven profile fields (`role_mandate`, `goals_incentives`, `decision_criteria`, `constraints`,
  `risk_tolerance`, `dependencies`, `known_positions`, `objections`, `information_needs`,
  `communication_style`, `influence`), each with a value, a confidence and evidence.

Segment personas are unaffected: the persona panel, flow verdicts, the Audience & Personas page and
persona ratings read segment personas only.

## How they are built

The `stakeholders` phase (after `deep_dives`; existing schedules gained it) plans two task types,
both saving with `save_stakeholder`. At most `maxOwn` own and `maxPerCompetitor` per competitor are
kept, counting those not failed or superseded. Review and status work as for personas. Only runs of
these two task types may save a stakeholder. A label is one line of at most 80 characters (newlines
and tabs become spaces, as in the relation).

### `competitor_stakeholders`

Uses the browser, public sources only, and never searches for a person not named in public evidence
(except the former colleagues it is told to follow, see below). It is planned only when the tree has
competitors or the node has former colleagues to follow.

### `own_stakeholders`

Works from what the store already holds: captured public pages, internal uploads, the interview, the
business tree (parent and sibling nodes are offered as `team` or `system` stakeholders), and your
statements not yet tied to a stakeholder. It also works from the public web: the company's
leadership, board, ownership and investor pages, registry filings, parent and sister organisations,
press.

It runs like any other research task, on the usual models (its reviewer may be on another provider,
Codex included), with a browser when the planner asks for one. Every field still cites an artifact:
the worker saves a copy of each public page it relies on. Its prompt forbids putting anything from
internal uploads or the interview into a search query, web form or other web request; it searches
for the company's public record by its public name. (Decided by the owner on 2026-11-15; it was
offline before.)

These runs may save only stakeholders and copies of the pages they rely on: `save_artifact` with only
kind `page_snapshot` or `document`, mime, the content and the page's http(s) `source_url` (the title
is taken from the URL). Besides that they may finish, answer review and read. They cannot ask you
anything and are never escalated.

Those page copies are withheld with the research: while it is withheld they answer as unknown
everywhere (knowledge search and pages, artifact links, gc, the export). When the same bytes were
also uploaded or captured by another task, that artifact stays served, but nothing of the private
capture is shown with it, and what is shown comes from the served captures. The reviewer of this
task is given the same web rule as the worker.

The company audit and filings prompts also capture public leadership, ownership and investor pages
as artifacts (they do not save stakeholders).

Each stakeholder gets an agent.md ("You are <label>, a stakeholder of <scope>…"; for a competitor's,
"…at <competitor>, a rival of <scope>").

When the phase ends, the question round starts (below), then the combine run for former colleagues
whose follow task has ended. With `stakeholders.enabled: false` the phase is skipped (see below).

## Hidden until you answer: the question round

A first save of an own stakeholder is **hidden**. When the `stakeholders` phase ends, every hidden
own stakeholder that is not superseded or failed and has no questions yet gets four questions from
fixed templates filled with its label only (one set for people, one for teams and systems). The node
gets two more ("Is anyone missing…", "Is anyone on this list not relevant…"). No model writes or
picks a question, so a question cannot reveal what research found. Answers come first so that they
are your own, not an echo of the research.

While a stakeholder is hidden, every API response shows only its id, label, type and number of open
questions: never its profile, relation, evidence, agent.md, adjustments, proposals, signals or reads.
It gives no reads and is skipped by learning.

While own-stakeholder research runs, and while its node has any hidden stakeholder, the raw activity
of that research (run events, prompts, result summaries, review decisions, evidence refs, lessons
quotes, audit issues) is withheld from every API response and the live event stream. It is shown
again once the task has finished and none is hidden. The pages say "Withheld until you answer the
stakeholder questions", and the decision log shows only the save's label, type and confidences.

On the **Stakeholders** page you answer (every answer optional, at most 4,000 characters, redacted),
skip one stakeholder, skip all, or press "Show what the tool found" (a skip). A stakeholder you
answered or skipped opens for good; one you left blank stays hidden and in the round. The node
questions close with the round. Later stakeholders get a new round the same way.

With `stakeholders.enabled: false` the `stakeholders` phase is skipped (no tasks, no round; a harness
decision `phase_skipped` records it), no reads run, and the page shows no round. Hidden stakeholders
found earlier are listed with only "Show what the tool found", so none stays hidden.

## Statements

Everything you say about a stakeholder is an append-only, internal statement:

- question answers;
- notes ("Add a note" on a card);
- real decisions ("Record the real decision" on a recommendation: stakeholder, `approved` /
  `approved_with_conditions` / `rejected` / `deferred`, and your reasoning);
- what the interviewer records with `note_stakeholder` when you mention a stakeholder. It sees the
  node's stakeholders as id, label and type only; the quote, at least 12 characters, must be text you
  typed in the interview.

Storing a statement changes no persona.

## Reads

In the `persona_panel` phase, after the segment personas, each open, usable stakeholder reads each
usable recommendation of its node (own stakeholders first, at most `maxReadsPerPanel` runs).

- An own stakeholder answers `approve`, `approve_with_conditions`, `reject` or `not_my_call`.
- A competitor's answers `ignore`, `watch`, `copy` or `counter`.

Each read has conditions, concerns, reasoning and what would change its mind. Reads are shown on the
recommendation, labelled simulated, and never change its priority. A new read replaces the
stakeholder's earlier one. You can agree or disagree with a read, with a reason; the page shows your
latest reaction after a reload and you can change it.

An own stakeholder's read runs offline (its agent.md is internal) on the persona model, or on a model
that can run offline when that one cannot. With none, its reads are skipped and a harness decision
says why. A competitor's stakeholder reads as before.

## People who leave, move or change position

People change jobs; you record it, the tool never does by itself. On the **Stakeholders** page each
open own stakeholder has a "Position" line and "Change position":

- **Left the company.** Give the date and where they went: a competitor of the business, "A company
  not listed" (it is added as a competitor, marked as not researched yet) or "Elsewhere". From then on
  the person is a *former colleague* and no longer one of your stakeholders: no question round, no
  approval read, no real decisions, no place under `maxOwn`. At a competitor they read your
  recommendations as a rival (`ignore`, `watch`, `copy`, `counter`) who knows your plans and people as
  they were the day they left, and nothing later. Elsewhere, they are kept under "Former stakeholders"
  and read nothing.
- **Moved to another team or division**, **Promoted**, **Demoted.** The stakeholder goes to the other
  node, or gets a new type and title; its open questions go with it.
- **Moved to another company** (for someone who already left) and **Returned** (they work here again,
  with the profile as it stands). Both take an optional new name, for when the name is already in use
  where the person goes; the page then shows why the change was refused.

Dates are days, not in the future. Every change is kept in a history that cannot be edited or
deleted. A stakeholder that is still hidden must be opened first.

### Two layers for someone who left

What you knew and what the web shows are stored apart:

- **What we knew**: the profile as it was the day they left.
- **What is public**: what research finds about them on the public web since. The `stakeholders`
  phase follows at most `maxFollowed` former colleagues per task, those not looked at for longest
  first. It also notes where they work now ("What research last saw"); you decide whether to record
  that as a move.
- **Combined**: after the research, one run without web access writes a single profile from both.
  Each field says what it rests on (from what we knew, from public sources, from both, or concluded
  from both) and says so where the two disagree. Public sources flatter their subject, so what you
  knew stays the base for how the person decides.

Only research that failed (it could not finish) is "Not used": what it found is kept and shown under
that note, and the combined profile stays as it was. Research that finished without being verified
is still combined; the page then says "Used, although the research that found this was not
verified". The person stays usable either way.

### What stays internal

What you knew about a former colleague never goes into a web request. The research is told only who
to follow: the label, the position held here, until when, and where they went. Reads, learning and
the combining run for these personas run without web access (skipped, with a note in the decision
log, when no enabled provider can). Position changes, your notes and the record of the combining run
stay out of the default export; what the research found in public is exported like any competitor
research.

One limit: a run with web access works in a folder under the data directory and could read files
there, a former colleague's agent.md included (see [Isolation](#isolation)).

## What the retro does

Only the weekly retro changes a stakeholder, through [persona learning](personas.md#persona-learning).
A stakeholder goes to a learning run when the gate qualifies or it has a statement no run has
consumed. The run is shown its open statements (fenced, with ids) besides its reactions: your
reactions to its reads, and your recorded decisions compared with its read of the same
recommendation (approved against approve agrees, rejected against reject agrees, anything else
disagrees; `deferred` and `not_my_call` give no signal).

A proposal citing a statement needs no further evidence; one resting only on reactions keeps the
usual rule. A finished run consumes the statements it was shown. You accept or reject each proposal
as for segment personas; an accept makes a new persona version whose agent.md carries the correction.
The learning run of an own stakeholder is offline, on the learning model or one that can run offline
(skipped, with a harness decision, when none can).

## Export

An adjustment that rests on a statement is internal. These stay out of the default training export
(exclusion reason `internal`); `?includeUploads=1` includes them:

- internal proposals, adjustments and their decisions;
- every decision of an `own_stakeholders` task (worker, reviewer, harness) and feedback on it;
- all stakeholder statements, questions, reads and stakeholder feedback events (position changes
  among them);
- the record of a combine run;
- your ratings of, and your include overrides on, an own stakeholder or a former colleague, whatever
  decision they belong to.

Those of a competitor's stakeholder who never worked for you are exported as before. See also
[privacy-and-export.md](privacy-and-export.md).

## Isolation

Stakeholders, questions, statements and reads are keyed by business tree; an id of another tree
answers 404. Hiding applies to what BIF serves: an agent with shell access on the machine can read
files under the data directory (agent.md files, run logs), as was already true for uploads.

## API

All under `/api/workspaces/:id`.

| Route | Does |
|---|---|
| `GET …/stakeholders` | the node's stakeholders; former colleagues at a competitor are listed in that competitor's group and the others under `former` |
| `GET …/stakeholder-questions` | the open question round |
| `POST …/stakeholder-questions/answers` | `{answers: [{questionId, text}], skip?: [personaId], skipAll?}` |
| `POST …/stakeholders/:personaId/reveal` | "Show what the tool found" |
| `POST …/stakeholders/:personaId/notes` | `{text, field?}` |
| `GET …/stakeholders/:personaId/statements` | a stakeholder's statements |
| `POST …/recommendations/:recId/stakeholder-decisions` | `{personaId, decision, reasoning}` |
| `GET …/recommendations/:recId/stakeholder-reads` | the reads of a recommendation |
| `POST …/stakeholder-reads/:readId/reaction` | `{reaction, reason?}` |
| `GET …/stakeholders/:personaId/positions` | the position history, newest first; for a former colleague both layers, whether the public one is used and when the profile was last combined |
| `POST …/stakeholders/:personaId/position` | a position change (bodies below) |

Position change bodies:

- `{change: 'left', date, to: {competitorId} | {newCompetitor: {name, site?}} | {elsewhere: {companyName?}}, label?, title?, note?}`
  (for someone who already left: moved on to that company);
- `{change: 'moved' | 'promoted' | 'demoted', date, toWorkspaceId?, stakeholderType?, title?, note?}`;
- `{change: 'returned', date, toWorkspaceId, stakeholderType?, title?, note?}`.

The persona learning routes ([personas.md](personas.md#api)) serve open stakeholders too, never
hidden ones.
