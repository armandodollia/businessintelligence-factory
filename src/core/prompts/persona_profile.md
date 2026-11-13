# Task type: persona_profile

Build one evidence-backed persona for one audience segment and save it with `save_persona`.

## Fields (all required)
`profile` must contain every field below, each as `{ value, confidence, evidence }`:
- `value`: concrete, specific prose (numbers, ranges, named tools and phrases — not generic filler)
- `confidence`: 0–1, how well the evidence supports the value
- `evidence`: at least one artifact id you saved (or one from a workspace in the same business tree)

| Field | What it covers |
|---|---|
| `demographics` | role/seniority, age band, location, household where relevant |
| `socioeconomic` | income or budget authority, education, company size they work in |
| `personality_values` | personality traits and values that shape their decisions |
| `goals` | what they are trying to achieve |
| `needs` | what they need from a product / service / internal tool |
| `pain_points` | what frustrates them today |
| `jobs_to_be_done` | the jobs they "hire" a solution for |
| `buying_behavior` | decision maker, budget, price sensitivity, purchase triggers, objections |
| `channels_media` | where they learn, discuss and buy (sites, communities, events, media) |
| `alternatives_switching` | current alternatives and switching costs |
| `tech_attitude` | attitude to technology and new tools |
| `voice` | vocabulary and phrases quoted from real reviews, posts or interviews |
| `segment_size_value` | estimated segment size and value to the business, with the basis |

Several fields may cite the same artifacts (e.g. `personality_values` and `voice` often come from the
same reviews). Do not invent: if the evidence is thin, say so in the value and lower the confidence.

## Audience
Set `audience`:
- `external` — customers / prospects. Research reviews, forums, social, competitor marketing,
  industry and census reports, analyst coverage, and the interview.
- `internal` — employees or internal users of the workspace scope. Research job postings and role
  descriptions, employee-review sites, industry surveys of the role, the interview, and internal
  uploads (weight internal uploads highest).

## Saving
- `segment`: the segment name; `slug`: optional stable id (re-using a slug updates that persona and
  bumps its version — use it when refining an existing persona).
- Each save compiles the persona into a simulated persona agent (`agent.md`); persona feedback is
  always labeled simulated and is never evidence.
- Finish with `submit_result` referencing the persona id(s) returned by `save_persona` and the
  artifact ids you relied on.
