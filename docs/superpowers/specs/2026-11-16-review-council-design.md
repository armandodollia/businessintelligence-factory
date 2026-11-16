# Review council — design

Date: 2026-11-16. Status: requested by the owner on 2026-11-16 with the rules in §2; decisions the
owner did not state are marked **(my call)**. Adapted from the council skill of tstack
(https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md), as approved for the owner's
AI app factory.

## 1. Intent

Wherever one reviewer agent judged work, several independent reviewers can judge it in parallel, each
through one lens, on different CLIs and models. In BIF the work under review is a research
deliverable: claims against evidence and a task brief, not code against a ticket.

## 2. The owner's rules (all carry over)

1. Members (number, lens), models and the number of rounds are configurable.
2. Members can come from several CLIs. An unavailable CLI or model is reported, never replaced by
   another model.
3. No nits: style and preference never block and never lower a score.
4. No major scope creep: members judge against the task as given; a real problem outside it is a
   follow-up. The orchestrator keeps the scope limited across rounds.
5. Members hunt for useless work that adds bloat and propose deleting it (in code: useless tests; in
   research: useless findings).
6. Nothing under review is precious: a member may propose discarding the deliverable and redoing it
   another way, within the same task.
7. Evidence or nothing: a finding without evidence is a question.
8. Each member scores out of 10 per round; a pass needs every blocking member at or above the pass
   score; at the round limit the task goes to a person.
9. With no council configured, behaviour is exactly as today. A council is opt-in per stage.

## 3. Where a council sits

A stage is a task type. `council.stages` names the task types reviewed by a council; every other task
type keeps its single reviewer.

- Recommended (documented, not switched on by default): `synthesize_recommendations` (few tasks; its
  recommendations and their scores are what the user acts on) and `symptom_hypotheses` (causal claims
  that steer later research).
- One reviewer is enough for bulk evidence gathering (many tasks per run, sampled by the reviewer
  audit), and nothing changes for the persona panel, stakeholder reads, learning runs, the combine
  run and escalation: they are not verification steps.
- The reviewer audit does not audit a task whose final review was a council.
- Development workflow: `.claude/skills/council/SKILL.md`, the skill adapted for reviewing a BIF
  branch against its plan and spec (§11).

## 4. Configuration

```jsonc
"council": {
  "rounds": 3,              // most review rounds of a council stage; a stage may override
  "passScore": 9,           // every blocking member must score this or more; a stage may override
  "blockOn": "any",         // any | majority | all: blocking members needed to uphold a finding
  "onUnavailable": "fail",  // fail | report
  "members": [
    { "name": "evidence",  "provider": "claude", "model": "opus",   "lens": "evidence" },
    { "name": "second",    "provider": "codex",  "model": "gpt-5",  "effort": "high", "lens": "evidence" },
    { "name": "reasoning", "provider": "claude", "model": "sonnet", "lens": "reasoning" },
    { "name": "redo",      "provider": "claude", "model": "opus",   "lens": "rewrite", "blocking": false }
  ],
  "stages": { "synthesize_recommendations": { "members": ["evidence", "second", "reasoning"], "rounds": 4 } }
}
```

- `provider` is one of BIF's CLIs (`claude`, `codex`, `opencode`). Any other name is a configuration
  error that lists the supported ones. `cli` is accepted as another spelling of `provider`.
- Defaults: `rounds` 3, `passScore` 9, `blockOn` `any`, `onUnavailable` `fail`, `blocking` true.
- A stage with no `members` seats the whole council. A stage must seat at least one blocking member.
- Member names are unique. A stage naming an unknown member is a configuration error.
- A member whose provider is disabled or whose model is not in that provider's `models` is **not** a
  configuration error: the configuration loads, a start-up warning names the member, and at review
  time the member is unavailable (§7). This lets one configuration be used on machines with
  different CLIs installed **(my call)**.
- `effort` is passed to the CLI where that CLI has a setting for it. For a provider that has none,
  `effort` is a configuration error naming the provider (never ignored silently).
