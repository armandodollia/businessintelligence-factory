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
The system prompt says nothing about the round, so a member has one prompt version per lens and
pass score; what depends on the round (from round 2: the round note and the issues of earlier
rounds, §6 step 3.5) is in its review prompt.

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
   put it in `questions`. An id counts only when it is real: in `where`, an output of this task; in
   `evidence`, something in the task's review slice (§6 step 3.3).
5. **A score below the pass score needs a reason.** Give at least one blocking or substantive issue,
   or score at or above the pass score. A score below the pass score counts only when one of your
   issues is upheld in the merge (§6 step 4); otherwise it is counted as the pass score.
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
`questions` and `follow_ups` (lists of short texts). A member that cannot score sends `score: null`
and says why in `summary` (`submit_review` refuses a member's null score without one). The harness
records "no score" with that reason, and the member counts as unavailable in the round (§7).
`score: null` is accepted from a council member run only (ruling of 2026-11-16): from the single
reviewer, and from any other run, `submit_review` refuses it with the error a missing score gives,
as it did before there were councils and whether or not a `summary` came with it, so the run can
send a number. The optional fields are accepted from everyone.

## 6. A round

The harness is the orchestrator. There is no chair model: results are merged by the fixed rules
below **(my call: an extra model's judgment would be one more opinion, not a ruling, and the rules
must be the same every time)**.

1. Start every seated member that is available (§7), in parallel: the blocking members first. A
   non-blocking member is started only once every blocking member has started (it has its worker
   slot) or ended, so with few worker slots (`limits.maxParallelWorkers`) it never holds one a
   blocking member is waiting for, wherever it is seated (ruling of 2026-11-16).
2. The round ends when every blocking member has ended. A non-blocking member still running then,
   or not started yet, is cancelled and recorded as "not waited for" **(my call: the revision starts
   at once and a later result would have no round to belong to)**. A run that finished by itself
   before the cancel took effect is recorded as what happened: a finished run, whose review is taken
   like that of a non-blocking member that ended in time. A non-blocking member's score is never
   counted, and nothing it sends decides the round (step 3.6).
3. Merge:
   1. *Same defect.* Issues of different members about the same thing are merged into one, keeping
      every member's name, evidence and wording (ruling of 2026-11-16, council review): the text of
      a merged issue, as shown to the worker and stored, is the lead text followed by "Also raised
      by <name>: <text>" for each other member whose text is not a near-repeat (similarity below
      0.9) of one already there. Two different points about one output can be taken for one defect,
      and the worker must still read both. Two issues are the same defect (ruling of 2026-11-16) when
      (a) both reuse the id of the same earlier issue the members were shown (step 3.5), in whatever
      words and about whatever output; or (b) their `where` overlaps and the texts are similar at
      the looser measure the review-issue history uses for reasserted issues; or (c) the texts alone
      are similar at the measure it uses for repeated issues. Issues whose `where` are both given
      and share no output are never merged unless (a); issues that reuse the ids of different
      earlier issues never are. A member is counted once per issue, and issues with different
      actions (`fix`, `delete`, `rewrite`) stay apart.
   2. *Rules 3 and 4.* `nit` and `scope_expansion` issues are dropped from what the worker must
      answer, recorded with the rule that dropped them; `scope_expansion` issues and `follow_ups`
      are kept as follow-ups.
   3. *Rule 7.* A blocking or substantive issue with neither `where` nor `evidence` becomes a
      question. This is checked for each member's issue by itself, before issues are merged (ruling
      of 2026-11-16, council review): such an issue is that member's question, it is no vote for
      the same defect another member showed, and it borrows no other member's evidence. Before the
      merge (ruling of 2026-11-16) the harness takes off every issue the ids in
      `where` that are not outputs of this task (anything the task saved: its outputs of any round,
      its review mentions, the public layers it saved, the facts it confirms or retracts) and the
      ids in `evidence` that are not in the task's review slice. An issue left with neither is a
      question by this rule. What was taken off is recorded on the member's entry of the round; the
      member's own Decision keeps what it sent.
   4. *Disputes.* An issue the worker pushed back on blocks again only when the member that raises it
      again says something new (ruling of 2026-11-16): the issue names an output or evidence (rule
      7), and the text of at least one blocking member that raised it is not a mere repeat of the
      earlier text (similarity below 0.9, by the same measure; the earlier text is the stored text
      or the wording of any one member in it). A mere repeat does not block, whatever
      evidence is cited under it. The existing cap on reasserts (`loop.maxReasserts`) applies
      unchanged.
   5. *Scope across rounds.* From the second review of a deliverable, a substantive issue that no
      member raised in an earlier round is advisory: it is shown to the worker and does not block.
      A new `blocking` issue still blocks **(my call)**. "The second review" is counted, not read
      off the round number (ruling of 2026-11-16, council review): the rule applies when the task's
      current deliverable has had a valid review (by a council or by a single reviewer) since the
      worker last did the work step. A failed council round (§7) is not a review, and a re-run from
      an escalation that does the work again starts the count again, in whatever round it runs.
      Members are new runs each round, so from that second review every member's review prompt
      says so (the round note), and from round 2 it lists the upheld issues of earlier rounds (id, text, and the worker's answer: fixed, or pushed
      back with its reason) and asks: if one still stands, list it again with the same id and say
      what in the current deliverable shows it. An issue counts as raised earlier when it reuses the
      id of an earlier issue it was shown; or when its `where` overlaps an earlier issue's and the texts are
      similar at the looser measure the review-issue history uses for reasserted issues; or when the
      texts alone are similar at the measure it uses for repeated issues. The harness never gives a
      member's new issue the id of an earlier one.
   6. *`blockOn`.* A remaining blocking or substantive issue is upheld when enough blocking members
      raised it: one (`any`), more than half of the blocking members with a score (`majority`), or
      all of them (`all`). An issue that is not upheld is advisory. Only blocking members decide
      (ruling of 2026-11-16, council review): the class of an issue, the outputs it is about,
      whether it repeats an earlier issue, whether it says something new after a pushback and how
      many raised it are taken from the blocking members that raised it. What a non-blocking member
      sent about the same defect is attached to the issue (its name, its evidence, its wording)
      and changes nothing of this; an issue only non-blocking members raised is advisory. Taking
      every non-blocking member out of a round never changes whether it passes or which issues
      are upheld.
   7. *Rewrite.* An upheld rewrite replaces every other issue about the outputs it discards (the
      outputs its blocking members named). The replaced issues are recorded with the dropped
      issues, under the rule `rewrite`, the id of the rewrite and the standing each had (upheld or
      advisory). Only a replaced issue that was upheld counts as raised again after a pushback; one
      that was not is settled like any pushed-back issue the council did not uphold (ruling of
      2026-11-16, council review). When a wider rewrite replaces a rewrite, what the first one replaced is recorded
      under the id of the rewrite that stands.
