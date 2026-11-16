# Flows and flow ranking

BIF records how each company in the picture, your own included, lets people get a job done (sign up,
sign in, recover an account, pay, cancel, invite a teammate, get support) and ranks the ways of doing
the same job against each other.

Code: `src/core/flows/`. Settings: [configuration.md](configuration.md#flows). Design:
[superpowers/specs/2026-11-14-flow-records-and-ranking-design.md](superpowers/specs/2026-11-14-flow-records-and-ranking-design.md).

## Flow records

In `deep_dives` a worker lists the flows a subject offers and gives each one a type from the
business's catalog: sign-up, sign-in, account recovery, onboarding, pricing and plan choice,
checkout, cancel or downgrade, invite a teammate, get support. A new type is *proposed* and takes part
in rankings once you accept it or merge it into another.

The worker walks a flow one screen at a time and saves it with `save_flow`:

- the goal, and whether it was reached (or where and why the walk stopped: payment, phone, identity
  check, captcha, …);
- per step: what was done, what was seen, what was asked for, the page address and the screenshot.

A subject can have several *variants* of one type (sign-up by email, by single sign-on). The one it
puts first is the *primary*, and only primaries are ranked unless you ask for every variant.

A flow is a living record, like a fact. A re-walk with the same steps confirms it at once. Changed
steps are reported to the worker, which saves a new version that becomes current when its task is
verified. A flow that stopped before its goal is kept, ranked on the steps walked and marked
*partial*.

## Checklists

A general checklist applies to every flow (dead ends, errors that say how to fix them, asking only
for what the next step needs, deceptive patterns, keyboard and phone-width use, …). Sign-up, sign-in,
account recovery and checkout have their own, built from published guidance (NIST SP 800-63B, WCAG
2.2, web.dev, GOV.UK, Baymard, NN/g) and active from the first run.

Workers answer the checks with `save_flow_checks`. An *objective* check counts in the checklist score
(the weighted share of applicable checks passed). An *audience-dependent* one is only recorded and
shown to the personas. An agent may propose a checklist for a new type; it waits for you.

## Reviews

A `flow_reviews` task collects public feedback (app stores, review sites, forums, support boards)
with `save_review_mentions`. Each quote is checked against its stored page, stored once, dated, with
a polarity and, when clear, the flow type and check it speaks to.

Reviews answer what a walkthrough cannot see ("does the code arrive?"). At least
`minMentionsForCheck` recent, confidently attributed complaints make the check *reported problem*
(or *disputed* when they contradict a walkthrough's pass). Fewer leave it at *no signal*, which
neither helps nor hurts the score. Thin review coverage is normal and reads as "no signal", never as
"no problems".

## The ranking rule

The `flow_ranking` phase (a runner phase after `deep_dives` and `stakeholders`) ranks each node's
flows per flow type. Existing schedules were updated to include the ranking step: once, on upgrade,
`flow_ranking` was added right after `deep_dives` in every schedule that has `deep_dives` and did not
have it.

Your overrides come first: "this one is better than that one" is a hard rule the order always keeps.
Below them:

```
rank score = coverage × checklist score + (1 − coverage) × persona score
```

Coverage (0–1, per checklist: sign-in 0.7; sign-up, checkout and account recovery 0.6; the general
checklist alone 0.3) says how much of the job the checklist can settle. So the more a flow type is a
matter of taste, the more the personas count. Scores within `tieMargin` are ordered by the personas'
direct head-to-head. A flow alone in its type shows "no comparison".

Opening a position shows both scores, the coverage, each check with its evidence, the verdicts, the
review counts and your rulings.

## Persona head-to-heads, simulated

The node's audience personas judge in two stages.

1. **Broad.** Each persona reads all flows of a type in one sitting (overlapping groups when there
   are many) and gives a verdict on every pair: winner or tie, strength, confidence and a short
   reason.
2. **Focused.** Single pairs get a second look when the persona was unsure, the personas split, the
   verdicts form a loop, the two flows are close or decide a top-three place, a verdict strongly
   contradicts the checklist, or you disagreed with it (at most `maxFocusedComparisons` per round).

Personas see the steps, the audience-dependent answers, the notable note and a review digest, all
fenced as untrusted text, never the checklist score. Verdicts are labelled simulated and kept until
either flow or the persona has a new version, so a recurring round only judges new or stale pairs.
With a `personaPanel` block a persona judges on its panel seat (see
[persona-panel.md](persona-panel.md#seats)).

## Your reactions, with reasons

The **Flows** page shows flow types down the side and the chosen type's ranking (rank, checklist,
personas, reviews). Open a flow for its screenshot strip, checks, reviews and verdicts, or compare two
side by side.

You can, each with an optional reason:

- agree or disagree with a position or a verdict;
- override a pair;
- correct a check;
- accept, edit, merge or reject a proposed flow type;
- accept (with your coverage) or reject a proposed checklist;
- edit a checklist, the built-in ones too: its coverage, a check's weight or question, or remove a
  check. Saving makes a new version and says how many flows need a re-walk. Adding checks is not
  offered yet;
- correct a review's attribution.

Each is a feedback event naming exactly what it reacts to (for a verdict also the persona, its
version, the stage and both flow versions). Agreement is kept like disagreement. A ruling follows its
two flows to new versions and then asks whether it still holds. "What changed" lists new flows, new
versions, confirmations and rank moves.

Flows stay inside their business tree. Upload-derived flows follow the export rules (see
[privacy-and-export.md](privacy-and-export.md)), and persona verdicts are never exported as training
data.

API under `/api/workspaces/:id/flows`: `types`, `rankings/:flowTypeId`, `checklists`, `compare`,
`:flowId`, and the reaction, override, decision and `checklists/:checklistId/edit` routes.

## Not built yet

- Personas change only through persona learning in the weekly retro (see
  [personas.md](personas.md#persona-learning)), never at the moment you react.
- Stakeholder personas do not judge flows.
- Only web flows are walked, not mobile apps.