- In a council stage, `rounds` and `passScore` replace `loop.maxRounds` and `loop.passThreshold`
  (including their per-task-type overrides) for that task type.

## 5. Members

Each member is one reviewer run: role `reviewer`, the same tools and the same review slice as today's
reviewer, started in parallel with the others, never shown another member's output. Its system
prompt is today's reviewer prompt followed by the council section: the member rules and its lens.

### 5.1 What every member is told

1. **Nothing here is precious.** The deliverable is a draft in review. If a better answer to the
   same brief is possible by discarding it and working another way, say so (§5.4). This covers this
   task's outputs only, not facts already stored by other tasks.
2. **No nits.** Wording, order and presentation that touch no acceptance criterion, no claim's
   support and no privacy rule are `nit`. A nit never blocks and never lowers your score.
3. **No scope creep.** Judge the deliverable against its brief and acceptance criteria. A real
   problem outside them is `scope_expansion` and becomes a follow-up.
4. **Evidence or nothing.** Every blocking or substantive issue names the output it is about
   (`where`: the id of a finding, recommendation or other output of the task) or evidence copies
   (`evidence`), and says what in them shows the problem. A suspicion you cannot show is a question:
   put it in `questions`.
5. **A score below the pass score needs a reason.** Give at least one blocking or substantive issue,
   or score at or above the pass score.
6. **Work alone.** One review, no subagents, no edits.

### 5.2 Lenses

| Lens | Look for |
|---|---|
| `evidence` | Each claim against the copy it cites: figures, dates, names and quotes match; nothing invented, stale or misattributed; one source presented as several. |
| `brief` | Each acceptance criterion and each thing the brief asks: met, partly met, unmet, or not checkable. Anything not fully met is at least substantive. |
| `reasoning` | The step from evidence to conclusion: findings that do not support the recommendation or hypothesis built on them, scores and priorities the evidence does not justify, ignored counter-evidence, alternative explanations not ruled out. |
| `privacy` | Upload-derived or interview text where it must not be, internal details in public-facing output, data of another business tree, stored secrets. |
| `value` | Useless findings (§5.3). |
| `rewrite` | A better way to do the same task (§5.4). |

A member has exactly one lens. Every member also reports a useless finding or a rewrite when it sees
one.

### 5.3 Useless findings (lens `value`)

A finding is useless when removing it would change no recommendation, hypothesis or answer to the
brief:

- it restates its source without a claim that bears on the brief;
- it repeats another finding of the task, or a fact already stored, with different wording;
- it cannot be checked against any evidence, and nothing rests on it;
- it is about a subject the brief does not ask about.

Raise each with `action: "delete"`, class `substantive`, the finding's id in `where`, and one
sentence on what would still hold without it. Never propose deleting a finding that is the only
support of an acceptance criterion, or that a recommendation or hypothesis of the task cites.

### 5.4 Rewrite (lens `rewrite`)

One issue with `action: "rewrite"`: which outputs to discard (`where`, several ids allowed), the
other approach in five lines or fewer, why it answers this brief better, and which acceptance
criteria it covers. It must deliver the same task and nothing more.

### 5.5 Member output

`submit_review` as today (`score`, `issues`, `summary`), extended by optional fields: per issue
`action` (`fix` default, `delete`, `rewrite`) and `where` (ids of outputs of the task); per review
`questions` and `follow_ups` (lists of short texts). A member that cannot score says why in
`summary` and the harness records "no score".

## 6. A round

The harness is the orchestrator. There is no chair model: results are merged by the fixed rules
below **(my call: an extra model's judgment would be one more opinion, not a ruling, and the rules
must be the same every time)**.

1. Start every seated member that is available (§7), in parallel.
2. The round ends when every blocking member has ended. A non-blocking member still running then is
   cancelled and recorded as "not waited for" **(my call: the revision starts at once and a later
   result would have no round to belong to)**. A non-blocking member's score is never counted.
