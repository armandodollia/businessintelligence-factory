# Context measurements: where the input tokens of a run go

Measured on 2026-11-16 with `scripts/measure-context.ts`, Claude Code 2.1.325 (`haiku`), Codex CLI 0.169.0
(`gpt-6.1-sol`) and the shipped research browser `@playwright/mcp` 0.0.85. Re-measure with:

```
npx tsx scripts/measure-context.ts --no-model     # part A: sizes only, no model call
npx tsx scripts/measure-context.ts                # part A and every real run (9 Claude runs, 2 Codex runs)
npx tsx scripts/measure-context.ts --runs research,worker   # some run groups only
npx tsx scripts/measure-context.ts --reanalyze <capture dir>[,<capture dir>…]   # tables again from kept captures
```

**Priority.** Quality of results comes first. Token savings are welcome but never at the cost of worse
results. Every saving below is therefore sorted into two groups:

- **(a) cannot affect results**: the agent reads the same instructions and the same material, only less
  duplication, or fewer tools it can never use.
- **(b) could affect results**: anything that shortens what an agent reads or can reach.

Only group (a) is recommended as a default. For group (b), this doc says what it could cost and how to
measure that before deciding.

## Summary

1. **The CLI is most of every run, and BIF passes most of it on.** Claude Code's first call holds about
   **38.5k tokens** before BIF adds anything. **29.7k** of those are its 29 built-in tool definitions:
   scheduling, notifications, worktrees, notebooks, sub-agents, and also file, shell and web tools. BIF
   offers all of them to every run that is not offline. In the measured runs, 68–94 % of all input tokens
   were this fixed CLI part, sent again with every model call.
2. **Tool lists cost almost nothing with today's CLIs.** Claude Code lists MCP tools by name only, about
   **13 tokens per tool**, and loads a schema when the model asks for it (ToolSearch). Codex leaves MCP
   tools out of the first call entirely: 24 extra tools cost **5 tokens**. Offering each task type only
   its tools therefore saves only about **0.2k tokens per model call** today. It would save about **11k
   tokens per call** in any setup that sends schemas in full. Claude without built-in tools is one such
   setup, measured here. OpenCode was not measured.
3. **Browser results are the largest part BIF does not fix in advance.** They come almost entirely from
   `browser_snapshot`: 0.4k, 3.9k and 12.4k tokens in the three runs. The encyclopaedia snapshot was
   **294,709 characters (about 74k tokens)**. Claude Code refused it inline and wrote it to a file. The
   agent then read that file with the built-in Read and Bash tools. Carried into later calls, browser
   results were 1–13 % of a research run's input.
4. **Shortening browser results is group (b), and it measurably loses material.** Capping a result at 2,000
   tokens would have cut out **3 of the 4** quotes the agents saved from browser results. A cap at 4,000
   tokens would have cut out 1 of 4. Keeping only the page's main content saved 25 % and kept all 4 quotes,
   but 4 quotes is a very small sample.

**Recommendation.** Build group (a) first, in this order:

1. Stop offering Claude Code built-in tools a role never uses. This is up to 29.7k tokens per call, the
   largest item BIF controls. Keep ToolSearch, or MCP schemas are sent in full. Keep Read, Bash and the web
   tools until it is measured whether removing them changes results.
2. Stop offering `browser_close`: it always fails in BIF's shared-browser mode.
3. Remove the duplicated field schemas inside three BIF tools. Together they are about 6.8k tokens whenever
   they are loaded, mostly that repetition.
4. Offer each task type only its tools where code already refuses the others. Elsewhere, do this once
   logged tool calls show the type never uses the tool.

A gateway that cuts tool lists by task type pays off only once BIF uses a backend that sends schemas in
full. Shortening browser results should not be a default. If it is considered, test "main content only"
first, with the quality check described in the browser results section.

## Method

**Part A (no model call).**
- System prompts are built by BIF's own functions (`workerSystemPrompt`, `reviewerSystemPrompt`, and so on).
- Tool lists are read with `tools/list` from the real MCP endpoint of a booted server, with a run token per role.
- The research browser is the shipped `node_modules/@playwright/mcp/cli.js`, started on a free port. It only
  listens, so no browser opens. It was stopped by process id.
- Codex's model-visible input is rendered by `codex debug prompt-input`, with the exact command, isolated
  home and MCP overrides the Codex adapter builds.
- Work prompts come from a seeded tree: 4 nodes, 100 facts.
- Token estimates are characters ÷ 4.

**Part B (real runs).** Every run went through the real Supervisor of a freshly booted server, with a
temporary data folder and configuration.
- 11 Claude `haiku` runs:
  - 5 overhead runs with a one-line prompt: (a) the smallest tool list (persona, 4 tools); (b) the worker list;
    (c) the worker and browser lists; (d) as (a) and (e) as (b), both with BIF's offline flag (`--tools ""`),
    which switches the built-in tools off;
  - 3 browser research runs;
  - 1 reviewer run on the first research run's task;
  - 1 non-browser worker run;
  - 1 interviewer run, over HTTP.
