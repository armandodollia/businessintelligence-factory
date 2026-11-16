# Stakeholder positions: people who leave, move or change position — design

Date: 2026-11-15. Status: approved in conversation (the user asked for it and refined it on
2026-11-15); decisions the user did not state are marked **(my call)**. This is step 0 of
`2026-11-15-hub-and-runners-design.md` (§8d, first part). It works on one machine and does not depend
on the hub. The account part of §8d (sign-in, roles, machines) is not in this project.

## 1. Intent

A stakeholder persona models a person (or team) whose approval a node needs. People change position.
The user wants to:

- mark that someone left the company and where they went, so they stop counting as a stakeholder while
  their persona stays in use as a competitor's;
- mark a move to another team or division, a promotion or a demotion;
- keep refining the persona of someone who left from what the public web shows, **stored apart from**
  what the company knew from inside, and read both to form one combined profile. Public data is
  filtered and coloured; internal knowledge is the more valuable part, and the two together allow
  conclusions neither gives alone.

## 2. Goals, non-goals, anti-goals

Goals

1. An append-only position history per stakeholder persona.
2. Four actions by the user: left, moved, promoted or demoted, returned.
3. A former colleague at a competitor reads recommendations as a rival, knowing what they knew when
   they left.
4. Two stored layers for a former colleague (internal, public) and a combined profile written from
   both, each field marked with what it rests on.
5. Research follows former colleagues on the web in the normal stakeholders phase.

Non-goals

- Hub accounts, roles, access per branch ("start fresh at the new node" of §8d needs roles and waits
  for hub step 3; here a moved persona always carries what is known).
- Automatic position changes. Research reports what it found; the user records the change.
- Following people who are not stakeholder personas.

Anti-goals

- Internal knowledge about a former colleague in a web request, an export, or a run that has web
  access.
- A former colleague still asked for approval, still in the question round, or still taking a place
  among the own stakeholders.
- A failed follow research disabling a persona.
- History that can be edited.

## 3. Terms

- **Former colleague**: a stakeholder persona with `leftAt` set.
- **Parked**: a former colleague who went somewhere that is not a competitor of the tree
  (`subjectKind: 'former'`).
- **Internal layer**: the profile as it was when they left (`internalProfile`), plus the active
  adjustments and the user's statements (existing mechanisms, already marked internal).
- **Public layer**: the profile research found on the web after they left (`publicProfile`).
- **Combined profile**: `profile`, written by an offline run from both layers.

## 4. Storage (migration 28)

`personas`, new columns:

| Column | Meaning |
|---|---|
| `left_at TEXT` | Date (YYYY-MM-DD) the person left the own company. Set ⇒ former colleague. |
| `left_from TEXT` | JSON `{ workspaceId, scopeName, stakeholderType, title?, relation? }`: the position held when leaving. |
| `position_title TEXT` | Current title, when the user gave one. |
| `internal_profile TEXT` | JSON profile snapshot taken at leaving. |
| `public_profile TEXT` | JSON profile from follow research. |
| `public_task_id TEXT` | The task whose run last saved the public layer. |
| `public_saved_at TEXT`, `combined_at TEXT` | When the public layer was last saved; when the combined profile was last written. |
| `public_position TEXT` | JSON `{ text, evidence[] }`: what research saw of the person's current company and title. |

`subject_kind` gains the value `former`. A profile field (`PersonaProfileField`) gains two optional
properties: `basis` (`internal | public | both | inferred`) and `conflict` (text).

New table `stakeholder_positions`, append-only (triggers refuse UPDATE and DELETE), id prefix `spo_`:
`id, root_workspace_id, persona_id, change` (`joined | moved | promoted | demoted | left | returned`),
`place_kind` (`node | competitor | elsewhere`), `workspace_id`, `competitor_id`, `company_name`,
`stakeholder_type`, `title`, `relation`, `effective_on` (date), `actor`, `note`, `created_at`.

The first change recorded for a persona first writes a `joined` row with the position it had until
then (no date), so the history starts with where the person was.

