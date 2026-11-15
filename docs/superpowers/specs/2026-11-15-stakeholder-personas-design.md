# Stakeholder personas — design

Date: 2026-11-15. Project 3 of 4. Builds on persona learning (project 2,
`2026-11-15-persona-learning-design.md`).

The user asked for projects 2–4 to be designed and built without further input. Every decision below
that the user did not state is marked **(my call)**.

## 1. Intent

A proposal only matters if the people and systems it depends on say yes. The tool should know who
those are for each node of the business tree, build a simulated persona of each from what it can find,
and then learn from the user, who knows them first-hand.

What the user decided:

- "Stakeholders" means everyone whose approval, decision or data the node depends on: the people who
  run the company (CEO, managers), investors and other owners, and, at lower layers of the tree, sister
  systems and teams, and the system or team above.
- Stakeholder personas are built for the user's own company and for the companies under investigation.
- For the user's own company they are built automatically in the background. Then the user is asked a
  round of questions, and during that questioning the tool must not show what it found, so the
  research does not colour the user's answers.
- The answers fine-tune the personas. Anything the user later says about a stakeholder (for example a
  decision on a proposal and the reasoning behind it) improves them further.
- All learning happens in the scheduled retro, not at the moment the information arrives.
- Outside the question round, showing assumptions and proposed changes is fine.

## 2. Goals, non-goals, anti-goals

Goals

1. Stakeholder personas per node (own) and per investigated company, each field backed by evidence.
2. Own-company stakeholders are researched from what the store already holds, without new web requests.
3. A question round per node whose questions contain nothing the research found; the personas stay
   hidden until the user has answered or skipped.
4. One place for everything the user says about a stakeholder: answers, notes, real decisions with
   their reasoning, and statements made in the interview.
5. The retro turns those statements, and the user's reactions to stakeholder reads, into proposed
   adjustments (the machinery of project 2).
6. A use for the personas: a simulated read of each recommendation ("would this stakeholder approve",
   or for a rival's stakeholder "how would they respond").

Non-goals

- Stakeholder reads changing a recommendation's priority **(my call)**: they are shown, not scored.
- Stakeholder personas judging flows.
- Detecting stakeholder information inside uploaded files automatically **(my call)**: the stakeholder
  research task reads uploads when it runs; the retro does not scan them.
- A persona of the user (project 4).

Anti-goals

- A question that reveals a researched trait.
- A private name or internal detail typed into a web search.
- A stakeholder persona changing outside the retro.
- Internal statements leaving in an export by default.

## 3. Constraints

As in project 2. In addition: own-company stakeholder research runs without a browser, so nothing it
reads can reach the web. Statements are the user's internal information and are treated like
upload-derived text for exports (excluded by default, sticky).

## 4. Approaches considered

- **A. Stakeholders are personas of a second kind, sharing the learning machinery (chosen).** One
  `personas` table with `kind`, one adjustments mechanism, one retro step.
- **B. A separate stakeholder model.** Cleaner names, but it duplicates versions, agent.md, review
  status, include overrides, adjustments and learning.
- **C. Questions written by a model from the persona.** More pointed questions, but there is no way to
  prove a generated question leaks nothing. Rejected for the question round: questions are fixed
  templates filled with the stakeholder's label only **(my call)**.

## 5. The model

`personas` gains (migration 25):

| Column | Values |
|---|---|
| `kind` | `segment` (default; every existing persona), `stakeholder`, `user` (reserved for project 4) |
| `stakeholder_type` | `leader`, `manager`, `investor`, `board`, `owner`, `team`, `system`, `regulator`, `partner`, `other` |
| `subject_kind` | `own` (the node itself) or `competitor` |
| `subject_id` | the competitor id when `competitor` |
| `relation` | ≤ 300 characters: what the node needs from them or they decide ("approves pricing changes") |
| `disclosure` | `hidden` or `open`; `open` for everything except own stakeholders before their question round |

`segment` holds the stakeholder's label: a role, team or system name ("Chief financial officer",
"Billing platform team"). A person's name is used only when it appears in public evidence.
`slug` is `stk-<slug of label>` (own) or `stk-<competitor slug>-<slug of label>`.

Stakeholder profile fields (`STAKEHOLDER_FIELDS`, each `{ value, confidence, evidence }` like segment
fields): `role_mandate`, `goals_incentives`, `decision_criteria`, `constraints`, `risk_tolerance`,
`dependencies` (what the node needs from them and they from the node), `known_positions` (past
decisions and stated reasons), `objections`, `information_needs`, `communication_style`, `influence`.