- 2 Codex runs: overhead (a) and (b).

From each run's kept raw output (`stdout.log`):
- the CLI's usage report;
- for Claude, the context of every model call (input + cache read + cache write, from each message's usage);
- every tool call, with the size of its arguments and of its result.

**Attribution (B4).** A run's input is the sum of the contexts of all its model calls.
- The first call's context is sent with every call. It is split into three parts: tool lists at the
  measured rates, BIF's prompts (chars ÷ 4), and the CLI's own part (the rest).
- Each later growth of the context is assigned to the tool results that caused it: text at chars ÷ 4,
  images by pixel size, and ToolSearch results as the schemas they loaded, at the measured 0.413 tokens per
  character. Each is capped at the measured growth, then multiplied by the number of later calls that carry
  it. The remainder is the model's own messages, including thinking the CLI keeps but does not print.

**Pages read.** A Wikipedia article (HTTP), an MDN documentation page (HTTP overview) and the PostgreSQL
"About" page. All three are public, need no account, and no form was submitted. The prompts named only the
page.

## Part A: what BIF hands each role

### System prompt and tool list per role

Tokens are chars ÷ 4. The tool list is as `tools/list` serves it: name, description and input schema as JSON.

| role | system prompt | tools | tool list, chars | tool list, est. tokens | full schemas, measured rate (0.413/char) |
| --- | ---: | ---: | ---: | ---: | ---: |
| worker (news_scan) | 985 | 28 | 43.2k | 10.8k | 17.8k |
| synthesizer | 1,406 | 15 | 20.7k | 5.2k | 8.5k |
| orchestrator | 507 | 12 | 16.3k | 4.1k | 6.7k |
| interviewer | 835 | 10 | 12.1k | 3.0k | 5.0k |
| retro | 464 | 4 | 11.8k | 2.9k | 4.9k |
| reviewer | 619 | 5 | 7.1k | 1.8k | 2.9k |
| escalation | 609 | 4 | 5.5k | 1.4k | 2.3k |
| persona | 1,627 (synthetic agent.md) | 4 | 5.2k | 1.3k | 2.2k |
| research browser (Playwright) | 144 (browser note) | 25 | 18.5k | 4.6k | 7.6k |

chars ÷ 4 **underestimates JSON schemas by about 1.65×**. Run (e) against run (d) measured 15.7k tokens for
37.9k characters of schema (0.413 tokens per character). In the full-schema column, everything except the
worker list is extrapolated at that rate.

### Worker per task type

The tool list is estimated at chars ÷ 4. Multiply by about 1.65 for tokens sent in full.

| task type | system prompt | tools needed / offered | needed list | saving if sent in full | basis |
| --- | ---: | ---: | ---: | ---: | --- |
| news_scan, public_filings, customer_pain_points | 985–1,033 | 11 / 28 | 4.1k | 6.7k (62 %) | prompt |
| symptom_hypotheses | 1,200 | 12 / 28 | 4.2k | 6.5k (61 %) | prompt |
| discover_competitors | 1,205 | 12 / 28 | 4.4k | 6.4k (59 %) | prompt |
| map_business_units | 985 | 13 / 28 | 4.6k | 6.2k (57 %) | prompt |
| own_stakeholders | 2,081 | 11 / 28 | 4.8k | 6.0k (56 %) | **code** |
| flow_reviews | 1,521 | 13 / 28 | 4.9k | 5.9k (54 %) | prompt |
| audience_segments, persona_profile | 1,633 | 12 / 28 | 5.2k | 5.6k (52 %) | prompt |
| competitor_stakeholders | 1,936 | 12 / 28 | 5.3k | 5.5k (51 %) | code + prompt |
| flow_walkthrough | 2,351 | 19 / 28 | 6.2k | 4.5k (42 %) | prompt |
| own_company_audit | 1,034 | 19 / 28 | 6.5k | 4.3k (39 %) | guess |
| synthesize_recommendations (synthesizer) | 1,406 | 10 / 15 | 4.1k | 1.1k (21 %) | prompt |

How "needed" was derived:
- **Core, every research task.** `log_decision`, `save_artifact`, `save_finding`, `confirm_finding`,
  `retract_finding`, `submit_result`, `respond_to_review`, `search`, `get_card`, `expand`, `read_artifact`:
  4.1k tokens. worker.md tells every worker to use these.
- **Plus the tools of the task type's own prompt file:**
  - `save_persona` (persona_profile.md);
  - `save_competitor` (competitors.md);
  - the flow tools (flow_walkthrough.md);
  - `save_review_mentions` (flow_reviews.md);
  - `save_hypothesis` (hypotheses.md);
  - `propose_business_unit` and `read_workspace` for mapping;
  - the ask-the-user tools (`request_user_action`, `request_approval`, `get_identity`) only for types that
    sign up or walk flows.
- **Sure ("code").** `own_stakeholders`: `taskToolRefusal` refuses everything outside
  `PRIVATE_TASK_TOOLS`. `save_stakeholder`: its handler refuses it outside the two stakeholder types.
- **Fairly sure ("prompt"):** the rest.
- **Guess:** `own_company_audit`, derived from the phase goal only.
- **Left out as rarely needed:** `read_workspace`, `list_changes`, `describe_artifact`.
- **`propose_checklist`** (1.7k chars) is offered to every worker, but no prompt names it.
- **`persona_panel`** is a task type with no worker run.

### Research browser

The 25 Playwright tools total 18.5k chars (4.6k est. tokens, about 7.6k at the measured rate). The worker
prompt's browser section tells a worker to:
- open a new tab;
- work only in it and close it;
- save screenshots with `save_artifact`.

| set | tools | est. tokens | saving |
| --- | ---: | ---: | ---: |
| full, as offered today | 25 | 4,621 | – |
| reading: tabs, navigate, navigate_back, snapshot, take_screenshot, click, wait_for | 7 | 1,336 | 3,285 (71 %) |
| walkthrough: reading + type, fill_form, press_key, select_option, handle_dialog, hover | 13 | 2,280 | 2,341 (51 %) |

Also offered, but used by no prompt: `browser_run_code_unsafe`, `browser_evaluate`, the network and
console tools, and `browser_drop`. `browser_close` always fails in BIF's shared mode ("The browser context
is shared between clients and cannot be closed"). Two of the three research runs tried it.

### Codex's own input, rendered without a model call

From `codex debug prompt-input`, est. tokens:

| part | (a) persona list | (b) worker list | (c) worker + browser |
| --- | ---: | ---: | ---: |
| Codex base instructions | 5,527 | 5,527 | 5,527 |
| built-in tools: exec, wait, request_user_input | 4,080 | 4,080 | 4,080 |
| skills list | 3,038 | 3,038 | 3,042 |
| sub-agent tools and instructions | 2,205 | 2,205 | 2,205 |
| environment, clock | 364 | 364 | 364 |
| BIF system + task prompt | 105 | 105 | 105 |
| **total** | **15.3k** | **15.3k** | **15.3k** |

No MCP tool appears in the rendered input. The real runs (a) and (b) measured **14.9k** tokens each, within
5 tokens of each other, so Codex defers MCP tools entirely. Its feature list shows
`tool_search_always_defer_mcp_tools` on.

The skills list (about 3k tokens) comes from the skill folder in the user's own home directory. BIF's
isolated `CODEX_HOME` does not cover it. That costs tokens, and it carries the user's own skills into BIF
runs.

### Typical work prompts on the seeded tree

| prompt | est. tokens |
| --- | ---: |
| worker work prompt (news_scan, subject card in the briefing) | 560 |
| synthesizer work prompt (100 facts in the tree; briefing budget 4,000) | 3,228 |
| orchestrator prompt (deep_dives, round 1) | 1,996 |
| interviewer prompt (new workspace) | 703 |
| escalation prompt | 294 |
| reviewer prompt (2 findings) | 283 |

Knowledge budgets are the defaults: search 1,200, card 800, expand 2,000, briefing 1,500; reviewer expand
3,000; synthesizer briefing 4,000. In the real runs, BIF's prompts were **2–3 %** of a run's input.

## Part B: real runs

### Fixed overhead of each CLI: first call's context, one-line prompt

| run | context | difference | estimate from part A |
| --- | ---: | ---: | ---: |
| Claude (a): persona list, 4 tools | 38,530 | – | – |
| Claude (b): worker list, 28 tools | 38,838 | +308 (13 per tool) | +9.5k if in full |
| Claude (c): worker + browser lists, 53 tools | 39,198 | +360 (14 per tool) | +4.6k if in full |
| Claude (d): as (a), built-in tools off | 8,812 | **−29.7k** | – |
| Claude (e): as (b), built-in tools off, so schemas sent in full | 24,511 | **+15.7k** against (d) | +9.5k (chars ÷ 4) |
| Codex (a): persona list | 14,948 | – | 15.3k rendered |
| Codex (b): worker list | 14,953 | +5 | – |

Without built-in tools there is no ToolSearch, so Claude Code sends MCP schemas in full. Switching built-ins
off entirely therefore trades 29.7k for the full role list: 15.7k more for the worker than for the persona.
An allowlist that keeps ToolSearch would keep the deferral. That was not measured, because BIF's code has no
such option.

### Where the tokens of a run go

Claude `haiku`, measured totals; shares are attributed as described under Method.

| run | total input | model calls | first call | peak context | CLI own | tool lists | BIF prompts | browser results | BIF tool results | schemas loaded (ToolSearch) | built-in tool results | model's own messages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| browser worker: encyclopaedia | 548k | 11 | 41.1k | 54.8k | 78 % | 1 % | 3 % | 1 % | 0 % | 7 % | 3 % | 7 % |
| browser worker: documentation | 399k | 7 | 41.1k | **68.1k** | 68 % | 1 % | 2 % | 13 % | 0 % | 5 % | 0 % | 10 % |
| browser worker: project page | 348k | 7 | 41.0k | 55.6k | 78 % | 1 % | 3 % | 5 % | 0 % | 6 % | 0 % | 6 % |
| non-browser worker (local page copy) | 229k | 5 | 40.6k | 48.3k | 85 % | 1 % | 3 % | – | 1 % | 6 % | 0 % | 4 % |
| reviewer | 172k | 4 | 40.5k | 44.6k | 90 % | 1 % | 3 % | – | 0 % | 4 % | – | 2 % |
| interviewer (first message) | 124k | 3 | 40.0k | 42.6k | 94 % | 0 % | 2 % | – | 0 % | 1 % | – | 2 % |

Notes:
- Most input was cache reads: 85–94 % of each run's total.
- Haiku cost $0.006–0.014 per run.
- In the encyclopaedia run, the snapshot came back as an error ("exceeds maximum allowed tokens"). The agent
  then read the saved file with Read (1.8k tokens) and Bash (1.0k): those are the built-in tool results.
- BIF's own tool results are small: `search` 0.5k, everything else under 0.1k.
- The ToolSearch loads (the schemas of the 4–6 tools a run selected) were 1–7 % of a run's input.

### Browser results

Tokens per result are chars ÷ 4. Screenshots were not taken in these runs.

| tool | calls | median | max | total | carried into later calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| browser_snapshot | 3 | 3,898 | 12,355 (74k refused by the CLI) | 16.6k | 68.2k |
| browser_tabs (new tab with URL, list, close) | 6 | 171 | 213 | 0.6k | 3.5k |
| browser_close (always an error) | 2 | 21 | 21 | 0.04k | 0.1k |

In Playwright MCP 0.0.85, the result of an action such as `browser_tabs` "new" no longer inlines the page.
It links a snapshot file instead. So a "no snapshot in action results" rule (`--snapshot-mode none`) saves
nothing today.

**Offline rules on the captured results.** These are group (b) savings. The last two columns check what was
lost: whether each quote the agents saved in `save_finding` is still in the shortened browser results.
4 of the 6 quotes were found in the captured browser results. The other 2 came from the encyclopaedia
snapshot file, read with Read and Bash.

| rule | browser result tokens saved | saved per research run, carried | quotes still inside |
| --- | ---: | ---: | ---: |
| as captured | – | – | 4 of 4 |
| cap at 1,000 tokens + "ask for more" note | 82 % | 18.9k | **0 of 4** |
| cap at 2,000 tokens | 71 % | 16.3k | **1 of 4** |
| cap at 4,000 tokens | 48 % | 11.1k | **3 of 4** |
| main content only (the snapshot's `main` landmark; else drop banner, navigation, footer, complementary) | 26 % | 5.9k | 4 of 4 |
| main content only, then cap at 2,000 | 71 % | 16.3k | 2 of 4 |

A run's input averaged 432k tokens, so even the deepest cut saves about 4 % of it. A cap cuts the article
text the agent quotes. "Main content only" kept every quote here, but only 4 quotes on 2 pages were checked.

**What it could cost.** An agent could miss facts outside the main landmark, such as figures in sidebars or
infoboxes. A capped agent may make extra "ask for more" calls, or save fewer or weaker findings.

**How to measure before deciding.** Run the same task set (for example 10 pages × 3 runs) with and without
the rule, and compare:
- the share of findings whose quotes verify against the saved copy;
- the review score;
- the number of findings and of browser calls;
- the total tokens.

## What a small-context model could run today

These are the measured fixed costs and peaks. Fitting into a context window says nothing about result
quality, which was not measured.

| setup | first call | fits 32k | fits 64k |
| --- | ---: | --- | --- |
| Claude Code, as BIF runs it today | 38.5–41.1k, every role | no role | non-browser roles (peaks 42.6k–48.3k measured); browser workers: 2 of 3 (peaks 54.8k, 55.6k; the documentation run peaked at 68.1k) |
| Claude Code, built-in tools off (measured for persona and worker lists) | 8.8k persona list; 24.5k worker list | reviewer, escalation, persona, retro (est. about 10–12k + their work); worker about 26k + work, tight; browser worker about 33k, no | all roles at the measured sizes, if results stay at today's sizes |
| Codex | 14.9k, MCP deferred | about 17k left for prompts, schema loads and results; peak context not measurable (Codex reports per turn only) | likely all measured roles; not measured |

**Fixed costs BIF controls, per call:**
- Claude Code built-in tools offered: 29.7k;
- schemas when sent in full: worker 17.8k, browser 7.6k;
- BIF's prompts: 1–2.5k;
- Codex: the user's skills list, about 3k.

**Fixed costs the CLI imposes:**
- Claude Code's own instructions: about 6.6k (run d without its 4 tools' schemas, est.);
- Codex's base instructions and its own tools: about 12k.

## The five largest items BIF controls

1. **Claude Code built-in tools offered to every non-offline run: 29.7k tokens per call, measured.** No
   BIF role needs the scheduling, notification, artifact, worktree, notebook, design and workflow tools.
   - Group (a) for those.
   - Group (b) for Read, Bash, WebFetch and WebSearch: the encyclopaedia run needed Read and Bash to get at
     the oversized snapshot.
   - ToolSearch must stay, or the deferral is lost.
   - The per-tool split of the 29.7k was not measured. One allowlist run per role would measure it.
2. **The worker's 28 tools: 17.8k tokens when sent in full, measured** (13 per tool as names today). Per
   task type, 39–62 % of the list is unneeded (table above).
   - Group (a) where code already refuses the tool.
   - Group (a) for the prompt-derived rows once logged tool calls confirm the type never uses the tool.
3. **Browser snapshots: up to 74k tokens for one page** (12.4k for a documentation page). Group (b); see the
   browser results section.
4. **Duplicated field schemas inside three BIF tools.** `submit_combined_profile` (7.2k chars),
   `save_stakeholder` (4.9k) and `save_persona` (4.4k) each repeat the same per-field schema 11–13 times.
   The repetition comes from zod inlining the shared field object instead of using `$defs`.
   - Together the three are 16.5k chars, about 6.8k tokens at the measured rate, and most of that is the
     repetition. The saving after deduplication was not computed.
   - Group (a): same instructions, once. Check first, with one call per CLI, that every CLI accepts `$ref`
     in tool schemas.
   - Smaller of the same kind: property descriptions repeated across tools (`max_tokens`, `cursor`, scope;
     about 5k chars), and the paging paragraph repeated in 6 read-tool descriptions (345 chars each).
5. **The full browser tool list: 7.6k tokens in full (14 per tool today).**
   - `browser_close` always fails in shared mode: group (a), remove it.
   - Tools no prompt uses (`run_code_unsafe`, `evaluate`, network, console, `drop`): group (a) by the same
     reasoning as item 2.
   - The reading set is 1.3k est. tokens against 4.6k.

**Also found:**
- Claude Code writes every run's transcript, and any tool result too large to return inline, under the
  user's own Claude folder, outside BIF's data folder. That includes the full text of oversized page
  snapshots. The files this measurement created there were deleted.
- Codex reads the user's own skill list despite BIF's isolated `CODEX_HOME`.

Both matter for BIF's privacy promise as much as for tokens.

## Measured, estimated, not measured

**Measured.** Each from the CLIs' usage reports and raw output:
- the fixed overhead of both CLIs;
- the cost of tool lists as each CLI sends them today (names only, or none);
- the cost of full BIF schemas (0.413 tokens per character);
- the cost of Claude Code's built-in tools;
- every run's totals, per-call context and peak;
- every tool call's argument and result size;
- which quotes survive each offline rule.

**Estimated:**
- all part A token counts (chars ÷ 4);
- the split of each run's first call into CLI, tool lists and prompts;
- the per-result attribution: result sizes at chars ÷ 4, ToolSearch loads at the measured schema rate,
  thinking in the remainder;
- the browser schema cost in full (at the BIF schema rate);
- the small-context fits marked "est.";
- the tool needs per task type: from prompts and code, not from logged usage;
- the persona system prompt, from a synthetic agent.md.

**Not measured:**
- result quality of any saving;
- OpenCode;
- Codex per-call context and peak, and whether and how Codex loads deferred MCP schemas (no Codex run
  called a tool);
- the per-tool split of Claude Code's built-in tools;
- a Claude allowlist that keeps ToolSearch;
- screenshot results;
- flow walkthroughs;
- orchestrator, synthesizer, persona, escalation and retro runs (their sizes are from part A only).

The samples are small: 3 research runs, 1 run of each other kind, and 6 quotes in total. The numbers show
proportions, not stable averages.

## After: leaner runs and two isolation fixes (2026-11-16)

Re-measured the same day with the same script, CLIs and pages, after five changes (the council's fixes
changed items 1, 3 and 5 afterwards; the final state is in
[the last subsection](#final-state-after-the-councils-fixes)):

1. Claude Code runs that are not offline got `--tools` with 11 of the 29 built-in tools (an allowlist).
   Final state: the 19 unusable ones are denied by name instead (`--disallowedTools`, `CLAUDE_REMOVED_TOOLS`
   in `src/core/harness/adapters/claude.ts`), and the skill tool is one of them. ToolSearch is kept.
2. In shared-browser mode `browser_close` is not offered, and the prompt says to close your own tab with
   `browser_tabs` (action `close`).
3. The three profile tools write their per-field schema once (`$defs.profile_field`). Final state: only for
   Claude Code and Codex runs, the CLIs it was checked with; OpenCode runs get the inline schema.
4. Codex runs get `-c skills.include_instructions=false`.
5. Claude Code runs get `--no-session-persistence` and Codex runs `--ephemeral`. Final state: Claude Code
   runs also get `--session-id`, and BIF removes what a run leaves outside the data folder when it ends.

The script now also records what each run delivered: its artifacts, its findings with their stored
(verified) quotes, and every failed tool call with its error. The "before" numbers below are a fresh
baseline taken just before the changes. They match the tables above within run-to-run noise.

### Results did not change

| run | status before / after | page copy before / after | findings before / after | quotes verified before / after | failed tool calls before / after |
| --- | --- | --- | --- | --- | --- |
| research: encyclopaedia | done / done | 1 / 1 | 2 / 2 | 2 of 2 / 2 of 2 | 0 / 0 |
| research: documentation | done / done | 1 / 1 | 2 / 2 | 2 of 2 / 3 of 3 | 3 (`save_finding` with placeholder ids) / 0 |
| research: project page | done / done | 1 / 1 | 2 / 2 | 2 of 2 / 2 of 2 | 1 (`save_finding` with a placeholder id) / 0 |
| worker without browser | done / done | 1 / 1 | 2 / 2 | 2 of 2 / 2 of 2 | 0 / 0 |
| reviewer | done / done | – | – | – | 0 / 0 |
| interviewer | done / done | – | – | – | 0 / 0 |
| overhead (a)–(e), Codex (a)–(b) | done / done | – | – | – | 0 / 0 |

- No agent called a tool that is no longer offered. No call was refused as unknown.
- No agent tried `browser_close`. Each research agent closed its own tab with `browser_tabs`, and after
  that only the browser's first blank tab was left.
- The reviewer ran the same steps both times (`read_artifact`, two `expand`, `submit_review`).
- Agents chose their own steps both times:
  - Encyclopaedia: before, the agent took a snapshot that was too large to return inline, then read the
    page with `browser_evaluate`. After, it used `browser_evaluate` directly.
  - Documentation: `browser_evaluate` before; a 49k-character `browser_snapshot` after, which raised its
    peak context to 50.9k.
  - Project page: a snapshot both times.

### Tokens per run type

Total input is the sum of the context of every model call, as the CLI reports it.

| run | first call before | first call after | total input before | total input after | change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude (a): persona list | 38.5k | 21.2k | 38.5k | 21.2k | −45 % |
| Claude (b): worker list | 38.8k | 21.5k | 38.8k | 21.5k | −45 % |
| Claude (c): worker + browser lists | 39.2k | 21.9k | 39.2k | 21.9k | −44 % |
| Claude (d): offline, persona list | 8.8k | 8.8k | 8.8k | 8.8k | 0 |
| Claude (e): offline, worker list (schemas in full) | 24.5k | 22.2k | 24.5k | 22.2k | −9 % |
| Codex (a): persona list | 14.9k | 14.1k | 14.9k | 14.1k | −5 % |
| Codex (b): worker list | 14.9k | 14.1k | 14.9k | 14.1k | −5 % |
| research: encyclopaedia (Claude) | 41.1k | 23.8k | 477k | 266k | −44 % |
| research: documentation (Claude) | 41.1k | 23.8k | 439k | 329k | −25 % |
| research: project page (Claude) | 41.0k | 23.8k | 346k | 261k | −25 % |
| worker without browser (Claude) | 40.6k | 23.2k | 228k | 147k | −36 % |
| reviewer (Claude) | 40.5k | 23.2k | 175k | 107k | −39 % |
| interviewer, first message (Claude) | 40.0k | 22.7k | 125k | 71k | −43 % |

What each change saved:

- **Built-in tools (item 1): 17.3k tokens per Claude call.** The 11 built-ins that stayed cost 12.4k, measured
  as run (a) against run (d); about 7.8k of that was the skill tool with its list of the person's own skills
  (see the final state). MCP tools are still deferred: 12 tokens per BIF tool and 14 per browser tool,
  as before.
- **`browser_close` (item 2):** browser runs are offered 24 browser tools instead of 25. That is about 14
  tokens per call. The point of this change is the failed call that no longer happens.
- **Profile field schema (item 3).** The three tools shrink in `tools/list`:
  - `save_persona`: 4,412 → 1,819 characters;
  - `save_stakeholder`: 4,908 → 2,757 characters;
  - `submit_combined_profile`: 7,162 → 1,961 characters.

  The worker list goes from 43.2k to 38.4k characters, the retro list from 11.8k to 6.6k. Where schemas are
  sent in full this saves 2.3k tokens per call (run e). With deferral it saves the same characters each
  time ToolSearch loads one of these tools. Both CLIs called `save_persona` with the shared schema
  correctly on the first try: one real run each, all 13 fields filled.
- **Codex skills list (item 4): 0.8k tokens per Codex call** (14.9k → 14.1k measured; 0.9k in
  `codex debug prompt-input`). Part A's earlier 3.0k estimate counted the whole developer message that
  starts with the skills list. The rest of that message (2.2k) is still sent, now labelled "other".
- **Session files (item 5)** change no tokens. After the change, no run left a transcript or a
  tool-result file in the Claude folder. Codex's private home had no `sessions/` folder. Runs that ended
  normally still left empty folders, and a killed run would have left its oversized results: see the final
  state.

The samples are as small as before: one run of each kind, 3 research runs.

### Final state after the council's fixes

Measured on 2026-11-16, same CLIs, after three changes made on the council's findings:

- Built-in tools are denied by name instead of allowed by name. A tool a later release renames or adds is
  then offered, never lost; BIF reports it once per server start (server log, setup check).
- The skill tool is denied too (the owner's ruling: no use in a headless run, and it brought the person's
  own skills into a BIF run).
- BIF removes what a Claude run leaves outside the data folder when the run ends, however it ends
  (inventory in [data-storage.md](data-storage.md#what-the-agent-clis-keep-outside-the-data-folder)).

Runs: the fixed-overhead runs (a)–(e) and Codex (a), one browser research run (encyclopaedia) and its reviewer.
Claude Code 2.1.325 on `haiku`, Codex 0.169.0 on `gpt-6.1-sol`.

| run | first call, allowlist (earlier "after") | first call, deny list | total input, allowlist | total input, deny list |
| --- | ---: | ---: | ---: | ---: |
| Claude (a): persona list | 21.2k | 12.3k | 21.2k | 12.3k |
| Claude (b): worker list | 21.5k | 12.6k | 21.5k | 12.6k |
| Claude (c): worker + browser lists | 21.9k | 12.9k | 21.9k | 12.9k |
| Claude (d): offline, persona list | 8.8k | 8.4k | 8.8k | 8.4k |
| Claude (e): offline, worker list (schemas in full) | 22.2k | 21.9k | 22.2k | 21.9k |
| Codex (a): persona list | 14.1k | 14.1k | 14.1k | 14.1k |
| research: encyclopaedia (Claude) | 23.8k | 14.8k | 266k | 236k |
| reviewer (Claude) | 23.2k | 14.2k | 107k | 68k |

- **The switch to a deny list itself changes nothing.** Every non-offline run's init event lists the same
  10 built-ins as the allowlist did, less the skill tool: Task, Bash, Edit, Monitor, Read, TaskStop,
  ToolSearch, WebFetch, WebSearch, Write. The denied ones are absent.
- **The 9k drop is the skill tool.** One extra run with the deny list but the skill tool offered (no BIF tools,
  a one-line prompt) started at 20.0k tokens: its listing of the person's own skills cost about 7.8k
  tokens per call on this machine. That figure depends on how many skills a person has installed.
- **MCP tools are still deferred:** (b) − (a) = 301 tokens for 24 more BIF tools (13 per tool), (c) − (b) =
  348 for 24 browser tools (14 per tool). With no built-in tools, so no ToolSearch, the schemas are sent
  in full (e).
- **Results are the same.** The research run ended `done` with its page copy, two findings and both quotes
  verified, and no failed tool call, as in the earlier "after" run. It read the page with `browser_evaluate`
  and closed its own tab with `browser_tabs`. No run called a tool that is no longer offered. The reviewer
  ended `done` with `read_artifact` and `submit_review` (it called `expand` twice in the earlier run).
- **Nothing was left behind.** After each of these Claude runs, nothing of the run was in the Claude folder
  or Claude Code's temp root (the script now checks this).

#### Smoke modes after the changes

| mode | result |
| --- | --- |
| `worker claude` | PASS: `done`, `log_decision` and `submit_result` through the real MCP endpoint |
| `worker codex` | PASS: the same; the Codex isolation check (only the `bif` server loaded) passed too |
| `browser claude` | PASS: shared Playwright browser; opened its tab, navigated, screenshot saved as a PNG artifact, closed its tab with `browser_tabs` |
| `knowledge claude` | PASS: all 7 steps (save, search, expand, verified quote, duplicate handshake, paged read, failed quote and recovery) |

The kill probe (one Claude run through BIF's supervisor that wrote and edited a file, got a shell result too
large to return inline and was then ended by the idle timeout during `sleep 120`): the run ended `failed`
("idle timeout"), and nothing of it remained in the Claude folder, the temp root or the session list.

#### The 29 built-in tools of Claude Code 2.1.325

| tool | what it does | BIF runs | why |
| --- | --- | --- | --- |
| Bash | runs shell commands | offered | reading files too large to return inline, local work |
| Read | reads a file | offered | a run needed it to reach an oversized page snapshot |
| Write | writes a file | offered | notes and files in the run's folder |
| Edit | edits a file in place | offered | as Write |
| WebFetch | fetches a web page | offered | research |
| WebSearch | searches the web | offered | research |
| ToolSearch | loads the schema of a deferred tool | offered | without it every MCP schema is sent in full |
| Task | starts a sub-agent | offered | may help a run split its work |
| Monitor | watches a background command's output | offered | may help with long commands |
| TaskStop | stops a background command or sub-agent | offered | goes with Monitor and Task |
| CronCreate | schedules a prompt to run later | removed | a run ends when it is done |
| CronDelete | deletes a scheduled prompt | removed | as CronCreate |
| CronList | lists scheduled prompts | removed | as CronCreate |
| ScheduleWakeup | wakes the session later | removed | as CronCreate |
| PushNotification | sends a notification to the person | removed | runs ask through BIF's request tools |
| RemoteTrigger | starts a remote agent run | removed | a run has no remote agents |
| ListAgents | lists other agent sessions | removed | a run has no teammates |
| SendMessage | sends a message to another session | removed | as ListAgents |
| Artifact | publishes a page on claude.ai | removed | evidence goes to `save_artifact` |
| ArtifactComments | reads and answers comments on a published page | removed | as Artifact |
| ArtifactData | reads and writes a published page's data | removed | as Artifact |
| DesignSync | syncs a design with claude.ai | removed | as Artifact |
| EnterWorktree | moves the session into a git worktree | removed | code work |
| ExitWorktree | leaves the worktree | removed | code work |
| NotebookEdit | edits a Jupyter notebook | removed | code work |
| LSP | code navigation through a language server | removed | code work |
| ReportFindings | reports code-review findings to the CLI's host | removed | BIF findings go to `save_finding` |
| Workflow | runs a scripted multi-agent workflow | removed | a person opts into those |
| Skill | loads one of the person's skills | removed | the owner's ruling (above) |

#### Codex and OpenCode built-in tools: checked, not changed

- **Codex 0.169.0** (`codex debug prompt-input`, no model call): `exec` (shell), `wait`, `sleep`, `clock`,
  `request_user_input` and `request_user_input_async`, and the sub-agent tools (`spawn_agent`,
  `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, `wait_agent`). The sub-agent tools are
  the counterpart of Claude's Task, which BIF keeps. Only `request_user_input` asks the person through the
  CLI; Codex has no documented setting to withhold one built-in tool (`codex features list` shows feature
  switches, not tools), so nothing was changed.
- **OpenCode 1.2.27** (tool definitions in its code; not run): `bash`, `read`, `write`, `edit`,
  `apply_patch`, `glob`, `grep`, `codesearch`, `lsp`, `webfetch`, `websearch`, `task`, `todoread`,
  `todowrite`, `batch`, `question`, `plan_exit`, `skill` (and `invalid`, its error placeholder). Candidates
  like those removed for Claude: `lsp`, `question` (asks the person through the CLI), `plan_exit` and `skill`.
  OpenCode has never run end to end in BIF, so a change could not be checked and none was made; its
  `permission` setting could deny them (as BIF does for offline runs).

#### OpenCode: what of the person's own setup reaches a run (from its code, 1.2.27)

BIF starts OpenCode with `XDG_CONFIG_HOME` pointing at BIF's own folder and `OPENCODE_DISABLE_PROJECT_CONFIG=1`.

| input | reaches a BIF run? |
| --- | --- |
| global config, MCP servers, plugins (`{plugin,plugins}/*.{ts,js}` in the config folder), global `AGENTS.md` | no: the config folder is BIF's |
| project config and project instruction files (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` found walking up) | no: project config is off |
| the person's global `~/.claude/CLAUDE.md` | yes, unless `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` is set (it is not) |
| skills in `~/.claude/skills` and `~/.agents/skills`, and in `.claude` or `.agents` folders between the run folder and the repository root | yes, unless `OPENCODE_DISABLE_EXTERNAL_SKILLS` is set (it is not) |
| hooks, memories | OpenCode has none apart from plugins |
| login, sessions | its data folder (`~/.local/share/opencode`) |

Switching the two off is a question for the owner: it is not checked with a live OpenCode run.

#### Not checked on Windows

Windows could not be run. Not checked there: where Claude Code keeps its temp files (BIF removes nothing
from a temp root on Windows, where Claude Code's folder is not named after a user id), whether its project
folder is named after the same path BIF uses (BIF tries the real path and the path as given), the kill
probe, the deny list and the init-event check, and the Codex inventory. The paths are built with
`node:path` and `os.homedir()`, and `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TMPDIR` are honoured.
