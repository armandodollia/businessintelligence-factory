# Persona learning in the retro — design

Date: 2026-11-15. Project 2 of 4 (1: flow records and ranking, built; 3: stakeholder personas; 4: a persona of the user).

The user asked for projects 2–4 to be designed and built without further input. Every decision below
that the user did not state is marked **(my call)**.

## 1. Intent

Personas only assist: they break ties in flow rankings and give simulated feedback on recommendations.
The user reacts to what they say (agrees, disagrees, overrides, rates), often with a reason. Those
reactions, positive and negative, are the signals for making each persona judge more like the audience
the user knows.

What the user decided:

- Both positive and negative signals are kept and used.
- Learning happens only in the scheduled retro, never at the moment of a reaction, so that one loud
  reaction cannot move a persona. There must be enough data to smooth out statistical peaks.
- The retro may show the user the assumptions the tool is making and the changes it wants to make, so
  the user can respond to them.
- The user can give a free-text reason with every approval or rejection.

## 2. Goals, non-goals, anti-goals

Goals

1. Collect, per persona, every user reaction to that persona's output, with polarity, what it was about
   and the user's reason.
2. In the retro only, decide by a fixed statistical rule whether a persona has enough disagreement,
   over enough different things, to justify a change.
3. For a persona that qualifies, have an agent state its assumption (how the persona misjudges) and
   propose a small number of adjustments, each resting on several signals.
4. The user accepts (optionally editing), or rejects, each proposal with a reason. Accepted adjustments
   become part of the persona: a new persona version and a recompiled agent.md.
5. Track whether an adjustment helped; propose retiring one that did not.

Non-goals (this project)

- Stakeholder personas and the persona of the user (projects 3 and 4). The machinery here is built so
  those two can add their own signal sources.
- Reliability weights per persona in rankings **(my call)**: discounting a persona is not improving it.
- Applying changes without the user **(my call)**: proposals wait for the user's decision.
- Rewriting researched profile fields. Adjustments are layered on top of the profile and can be retired.
- Learning from reactions to a ranking position (`flow_rank_reaction`) **(my call)**: a position blends
  the checklist, all personas and overrides, so it cannot be attributed to one persona.

Anti-goals

- A persona changing between retros, or because of a single reaction.
- A proposal that rests on one outlier.
- Upload-derived text reaching a learning run, an adjustment or a persona prompt.
- Signals or adjustments crossing business trees.

## 3. Constraints (unchanged from the repo brief)

Local-first; Node 25; TypeScript ESM; `src/core` never imports from `src/api` or `web`. No data leaks
across business trees. Upload-derived text stays out of exports by default and its provenance is
sticky. Third-party and user text shown to an agent is fenced as untrusted data. Agents get minimal
slices. All persona output stays labelled simulated.

## 4. Approaches considered

- **A. Adjustments layered on the persona, proposed in the retro, decided by the user (chosen).** A
  deterministic gate picks the personas with enough signal; an agent writes the adjustment text; the
  user decides. Reversible, auditable, and it reuses the pattern of lesson rules.
- **B. Reliability weights.** Pure arithmetic and no agent, but it only turns a persona down; it never
  teaches it anything, and the reasons the user typed would go unused.
- **C. Re-research the persona with the feedback as evidence.** Rewrites evidence-backed fields from
  the user's opinion, which mixes two kinds of evidence and cannot be undone piece by piece.

## 5. Signals

A signal is computed on read from the append-only logs (feedback events and ratings); nothing new is
stored for it. Module `src/core/personas/signals.ts`.

```ts
type PersonaSignal = {
  id: string;                 // id of the source row (feedback event or rating)
  source: 'verdict_reaction' | 'override' | 'feedback_rating' | 'profile_rating' | 'include';
  personaId: string;
  personaVersion?: number;    // version that produced the judged output, when known
  polarity: 'agree' | 'disagree';
  itemKey: string;            // the thing judged (see table)
  topic: string;              // grouping for the learning run (see table)
  detail: string;             // one line built from ids, names and enums; never evidence text
  reason?: string;            // the user's words, as stored (already redacted)
  refs: string[];             // ids it rests on, for the upload check
  at: string;
};
```