## 5. The actions

All four are the user's decisions: recorded under the actor, each with a feedback event of kind
`stakeholder_position_change` (kinds starting `stakeholder_` are already internal for export). Each
runs in one transaction: history row(s), persona update, version + 1, agent.md rewritten. Dates are
`YYYY-MM-DD`, not in the future. A hidden stakeholder answers 409 ("answer or skip its questions
first"). Unknown ids and ids of another tree answer 404.

### 5.1 Left

Input: date; destination; optional new label (for example the person's name, when the persona was
labelled by role), title at the new company, note.

Destination is one of:

- **a competitor of the tree** (not superseded): the persona becomes that competitor's stakeholder
  (`subjectKind: 'competitor'`, `subjectId`), slug `stk-<competitor>-<label>`;
- **a new competitor by name** (and optional site): a competitor is created at the node with threat
  and directness 1, an empty comparison, no evidence, status `unverified` **(my call)**, so it is
  usable and visibly unresearched; then as above;
- **elsewhere**, with an optional company name: the persona is parked (`subjectKind: 'former'`, slug
  unchanged).

In every case: `leftAt`, `leftFrom` and `internalProfile` (a copy of `profile`) are set; every profile
field gets `basis: 'internal'`; the persona's open questions are closed as skipped; `relation`
becomes the new title or empty (the old relation is kept in `leftFrom`). A slug already used by
another persona of the node answers 409 with the conflicting label.

Only an own stakeholder (`subjectKind: 'own'`, no `leftAt`) can leave. A parked former colleague can
be given a competitor later with the same action ("attach"): its `leftAt` and layers are kept.

### 5.2 Moved, promoted, demoted

Input: the kind of change, date, optional target node (same tree), stakeholder type, title, note.
`moved` requires a target node different from the current one. The persona's node, type and title
change; its agent.md path follows the node; its open questions move with it. Past reads, statements
and learning records stay where they are (they are keyed by persona, and statements are
append-only). A slug already used at the target node answers 409. Only an own stakeholder that has
not left can be moved or change position. The user's move is not held back by `maxOwn` at the target.

### 5.3 Returned

For a former colleague (at a competitor or parked). Input: date, target node, optional type, title.
The persona becomes an own stakeholder of that node again (`subjectKind: 'own'`, no `subjectId`, slug
`stk-<label>`), disclosure `open`. `leftAt`, `leftFrom`, `internalProfile`, `publicProfile`,
`publicPosition` are cleared; `profile` keeps the combined profile as its working profile, with the
`basis` marks.

## 6. What a former colleague takes part in

| | Own | Former colleague at a competitor | Parked |
|---|---|---|---|
| Question round | yes | no | no |
| Reads of recommendations | approval stances | rival stances | none |
| Recording a real decision | yes | no | no |
| Notes by the user | yes | yes | yes |
| Learning from notes and reactions | yes | yes | notes only |
| Counts towards `maxOwn` | yes | no | no |
| Counts towards `maxPerCompetitor` | – | no | – |
| Interview: listed as own stakeholder | yes | no | no |
| Followed on the web | no | yes | yes |

One helper decides privacy everywhere: `holdsInternal(persona)` is true for every stakeholder persona
except a competitor's stakeholder that never worked here (`subjectKind === 'competitor'` and no
`leftAt`). Runs that carry such a persona's agent.md or learning prompt (reads, learning, the combine
run) are offline; with no provider that can run offline they are skipped with a harness Decision, as
today.

The agent.md of a former colleague at a competitor adds, after the opening paragraph: that until the
date they worked at the node in the position of `leftFrom`; that they know its plans, people and way
of deciding as they were up to then and nothing that changed later; and, per section, what the
content rests on (internal knowledge, public sources, both, or a conclusion from both), with any
recorded conflict.

## 7. The two layers and the combined profile

### 7.1 Follow research (public layer)

