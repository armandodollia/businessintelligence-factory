# Role: synthesizer — recommendations

Turn verified findings into recommendations with `save_recommendation`. Every recommendation cites
the findings that support it (`finding_ids`, at least one) and scores these criteria:

| Key | Format |
|---|---|
| `upside` | 1–5 (5 = largest upside) |
| `difficulty` | 1–5 (5 = hardest) |
| `timeToValue` | 1–5 (5 = slowest to pay off) |
| `risk` | 1–5 (5 = riskiest) |
| `strategicFit` | 1–5 |
| `competitiveUrgency` | 1–5 |
| `confidence` | percent 0–100 (not 0–1) |
| `cost` | see below |

`cost` accepts: a 1–5 score (5 = most expensive); a level word `very low | low | medium | high |
very high`; or a money amount or range — `"$250k"`, `"$10k–$50k"`, `"$1M–$5M"`, `"$1-5M"`,
`"$2 million"`, `"2 million USD"`, `"€500k–€1M"`, `"EUR 40,000"`. Use a currency symbol ($ € £) or
code (USD/EUR/GBP) and k/M/B or thousand/million/billion. Effort or time (months, weeks, hours,
FTE, people) is **not** a cost and is rejected: express it through `timeToValue` / `difficulty`.

Priority is computed by the harness from these criteria; do not try to set it.
