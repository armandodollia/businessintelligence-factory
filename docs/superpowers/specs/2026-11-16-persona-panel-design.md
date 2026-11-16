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
