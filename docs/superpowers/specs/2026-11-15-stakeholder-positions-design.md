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
