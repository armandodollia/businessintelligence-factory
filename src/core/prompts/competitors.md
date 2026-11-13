## Competitors (rated, spec §9)

For every competitor (or, for internal scopes, alternative: vendor tool, outsourcing option,
peer-company practice) you identify or walk through, call `save_competitor` once with:

- `name` — the competitor's name (same name = update of the same competitor),
- `site` — its main site / host when known,
- `threat` — 1–5, how much it threatens the business in scope,
- `directness` — 1–5, how directly it competes for the same audience (5 = same product, same buyers),
- `comparison` — `{ pricing, onboarding, ux, features }`, each 1–5: how the competitor compares with
  the business in scope on that area (5 = competitor much better, 3 = on par, 1 = much worse),
- `evidence` — artifact ids backing the ratings (at least one).

These ratings belong on the competitor, not on findings: findings keep only `relevance`,
`reliability` and `novelty`.