Everything that today assumes "a persona is an audience segment" (the persona panel, flow verdict
rounds, the Personas page, persona rating criteria) reads segment personas only.

## 6. Building them

New phase `stakeholders`, after `deep_dives` and before `flow_ranking`; existing schedules gain it by
migration (as flow ranking did). Two task types:

- `own_stakeholders` — never has a browser (forced in code where the task is created, whatever the
  planner asked). The worker reads what the store holds for the node: public pages other tasks already
  captured (company audit, filings, news), internal uploads, the interview, the business tree (parent
  and sibling nodes). It saves each stakeholder with `save_stakeholder`, at most `maxOwn` (default 8).
  For a node below the root it is told that parent and sibling nodes whose approval or data this node
  needs are stakeholders of type `team` or `system`.
- `competitor_stakeholders` — with a browser, public sources only, for the `maxCompetitors` (default 3)
  most important competitors, at most `maxPerCompetitor` (default 3) each: leaders, owners, investors,
  parent company.

`save_stakeholder` (worker tool): `label`, `stakeholder_type`, `subject` (`own` or a competitor id of
the tree), `relation`, `profile` (every stakeholder field, each with value, confidence, at least one
evidence artifact of the tree). Upserts by slug, bumps the version, writes agent.md, records a `score`
Decision carrying the label, type and confidences only. Review status works as for personas. A first
save of an own stakeholder sets `disclosure: hidden`; a later save never changes disclosure.

The company audit and public filings prompts gain one line: capture the public leadership, ownership
and investor pages when they exist.

agent.md for a stakeholder: "You are <label>, a stakeholder of <scope>: <relation>. You judge proposals
as someone who must approve, fund or supply them", the stakeholder sections, the corrections section of
project 2, and instructions to answer with `submit_stakeholder_read`. For a competitor's stakeholder:
"You are <label> at <competitor>, a rival of <scope>" and the read asks how they would respond.

## 7. Hidden until asked

While an own stakeholder persona is `hidden`:

- the API returns only its id, label, type and the state of its questions; never its profile, relation,
  evidence, agent.md path, adjustments, proposals, signals or reads;
- it gives no stakeholder reads and is skipped by persona learning;
- pages that list raw agent activity (the decision log) show only what the Decision holds: label, type
  and confidence numbers.

It becomes `open` when the user answers or skips its questions, or presses "Show what the tool found"
(recorded as a skip). Opening is one-way.

## 8. The question round

Created when the `stakeholders` phase ends and the node has hidden stakeholder personas that are usable
and have no questions yet. No model is involved. For each such stakeholder, four questions from fixed
templates, filled with the label only:

People (`leader`, `manager`, `investor`, `board`, `owner`, `regulator`, `partner`, `other`)

1. `decision_criteria` — "When {label} decides on something you bring to them, what matters most to them?"
2. `dependencies` — "What do you need from {label} (approval, budget, people, information), and what do they need from you?"
3. `known_positions` — "Think of the last time {label} said yes or no to something you proposed. What was it, and what reason did they give?"
4. `objections` — "What usually makes {label} hesitate or push back?"

Teams and systems (`team`, `system`)

1. `dependencies` — "What does {label} provide to you, and what do you have to ask them for?"
2. `decision_criteria` — "When you ask {label} for a change or for access, what decides whether you get it?"
3. `known_positions` — "Think of the last request {label} accepted or turned down. What was it, and why?"
4. `constraints` — "What limits what {label} can do for you (their roadmap, capacity, rules)?"

And two questions for the node as a whole: "Is anyone missing from this list whose approval, budget or
data you depend on?" and "Is anyone on this list not relevant to your work?"

Every answer is optional free text (≤ 4,000 characters, redacted like reasons). The user can skip one
stakeholder or the whole round. Submitting or skipping opens the personas concerned. A non-empty answer
becomes a statement (§9). Later stakeholders get a new round the same way.

## 9. Statements

Everything the user says about a stakeholder is a statement (`stakeholder_statements`): `id` (`sst_`),
tree root, node, `persona_id` (empty for the two node-wide questions and for notes about someone not
yet known), `source`, `field`, `text`, and what it came from.

