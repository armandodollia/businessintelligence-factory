# Smoke tests

`npx tsx scripts/smoke.ts` (also `npm run smoke`) boots the real server on a temporary data dir and
runs real agent CLIs. **Every mode spends real model usage.** Latest results:
[smoke-results.md](smoke-results.md).

## Running

```sh
npx tsx scripts/smoke.ts [mode] [providers]
```

- Without a mode it runs `worker`, `browser`, `knowledge`, `flows` and `interview`. The other modes
  run only when named.
- Modes: `worker`, `browser`, `knowledge`, `flows`, `persona-learning`, `stakeholders`,
  `stakeholder-positions`, `user-persona`, `council`, `persona-panel`, `interview`.
- `--help` lists them and runs nothing.
- Providers (optional, after the mode): `claude`, `codex`, `opencode`.

| Variable | Sets |
|---|---|
| `BIF_SMOKE_CLAUDE_MODEL`, `BIF_SMOKE_CODEX_MODEL`, `BIF_SMOKE_OPENCODE_MODEL` | the model per provider |
| `BIF_SMOKE_COUNCIL_SECOND_MODEL` | the council's second Claude member (default `sonnet`) |
| `BIF_SMOKE_COUNCIL_EXTRA` | `codex` or `opencode`: adds a council member of that CLI |
| `BIF_SMOKE_PANEL_SECOND_MODEL` | the persona panel's second seat (default `sonnet`) |
| `BIF_SMOKE_TIMEOUT_MS` | the per-run limit |
| `BIF_SMOKE_KEEP=1` | keeps the knowledge smoke's temp dir |
| `BIF_SMOKE_HEADED=1` | runs the shared browser with a visible window (headless otherwise) |

## What each mode checks

- **`worker`**: a real worker run per provider (`log_decision`, then `submit_result`, through the
  real MCP server). For Codex it also checks the CLI isolation.
- **`browser`**: a shared-browser run (claude unless providers are named): open a tab, go to a page,
  screenshot, `save_artifact` the file, close the tab, `submit_result`.
- **`knowledge`**: the knowledge-store flow (below).
- **`flows`**: a worker records a fictional sign-up from three seeded screen notes (no browser) with
  `read_flow_catalog`, `save_flow` and `save_flow_checks`. Then the real ranking round runs with that
  provider as the persona over two seeded flows. Both are judged from the store.
- **`persona-learning`** (default claude, only when named): six reactions (five disagree) to a seeded
  persona's verdicts, then the real retro with that provider as the learning model. It checks one
  `submit_persona_learning` call and the stored run and proposals, and that the persona did not
  change.
- **`stakeholders`** (default claude, only when named): a node with three internal notes, one
  `own_stakeholders` task through the real review loop (not offline) and the phase-end question round.
  It checks that the worker run is not offline (a Claude worker's CLI was offered built-in tools;
  browsing is not required), that at least one hidden own stakeholder cites the notes, that each has
  its four template questions (and the node its two), and that the task's research is withheld.
- **`stakeholder-positions`** (default claude, only when named): an own stakeholder of a fictional
  company is marked as left for a competitor. One `competitor_stakeholders` task follows the person
  from two captured public pages through the real review loop, then the real combine run writes one
  profile from both layers. It checks the public layer (and that the persona's own profile, status and
  version did not change), that no prompt of the research held what was known from inside, one
  offline combine run with one `submit_combined_profile` call, and that every combined field says
  what it rests on.
- **`user-persona`** (default claude, only when named): twelve actions of the configured person on
  six fictional competitors through the real action functions, then the real retro with that
  provider as the learning model. It checks one offline learning run (only harness tools offered and
  called), one `submit_persona_learning` call, the stored proposals (a user topic, evidence among the
  actions shown, no identifier of the person), and that no line or brief exists before the user
  decides.
- **`council`** (only when named): one small task of a council stage with two Claude members on the
  two cheapest models (lenses `evidence` and `brief`), and one member of another CLI when
  `BIF_SMOKE_COUNCIL_EXTRA` is `codex` or `opencode`. It checks that every member ran as its own
  reviewer run on its own model and that the runs overlapped, that each prompt holds its lens and no
  other member's, one `council_review` decision per round, that the task's final status follows the
  council's last round, and that the council route serves the rounds. A second task then seats a
  member whose model does not exist under `onUnavailable: "fail"`: it must end *unverified* naming
  that member, with no reviewer run on any other model.
- **`persona-panel`** (only when named): three personas of a fictional courier firm on two Claude
  models with a baseline, on one recommendation. Then the recommendation's summary is changed and the
  panel runs again, and once more on the unchanged text. It checks one run per persona on its own seat
  with its own profile and no other persona's, that the baseline ran with no persona and is stored
  apart from the persona feedback, that each round-2 prompt lists the reader's own earlier concerns
  and no other reader's and shows the text it read before and the text as it stands now, that the
  rulings are stored and the earlier round is kept, that the third pass starts no run, and that the
  recommendations route serves the panel.
- **`interview`**: an interview round-trip over HTTP with the claude CLI as interviewer.

## The knowledge flow

It uses the real worker system prompt, a real task and a verified fact seeded from an earlier task.
The worker:

1. saves a local HTML page with `save_artifact` and a description;
2. runs `search`;
3. `expand`s a passage;
4. saves a finding with a verified quote;
5. saves a near-duplicate and answers the duplicate check;
6. reads the page text page by page with `read_artifact` and the cursor;
7. recovers from a quote that fails verification.

Each step is judged from the store and the run's tool calls. The check covers:

- `retrieval_events` rows and `promptStoreGaps`;
- a replay of the paged reads, which checks that every passage was served whole;
- tokens and cost from `agent_usage`.
