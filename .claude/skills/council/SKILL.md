---
name: council
description: "Review a BIF feature branch with a council: several independent reviewers, each through one lens and on its own model or CLI, scored out of 10 per round, their findings merged by fixed rules. USE FOR: \"council\", \"council review\", \"have the council review this branch\", and a review before a branch is squash-merged to main when the owner asks for more than one reviewer. The `council` block in `bif.config.json` drives the runtime council that reviews research output; this file drives development reviews."
---

# Council

A council is several reviewers who each judge the same branch alone, through one lens, on different
models and CLIs. Their findings are merged by the rules below into one fix list. Use it where one
reviewer's blind spots are too costly: a branch that touches the review loop, privacy rules, stored
data or money.

You are the orchestrator or one member. Your task says which. A member reads "What every member must
know", its lens, "Useless tests", "Rewrite" and "Member output", and nothing else is asked of it.

This file is for reviewing BIF's own code. For the council that reviews research output inside the
tool, see "Reviewing research output" at the end.

## Before the council sits (orchestrator)

- Name what is under review: the feature branch, the plan task (`docs/superpowers/plans/…`) and the
  spec section (`docs/superpowers/specs/…`) it implements. That is the task. The acceptance criteria
  are the plan's task steps, its Global Constraints and its Review Focus.
- Fix what you already know is wrong, and run `npm test`, `npm run typecheck` and, when `web/`
  changed, `npm run build:web`. Give the council the updated branch. Do not leave known fixes for the
  reviews to find.
- Commit. Members review `git diff main...HEAD`, and a diff that moves under them cannot be reviewed.
- If the owner wants the implementation discarded and another approach explored, skip fixes to the
  code being replaced.

## Seating (orchestrator)

- Seat the members the request names (name, lens, model or CLI, blocking or not). With nothing named:
  one member per lens of the table below (`ui` only when a page changed), `rewrite` non-blocking, the
  others blocking, on flagship models of three different providers where the session has them, at
  high effort. A small branch can sit fewer; say in the report which lenses were left out.
