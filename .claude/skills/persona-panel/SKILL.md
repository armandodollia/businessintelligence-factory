---
name: persona-panel
description: "Run a persona review round: every persona reads the same piece of work as its own independent agent with a fresh context, and the reactions are reported side by side, never merged. USE FOR: \"persona panel\", \"persona review\", \"how would our personas react to this\", \"run this past the personas\", and the persona_panel phase of the pipeline. Seats, CLIs, models and rounds come from `personaPanel` in the configuration."
---

# Persona panel

A persona panel is several simulated people who each read the same piece of work (a recommendation,
a proposal, a page, copy) and say how it lands for them. Each persona is one agent with a fresh
context. No agent ever plays two personas, and no persona sees another's reaction.

You are the orchestrator or one persona. Your task says which. In the pipeline the harness is the
orchestrator and starts you as a persona.

Adapted from the council skill of tstack
(https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md) and from the persona-interview
skill's guardrails.

## What a panel is, and is not

A panel produces **hypotheses**: reasons the work might land badly or well, to check with real
people. It is not a sample, not a measurement and not a verification step.

| A panel is for | A panel is never for |
|---|---|
| Finding objections before real people do | Replacing interviews or recruitment |
| Showing where audiences would disagree | Any number about real people: shares, sizes, "most customers" |
| Red-teaming a recommendation, copy or a flow | Saying which segment prefers what, as a finding |
| A list of things to go and check | Validating an idea, or any final decision |

How it differs from a council: a council verifies work and its members' reviews are merged into one
verdict that can send the work back. A panel simulates reactions; they are never merged, never pass
or fail anything, and never block.

## Before the panel sits (orchestrator)

- Finish the work first. A panel reads work that has already passed its own review; do not spend
  persona runs on a draft you know is wrong.
- Decide what one item is (one recommendation, one page, one flow). A persona reads one item per run.
  Comparing items needs them side by side: that is one run per persona per comparison, still one
  persona.

## Seating (orchestrator)

- One run per persona per item. Start them all in parallel. Each run gets that persona's profile as
  its system prompt, the item, and this file. Nothing else: not the other personas, not their
  reactions, not the discussion that produced the item.
- Seat the personas `personaPanel` configures, each on its own CLI, model and effort. Spread the
  panel over more than one model where you can: personas on one model share its blind spots.
- If a persona's CLI or model is unavailable, report it. Never substitute another model.
  `onUnavailable` says whether the round fails or goes on without that persona.
- Run one **baseline**: the same item and question with no persona loaded. It shows what the
  personas add (see "Reading the results").
- Do not wait idle. Read each reaction as it arrives.
- Three to six personas. More than that and the reactions blur.

## What every persona must know

1. **You are one person.** Answer as the person in your profile, in the first person. Never speak
   for another audience, and never as a consultant.
2. **Ground it or say you are unsure.** Each concern names the part of your profile it rests on
   (your goals, your constraints, what you did last time). Where the profile is silent, say you are
   unsure. Do not invent a history.
3. **Do not please.** You are not here to like it. If it is irrelevant to you, say so and score it
   that way.
4. **Judge it as given.** React to this item. Do not redesign it and do not ask for other work. What
   would change your mind goes in `would_change_mind`, nowhere else.
5. **Nothing here is precious.** If you would refuse it outright, or would want a different route to
   the same goal, say so in `instead`: one or two sentences, same goal, nothing more.
6. **No numbers about other people.** No percentages, market sizes or "most people like me". Your
   scores describe you alone.
7. **Argue the other side before you finish.** If you liked it: what would make you dismiss it in
   five seconds? If you dismissed it: what would make you take it up? Put that in `other_side`.
8. **Work alone.** Do not read other reactions. Do not start subagents. Do not edit files.

## Persona output

In the pipeline, answer with the harness tool you are given, once. Elsewhere, end with one line:

`PERSONA_RESULT: {"persona": "<slug>", "scores": {...}, "concerns": [...], "reasoning": "...", "would_change_mind": "...", "other_side": "...", "instead": "...", "unsure": [...]}`

- `scores`: the scales your task names (in BIF: appeal, adoption, willingness to pay, friction, each
  1–5). They say how strongly you react, nothing about anyone else.
- `concerns`: most important first, each with `basis` (the part of your profile it rests on).
- `unsure`: what you could not judge because your profile does not say.

If you cannot react at all, say why and give no scores.

## Rounds

- One read of the item by the whole panel is one round. A new round starts only after the item
  changed. Rereading unchanged work is not a round.
- At most `rounds` rounds.
- Every round is a fresh run. A persona remembers nothing. From round 2 its task lists **its own**
  earlier concerns (never another persona's) and what changed in the item. It rules on each concern:
  `resolved`, or `stands` with what in the changed item still causes it. It may add new concerns
  only about what changed.
- A panel never passes or fails. When the rounds are used up, report what still stands.

## Reading the results (orchestrator)

1. Keep every reaction whole and under its persona's name. Never rewrite one into another's words.
2. **Report the spread, not the average.** Where personas differ by two points or more on a scale,
   that disagreement is the result. An average hides it, and an average of simulated people is not a
   number about real ones.
3. Compare each reaction with the baseline. A reaction that says what the baseline says added
   nothing: say so, and do not count it as support.
4. Drop anything that breaks rule 6 (numbers about other people) and say that you dropped it.
5. When two personas contradict each other, state both. Do not pick one.
6. Sort concerns into: grounded (has a `basis`), and unsure. Only grounded concerns go forward.
7. Wishes outside the item (`instead`, and anything in `would_change_mind` that needs other work) are
   follow-ups. Do not let the panel widen the work.
8. Everything a panel says is marked simulated. It becomes a list of things to check with real
   people. It never changes a score, a priority or a decision by itself, and it is never quoted as
   what customers think.

## Report

Put the result where the work is reported (BIF merges to `main` without pull requests, so in the
final reply or on the item's page):

## Persona panel (simulated)

Rounds: 2 · Baseline: run

| Persona (model) | Round 1 | Round 2 | Top concern still standing |
| --- | --- | --- | --- |
| operations-lead (claude sonnet) | appeal 2, adoption 2 | appeal 4, adoption 3 | Needs a pilot before a contract |
| finance-approver (codex) | appeal 3, adoption 1 | appeal 3, adoption 1 | No budget line this year |
| field-user (opencode) | unavailable | unavailable | |

Disagreement: adoption (1 to 3). Things to check with real people: …

Write `no reaction` when a persona gave none, and `unavailable` when it could not be started. Never
invent a score.

## Configuration

```jsonc
"personaPanel": {
  "rounds": 1,                // most rounds per item
  "baseline": true,           // one run with no persona per item
  "onUnavailable": "report",  // fail | report: never substitute another model
  "seats": [                  // personas are given seats in turn, so the panel is spread over them
    { "cli": "claude", "model": "sonnet" },
    { "cli": "codex",  "model": "gpt-5", "effort": "medium" }
  ],
  "personas": { "<slug>": { "seat": 0 } }   // optional: pin a persona to a seat
}
```

With no `personaPanel` configured, every persona runs on the one model configured for personas.
