# Persona panel: seats, baseline, grounded answers, rounds — design

Date: 2026-11-16. Status: approved by the owner on 2026-11-16 ("Go for it") as the list of gaps
between BIF's panel and the skill `.claude/skills/persona-panel/SKILL.md`; decisions the owner did
not state are marked **(my call)**. Builds on the review council (`2026-11-16-review-council-design.md`)
for the per-run `effort` setting and the "unavailable, never substituted" rule.

## 1. Intent

BIF's persona panel already runs one fresh agent per persona per recommendation, in parallel. This
project makes it match the skill in the four places it does not:

1. seats: personas spread over several CLIs and models;
2. a baseline run with no persona, to see what a persona adds;
3. grounded answers: the other side, another route, the basis of each concern, what the persona is
   unsure about;
4. rounds: a persona re-reads a recommendation only when it changed, and then rules on its own
   earlier concerns.

A panel stays what it is: simulated reactions, side by side, never merged, never blocking.

## 2. Scope

- The segment persona panel (`segmentPanel` in `src/core/market/panel.ts`) gets all four.
- Flow verdict runs by personas (`src/core/flows/round.ts`) get seats only (the same persona runs on
  the same seat everywhere) **(my call)**.
- Stakeholder reads are unchanged: they have their own tool and the offline rule **(my call)**.
- With no `personaPanel` block in the configuration, behaviour is exactly as today.

## 3. Configuration

```jsonc
"personaPanel": {
  "rounds": 3,                // most reads of one recommendation by one persona
  "baseline": true,           // one run with no persona per recommendation
  "onUnavailable": "report",  // fail | report
  "seats": [
    { "provider": "claude", "model": "sonnet" },
    { "provider": "codex",  "model": "gpt-5", "effort": "medium" }
  ],
  "personas": { "<slug>": { "seat": 0 } }
}
```

- Defaults when the block is present: `rounds` 3, `baseline` true, `onUnavailable` `report`, `seats`
  one seat with `roles.persona`.
- `provider` is one of BIF's CLIs; `cli` is accepted as another spelling. `effort` follows the
  council's rule (passed where the CLI has the setting, a configuration error where it has none).
- Seat of a persona: its pinned seat, else personas sorted by slug take seats in turn. The assignment
  depends only on the configuration and the node's usable personas, so it is the same on every run.
- A seat whose provider is disabled or whose model is not configured is not a configuration error:
  a start-up warning names it and the personas on it are unavailable at run time.
- A pin to a seat that does not exist, or a `seat` out of range, is a configuration error. A pin for
  a slug no persona has is ignored (personas come and go).

## 4. Unavailable

A persona is unavailable for a recommendation when its seat cannot be started or its run ends without
a valid answer after the existing retry. It is never run on another seat or model.

- `report`: the panel goes on; the pair is recorded as unavailable with the reason and shown so.
- `fail`: the panel phase ends as failed with a reason naming the persona, provider, model and cause;
  reactions already stored are kept.

## 5. The baseline

