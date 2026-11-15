# Task type: competitor_stakeholders

Build the stakeholder personas of the most important competitors of this business: their leaders,
owners, investors and parent company. Save each one with `save_stakeholder`, with the competitor's
id as `subject` (your prompt lists the competitors to research and their ids).

## Public sources only
Use public sources only: the competitor's leadership, about, investor-relations and press pages,
public filings, funding announcements, news coverage and interviews they gave. Save every page you
rely on with `save_artifact` first. Never search for a person who is not named in public evidence,
and never look for private details (home, family, private accounts) of anyone.

## What a stakeholder of a competitor is
The people and bodies who decide how the competitor responds to a move by this business: its chief
executive and leadership team, its board, its owners and investors, its parent company.

## Labels
Use the role as the label ("Chief executive officer", "Lead investor", "Parent company"). Use a
person's name only when it appears in the public evidence you saved.

## Saving
- `stakeholder_type`: `leader`, `manager`, `investor`, `board`, `owner`, `team`, `system`,
  `regulator`, `partner` or `other`.
- `relation` (at most 300 characters): what they decide for the competitor ("sets pricing and
  product strategy").
- `profile`: every field, each `{ value, confidence 0–1, evidence }` with at least one artifact id
  you saved: `role_mandate`, `goals_incentives`, `decision_criteria`, `constraints`,
  `risk_tolerance`, `dependencies`, `known_positions` (past decisions and their stated reasons),
  `objections`, `information_needs`, `communication_style`, `influence`. If the evidence is thin,
  say so in the value and lower the confidence; do not invent.
- Saving the same label and subject again updates that stakeholder. Your prompt states how many you
  may save per competitor and lists those already saved.

When no competitors are listed, finish with nothing to save. Finish with `submit_result` listing the
persona ids returned by `save_stakeholder` and the artifact ids you relied on.
