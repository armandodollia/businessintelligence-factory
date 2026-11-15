# A persona of the user — design

Date: 2026-11-15. Project 4 of 4. Builds on persona learning (project 2) and shares the `personas.kind`
column added by stakeholder personas (project 3).

The user asked for projects 2–4 to be designed and built without further input. Every decision below
that the user did not state is marked **(my call)**.

## 1. Intent

The user's own behaviour in the tool says what they care about: what they include and exclude, which
proposals they accept, edit or reject, what they overrule, and the reasons they type. The tool should
keep a picture of the person it works for, improve it from those interactions over time, and use it
so its work fits that person better.

What the user decided:

- The user's interactions with the tool improve their virtual persona over time.
- Learning happens only in the scheduled retro, with enough data to smooth out statistical peaks.
- Both positive and negative signals are kept.
- The retro may show the assumptions the tool is making and the changes it wants to make.

## 2. Goals, non-goals, anti-goals

Goals

1. One persona of the user per business tree, built only from what the user did in that tree.
2. Every statement in it rests on several interactions, is proposed in the retro, and takes effect
   only when the user accepts it (optionally edited), with a reason either way.
3. The user can see the whole picture, what each line rests on, and retire any line.
4. The accepted picture is given, as a short brief, to the roles that decide what to work on and how to
   present it.

Non-goals

- Predicting the user's decisions and showing the prediction **(my call)**: it would anchor the user,
  the same concern they raised about stakeholders.
- Using the interview transcript or uploads as input **(my call)**: that text is internal, and a brief
  built from it would mark every run that reads the brief as upload-exposed and keep its output out of
  exports. The persona learns from actions and typed reasons only.
- A persona shared across business trees (trees never share data).
- Role-playing the user. The persona is a brief, not an agent that speaks.

Anti-goals

- The user's name, email address or any identifier in the persona, a prompt or a request.
- A line that rests on one action.
- The picture changing between retros, or without the user's decision.
- The brief reaching reviewers or simulated personas, whose judgement must not bend to the user's taste.

## 3. Constraints

As in project 2. The persona holds no identifying information: it refers to "the person you work for".
All text passes the existing identity redaction before storage.

## 4. Approaches considered

- **A. A persona row of kind `user` whose content is adjustments, learned in the retro (chosen).**
  Reuses proposals, decisions, versions and the page block of project 2. Everything in it is a
  reversible, evidence-backed line.
- **B. A free-form profile document rewritten by an agent each retro.** Easy to build, but one rewrite
  can change everything at once, and no line can be traced to what the user did.
- **C. Statistics only (accept rates per kind).** No model and no risk, but numbers do not tell an
  agent how to work for the person.

## 5. The persona

One row of `personas` per business tree: `kind: 'user'`, workspace = the tree root, slug `user`,
label "The person you work for", empty profile, `disclosure: 'open'`. It is created by the first retro
that qualifies. It is never a segment or stakeholder persona and takes part in no panel or round.

Its content is its active adjustments (project 2), each tagged with one of `USER_FIELDS`:

| Field | What it covers |
|---|---|
| `priorities` | what they weigh most when choosing what to act on |
| `quality_bar` | what they reject or exclude, and why |
| `evidence_standards` | what kind of evidence convinces them, and what does not |
| `decision_style` | how they decide: fast or deliberate, alone or after checking |
| `risk_appetite` | how much uncertainty and cost they accept |
| `domain_knowledge` | where they correct the tool from expertise, and where they rely on it |
| `communication` | how they want results presented |
| `recurring_corrections` | corrections they make again and again |

At most `maxPerField` (default 3) active lines per field and `maxAdjustments` (default 12) in all.

## 6. Interactions

Computed on read from the feedback log and the ratings of the tree (module
`src/core/userPersona/interactions.ts`); nothing new is stored.

```ts
type Interaction = {
  id: string;                    // feedback event id or rating id
  kind: string;                  // the feedback kind, or 'rating'
  stance: 'accept' | 'reject' | 'edit' | 'neutral';
  target: string;                // `<targetType>:<targetId>`: the thing acted on
  topic: string;                 // grouping: the feedback kind, or `rating:<targetType>`
  detail: string;                // one line from ids, enums and numbers; never evidence text
  reason?: string;               // the user's typed reason, as stored
  refs: string[];                // ids it rests on, for the upload check
  at: string;
};
```

Stance by kind: accepting, agreeing, including and applying are `accept`; rejecting, disagreeing,
excluding, retracting, retiring and reverting are `reject`; anything accepted with changes, a
correction, an override or an edit is `edit`; the rest (`user_action`, schedule and config changes)
are `neutral` and are counted in the statistics but not shown as evidence. Ratings: verdict `agree`
is `accept`, `disagree` is `edit` (the user set another value). A change of the scoring weights
(`weights_change`) is `edit`, the clearest statement of the person's priorities; other config and
schedule changes are `neutral`. Only an answered `approval` request is a judgement (resolved `accept`,
denied `reject`); answering any other request kind is `neutral`.

**Open interactions**: newer than the `signalsThrough` of the user persona's latest finished learning
run, not older than `windowDays` (default 180).

## 7. The gate

A learning run happens when the open, non-neutral interactions number at least `minInteractions`
(default 12) on at least `minDistinctTargets` (default 6) different targets. Otherwise the page says
what is missing ("7 of 12 actions", "4 of 6 different things").

The smoothing is in three places: this gate, the evidence rule on each proposal (§8), and the user's
decision.

## 8. The learning run