3. Merge:
   1. *Same defect.* Issues of different members about the same thing are merged into one, keeping
      every member's name and evidence (same `where` and similar text, by the existing similarity
      measure of the review-issue history).
   2. *Rules 3 and 4.* `nit` and `scope_expansion` issues are dropped from what the worker must
      answer, recorded with the rule that dropped them; `scope_expansion` issues and `follow_ups`
      are kept as follow-ups.
   3. *Rule 7.* A blocking or substantive issue with neither `where` nor `evidence` becomes a
      question.
   4. *Disputes.* An issue the worker pushed back on and a member raises again without evidence does
      not block. The existing cap on reasserts (`loop.maxReasserts`) applies unchanged.
   5. *Scope across rounds.* From round 2, a substantive issue that no member raised in an earlier
      round is advisory: it is shown to the worker and does not block. A new `blocking` issue still
      blocks **(my call)**.
   6. *`blockOn`.* A remaining blocking or substantive issue is upheld when enough blocking members
      raised it: one (`any`), more than half of the blocking members with a score (`majority`), or
      all of them (`all`). An issue that is not upheld is advisory.
   7. *Rewrite.* An upheld rewrite replaces every other issue about the outputs it discards.
4. *Scores.* A member's score counts when it is a blocking member with a valid review. A counted
   score below the pass score with no blocking or substantive issue from that member is an
   unsupported score: it is recorded and treated as the pass score (rules 3 and 7).
5. *Pass.* Every counted score is at or above the pass score and no upheld issue stands. The round's
   score, for everything that needs one number, is the lowest counted score.
6. Not passed and rounds left: the worker revises against the upheld issues (must answer each, as
   today), and is shown the advisory issues and the questions as such. Round limit reached: the task
   ends `unverified` and goes to the person through the existing escalation.

## 7. Unavailable members

A member is unavailable in a round when its provider is disabled, its model is not configured for
the provider, its CLI cannot be started, or its run ends without a valid review (after the
supervisor's own retries). The round record says which and why.

- `onUnavailable: "fail"`: the task ends `unverified` at once, with a failure reason naming the
  member, provider, model and cause. No revision is made on a partial council.
- `onUnavailable: "report"`: the round goes on without the member, and the record and the page show
  it as unavailable. With no blocking member left, the round is treated as `fail`.
- Never: another model in the member's place. `reviewerFor`, which picks another provider for the
  single reviewer, is not used for members.

## 8. One review to everything downstream

A council round is stored so that the rest of BIF sees one review per round:

- Each member's `submit_review` Decision is kept, and its run is tagged as a council member run.
- One harness Decision of kind `review`, event `council_review`, holds the round: score, pass,
  members (name, provider, model, lens, blocking, score or none, state, run id), merged issues with
  who raised them, dropped issues with the rule, advisory issues, questions, follow-ups.
- The review-issue history, the last-review note on outputs, outcomes, the review queue and the
  export take the council review as the round's review, and member Decisions are not counted as
  further reviews of the task. Runs, usage and cost stay per member run.

## 9. What people see

Where a task's review is shown: the council table (members down, rounds across, `7/10`, "no score",
"unavailable", "not waited for"), the open issues with who raised each, the questions and the
follow-ups. `GET /api/tasks/:id/council` serves it. The settings page shows the configured council
read-only.

## 10. Verification

Unit tests for the merge rules (each numbered rule), configuration (errors, defaults, stage
overrides), unavailable members under both settings, the non-blocking member, the scores rule, a
council stage next to a non-council stage in one run, restart in the middle of a round, and that
with no `council` block every existing test passes unchanged. One real run with two Claude models as
members on the cheapest models; Codex and OpenCode members when those CLIs work on the machine.

## 11. The skill for BIF's own development

`.claude/skills/council/SKILL.md`: the source skill with BIF's terms. Members review a feature
branch against its plan and spec; lenses `correctness`, `acceptance` (plan tasks and spec sections),
`privacy` (BIF's rules: no data across trees, upload-derived text out of exports, minimal reviewer
slices), `test-value` and `rewrite`. Members are started through whatever the session has: subagents
on different models, and the Codex and OpenCode CLIs when installed; an unavailable one is reported.
The score table goes in the final report (BIF merges to `main` without pull requests).