In a `competitor_stakeholders` task the work prompt gains a section "Former colleagues to follow":
at most `stakeholders.maxFollowed` (default 5) former colleagues of the node, those whose public layer
is oldest first. Each line gives the persona id, the label, the position held here and until when,
and where they went (competitor name, or the company name for a parked one). Nothing else of the
persona is in the prompt: no profile, no adjustments, no statements. The existing rule against
putting internal details into web requests applies.

`save_stakeholder` gains two optional inputs:

- `follow`: the id of a former colleague of the node. When set, `label` and `subject` are ignored and
  the profile is stored as that persona's **public layer** (`publicProfile`, `publicTaskId`,
  `publicSavedAt`). The persona's `profile`, `status`, `taskId` and `version` are not touched, so a
  failed review cannot disable the persona.
- `now_at`: one line on the company and title research saw, stored with the save's evidence as
  `publicPosition`. The page shows it; the user records a change if it is right.

A `follow` of a persona that is not a former colleague of the node is refused. A save without
`follow` whose slug belongs to a former colleague is refused with a message naming `follow`.

The stakeholders phase plans a `competitor_stakeholders` task when the node has competitors **or**
former colleagues to follow.

### 7.2 The combine run

After the stakeholders phase's tasks have ended, for each former colleague of the node whose public
layer is newer than its combined profile and whose `publicTaskId` task ended `verified` or
`unverified`: one offline run (role `retro`, as persona learning) gets the internal layer (the
snapshot, each field with its date `leftAt`), the public layer, and the instruction to write one
profile:

- internal knowledge is the base for how the person decides; public facts say what they do now;
- public sources are filtered and favourable to their subject: weigh them so;
- where the layers disagree, keep both in a `conflict` note and do not resolve it silently;
- a statement concluded from both layers has basis `inferred` and says what it rests on;
- every field states its basis.

It answers with a new tool `submit_combined_profile` (`persona_id`, and for every stakeholder field
`value`, `confidence`, `basis`, optional `conflict`). The handler refuses a persona other than the
one asked and a missing field. Evidence is not taken from the model: per field it is the internal
field's evidence for `internal`, the public field's for `public`, and both for `both` and `inferred`,
so upload-derived evidence keeps a combined field out of exports exactly as it did before. On
success: `profile` replaced, version + 1, `combinedAt` set, agent.md rewritten, one Decision recorded
(internal for export). A run that ends without the call leaves the profile as it was and records why.

A task that failed review leaves its public layer stored and unused.

### 7.3 Export

The record of a combine run, position changes and the user's notes are internal (left out of exports
by default). The public layer's own research decisions export as those of any competitor stakeholder.

## 8. Settings

`stakeholders.maxFollowed` (default 5; 0 turns following off).

## 9. API

Under `/api/workspaces/:id`:

- `GET /stakeholders` also returns `former` (parked former colleagues) and, on every open view,
  `leftAt`, `leftFrom`, `positionTitle`, `publicPosition`, and whether a public layer exists.
- `GET /stakeholders/:personaId/positions` — the history, newest first; `internalProfile` and
  `publicProfile` for a former colleague.
- `POST /stakeholders/:personaId/position` — body `{ change: 'left' | 'moved' | 'promoted' |
  'demoted' | 'returned', date, … }` as in §5. Answers the stakeholder's view.

## 10. Page

On the Stakeholders page: each open own stakeholder gets a "Position" line (title, since when) and a
"Change position" form (left, moved, promoted, demoted). Former colleagues at a competitor are shown
in that competitor's group with "Former colleague, left <date>", the three profiles (combined with
the basis of each field, internal, public), what research last saw of their position, and "Returned".
A "Former stakeholders" group lists parked ones with "Attach to a competitor" and "Returned".

## 11. Verification

Unit tests for every action and every refusal; the table in §6 as tests (question round, reads,
caps, interview list); the follow save (public layer only, persona untouched, failed task ignored);
the combine run with a fake agent (evidence computed in code, refusals, offline, skipped without an
offline provider); export tests (internal records left out); route tests incl. another tree → 404;
page tests; one smoke run on the cheapest Claude model: mark a stakeholder as left to a competitor,
run the follow research and the combine run, check the two layers and the combined profile.