In `runRetro`, after persona learning. One agent run per tree: role `retro`, no browser, system prompt
`prompts/user_persona_learning.md`, model as in project 2. The prompt holds, within the budget rules
of project 2 (the oldest interactions are kept when it is too long; the header takes at most half):

- the picture so far: active lines by field;
- proposals the user rejected before, with the reason (at most 5);
- statistics over the window: counts by kind and stance;
- the open interactions grouped by topic, each `<id> <stance> — <detail>` and the reason, fenced as
  untrusted data. An interaction whose refs are blocked by the upload rule is shown as id and stance
  only.

It answers once with `submit_persona_learning` (project 2's tool; `field` from `USER_FIELDS`). The
handler applies project 2's checks with these differences: an `add` or `replace` needs at least
`minEvidence` (default 3) interactions on at least 2 different targets, with no rule about
disagreements; at most `maxProposals` (default 3); the per-field and total caps of §5. Text is written
about "the person you work for", in the third person, as a general statement, never quoting a reason.

The run is recorded in `persona_learning_runs`; a finished run consumes what it was shown; a failed one
consumes nothing. There is no engine step for this persona.

## 9. Decisions and the brief

The user accepts (optionally edited), rejects or retires through project 2's functions; each bumps the
persona version. These decisions are interactions too, so rejecting a line teaches the next retro.

`userBrief(store, rootWorkspaceId)` returns the active lines grouped by field, or nothing. With
`useInPrompts` (default true) it is appended to the system prompts of the **orchestrator, synthesizer
and interviewer** **(my call)** under:

```
## The person you work for

Learned from their decisions in this tool. Follow it where it does not conflict with the evidence.

- [A-71C0DE.v1] (priorities) Prefers changes that can ship within a quarter over larger bets.
```

Workers, reviewers, personas, the escalation role and the retro itself never receive it. Because the
brief is part of the prompt text, a run's prompt version shows which brief it carried.

## 10. Storage and settings

No new tables. Migration only if project 3's `kind` column needs the value documented; `'user'` is
already allowed. `persona_learning_runs.shown_signal_ids` holds the interaction ids shown.

`config.userPersona` (all optional): `enabled` true · `minInteractions` 12 · `minDistinctTargets` 6 ·
`minEvidence` 3 · `maxProposals` 3 · `maxAdjustments` 12 · `maxPerField` 3 · `windowDays` 180 ·
`useInPrompts` true.

## 11. API

- `GET /api/workspaces/:id/user-persona` — `{ enabled, gate: { n, targets, qualifies, missing },
  stats, lines: adjustments by field with evidence counts, proposals, lastRun }` for the tree.
- `GET /api/workspaces/:id/user-persona/interactions` — newest first, paged.
- Accept, reject and retire use project 2's routes.

## 12. What the user sees

A "You" page per business tree.

```
How the tool sees you                       Used by: orchestrator, synthesizer, interviewer  [on]

Priorities
  [A-71C0DE.v1] Prefers changes that can ship within a quarter over larger bets.   [Retire]
  Rests on 5 of your actions ▸ show

Proposed by the retro of 16 Nov
  Assumption: you exclude findings that rest on a single review site.
  add (evidence_standards) "Does not act on a claim backed by one source."  [Accept] [Edit] [Reject]
  reason: [__________]

What the tool has seen you do (last 180 days)
  Included 14, excluded 9 · proposals accepted 5, edited 3, rejected 2 · verdicts agreed 6, disagreed 9
  Next retro: 7 of 12 actions since the last learning run.
```

## 13. Privacy and isolation

- Input is the tree's own feedback log and ratings; no interview text, no upload text.
- A learning run that was shown upload-derived text has its proposals refused (project 2's rule).
- No identifier of the user is stored or sent; a test asserts the brief and prompts contain neither
  the configured user id nor any email-like string.
- Another tree's persona, lines and interactions answer 404.

## 14. Left to the builder

Prompt wording, the exact stance mapping table for each feedback kind (follow §6), statistics layout,
component split.

## 15. Verification

Unit tests per module; end to end (actions → retro → proposal → accept → brief in the orchestrator's
prompt, absent from a reviewer's); a test that nothing changes outside the retro; isolation across two
trees; the identifier test; a smoke mode `user-persona` for the real CLIs.

## 16. Amendment: one persona per person

Decided after the design, when the user said several people will use one shared store. The persona is
one per person per business tree, not one per tree: the row carries the actor id (the same id the
feedback log records on every action) in `subjectId`, interactions are only that person's actions, the
retro runs the learning once per person with enough actions, and the brief given to a run is the brief
of the person acting (today the one configured user). Only that person can decide their own lines. The
actor id still never appears in a line, a prompt or a request to an agent. Where §5–§13 say "per
business tree", read "per person per business tree".

## 17. As built: where the build differs from this design

- The retro learns only for people the tool can show proposals to. Today that is the configured
  person; actions recorded under another id are not learned from.
- The learning run is offline (no web tools), and is skipped with a recorded Decision when no enabled
  provider can run offline.
- `userPersona.enabled: false` switches off both learning and the brief; `useInPrompts: false` only the
  brief.
- A line the person edits is refused when it contains their user id or an email-like string. The
  default id `local-user` is not treated as an identifier.
- A change of the scoring weights counts as `edit`. Only an answered approval request counts as a
  judgement; other requests are neutral.
- The user persona is kept out of knowledge search, entity cards, the orchestrator's knowledge briefing
  and every persona list.
- The page has no on/off switch for the brief; it is set in the config file.
- Not separated by person (matters once several people share a store): the feedback log, run logs and
  stored prompts of a business.
