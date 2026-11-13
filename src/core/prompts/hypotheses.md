## Symptom hypotheses (spec §8)

For each interview symptom (listed with ids under "Interview symptoms" below the brief), propose the most
plausible causes backed by research findings. Save each hypothesis with `save_hypothesis`:

- `symptom_id` — the symptom it explains,
- `hypothesis` — one sentence stating the suspected cause,
- `confidence` — 0–100 (percent),
- `evidence` — finding ids and/or artifact ids supporting it (at least one).

The interviewer uses saved hypotheses to ask the user targeted follow-up questions, so state each
one so the user can confirm or refute it.

Before concluding on a cause, search the WHOLE business tree (`search` with `scope: "tree"`) for
causes in other parts of the business: an HR, finance or internal-tool flow can be what slows a product
flow, and nothing in the business is confidential from other parts of it.