| Source | From | Polarity | itemKey | topic |
|---|---|---|---|---|
| `verdict_reaction` | `flow_verdict_reaction` events; the latest reaction per verdict | the reaction | the two flows' lineage ids, sorted, joined with `\|` | `flow:<flow type key>` |
| `override` | `flow_override` events that record a ruling; one signal per persona verdict recorded with it | `agree` when the persona's winner is the user's winner, else `disagree` (a tie disagrees) | same pair key | `flow:<flow type key>` |
| `feedback_rating` | ratings on `persona_feedback` (`<recId>:<personaId>`), criteria appeal, adoption, willingnessToPay, friction; latest per target and criterion; stale ratings dropped | the rating's verdict | `rec:<recId>` | `recommendation:<criterion>` |
| `profile_rating` | ratings on `persona` (criterion = profile field); latest per field | the rating's verdict | `field:<field>` | `profile:<field>` |
| `include` | `include_override` events on the persona; the latest | include true `agree`, false `disagree`; cleared: none | `persona` | `persona` |

Rules

- When the user both reacted to a verdict and ruled on its pair, the explicit reaction counts and the
  override signal for that verdict is dropped.
- A signal belongs to the persona whatever its version.
- **Open signals** of a persona: those newer than the `signalsThrough` of the persona's latest learning
  run that ended `proposed` or `no_change`, and not older than `windowDays`. A learning run consumes the
  signals it was shown; a failed run consumes nothing.
- `collectPersonaSignals(store, config, personaId, { since?, until? })` returns all of them, oldest
  first; `openSignals(...)` applies the rule above.

## 6. The gate

Module `src/core/personas/gate.ts`. Over a persona's open signals: `n` signals, `d` disagreements,
`items` distinct `itemKey`s, and `lower` = the lower bound of the 95% Wilson interval of `d / n`.

A persona **qualifies** when all hold:

- `n ≥ minSignals` (default 6),
- `items ≥ minDistinctItems` (default 4),
- `lower ≥ disagreeFloor` (default 0.3).

With the defaults: 5 of 6 qualifies, 4 of 6 does not, 5 of 8 does, 10 of 20 does not, 11 of 20 does.
Agreements count against a change, which is how positive signals are used at the gate. Otherwise the
persona is `watching`, with what is missing ("4 of 6 reactions", "3 of 4 different things",
"disagreement not clearly above 30%").

`personaGate(signals, settings)` returns `{ n, agree, disagree, items, lower, qualifies, missing: string[] }`.

## 7. The learning run

Module `src/core/personas/learn.ts`. `runPersonaLearning(deps, rootWorkspaceId, { now, retroId })`:

1. For every usable persona in the tree, compute the gate.
2. Engine step (no agent): for each active adjustment with at least `minEffectSignals` (default 6)
   signals since it became active, compare the disagreement rate since then with the rate recorded
   when it was proposed. Only reactions to output of the persona version that carries the adjustment
   count (a reaction to older output says nothing about the adjustment). A retire the user rejected is
   not proposed again until the adjustment changes. Not lower: create a pending `retire` proposal (source `engine`) unless one is
   already pending for it.
3. Take the qualifying personas, most disagreements first, at most `maxPersonasPerRetro` (default 5).
   A persona with pending proposals is skipped (the user has not answered the last round).
4. For each, one agent run: role `retro`, no browser, no knowledge tools, system prompt
   `prompts/persona_learning.md`, model `personaLearning.model` (default: the retro model). The prompt
   holds, within a fixed budget:
   - the persona: segment, audience, and each profile field's value cut to 300 characters;
   - its active adjustments with their effect so far;
   - proposals the user rejected before, with the user's reason;
   - the open signals grouped by topic, each as `<id> <polarity> — <detail>` plus the user's reason.
   All of it is fenced as untrusted data. A signal whose `refs` are blocked by the upload rule
   (`LessonPrivacy.blocked`) is shown as its id and polarity only. A profile field resting on
   upload-derived evidence is shown as "(withheld)".
