# Configuration

BIF reads one JSON file, `bif.config.json` (or the path in `BIF_CONFIG`). Start from
`bif.config.example.json`. The file is merged over the built-in defaults: objects merge key by key,
while arrays and single values replace the default. The result is validated at start. A problem
(missing file, bad JSON, a key that does not exist, a wrong value) stops the server with a list of
the offending paths. The Settings page edits the same file.

The schema is `src/core/config/schema.ts`. Each optional block is read through a settings function
that applies its defaults; this page lists them.

Three blocks are documented with their subsystem, because their keys only make sense there:

| Block | Where it is documented |
|---|---|
| `browser` | [setup.md, Research browser profile](setup.md#research-browser-profile) |
| `council` | [council.md, Configuration](council.md#configuration) |
| `personaPanel` | [persona-panel.md, Configuration](persona-panel.md#configuration) |

## Required blocks

These have built-in defaults, so a config file may leave them out.

### `providers`

One entry each for `claude`, `codex` and `opencode`.

| Key | Meaning | Default |
|---|---|---|
| `enabled` | whether the CLI may be used | claude `true`, codex `true`, opencode `false` |
| `command` | the command that starts the CLI | `claude`, `codex`, `opencode` |
| `models` | the models agents may use on this CLI | claude `opus`, `sonnet`, `haiku`; codex `gpt-6.1-sol`; opencode none |

### `roles`

A `{ provider, model }` per role. Every role model must be listed under an enabled provider, or the
configuration does not load.

| Key | Used for | Default |
|---|---|---|
| `orchestrator` | plans the tasks of each research phase | claude / opus |
| `interviewer` | the interview chat | claude / opus |
| `reviewer` | reviews every worker result | codex / gpt-6.1-sol |
| `synthesizer` | recommendation synthesis | claude / opus |
| `persona` | simulated persona runs | claude / sonnet |
| `workers.default` | workers of any task type without its own entry | claude / sonnet |
| `workers.<taskType>` | workers of one task type | none |

When the reviewer would run on the same provider as the worker and another enabled provider has a
model, the review runs on that provider's first model instead, to reduce shared blind spots.

Task types: `audience_segments`, `persona_profile`, `discover_competitors`, `flow_walkthrough`,
`flow_reviews`, `news_scan`, `public_filings`, `customer_pain_points`, `own_company_audit`,
`symptom_hypotheses`, `synthesize_recommendations`, `persona_panel`, `map_business_units`,
`own_stakeholders`, `competitor_stakeholders`.

### `loop`

The review loop (see [research-pipeline.md](research-pipeline.md#review-loop)).

| Key | Meaning | Default |
|---|---|---|
| `maxRounds` | most review rounds per task | 3 |
| `passThreshold` | review score (0–10) at or above which a task is verified | 8 |
| `perTaskType.<taskType>` | `maxRounds` / `passThreshold` for one task type | none |
| `maxReasserts` | how often a reviewer may reassert an issue the worker pushed back on; after that the worker is told to fix it | 1 |

### `limits`

| Key | Meaning | Default |
|---|---|---|
| `maxParallelWorkers` | agent runs at once of the roles worker, reviewer, persona and synthesizer | 3 |
| `maxBrowserRuns` | browser-using runs at once (capped at 1 in `per_run` browser mode) | 2 |
| `maxTasksPerRun` | tasks one phase run may propose | 30 |
| `idleTimeoutMs` | a run with no output for this long is killed (10 minutes) | 600000 |

### `identity`

Disposable identities for sign-ups.

| Key | Meaning | Default |
|---|---|---|
| `emailProvider` | `mailtm` or `catchall` | `mailtm` |
| `catchallDomain` | the domain for `catchall`; required with it | none |

### `actionPolicy`

Three lists of plain-language actions: `allowed`, `approvalRequired` and `never`. The defaults are
in the example file. See [research-pipeline.md](research-pipeline.md#action-policy).

### `scoring`

| Key | Meaning | Default |
|---|---|---|
| `personaWeight` | weight of simulated persona feedback in priority | 0 |
| `weights` | weights of the recommendation criteria in priority (edited on the Strategy page) | `{}` |

### `server`, `dataDir`

| Key | Meaning | Default |
|---|---|---|
| `server.port` | the port the server listens on (127.0.0.1 only) | 4317 |
| `dataDir` | where all data lives (see [data-storage.md](data-storage.md)) | `data` |

## Optional blocks

### `user`

| Key | Meaning | Default |
|---|---|---|
| `user.id` | who you are in the feedback log | `local-user` |

Every rating, override, correction, answer and approval records this id. The API never takes it from
a request.

### `budgets`

Token and cost caps per workspace and per research pipeline. Without `budgets` there are no caps.

```json
"budgets": { "workspace": { "maxCostUsd": 50 }, "pipeline": { "maxTokens": 20000000 } }
```

| Key | Meaning |
|---|---|
| `workspace.maxTokens`, `workspace.maxCostUsd` | total spend of each workspace |
| `pipeline.maxTokens`, `pipeline.maxCostUsd` | spend of each research pipeline |

Tokens are input + output + cache read + cache write. Past a cap no new agent run starts. A "Waiting
on you" request asks to extend it by one more cap. Deny to stop; raising the cap in config lifts a
denial.

### `escalation`

See [research-pipeline.md](research-pipeline.md#escalations).

| Key | Meaning | Default |
|---|---|---|
| `enabled` | run the escalation agent when a task ends unverified or failed | `true` |
| `model` | model of the escalation agent | `roles.orchestrator` |
| `maxQuestions` | questions per escalation, 0–3 | 3 |
| `maxPerTask` | escalations per task | 2 |

### `telemetry`

See [usage-and-metrics.md](usage-and-metrics.md#event-history).

| Key | Meaning | Default |
|---|---|---|
| `busEventRetentionDays` | days `bus_events` rows are kept; 0 keeps them | 30 |
| `otlp.enabled` | send bus events as OTLP/HTTP JSON logs | off (no `otlp`) |
| `otlp.endpoint` | base URL; logs go to `<endpoint>/v1/logs` | `http://127.0.0.1:4318` |
| `otlp.headers` | extra HTTP headers | none |
| `otlp.serviceName` | service name | `bif` |

### `knowledge`

The knowledge store (see [knowledge-store.md](knowledge-store.md)). Every field has a default.

| Key | Meaning | Default |
|---|---|---|
| `budgets.default` | tokens per response kind: `search`, `card`, `expand`, `briefing` | 1200 / 800 / 2000 / 1500 |
| `budgets.roles.<role>` | per-role overrides of those kinds | reviewer `expand` 3000; synthesizer `briefing` 4000 |
| `budgets.providers.<provider>` | per-provider scale (e.g. 0.5 for a CLI with a small tool-output limit) | none |
| `hardMaxTokens` | cap on any single knowledge response; at least the highest read-tool floor | 8000 |
| `freshness.defaultDays` | days a fact stays fresh (its TTL) | 90 |
| `freshness.byEntityKind.<kind>` | the same per entity kind | none |
| `extraction.maxTextChars` | most characters extracted from one artifact | 2000000 |
| `extraction.chunkTokens` | target passage size; must not exceed `maxChunkTokens` | 400 |
| `extraction.maxChunkTokens` | largest passage | 600 |
| `extraction.xlsxMaxRows` | most rows read from a spreadsheet | 2000 |
| `extraction.inlineMaxBytes` | artifacts up to this size are extracted at save; larger ones are queued | 1048576 |
| `extraction.concurrency` | extractions at once | 1 |
| `captions.required` | agents must describe image artifacts | `true` |
| `captions.minChars` | shortest description | 20 |
| `dedupe.candidateLimit` | duplicate-check candidates returned to the saving agent (1–20) | 3 |
| `dedupe.similarityFloor` | least similarity (0–1) for a candidate: Jaccard overlap of the word sets of the two normalized claims. Full-text bm25 only picks which stored facts are compared | 0.5 |
| `retention.pruneMinAgeDays` | prune never touches files younger than this | 90 |
| `ocr.enabled` | the model pass of OCR | `true` |
| `ocr.model` | Claude CLI model for that pass | `haiku` |
| `ocr.images` | images read by the model: `all`, `uploads` or `none` | `all` |
| `ocr.minPageChars` | a PDF page with fewer non-space characters has no usable text layer | 40 |
| `ocr.maxPages` | pages of one document read by the model (1–100) | 30 |
| `ocr.pagesPerCall` | pages per model call (1–20) | 8 |
| `ocr.maxFileBytes` | larger files are never sent (images are also capped at 5 MB) | 20000000 |
| `ocr.timeoutSeconds` | time limit of one call | 180 |
| `ocr.concurrency` | model calls at once (1–10) | 2 |
| `ocr.rateLimitPauseMinutes` | pause after a rate limit | 15 |

### `flows`

Flow ranking (see [flows.md](flows.md)). Every field has a default.

| Key | Meaning | Default |
|---|---|---|
| `tieMargin` | rank scores (0–100) closer than this are ordered by their direct head-to-head | 5 |
| `minMentionsForCheck` | recent, confidently attributed complaints that make a check *reported problem* | 3 |
| `mentionWindowDays` | older mentions are shown but not counted | 365 |
| `minAttributionConfidence` | less confidently attributed mentions are shown but not counted | 0.6 |
| `maxFocusedComparisons` | focused head-to-heads per ranking round | 20 |
| `lowConfidence` | a broad verdict below this confidence gets a focused look | 0.5 |
| `maxFlowsPerSitting` | flows one persona reads in one sitting (2–20) | 8 |
| `generalCoverage` | coverage of a flow type judged on the general checklist alone | 0.3 |
| `model` | model of verdict runs | `roles.persona` |

### `lessons`

Lessons and the weekly retro (see [learning.md](learning.md#lessons-and-the-weekly-retro)).

| Key | Meaning | Default |
|---|---|---|
| `enabled` | lessons engine and retro; `false` is a kill switch | `true` |
| `minTasks` | distinct tasks a problem must recur in before a rule is proposed | 3 |
| `retireAfterCleanTasks` | clean tasks under a rule before its retirement is proposed | 10 |
| `minEffectTasks` | tasks under a rule's current version before its effect is judged (revert) | 5 |
| `maxRulesPerRole` | active rules (plus pending additions) per role and business, at most 15 | 15 |
| `retro.enabled` | the weekly retro per business | `true` |
| `retro.cron` | when it runs (Mondays 06:00 server time) | `0 6 * * 1` |
| `retro.model` | model of the retro agent | `roles.orchestrator` |
| `retro.windowDays` | days a retro digests when there was no earlier retro | 7 |
| `retro.maxProposals` | proposals one retro may make (0–10) | 5 |

### `audit`

Reviewer audits (see [learning.md](learning.md#reviewer-audits)).

| Key | Meaning | Default |
|---|---|---|
| `model` | auditor model; used when it differs from the original reviewer's model | the first model of another enabled provider, else another model of the same provider |
| `n` | tasks re-reviewed per audit when the caller gives no number (1–50) | 5 |

### `experiments`

| Key | Meaning | Default |
|---|---|---|
| `allowBrowser` | allow experiments on tasks that use the browser | `false` |

### `personaLearning`

Persona learning (see [personas.md](personas.md#persona-learning)). All optional.

| Key | Meaning | Default |
|---|---|---|
| `enabled` | persona learning in the retro | `true` |
| `minSignals` | reactions a persona needs before the retro looks at it | 6 |
| `minDistinctItems` | different things those reactions must cover | 4 |
| `disagreeFloor` | the lower end of the 95% Wilson interval of the disagreement rate must be above this | 0.3 |
| `windowDays` | days of reactions read | 180 |
| `maxPersonasPerRetro` | personas one retro may look at | 5 |
| `maxProposalsPerPersona` | proposals per persona and retro (0–5) | 3 |
| `minEvidence` | reactions a proposal must rest on | 3 |
| `maxAdjustments` | active adjustments per persona (1–20) | 8 |
| `minEffectSignals` | reactions under an adjustment before its effect is judged | 6 |
| `model` | model of the learning run | the retro model |

Learning runs only when lessons and the retro are on.

### `stakeholders`

Stakeholder personas (see [stakeholders.md](stakeholders.md)). All optional.

| Key | Meaning | Default |
|---|---|---|
| `enabled` | stakeholder personas and the `stakeholders` phase | `true` |
| `maxOwn` | own stakeholders per node | 8 |
| `maxCompetitors` | competitors whose stakeholders are researched | 3 |
| `maxPerCompetitor` | stakeholders per competitor | 3 |
| `maxReadsPerPanel` | stakeholder read runs per persona panel | 40 |
| `maxFollowed` | former colleagues one research task follows on the web; 0 turns following off | 5 |

### `userPersona`

The persona of you (see [user-persona.md](user-persona.md)). All optional. The model is persona
learning's.

| Key | Meaning | Default |
|---|---|---|
| `enabled` | learning, and the picture in prompts | `true` |
| `useInPrompts` | the accepted lines go into prompts | `true` |
| `minInteractions` | your actions a learning run needs | 12 |
| `minDistinctTargets` | different things those actions must be on | 6 |
| `minEvidence` | actions an added or replaced line must rest on | 3 |
| `maxProposals` | proposals per learning run (0–5) | 3 |
| `maxPerField` | active lines per topic | 3 |
| `maxAdjustments` | active lines in all (1–30) | 12 |
| `windowDays` | days of actions read | 180 |
