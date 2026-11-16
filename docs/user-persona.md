# A persona of you

BIF keeps a short picture of the person it works for, learned from what you do in the tool, and
gives it to the agents that decide what to work on and how to present it. You see it, and decide
every line of it, on the **You** page.

Code: `src/core/userPersona/`. Settings: [configuration.md](configuration.md#userpersona). Design:
[superpowers/specs/2026-11-15-user-persona-design.md](superpowers/specs/2026-11-15-user-persona-design.md).

## One per person per business

Each person who acts in a business tree has their own picture of that tree. Trees never share one,
and the You page shows and decides only your own. Today the person is the configured user
(`user.id`), and the retro learns only for that person: actions recorded under another id (for
example before `user.id` was set) are not learned from. The feedback log, run logs and stored prompts
of a business are not separated by person. The picture never holds your user id, name or email
address: it calls you "the person you work for".

## What it learns from

Only your actions in that business and the reasons you typed with them:

- what you include or leave out;
- which proposals you accept, edit or reject;
- the facts you retract or correct;
- your agree / disagree on ratings, verdicts and reads;
- your rulings in flow rankings;
- your decisions on lessons and on earlier lines of this picture.

A change of the scoring weights counts as a correction (it says what you care about most). Answering
an approval request counts (granted or denied). Answering a login, captcha or other request does not,
and neither do schedule and settings changes or uploads. Nothing is learned from the interview or
from uploaded documents.

## When it learns: only in the scheduled retro

Nothing changes while you work. At each retro BIF counts your actions since its last finished
learning run (at most `windowDays` old). It looks at them only when there are at least 12 actions on
at least 6 different things; otherwise the You page says what is missing ("7 of 12 actions", "4 of 6
different things").

Then one offline run (no web, no browser, only the harness tools) reads those actions and proposes at
most 3 changes: add, replace or retire a short line. Each line it adds or replaces must rest on at
least 3 of your actions on at least 2 different things, and has one of eight topics: `priorities`,
`quality_bar`, `evidence_standards`, `decision_style`, `risk_appetite`, `domain_knowledge`,
`communication`, `recurring_corrections` (at most 3 lines per topic, 12 in all). The run also states
the assumption it is making about you.

A failed run changes nothing and its actions wait for the next retro. When no enabled provider can
run offline (Codex cannot), the run is skipped and a Decision records it.

## Every line waits for your decision

Proposals appear on the You page: accept (optionally with your own wording), reject, or later retire
a line, each with an optional reason. Nothing reaches a prompt until you accept it. A line you write
or edit may not contain your user id or an email address; it is refused and you can rewrite it. Your
decisions are actions too: a line you rejected is shown to the next retro with your reason, so it is
not proposed again the same way.

## Where the picture goes

Your accepted lines go, under "The person you work for", at the end of the system prompt of the
**orchestrator, synthesizer and interviewer** of that business only. They never reach workers,
reviewers, the simulated personas, escalations or the retro, so the checking and the simulated
judgement do not bend to your taste. A prompt's version changes when its lines do, so each run shows
which picture it carried. The picture is not a persona of the market: it is in no panel, ranking
round, stakeholder read, knowledge search, card or persona list.

## Switching it off

- `userPersona.enabled: false` stops learning and removes the picture from the prompts.
- `userPersona.useInPrompts: false` keeps learning (and the You page) but leaves the prompts exactly
  as they were without it.

Learning also needs lessons and the retro to be on.

## API

Under `/api/workspaces/:id`, any node of the tree:

| Route | Does |
|---|---|
| `GET …/user-persona` | the gate, statistics, lines by topic, proposals, last run |
| `GET …/user-persona/interactions?limit=&before=&line=` | your actions, newest first; `line` gives the actions a line rests on |

Accept, reject and retire use the [persona learning routes](personas.md#api).