| Source | Where |
|---|---|
| `question_answer` | the question round |
| `note` | "Add a note" on a stakeholder, any time |
| `decision_record` | "Record the real decision" on a recommendation: stakeholder, decision (`approved`, `approved_with_conditions`, `rejected`, `deferred`), the reasoning |
| `interview` | the interviewer's `note_stakeholder` tool, when the user mentions a stakeholder; `quote` must be text the user typed in the interview, checked against the transcript |

Statements are append-only, internal, and excluded from exports by default. Storing one changes no
persona. Statements without a persona are given to the next `own_stakeholders` task as input.

## 10. Stakeholder reads

In the `persona_panel` phase, after the segment personas: each open, usable stakeholder persona reads
each usable recommendation of its node, own stakeholders first, at most `maxReadsPerPanel` (default 40)
runs. It answers with `submit_stakeholder_read`:

- own: `stance` one of `approve`, `approve_with_conditions`, `reject`, `not_my_call`;
- competitor: `stance` one of `ignore`, `watch`, `copy`, `counter`;
- both: `conditions[]`, `concerns[]`, `reasoning`, `would_change_mind`.

Stored in `stakeholder_reads` (`id` `srd_`, recommendation, persona, persona version, stance, the
texts, run, `simulated: true`); a new read by the same persona replaces the old one. Reads are shown on
the recommendation, labelled simulated, and never change its priority.

The user can agree or disagree with a read, with a reason (`stakeholder_read_reaction`).

## 11. Learning (extends project 2, retro only)

New signal sources for stakeholder personas:

- `read_reaction` — the user's latest reaction to a read; item `rec:<id>`; topic `read`.
- `decision_record` — a recorded real decision compared with the persona's read of the same
  recommendation, when there is one: `approved` or `approved_with_conditions` against `approve` or
  `approve_with_conditions` agrees, `rejected` against `reject` agrees, anything else disagrees;
  `deferred` and `not_my_call` give no signal. Item `rec:<id>`; topic `decision`.

A stakeholder persona goes to a learning run when the gate of project 2 qualifies **or** it has at
least one statement no run has consumed. The run's prompt adds the open statements (fenced, with ids);
a proposal may cite statement ids. An `add` or `replace` that cites at least one statement needs no
further evidence **(my call)**: a first-hand statement is not a noisy reaction; proposals resting only
on reactions keep the rule of project 2. A finished run consumes the statements it was shown.

Adjustments from a run that was shown statements are `internal`. Internal adjustments and statements
follow the export rule for upload-derived text. Hidden personas are skipped; their statements wait.

## 12. Storage (migration 25)

- `personas`: the six columns of §5.
- `stakeholder_questions`: `id` (`stq_`), root, node, `persona_id` (empty: node-wide), `field`, `text`,
  `status` (`open`, `answered`, `skipped`), `statement_id`, `created_at`, `answered_at`.
- `stakeholder_statements`: §9, plus `question_id`, `recommendation_id`, `decision`, `actor`,
  `created_at`, `consumed_by_run_id`.
- `stakeholder_reads`: §10.
- Schedules: the `stakeholders` phase after `deep_dives` (migration 26, like migration 23).

## 13. Settings (`config.stakeholders`, all optional)

`enabled` true · `maxOwn` 8 · `maxCompetitors` 3 · `maxPerCompetitor` 3 · `maxReadsPerPanel` 40.

## 14. API

- `GET /api/workspaces/:id/stakeholders` — own and competitor stakeholders of the node; hidden ones as
  `{ id, label, stakeholderType, disclosure: 'hidden', questions: n }` only.
- `GET /api/workspaces/:id/stakeholder-questions` — open questions grouped by stakeholder.
- `POST /api/workspaces/:id/stakeholder-questions/answers` `{ answers: [{ questionId, text }], skip: [personaId], skipAll? }`
- `POST /api/workspaces/:id/stakeholders/:personaId/reveal`
- `POST /api/workspaces/:id/stakeholders/:personaId/notes` `{ text, field? }`
- `POST /api/workspaces/:id/recommendations/:recId/stakeholder-decisions` `{ personaId, decision, reasoning }`
- `GET /api/workspaces/:id/recommendations/:recId/stakeholder-reads`
- `POST /api/workspaces/:id/stakeholder-reads/:readId/reaction` `{ reaction, reason? }`
- The persona learning routes of project 2 serve stakeholder personas too, never hidden ones.

## 15. What the user sees

A Stakeholders page per node.