5. The run answers once with `submit_persona_learning`:

```ts
{
  persona_id: string,
  assumption: string,          // ≤ 600 chars: how the persona misjudges, in plain words
  proposals: Array<{
    action: 'add' | 'replace' | 'retire',
    adjustment_id?: string,    // replace, retire
    field?: PersonaField,      // the profile field it corrects, when one fits
    text?: string,             // add, replace: ≤ 400 chars, second person, a general statement
    why: string,               // ≤ 400 chars
    evidence: string[],        // signal ids shown in the prompt
  }>,
}
```

   The handler refuses the call when: the run is not the learning run of that persona; an evidence id
   was not shown; there are more than `maxProposalsPerPersona` (default 3); an `add` or `replace` cites
   fewer than `minEvidence` (default 3) signals, fewer than 2 distinct items, or fewer than 2
   disagreements; active plus pending additions would exceed `maxAdjustments` (default 8); the run was
   shown upload-derived text (`runIsUploadExposed`). Text is redacted and cut (`servedLine`). Zero
   proposals is a valid answer (`no_change`).
6. The run is recorded in `persona_learning_runs` with the gate numbers, the assumption, and
   `signalsThrough` = the time of the newest signal it was shown. A run that fails or ends without the tool call is `failed` and consumes nothing.
   When the signals do not fit the prompt, the oldest are shown and the newer ones wait for the next retro; the persona's
   own description takes at most half of the prompt.

A learning failure never fails the retro.

## 8. Where it runs

Only inside `runRetro` (scheduled, or the existing "run retro now"), after the lessons engine and
independent of whether the period digest is empty. Nothing else calls `runPersonaLearning`, and
nothing outside the user's decision on a proposal writes an adjustment. The retro row's `digest`
counts gain `personasEvaluated`, `personasQualified`, `personaLearningRuns`, `personaProposals`.

## 9. Proposals and the user's decision

Module `src/core/personas/adjustments.ts`.

- `acceptPersonaProposal(store, actor, proposalId, { text?, reason? })`: `add` creates an active
  adjustment; `replace` changes its text and bumps its version; `retire` ends it. The persona's version
  goes up by one and its agent.md is recompiled. The user's edited text, when given, is what is stored.
- `rejectPersonaProposal(store, actor, proposalId, { reason? })`: nothing changes.
- `retireAdjustment(store, actor, adjustmentId, { reason? })`: the user retires an active adjustment
  directly; same effect as an accepted `retire`.

Each writes one feedback event (new kinds `persona_learning_accept`, `persona_learning_reject`,
`persona_adjustment_retire`; target types `persona_proposal`, `persona_adjustment`) and one Decision,
in one transaction. Reasons are redacted and capped at 2,000 characters like flow reactions.

Consequences of a new persona version, both intended: the persona's flow verdicts stop being live and
are re-judged in the next ranking round; its panel feedback is replaced at the next panel.

A persona saved again by research keeps its adjustments.

## 10. In the persona's prompt

`compileAgentMd` gains `adjustments`. After the profile sections and before the instructions:

```
## Corrections from people who know your segment

Where a correction conflicts with the profile above, the correction wins.

- [A-3F9C21.v2] (buying_behavior) You compare on total yearly cost, not the monthly price.
```

The marker (`A-` plus six hex characters, unique) and version are in the text, so the prompt of any
run shows which adjustments it carried. `writeAgentMd` reads the persona's active adjustments.

## 11. Storage (migration 24)