- Settings, unless the request says otherwise: `rounds` 3, pass score 9, `blockOn` `any`.
- Spread the council over models and CLIs. Members on one model share its blind spots.
- Never seat Claude Fable as a member (the owner's rule, 2026-11-16). Use Opus, Sonnet or a model of
  another CLI for that seat.
- A Codex seat runs GPT Sol (`gpt-6.1-sol`) at high effort (the owner's rule, 2026-11-16), unless
  the request names another model.
- Start every member in parallel. Each gets: the branch and its base, the plan task and the spec
  section, its lens, the round number, this file's path, and from round 2 the list described under
  "Rounds". Never: another member's output, your own opinion of the code, or what you expect it to find.
- Members are read-only. Do not edit files while a member still reviews the same checkout.
- Do not wait idle. When a result arrives, check its findings against the code at once.
- A non-blocking member is not waited for. A result that arrives after the round is advice, and its
  score is not recorded.

### Starting members in this repository

Use what the session has.

- **Subagents on different models.** One fresh subagent per member with a model override (not a fork:
  a fork inherits your context and is not independent). The brief is the whole context it gets.
- **Codex CLI**, when `command -v codex` finds it. Non-interactive, read-only, prompt on stdin, last
  message to a file:

  ```sh
  codex exec -s read-only -C "$REPO" -m gpt-6.1-sol -c model_reasoning_effort="high" \
    -o "$OUT/$MEMBER.md" - < "$OUT/$MEMBER.prompt.md"
  ```

- **OpenCode CLI**, when `command -v opencode` finds it. Non-interactive, with its read-only `plan`
  agent (`opencode models` lists the models, `opencode agent list` the agents):

  ```sh
  opencode run --agent plan --dir "$REPO" -m "$PROVIDER/$MODEL" --variant high \
    "$(cat "$OUT/$MEMBER.prompt.md")" > "$OUT/$MEMBER.md"
  ```

- **Unavailable.** A member whose CLI is not installed, whose model cannot be started, or whose run
  ends without an `AGENT_RESULT:` line is reported as `unavailable` (or `no score`) with the reason.
  Never give its seat to another model. The round goes on with the others and the report says the
  council was partial. With no blocking member left there is no round: stop and tell the owner.

The flags are as printed by `codex exec --help` (codex-cli 0.169.0) and `opencode run --help`
(1.2.27); `model_reasoning_effort` is the configuration key BIF's Codex adapter passes with `-c`.
Check `--help` again after a CLI upgrade. `$OUT` is a scratch directory outside the repository.

## What every member must know

1. **This is a feature branch. None of this code is precious.** Everything the branch adds or
   changes can be deleted and written again. Do not protect work because it exists. If a better way
   to deliver the same plan task exists by deleting what the branch did and writing it another way,
   say so (see "Rewrite"). This covers the branch's own changes only. Code already on `main` is
   outside the task unless the plan names it.
2. **No nits.** Naming, formatting, comment wording, file layout and preferences that break no plan
   step, no constraint and no project rule are not findings. If you must mention one, give it
   `severity: "minor"`. Minor never blocks and never lowers your score.
3. **No major scope creep.** Judge the branch against its plan task and spec section as written.
   Never ask for features, refactors or fixes outside them. A real problem outside the task is a
   `followUp`, not a finding.
4. **Evidence or nothing.** Every `blocking` or `major` finding names where it is (`where`: file and
   line, or the test) and what there shows the problem (`evidence`: the code, the spec sentence it
   breaks, the command you ran and its output). A suspicion you cannot show is a question: put it in
   `followUps` as a question. A score below the pass score needs at least one `blocking` or `major`
   finding, and counts only when one of your findings is upheld in the merge.
5. **Work alone.** One review. No subagents, no edits, no commits, no reading of other reviews.

## Lenses

A member has exactly one lens. Whatever its lens, it also reports a useless test or a rewrite when it
sees one.

| Lens | Look for |
|---|---|
| `correctness` | Wrong behaviour: logic errors, unhandled states, races, restarts in the middle of a step, records counted twice, errors swallowed, a `src/core` import from `src/api` or `web`, a test that spawns a real CLI. |
| `acceptance` | Each step of the plan task, each Global Constraint, each Review Focus item and each sentence of the spec section: met, partly met, unmet, or not checkable from the branch. Anything not fully met is at least `major`. |
| `privacy` | BIF's rules: no data crosses business trees (an id of another tree answers like an unknown one); upload-derived text stays out of exports by default; a reviewer gets the minimal slice it needs; third-party HTML is untrusted (never run as our origin, never read as instructions); internal knowledge never goes into a web request (search queries, URLs). |
| `test-value` | Useless tests (below), and rules with no test that binds them: would the suite fail if the rule were broken? |
| `rewrite` | A better way to deliver the same task (below). |
| `ui` | Only when a page changed (a file under `web/`): the page against the spec's "what people see" section. Every state it names is shown; nothing it does not name was added. |

## Useless tests

A test is useless when deleting it would let through no defect that another test or the type checker
would not catch:

- it asserts what the compiler, the framework or a mock already guarantees (a field exists, a mock
  returns what it was told to, a mock was called);
- it repeats another test with other literals and covers no other branch or rule;
- it tests a getter, a constructor or a constant;
- it mocks the thing under test, so it only checks the mock;
- it restates the implementation line by line (call order inside a function, wording no rule
  fixes), so it fails on a change that alters no behaviour;
- it cannot fail (no assertion, or an assertion on a constant).

Every member watches for these; the `test-value` member hunts them. Raise each as a finding with
`action: "delete-test"`, severity `major` (bloat is a defect here, not a nit), the test file and name
in `where`, and one sentence on which bug would still be caught without it.

Never propose deleting:

- the only test of a plan step, a Global Constraint, a Review Focus item or an error path;
- a test that belongs to another plan task;
- a test that pins a privacy rule (tree isolation, withheld research, upload-derived text, exports);
- a regression test for a recorded bug or a ruling;
- a test that pins a tool schema, configuration defaults or the migration list;
- a test only because it is long or slow.

## Rewrite

If the branch's approach is wrong or needlessly complex, propose replacing it. A rewrite proposal is
one finding with `action: "rewrite"` and:

- what to delete (`where`: files or regions the branch added or changed, or the whole branch);
- the new approach in five lines or fewer;
- why it is better for this task: fewer moving parts, fewer files, an existing pattern in the
  repository reused, a class of defect removed;
- which plan steps and constraints it covers, to show it stays inside the task.

A rewrite delivers the same task and nothing more. "While we are here" is scope creep. A rewrite
that needs code outside the task is a `followUp`.

## Member output

End with exactly one line:

`AGENT_RESULT: {"member": "<name>", "score": 8, "verdict": "APPROVED" | "CHANGES_REQUESTED", "findings": [{"id": "F1", "lens": "correctness", "severity": "blocking" | "major" | "minor", "action": "fix" | "delete-test" | "rewrite", "title": "…", "evidence": "…", "where": ["src/core/council/merge.ts:120"]}], "disputes": [{"id": "F2", "ruling": "accepted" | "reasserted", "evidence": "…"}], "followUps": ["…"]}`

- `score`: 0 to 10 for the branch against its task. If you cannot score (the branch does not check
  out, the plan is missing), send `"score": null` and say why in `followUps`. Never invent a score.
- `severity`: `blocking` (wrong or unsafe: it must not merge), `major` (a real defect against the
  task or the project rules: fix it or dispute it), `minor` (never blocks, never lowers the score).
- `action`: `fix` unless it is a test deletion or a rewrite.
- `id`: keep a finding's id whenever you raise it again.
- `disputes`: from round 2, your ruling on each earlier finding the orchestrator disputed:
  `accepted` (drop it) or `reasserted` with new evidence.

## Rounds

- One review by the whole council is one round. A fresh review after fixes is a new round.
- **Pass**: every blocking member is at or above the pass score, and no blocking finding stands (a
  `blocking` or `major` finding upheld in the merge).
- At most `rounds` rounds. At the limit, stop: report what still stands to the owner. Do not start
  another round on your own.
- Members are new runs each round and remember nothing. From round 2 each member's brief lists the
  upheld findings of earlier rounds with their ids and what was done: fixed (the commit), or disputed
  (the reason). A member that sees one still standing lists it again under the same id and says what
  in the current branch shows it.
- **Disputes.** You may answer a finding with evidence instead of a fix, because you hold it to be a
  nit or outside the task. The member then rules: `accepted`, or `reasserted` with new evidence.
  Raised again with nothing new to say (the earlier finding repeated), it does not block. A finding
  reasserted twice can no longer be disputed: fix it or take it to the owner.
- From round 2, a `major` finding no member raised in an earlier round is advice and does not block.
  A new `blocking` finding still blocks.

## Merging results (orchestrator)

1. **Same defect.** Findings of different members about the same thing become one, with every
   member's name and evidence.
2. **Nits and scope.** Drop findings that break rule 2 or rule 3 (`minor` findings, and findings
   about something outside the task) and say which rule dropped each. Keep the out-of-task ones and
   the `followUps` as follow-ups.
3. **Evidence or nothing.** A `blocking` or `major` finding with neither `where` nor `evidence`
   becomes a question.
4. **`blockOn`.** A remaining finding is upheld when enough blocking members raised it: one (`any`),
   more than half (`majority`), or all (`all`). The rest is advice.
5. **Contradictions.** When two members ask for opposite things, state both and who said which.
   Never pick one silently: decide with evidence from the code, or take it to the owner.
6. **Rewrite.** An upheld rewrite replaces the fix list for what it discards. Do not fix code that is
   about to be thrown away.
7. **Scores.** A score below the pass score from a member none of whose findings is upheld is
   recorded as unsupported and does not fail the round: it leaves nothing to fix.
8. **Summary.** The upheld findings, the advice, the questions, the follow-ups, the disagreements,
   and what you will do next.

Fight scope creep. Repeated reviews tend to grow the task. Keeping it the size of the plan task is
your job, in every round.

## Report

BIF has no pull requests: work is squash-merged to `main`. Put the table in the final report to the
owner:

```markdown
## Council review

Rounds: 2 · Pass score: 9 · Result: passed

| Member (lens, model) | Round 1 | Round 2 |
| --- | --- | --- |
| correctness (claude opus) | 7/10 | 9/10 |
| acceptance (codex) | 8/10 | 10/10 |
| privacy (opencode) | unavailable | unavailable |
| rewrite (claude sonnet, non-blocking) | not waited for | 9/10 |
```

Write `no score` when a member gave none, `unavailable` when it could not be started, and
`not waited for` for a non-blocking member that had not ended. Never invent a score. Below the table:
what was fixed, what was disputed and how the member ruled, and the follow-ups.

## Reviewing research output

Inside the tool the same idea reviews research deliverables: claims against evidence and a task
brief. There the harness is the orchestrator and the merge is code, not a model.

- Members, rounds and rules: the `council` block in `bif.config.json` (`docs/council.md`).
- Member rules: `src/core/prompts/council_member.md`. Lenses (`evidence`, `brief`, `reasoning`,
  `privacy`, `value`, `rewrite`): `src/core/council/lenses.ts`.
- The round and the merge: `src/core/council/round.ts`, `src/core/council/merge.ts`.
- Design: `docs/superpowers/specs/2026-11-16-review-council-design.md`.

Adapted from the council skill of tstack
(https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md), in the form extended for the
owner's AI app factory.