4. *Scores.* A member's score counts when it is a blocking member with a valid review. A counted
   score below the pass score stands only when that member raised at least one issue that is upheld
   after the merge. Otherwise it is an unsupported score: it is recorded and treated as the pass
   score (rules 3 and 7). So a round never fails with nothing the worker has to answer, and
   `blockOn` and the rules above alone decide which findings block.
5. *Pass.* Every counted score is at or above the pass score and no upheld issue stands. The round's
   score, for everything that needs one number, is the lowest counted score. A round with no counted
   score (no blocking member gave a valid review) does not pass and is treated as `fail` (§7),
   whatever `onUnavailable` says.
6. Not passed and rounds left: the worker revises against the upheld issues (must answer each, as
   today), and is shown the advisory issues and the questions as such. Round limit reached: the task
   ends `unverified` and goes to the person through the existing escalation.

## 7. Unavailable members

A member is unavailable in a round when its provider is disabled, its model is not configured for
the provider, its CLI cannot be started, or its run ends without a valid review (after the
supervisor's own retries; a review with `score: null` is not a valid review). The round record says
which and why.

`onUnavailable` is about blocking members only (ruling of 2026-11-16). A non-blocking member can
never end a task: one that cannot be started is recorded as unavailable with its reason, one whose
run gives no valid review as "no score", and the round runs with the others under both settings.
The start-up warning says the same.

- `onUnavailable: "fail"`: when a blocking member is unavailable, the task ends `unverified` with a
  failure reason naming the member, provider, model and cause. When the configuration cannot start
  the member (provider disabled, model not configured), the task ends before any member runs. When
  the member's run fails or gives no valid review, the task ends once the round's blocking members
  have ended, and their reviews are kept on the round's record for the person who gets the
  escalation (ruling of 2026-11-16, council review: the cost is bounded by one round). No revision
  is made on a partial council.
- `onUnavailable: "report"`: the round goes on without the member, and the record and the page show
  it as unavailable. With no blocking member left, the round is treated as `fail`.
- Never: another model in the member's place. `reviewerFor`, which picks another provider for the
  single reviewer, is not used for members.

A round that failed because a member was unavailable is treated as "no review took place": score 0,
nothing put to the worker, and downstream it reads like the single reviewer's synthetic review.
Known limit: when the person then re-runs the task from the escalation, the work is redone, not
only reviewed again.

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
follow-ups. It is reachable for every council-reviewed task, also one that passed (ruling of
2026-11-16): on the result pages where the last review of a result that did not pass is shown, and
on the Research page, where each task row of a council-reviewed task opens its council table. In
the Research page's list of review Decisions a member's own review is labelled "council member:
<name> (<lens>)", so it is not read as a further review of the task. The settings page shows the
configured council read-only.

Routes (ruling of 2026-11-16):

- `GET /api/workspaces/:id/tasks/:taskId/council` serves the council table of a task. It is
  tree-checked like every route under a node: a task of another business tree answers exactly like
  an unknown one. There is no variant that reads a task by its id alone.
- `GET /api/council` serves the configured council and nothing of any task: the rules with the
  defaults applied, every member with whether this configuration can start it and why not, and the
  stages.
- `GET /api/workspaces/:id/tasks` marks a task a council reviewed (`councilReviewed`), and
  `GET /api/workspaces/:id/decisions` and the live Decision events mark a member's own review
  (`councilMember`: name and lens).

The council route withholds what the other reads of private `own_stakeholders` research withhold
(ruling of 2026-11-16): for a withheld task each round keeps its number, Decision id and time and is
marked withheld, like the task's other Decisions.

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

## 12. As built

What the build settled beyond the sections above, the limits it is known to have, and what is left
for later. Dated rulings in the text above are marked where they apply; this section collects them.

### 12.1 Rulings taken during the build (2026-11-16)

- **Unsupported score** (§6 step 4): a score below the pass score stands only when its member raised
  an issue that is upheld. So a round never fails with nothing the worker has to answer.
- **Raised in an earlier round** (§6 step 3.5): by the id of an earlier issue the members were shown,
  or the same output in loosely similar words, or closely similar words alone. The harness never
  gives a member's new issue an id the task's reviews already used.
- **Same defect** (§6 step 3.1): the same earlier id, or a common output in loosely similar words, or
  closely similar words where at most one issue names an output. Issues about different outputs
  are never merged without the id.
- **No score** (§5.5): `score: null` with a reason, from a council member run only. Any other run
  gets the missing-score refusal, with or without a `summary`.
- **Known ids only** (§6 step 3.3): ids that are not outputs of the task (`where`) or not in its
  review slice (`evidence`) are taken off an issue before the merge and recorded on the member's
  entry.
- **Disputes** (§6 step 3.4): a pushed-back issue blocks again only when a blocking member that
  raises it says something new.
- **The non-blocking member** (§6 steps 1, 2 and 3.6, §7): started after the blocking members have
  their worker slots, never waited for, never able to end a task, and never able to decide a round:
  only blocking members' contributions settle whether an issue is upheld.
- **Evidence or nothing per member** (§6 step 3.3): checked before issues are merged, so an issue
  with nothing to show is its member's question and no vote.
- **Every member's wording** (§6 step 3.1): a merged issue carries the lead text and "Also raised by
  <name>: <text>" for each other wording that is not a near-repeat.
- **Which review it is** (§6 step 3.5): the valid reviews of the current deliverable since the
  worker last did the work step are counted; the loop's round number is not used.
- **What a rewrite replaced** (§6 step 3.7): recorded with the standing it had; only an upheld one
  counts as raised again after a pushback.
- **A blocking member's run-time failure under `fail`** (§7): the task ends when the round's blocking
  members have ended, with their reviews kept. Kept on purpose; the round is not cut short.
- **The round's Decision** (§8): its run is the round id, not a member's run, so it exists when no
  member ran; a failed round is recorded as "no review took place".
- **Routes** (§9): the council table of a task is served under its node and tree-checked; private
  `own_stakeholders` research is withheld there as everywhere else.
- **Experiments** (§8): a council round is one review score; of a round recorded twice after a
  restart, the later record.

### 12.2 Known limits

- **The same-defect edge case.** Grouping is greedy against a group's first issue, and issues that
  share neither an earlier id nor an output are never merged. So when one member paraphrases an
  earlier defect without its id on one output and another reuses the id on another output, they are
  two issues, and under `all` neither is upheld. The other way round, two different points about
  one output in loosely similar words are merged into one issue; both wordings reach the worker.
- **An escalation re-run after a failed round redoes the work** (§7): the deliverable the full
  council never judged is not kept and reviewed again. Its first review is then a first review
  (§6 step 3.5), but members are still shown the issues of the earlier rounds with their ids.
- **No GitHub Copilot adapter.** `provider` is one of `claude`, `codex`, `opencode`; any other CLI
  is a configuration error.
- **The council table does not show dropped ids.** The ids taken off a member's issues (§6 step
  3.3) are recorded and served with the round, but the page does not show why an issue became a
  question.
- **A merged issue names members to the worker and to later members.** "Also raised by <name>" is
  part of the issue's text, so the revise prompt and the earlier-issues list of later rounds carry
  the member names (configuration names such as `evidence`), though never a member's whole review.

### 12.3 Follow-ups (not done)

- A round recorded twice after a restart whose second record fails can leave the first record's
  issue rows as the round's latest rows in the review-issue history.
- Council review round 1, test-value finding F5 (minor): dropped under "no nits".
