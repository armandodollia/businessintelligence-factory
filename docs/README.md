# BIF documentation

Technical documentation for engineers working on the Business Intelligence Factory. The
[top-level README](../README.md) explains what the tool does in plain terms.

## Reference

| File | About |
|---|---|
| [architecture.md](architecture.md) | the parts, how they talk, how an agent run works, start-up and restart |
| [setup.md](setup.md) | install, CLI sign-in, running, ports, environment overrides, the research browser, CLI isolation |
| [configuration.md](configuration.md) | every configuration block and key with its default |
| [research-pipeline.md](research-pipeline.md) | workspaces, interview, phases, the review loop, escalations, action policy, scheduler |
| [council.md](council.md) | the review council: configuration, a round, the merge, unavailable members |
| [knowledge-store.md](knowledge-store.md) | the evidence rule, living facts, entities, evidence text, OCR, read tools |
| [flows.md](flows.md) | flow records, checklists, reviews, the ranking rule, persona head-to-heads |
| [personas.md](personas.md) | segment personas and persona learning |
| [persona-panel.md](persona-panel.md) | the persona panel: seats, rounds, baseline, unavailable personas |
| [stakeholders.md](stakeholders.md) | stakeholder personas, the question round, reads, positions, export |
| [user-persona.md](user-persona.md) | the persona of you |
| [learning.md](learning.md) | ratings, calibration, feedback log, decision outcomes, lessons, retro, audits, experiments |
| [usage-and-metrics.md](usage-and-metrics.md) | usage and cost, prompt versions, the Metrics page, event history |
| [privacy-and-export.md](privacy-and-export.md) | what leaves the machine, the export and upload rules, the local-only server |
| [data-storage.md](data-storage.md) | files under the data directory and the main database records |
| [smoke-tests.md](smoke-tests.md) | the real-CLI smoke test: modes, variables, what each checks |
| [known-limitations.md](known-limitations.md) | what does not work yet or has a known gap |

## Results and history

| File | About |
|---|---|
| [smoke-results.md](smoke-results.md) | latest smoke test results |
| [superpowers/verify-log.md](superpowers/verify-log.md) | review-gate history and open items per section |
| [superpowers/rulings-2026-11-15-persona-projects.md](superpowers/rulings-2026-11-15-persona-projects.md) | decisions taken without the owner during the persona projects |

## Design specs

| File | About |
|---|---|
| [2026-11-12-business-intelligence-factory-design.md](superpowers/specs/2026-11-12-business-intelligence-factory-design.md) | the main design |
| [2026-11-13-knowledge-store-design.md](superpowers/specs/2026-11-13-knowledge-store-design.md) | the knowledge store |
| [2026-11-13-learning-loop-parity.md](superpowers/specs/2026-11-13-learning-loop-parity.md) | the learning loop |
| [2026-11-14-flow-records-and-ranking-design.md](superpowers/specs/2026-11-14-flow-records-and-ranking-design.md) | flow records and ranking |
| [2026-11-15-hub-and-runners-design.md](superpowers/specs/2026-11-15-hub-and-runners-design.md) | a shared hub and local runners (draft, not built) |
| [2026-11-15-persona-learning-design.md](superpowers/specs/2026-11-15-persona-learning-design.md) | persona learning |
| [2026-11-15-stakeholder-personas-design.md](superpowers/specs/2026-11-15-stakeholder-personas-design.md) | stakeholder personas |
| [2026-11-15-stakeholder-positions-design.md](superpowers/specs/2026-11-15-stakeholder-positions-design.md) | stakeholder positions |
| [2026-11-15-user-persona-design.md](superpowers/specs/2026-11-15-user-persona-design.md) | the persona of you |
| [2026-11-16-persona-panel-design.md](superpowers/specs/2026-11-16-persona-panel-design.md) | the persona panel |
| [2026-11-16-review-council-design.md](superpowers/specs/2026-11-16-review-council-design.md) | the review council |

## Implementation plans

Implementation plans for most of the designs above live in [superpowers/plans/](superpowers/plans/),
named by date and topic (the main design's plan is `2026-11-12-business-intelligence-factory.md`).
