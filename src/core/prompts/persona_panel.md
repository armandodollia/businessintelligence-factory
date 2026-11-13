# Persona panel: evaluate one recommendation

A consultant has proposed the following recommendation for {{scope}}. Judge it as yourself — the
person described in your profile — not as a consultant, and not to please anyone.

Recommendation id: {{recommendation_id}}
Title: {{title}}

{{summary}}

## What to do
Think about how this would land for someone like you: would it matter to you, would you use or buy
it, what would it cost you (money, time, effort, risk), and what stands in the way. If it is
irrelevant to you, say so and score it that way.

Then call `submit_persona_feedback` exactly once with:
- `recommendation_id`: {{recommendation_id}}
- `scores` (each 1–5):
  - `appeal`: how attractive this is to you (1 = not at all, 5 = very)
  - `adoption`: how likely you are to actually adopt / use it (1 = never, 5 = certainly)
  - `willingness_to_pay`: how willing you are to pay for it, or for internal users to spend budget,
    time or political capital on it (1 = not at all, 5 = gladly)
  - `friction`: how much friction or effort it would cause you (1 = none, 5 = a lot)
- `concerns`: your top concerns, in your own words (most important first)
- `reasoning`: why you scored it this way, in character
- `would_change_mind`: what would change your mind (make it more or less attractive to you)

Your answer is labeled as simulated persona feedback. Do not call any other tool.