```
Questions for you (3 stakeholders)                         [Skip all]
The tool has drafted a picture of each of these. It will show you after you answer,
so your answers are your own.

Chief financial officer · leader                           [Skip] [Show what the tool found]
  When Chief financial officer decides on something you bring to them, what matters most?
  [__________________________________________]
  …
Is anyone missing from this list whose approval, budget or data you depend on?
  [__________________________________________]
                                                           [Send answers]
```

Below it, open stakeholders as cards: label, type, relation, profile fields with confidence and
evidence, "Add a note", and the "What the tool has learned" block of project 2. Competitor stakeholders
are listed under their company. On a recommendation: the stakeholder reads (simulated), agree /
disagree with a reason, and "Record the real decision".

## 16. Privacy and isolation

- Own stakeholder research has no browser. The competitor task has no access to the node's uploads or
  interview beyond what any research worker has, and its prompt forbids searching for anyone who is not
  named in public evidence.
- Question text is template plus label; a test asserts it for every template.
- Statements, reads and questions are keyed by tree root; other trees answer 404.
- No names, emails or identifiers of the user are stored in statements beyond what the user typed;
  text is redacted with the existing identity redaction before storage.

## 17. Left to the builder

Prompt wording, the order of cards, indexes, how the page splits into components, and the cut-off rule
for "most important competitors" (use the ordering the deep dives already use).

## 18. Verification

Unit tests per module; a leak test (no hidden persona content in any response of the API while hidden);
a no-browser test for `own_stakeholders`; end to end (research → hidden → answers → open → retro →
proposal citing an answer → accept → agent.md); decision record against a read gives the right signal;
isolation across two trees; a smoke mode `stakeholders` for the real CLIs.

## 19. As built: where the build differs from this design

Reviews during the build found gaps in the sections above. The build follows these rules; where they
conflict with an earlier section, this one holds.

- **Offline, not only "no browser" (§3, §6, §16).** The agent CLIs have their own web, shell and file
  tools, so removing the browser was not enough. A run of an `own_stakeholders` task (worker, reviewer,
  reviewer audit) is `offline`: the Claude CLI is started with no built-in tools, OpenCode with every
  tool denied except the harness tools, and Codex refuses offline runs. The same applies to a read by
  an own stakeholder and to a learning run for an own stakeholder persona. Competitor stakeholder work
  is not offline.
- **Model choice for offline work.** One helper (`src/core/harness/offline.ts`) picks the model. A
  configured model whose provider cannot run offline is swapped for one that can; the reviewer is the
  usual pick or the configured reviewer when it can run offline, else another capable model, and the
  worker's own model only when it is the only one. When no enabled provider can run offline the task is
  not planned (reads and learning runs are skipped) with a recorded Decision, and the server prints a
  warning at startup.
- **Withheld activity (§7).** While an `own_stakeholders` task is unfinished, or its node has a hidden
  stakeholder, its runs, run events, task detail, Decisions, requests and review audits are served in a
  withheld form on every route and on the live event stream (`src/core/stakeholders/withheld.ts`).
  Hidden content is also kept out of knowledge search results, entity cards, lessons quotes and the
  opt-in export. A hidden stakeholder cannot be included or excluded.
- **What own-stakeholder research may do.** It may save only stakeholders, cannot ask the user
  anything, and is not escalated. `save_stakeholder` is accepted only from the two stakeholder task
  types. Labels and relations are one line; labels are at most 80 characters. The caps count only
  stakeholders that are not failed or superseded.
- **Questions (§8).** A round holds the four template questions for every hidden own stakeholder that
  is not failed or superseded (verified or not), plus the two node questions. Node questions close with
  the round. A stakeholder whose questions were all skipped stays hidden until the user opens it.
- **Interview (§9).** The interviewer sees own stakeholders as id, label and type only, and records
  what the user says about one with `note_stakeholder` (quote of at least 12 characters).
- **Switching it off (§13).** `stakeholders.enabled: false` skips the phase and records that. Hidden
  stakeholders that already exist can still be opened from the page.
- **Export (§16).** Exclusion reason `internal` covers adjustments and proposals that rest on a
  statement, every `stakeholder_*` feedback event, and every Decision of an `own_stakeholders` task
  with the feedback that targets it.
- **Reads (§10).** A reaction to a read that was later replaced is not shown on the new read. A recorded
  decision is compared with the persona's current read of that recommendation.
- **Known gaps.** An `own_stakeholders` task left unfinished with nothing to finish it stays withheld
  (it fails safe). An experiment arm on a Codex model for such a task is refused when it runs. Agents
  with shell access on the machine can read files under the data directory, as was already true for
  uploads.
