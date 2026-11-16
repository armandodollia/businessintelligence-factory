# Usage, cost, metrics and event history

What every agent run costs, how prompt versions are tracked, the Metrics page, and the event history.

Code: `src/core/metrics/`, `src/core/harness/pricing.ts`, `src/core/prompts/`,
`src/core/telemetry/`.

## Usage, cost and prompts

Every agent run's token usage (input, output, cache read, cache write) is stored with its cost. The
cost is computed from the dated price table `src/core/harness/pricing.json` (USD per 1M tokens,
editable) and stored next to the cost the CLI itself reports. Bump the table's `version` /
`effectiveDate` when you change a price; stored rows keep the price version they were computed with.
The codex model price is a marked placeholder.

Runs also record attempts, rate-limit back-offs, round, task type and why they failed. Every prompt
version hash recorded anywhere (runs, decisions, usage, ratings, feedback events, outcomes, review
issues) resolves to its full text.

The **Usage & prompts** page shows:

- costs per role / model / prompt version / task;
- budget status (see [configuration.md](configuration.md#budgets));
- a per-prompt-version trend (rating agreement, mean delta, review pass and first-round pass rate);
- the calibration history of each role (revert to any earlier version);
- every agent run with a paged event viewer.

| Route | Serves |
|---|---|
| `GET /api/costs[?workspaceId=]` | costs |
| `GET /api/runs/:id` | one agent run |
| `GET /api/runs/:id/events?offset=&limit=` | a run's events, paged |
| `GET /api/prompts/:hash` | the full text of a prompt version |
| `GET /api/workspaces/:id/agent-runs` | the workspace's agent runs |
| `GET /api/workspaces/:id/metrics/prompt-versions[?role=]` | the per-prompt-version trend |
| `GET /api/workspaces/:id/calibration/versions[?role=]` | calibration history |
| `POST /api/workspaces/:id/calibration/versions/:versionId/revert` | revert to a calibration version |

## Metrics

The **Metrics** page charts review pass rate, first-round pass rate, rounds to pass, run failure
rate, cost and rating agreement per day or week. It has tables per role / task type / prompt version
/ model (pass, rounds, review issues, failures, ratings, outcome labels, cost), failures by reason,
review issues by class and the knowledge-store metrics (human reads apart).

- Scope is this part or the whole business, never another business.
- Experiment and reviewer-audit runs are left out unless you tick "Include experiment and audit
  runs".
- A lessons table shows each lesson rule's effect per prompt version (the same figures as the
  Lessons page).
- The training-export exclusion summary is computed only when you press its button (it runs the
  whole export).

API:
`GET /api/workspaces/:id/metrics[?scope=tree|node&since=&until=&groupBy=role|task_type|prompt_version|model&bucket=day|week&includeExperiments=1]`.

## Event history

Bus events that used to exist only on the live server-sent event stream (`GET /api/events`) are
kept in `bus_events`: tool-call validation errors, run and task status changes, request traffic.
They are kept for `telemetry.busEventRetentionDays` (`GET /api/workspaces/:id/bus-events`).

With `telemetry.otlp.enabled` they are also sent as OTLP/HTTP JSON logs to `<endpoint>/v1/logs`
(built-in `fetch`, no SDK dependency; ids, types and statuses only, no agent or user text). Settings:
[configuration.md](configuration.md#telemetry).