- `persona_adjustments`: `id` (`pad_`), `root_workspace_id`, `workspace_id`, `persona_id`, `field`,
  `marker` (unique), `text`, `version`, `status` (`active`, `retired`), `source` (`retro`, `engine`,
  `user`), `proposal_id`, `actor`, `stats_json` (the gate numbers when proposed), `internal` (0/1,
  reserved for project 3), `created_at`, `changed_at`, `ended_at`.
- `persona_proposals`: `id` (`ppr_`), `root_workspace_id`, `workspace_id`, `persona_id`, `run_id`,
  `action`, `adjustment_id`, `field`, `text`, `rationale`, `evidence_json`, `stats_json`, `source`,
  `status` (`pending`, `accepted`, `rejected`, `superseded`), `final_text`, `created_at`, `decided_at`,
  `actor`, `reason`, `decision_id`, `feedback_event_id`.
- `persona_learning_runs`: `id` (`plr_`), `root_workspace_id`, `persona_id`, `retro_id`, `status`
  (`proposed`, `no_change`, `failed`), `signals_through`, `stats_json`, `assumption`, `agent_run_id`,
  `failure_reason`, `created_at`, `ended_at`.

Deleting a persona's workspace removes its rows with it (same cascade rule the repo uses for personas).

## 12. Settings (`config.personaLearning`, all optional)

`enabled` true · `minSignals` 6 · `minDistinctItems` 4 · `disagreeFloor` 0.3 · `windowDays` 180 ·
`maxPersonasPerRetro` 5 · `maxProposalsPerPersona` 3 · `minEvidence` 3 · `maxAdjustments` 8 ·
`minEffectSignals` 6 · `model` (default: the retro model). Read through `personaLearningSettings(config)`.

## 13. API

Under the existing conventions (actor from config, never from the body):

- `GET /api/workspaces/:id/persona-learning` — for each persona of the node: gate numbers and what is
  missing, active adjustments with their effect, pending proposals, the last run and its assumption.
- `GET /api/workspaces/:id/personas/:personaId/signals` — every signal, both polarities, newest first.
- `POST /api/workspaces/:id/persona-proposals/:proposalId/accept` `{ text?, reason? }`
- `POST /api/workspaces/:id/persona-proposals/:proposalId/reject` `{ reason? }`
- `POST /api/workspaces/:id/persona-adjustments/:adjustmentId/retire` `{ reason? }`

Ids from another business tree answer 404.

## 14. What the user sees

On the Personas page, each persona card gains "What the tool has learned":

```
Reactions not yet used by a retro: 9 (4 agree, 5 disagree) on 6 different things.
Not enough for a change yet: disagreement not clearly above 30%.

Assumption (retro of 16 Nov): this persona overrates short sign-up forms; you preferred
the flow with fewer surprises later in 4 of 5 disagreements.

Proposed  add (buying_behavior)                                   [Accept] [Edit] [Reject]
  "You compare on total yearly cost, not the monthly price."      reason: [__________]
  Rests on 4 reactions (3 disagree, 1 agree)  ▸ show

Active    [A-3F9C21.v2] You distrust flows that ask for a card before showing the product.
          Disagreement before 62% of 8 · since 20% of 5                       [Retire]
```

"show" lists the signals: what the persona said, what the user did, and the user's reason. The Lessons
page shows the number of pending persona proposals with a link.

## 15. Privacy and isolation

- A learning run is never shown upload-derived text; if it was, its proposals are refused.
- Adjustment text is written by the agent as a general statement and redacted; it never quotes evidence.
- Everything is keyed by the business tree root; every read and decision checks the tree.
- Learning proposals and their decisions follow the training export's treatment of lesson proposals.

## 16. Left to the builder

File layout inside `src/core/personas/`, prompt wording, exact budget of the learning prompt (keep it
under the retro briefing budget), table indexes, component split of the page, and the wording of the
"missing" lines.

## 17. Verification

Unit tests per module; an end-to-end test (reactions → retro → proposal → accept → new agent.md →
verdicts no longer live); an isolation test across two trees; a test that no reaction changes a persona
outside the retro; a smoke mode `persona-learning` for the real CLIs.