## 12. As built (2026-11-15)

What was built differs from the sections above in the points below. Where a point changes a section,
this section holds.

### 12.1 Changes to what the sections say

1. **Moved on (§5.1).** §5.1 let only an own stakeholder leave, and a parked former colleague be given
   a competitor. A former colleague who goes to another company could not be recorded. Now the same
   action takes any former colleague, parked or at a competitor, with the same three destinations.
   `leftAt`, `leftFrom` and both layers are kept; the history row has the change `moved` (also for the
   "attach" of a parked one, which first wrote `left`); slug and agent.md follow the new place
   (`stk-<competitor>-<label>` at a competitor, `stk-<label>` for one who leaves a competitor for
   elsewhere, unchanged for a parked one). The place the person is at already is refused (400), so a
   repeated request adds no row to a history that cannot be taken back. API: the body
   `{ change: 'left', … }` sent for a former colleague. Page: "Moved to another company" on every
   former colleague; it replaced "Attach to a competitor".
2. **A competitor by a name the node already has (§5.1).** No second row is made. A live competitor
   of that name is used as it is. A superseded one is used again and reset to what a new one is:
   threat and directness 1, empty comparison, no evidence, its task cleared, status `unverified`. The
   new competitor is created at the persona's node.
3. **Refusals (§5).** A stakeholder whose research is not usable (pending, failed, superseded, or
   unverified without the user's include) answers 409 for every action. In every action agent.md is
   written last in the transaction. Text limits: label, company and competitor name 80 characters;
   title and site 300; note 2,000. "Not in the future" is judged by the calendar day of the machine.
4. **Returned (§5.3).** The relation becomes the title or empty, as when leaving. An optional new
   label is taken, under the rules of a label on leaving (one line, at most 80 characters, the slug
   derived from it). It is the way out when the slug is in use at the node (409, with the conflicting
   label). The same holds for someone who moved on to another company (§12.1 point 1).
5. **Who is followed (§7.1).** Left out: a former colleague the user excluded or whose status is not
   usable, and one whose public layer another task of the same research run already saved. With
   `maxFollowed: 0` a `follow` save is refused too; a layer saved earlier is still combined. A `follow`
   save takes only a former colleague who is usable and not excluded (the filter of the list, without
   its cap and its same-run rule); anyone else gets the answer of an unknown id. The combine run
   leaves the same people out, so a layer saved before the user excluded someone is not combined.
   A `follow` save whose evidence is an upload, or rests on one, is refused with the ids: the public
   layer may rest only on public pages.
6. **The follow save's Decision (§7.1, §7.3).** It names the person as `followedPersonaId`, not
   `personaId`: it is no judgment of the persona. A rating of the persona never joins it in the
   export, an earlier rating does not go stale by it, and it exports with the review status of its own
   task. With `follow`, `relation` and `stakeholder_type` of the call are ignored too.
7. **"Failed review" (§7.2).** In this code a task whose review never passes ends `unverified`; `failed`
   is a task that could not finish. A layer saved by a `failed` task is stored and not used; one saved
   by an `unverified` task is combined, as §7.2 says, and the page says so (§12.2 point 3).
8. **The combine run (§7.2).** A basis that names a layer the field is not in is refused (`internal` or
   `both` without the internal field, `public` or `both` without the public one). The prompt shows the
   snapshot and the public layer only (no adjustment, no statement), each value cut at 1,200
   characters. The Decision holds ids, the basis of each field, which fields have a conflict and the
   confidences; no value. No prompt reads are logged for the run. A second answer of the same run
   changes nothing.
9. **Export (§7.3).** A follow task names the former colleague, so the evidence of that persona's
   profile counts as the task's own. When the profile rests on an upload, every judgment of that follow
   task stays out of the default export. This is the existing rule erring on the safe side; it is
   wider than "the public layer's own research decisions export as those of any competitor
   stakeholder".
   What the user says about a persona for which `holdsInternal` is true is internal by its target,
   whatever Decision it would join: a rating of the persona joins no line of the default export, and
   a feedback event on it (an include override with the user's reason) is no line. Each such event,
   and each such rating that was kept out of a line that is exported, counts once under `internal`
   among the other lines left out. This holds for an own stakeholder as for a former colleague; a
   competitor's stakeholder that never worked here is exported as before.
10. **`GET /stakeholders` (§9).** `leftAt`, `leftFrom`, `publicPosition` and `hasPublicLayer` are served
    on the views of former colleagues only, and `positionTitle` only when set, so a stakeholder that
    never changed position is served as before.

### 12.2 Additions

1. **`publicPosition` (§4)** also stores the task whose save said it (`taskId`). The API serves the
   text and the evidence.
2. **API (§9).** `GET /stakeholders` also returns `places`: the competitors and the nodes of the tree
   a person can go to. Each row of `GET …/positions` carries `placeName` (the node, the competitor, or
   the company the user named). `GET …/positions` also returns, for a former colleague with a public
   layer, `publicSavedAt`, `publicLayerUsed` (false when the task that saved the layer failed or is
   gone) and `publicLayerStatus` (`verified`, `unverified`, `failed`, or `pending` while that task has
   not ended), and `combinedAt` once the profile was combined. The body of `returned` takes `label`.
3. **Page (§10).** Under "What is public" the page says "Not used: the research that found this
   failed", "Used, although the research that found this was not verified" (the saving task ended
   `unverified`) and "Not combined yet". The "Position" line of an own stakeholder says since when
   by the newest row of the history. "Moved" is offered only when the tree has another node. The full
   history is served by the route and not listed on the page. "Moved to another company" and
   "Returned" have an optional "New name" (sent as `label`); a change the server refuses, such as a
   name in use where the person goes (409), is shown in the form in the server's words. "Moved to
   another company" never offers the competitor the person is at.
4. **What follow research may read.** A run of a `competitor_stakeholders` task is served only the
   label and type of any persona for which `holdsInternal` is true (`withheld: internal`), by `expand`,
   by the entity cards and in its worker briefing. Its profile, relation, adjustments and layers are
   withheld, as a hidden stakeholder's are.
5. **What the reviewer of a follow task sees.** The public layers the task saved, with their
   evidence, and what research saw of the position only when that task saved it. Nothing of the
   internal profile.
6. **The orchestrator** of the stakeholders phase is told how many former colleagues are still to
   follow in this research run (a count; no id, no label).
7. **Parked former colleagues.** No engine proposal to retire an adjustment; the opening line of
   agent.md leaves the relation out.
8. **After a move (§5.2),** reactions made at the old node still reach the next learning run: for a
   stakeholder persona they are collected across the nodes of its business tree.
9. **Smoke mode `stakeholder-positions`.** It follows the person from two public pages captured in
   the store, not from the live web, so the run is repeatable and cheap.

### 12.3 Known gaps

1. **Files on disk.** A CLI run with web access works from a directory under the data directory and
   can read files there, a former colleague's agent.md included. The tool and prompt paths are closed;
   the file system is not. The hub design gives each run its own working directory on the runner,
   which closes it.
2. **Uploads and facts in the knowledge store.** Follow research is served nothing of a former
   colleague's persona but its label and type. The documents the user uploaded, and the facts taken
   from them, are served to it by the knowledge tools as to every research task. What keeps them out
   of web requests is the prompt rule, as before. What keeps them out of the public layer is the
   follow save, which refuses evidence that is upload-derived (§12.1 point 5).
3. **A change of title at the same outside company** cannot be recorded as a position change (the
   same place is refused); a note on the stakeholder can say it.
4. **Time zones.** The page proposes today in the browser's time zone and the server compares with
   its own day. On one machine they agree.
5. **The page was not checked in a real browser** (tests in jsdom and the web build only).