When `baseline` is on, each recommendation read in a round also gets one run with no persona: the
same panel prompt, a neutral system prompt ("a general reader with no particular stake"), on seat 0.
It answers with the same tool. Its answer is stored on the recommendation as the baseline of that
version (not as a persona's feedback, and never in any summary of the panel).

A reaction is marked `sameAsBaseline` when its concerns and reasoning are similar to the baseline's
by the word-similarity measure already used for review issues, at its repeat threshold. Marked
reactions are shown as "adds nothing beyond a general reader" and are not counted as agreement.

A baseline that fails is reported; reactions are then stored unmarked.

## 6. The answer

`submit_persona_feedback` gains optional fields:

- `other_side`: what would make the persona dismiss it (if it liked it) or take it up (if it did not);
- `instead`: another route to the same goal, when the persona would refuse this one;
- `unsure`: what it could not judge because its profile does not say;
- `concern_basis`: for each concern, in order, the part of the profile it rests on (a profile field
  name, or free text);
- `rulings` (from round 2): for each of its own earlier concerns, `resolved` or `stands` with a reason.

When `personaPanel` is configured the panel prompt asks for them and states the persona rules of the
skill (one person, ground it or say unsure, do not please, judge it as given, nothing is precious, no
numbers about other people, argue the other side, work alone). Without the block the prompt is
unchanged.

A concern without a basis is stored as ungrounded. Text that makes a claim about other people in
numbers (a percentage, "most customers", a market size) is flagged `aboutOthers` by a simple pattern
check and shown struck out with the reason **(my call: flag, do not delete, so the person can see
what the persona tried to say)**.

## 7. Rounds

Each stored reaction records the round, the seat (provider and model) and a hash of the
recommendation's title and summary as read.

When the panel runs for a recommendation and a persona:

- no reaction yet: round 1;
- a reaction to the same text: nothing runs (rereading unchanged work is not a round);
- a reaction to an older text, rounds left: the next round. The prompt lists that persona's own
  earlier concerns (never another persona's) and asks for a ruling on each, and for new concerns only
  about what changed. The new reaction replaces the old one as the current reaction; earlier rounds
  stay readable;
- rounds used up: nothing runs; the pair is reported as "round limit reached".

The baseline follows the same rule per recommendation text.

Today the panel re-reads everything on every run. That behaviour stays when `personaPanel` is not
configured.

## 8. What people see

On the recommendation's panel (Strategy page): per persona the round, the seat, the scores, the
concerns with their basis (ungrounded and flagged ones marked), the other side, another route, what
it is unsure about, the rulings on earlier concerns, earlier rounds on demand; "adds nothing beyond a
general reader", "unavailable" and "round limit reached" written out. Above the personas: where they
disagree (a spread of two or more on a scale), shown as the range, not an average. The baseline on
demand. Everything stays marked simulated.

## 9. Storage

`PersonaFeedback` gains optional fields (`round`, `seat`, `textHash`, `otherSide`, `instead`,
`unsure`, `concernBasis`, `ungrounded`, `aboutOthers`, `rulings`, `sameAsBaseline`). Earlier rounds
and the baseline are kept per recommendation (a column or a table, the builder's choice, by
migration). Existing rows read as round 1 with no hash, so their next read under a configured panel
is a new round.

## 10. Verification

Unit tests: seat assignment (turn-taking, pins, stability), configuration errors and warnings, both
`onUnavailable` settings, baseline stored apart and the `sameAsBaseline` mark, each new answer field,
the pattern flag, the three round cases and the limit, the prompt of round 2 holding only the
persona's own concerns, flow verdict runs on the persona's seat, and that with no `personaPanel`
block the prompt, runs and stored feedback are byte-identical to today. One real run: three personas
on two Claude models with a baseline, then a changed recommendation and a second round.

## 11. As built

Rulings taken during the build (2026-11-16), where the sections above are silent or were overruled, and
what was left for later. Where this section and a section above differ, this section is what the code
does.

### Seats and unavailable personas

- **Turn-taking and pins.** All personas, sorted by slug, take the seats in turn. A pinned persona keeps
  its place in that order and only its own seat changes, so a pin moves nobody else.
- **`fail` is decided at the end.** Every persona that can run still runs and its reaction is stored, the
  stakeholder reads run as always, and the phase then ends as failed.
- **Nothing to read is not unavailable.** A persona whose reaction to the text as it is now is stored, or
  whose rounds are used up, is not unavailable, whatever its seat. The seat is checked only for a pair
  that would run.
- **The records.** `persona_unavailable` and `baseline_unavailable` are harness Decisions that name the
  recommendation and the persona as plain fields (`recommendation`, `persona`) and carry no refs, so the
  export does not read them as a judgment and no rating joins them. They carry `round` and `textHash`:
  the page shows one only while it is the last word on the text as it is now. A pair whose run
  started and gave no answer is in `missing` and in `unavailable`; a pair whose seat could not be
  started is in `unavailable` only (no run was made, so no answer is missing).
- **Flow verdict runs.** With the block a persona judges flows on its panel seat, whatever `flows.model`
  says. `onUnavailable` is not applied there: an unavailable persona never fails the `flow_ranking`
  phase. A persona with no pair left to judge records nothing, whatever its seat (council round 1).

### The answer

- **`rulings`.** `{ concern, ruling, reason }`, where `concern` is the number of the concern as the
  prompt lists it, from 1. `reason` is required with `stands` and may be left out with `resolved`
  (council round 1). The tool refuses a ruling in round 1, a ruling on a number that was not listed and
  two rulings on one concern, each with a message the persona can act on in the same run. A listed
  concern without a ruling is accepted and recorded (`notRuled`).
- **The tool's schema is one for everybody.** Without the block the tool also accepts the new fields; the
  prompt does not ask for them and they are not stored on the recommendation.
- **The pattern check covers every free text of a reaction that the page shows:** the concerns and what
  each rests on, the reasoning, what would change its mind, the other side, another route, what it is
  unsure about, the reason of each ruling, and the earlier concerns as listed with what each rested on.
  Each is flagged where it is shown (council round 1).
- **Stored beyond §9:** `textRead` (the title and summary the read was made on), `earlierConcerns` (the
  concerns listed to the reader for a ruling, in order), `earlierConcernBasis` (for each of them the
  basis it was raised with: `''` ungrounded, `null` raised before a basis was asked for) and `notRuled`.

### Rounds

- **The text** is the title and the summary, and nothing else of the recommendation: a new score or
  priority is not a new text.
- **A later round shows the text the reader read before and the text as it stands now,** both fenced as
  data, and asks for new concerns only about what differs between them. Each read is stored with its
  text for this. The earlier text is the reader's own earlier read, never another reader's. A read
  stored without its text (before the block, or before this was built) has none to show: the prompt
  says so and shows the text as it stands now only. (Council round 1; it overrules the ruling during
  the build that a later round is shown the current text only.)
- **A later round lists every concern still open,** not only those of the last read: the listed concerns
  the reader did not rule `resolved`, then the concerns it raised in its last read, exact duplicates
  once.
- **A concern is carried with what was recorded of it when it was raised** (its basis, or that it had
  none), and its flag is found again wherever the concern is listed. The page shows those marks in the
  list of rulings too (council round 1).
- **A read without an answer is not a round:** the earlier reaction stays the current one and the next
  run tries the same round again.
- **A reaction with no hash** (stored before the block) is round 1; its next round's prompt says the
  text may have changed, not that it did.
- **Storage.** A persona's current reaction stays in `recommendations.persona_feedback`. The table
  `persona_panel_reads` (migration 30) keeps every baseline and each earlier round of a persona.

### The baseline

- It follows the rule of rounds with its own earlier concerns and its own round count, and runs by its
  own rule: a recommendation with no baseline of its text as it is now gets one even when no persona
  reads in that run, and the reactions already stored for that text are then marked.
- It gets no persona calibration. A baseline that cannot be had never fails the phase, also under
  `fail`. Its Decision is a `persona_feedback` line marked `baseline: true` with no persona and no
  rating target.
- **"Not counted as agreement" holds where reactions are counted.** A reaction marked `sameAsBaseline` is
  left out of `personaScore` and of the numbers of `panelSummary` (`leftOut` says how many were). So
  with `scoring.personaWeight` above 0 a mark can change a priority; with the default weight of 0 it
  changes none.

### The page and the documents

- The panel is served with the recommendation (`panel`, built in `market/panelView.ts`), also when the
  block was removed but earlier rounds or baselines are stored. Round limit and unavailable are shown
  only while the block is there.
- The range of disagreement counts every counted current reaction, also one to an earlier text (a
  persona at its round limit, or unavailable this round). It is marked simulated, as every reaction and
  every read of the baseline is (council round 1).
- A persona is labelled by its id, as before. A baseline's concern without a basis reads "No basis in
  the text", since it has no profile.
- The example configuration has no `personaPanel` block: the block cannot be inert, and it would turn
  the panel on, with a baseline run, for whoever copies the file. The README documents the block
  (council round 1).

### Left for later

- A recommendation's text changes on the same row only through a revision by its own task, an
  escalation re-run or a manual edit, so rounds past 1 are rare in the pipeline. The main effect of
  rounds is that unchanged recommendations are not read again on later runs.
- `markAgainstBaseline` compares only with the latest baseline: a text going A → B → A leaves a first
  reaction to A unmarked.
- The pipeline seats every usable persona. The skill's "three to six personas" is guidance for whoever
  defines the personas; nothing enforces it.
- `persona_feedback_missing` is still read by the export as a judgment of the recommendation, as on
  `main`.
- Stakeholder reads and flow verdicts do not have the baseline, the grounded answer fields or rounds.
