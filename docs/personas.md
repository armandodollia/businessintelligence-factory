# Personas and persona learning

Segment personas are simulated customers (or, for internal audiences, simulated employees). This
page covers how they are built and how they learn from your reactions. How they read
recommendations is in [persona-panel.md](persona-panel.md); how they judge flows is in
[flows.md](flows.md#persona-head-to-heads-simulated). Stakeholder personas are a separate kind
([stakeholders.md](stakeholders.md)), and so is the persona of you ([user-persona.md](user-persona.md)).

Code: `src/core/market/personas.ts`, `src/core/market/agentMd.ts`, `src/core/personas/`.

## Personas are simulated

Persona profiles are researched with evidence (`audience_segments` and `persona_profile` tasks in
`market_research`), compiled into persona prompts (an agent.md per persona), and every recommendation
is put to each persona. Their feedback is labelled *simulated*, shown in its own column, and has
weight 0 in priority unless you change `scoring.personaWeight`.

## Persona learning

Your reactions to what a simulated persona says teach that persona to judge more like the audience
you know, in the weekly retro only and only with your approval. Settings:
[configuration.md](configuration.md#personalearning). Learning runs only when lessons and the retro
are on.

### What counts as a signal

Every reaction to one persona's own output, agreeing or disagreeing:

- your agree / disagree on one of its flow verdicts;
- your ruling on a pair it judged (the persona's winner against yours; a tie disagrees; an explicit
  reaction to the same verdict wins over the ruling);
- your ratings of its panel feedback on a recommendation (appeal, adoption, willingness to pay,
  friction) and of its profile fields;
- including or leaving out the persona.

The latest reaction per thing counts, with the reason you typed. Reactions to a ranking position do
not count (a position mixes the checklist, every persona and your overrides). Signals are read from
the feedback log; nothing new is stored for them.

### The gate

At the retro, each persona's open reactions (since its last learning run, at most `windowDays` old)
are counted. A persona qualifies for a change only with at least 6 reactions (`minSignals`), on at
least 4 different things (`minDistinctItems`), and disagreement clearly above 30% (`disagreeFloor`:
the lower end of the 95% Wilson interval of the disagreement rate). So 5 of 6 qualifies, 4 of 6 does
not, 5 of 8 does, 10 of 20 does not. Agreements count against a change.

A persona that does not qualify shows what is missing ("4 of 6 reactions", "3 of 4 different
things", "disagreement not clearly above 30%").

### What the retro does

For each qualifying persona (most disagreements first, at most 5 per retro; a persona whose last
proposals still wait for you is skipped), one `retro`-role run states its assumption (how the persona
misjudges) and proposes at most 3 adjustments: add, replace or retire a short second-person
correction. Each rests on at least 3 of the reactions it was shown (2 different things, 2
disagreements).

The run is shown no upload-derived text; if it was, its proposals are refused. An engine step also
proposes retiring an adjustment whose disagreement did not drop after 6 more reactions. A failed
learning run never fails the retro and consumes nothing.

### Changes wait for you

Proposals appear under "What the tool has learned" on each persona card (the Lessons page counts
those waiting in the whole business). Accept (optionally with your edited text, at most 400
characters), reject, or retire an active adjustment, each with an optional reason. Each is a feedback
event and a Decision.

Only an accept changes the persona: a new persona version whose agent.md gains "Corrections from
people who know your segment" with a marker (`[A-3F9C21.v2]`). Its flow verdicts then stop being live
and are judged again in the next ranking round, and its panel feedback is replaced at the next panel.
Research that saves the persona again keeps its adjustments. Each card shows each adjustment's
disagreement before and since.

Everything stays inside its business tree. Learning proposals and their decisions follow the
training export's treatment of lesson proposals (their Decisions join only ratings of themselves).

### API

| Route | Does |
|---|---|
| `GET /api/workspaces/:id/persona-learning` | the learning state of the business |
| `GET …/personas/:personaId/signals` | a persona's signals |
| `POST …/persona-proposals/:proposalId/accept` | accept (`{text?, reason?}`) |
| `POST …/persona-proposals/:proposalId/reject` | reject (`{reason?}`) |
| `POST …/persona-adjustments/:adjustmentId/retire` | retire (`{reason?}`) |

`…` is `/api/workspaces/:id`. The same routes serve open stakeholders and the user persona's lines
(see [stakeholders.md](stakeholders.md) and [user-persona.md](user-persona.md)).
