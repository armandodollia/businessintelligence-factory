# Business Intelligence Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that interviews a business leader, runs an orchestrated team of CLI agents (Claude Code / Codex / OpenCode) with adversarial review to research the market, competitors and the user's own company with stored evidence, builds persona agents, and produces scored, ratable recommendations with a full decision log.

**Architecture:** One Node/TypeScript package. `src/core` is the engine (no HTTP, no UI). `src/api` exposes it over local HTTP+JSON+SSE and also hosts the harness MCP server (streamable HTTP, one URL per agent run carrying a run token that fixes role and tool scope). `web/src/logic` holds all UI behavior; `web/src/views` holds React markup+CSS only. Agents are headless CLI subprocesses driven by adapters; tests use a `FakeAdapter` that calls tool handlers directly.

**Tech Stack:** Node 25, TypeScript (ESM, `tsx` for running), `node:sqlite`, `zod`, `@modelcontextprotocol/sdk`, `hono` + `@hono/node-server`, `vitest`, Vite + React 18 for `web/`.

**Spec:** `docs/superpowers/specs/2026-11-12-business-intelligence-factory-design.md` — executors read it alongside this plan.

## Global Constraints

- Node ≥ 25, ESM only, TypeScript `strict: true`. No native-compiled deps (use `node:sqlite`).
- Data root: `data/<workspaceId>/` containing `artifacts/`, `runs/<runId>/events.jsonl`, `personas/<slug>.md`; one SQLite DB at `data/bif.db` with `workspace_id` on every domain row.
- `src/core` must not import from `src/api` or `web`. `web/src/views` must not call `fetch` or hold business state — only `web/src/logic` does.
- Review loop defaults: `maxRounds = 3`, `passThreshold = 8` (0–10 scale), overridable globally and per task type.
- Issue classes exactly: `blocking | substantive | nit | scope_expansion`.
- Every finding references ≥ 1 existing artifact in the same workspace; `save_finding` rejects otherwise.
- Action policy (spec §6.6): allowed = browse, signup with disposable identity, accept signup ToS, card-free trials, checkout up to payment; approval-required = enter payment (user enters it), request demo, contact sales/support/any human; never = complete purchase.
- No usage/cost caps. Rate-limit errors → exponential back-off retry (base 30 s, max 15 min, max 6 attempts).
- Persona feedback is labeled `simulated` everywhere and has priority weight `0` by default.
- Research browser = dedicated persistent profile, never the user's default Chrome profile.
- Agents never receive or store payment card data.

## Review Focus

1. **A CLI subprocess hangs or dies mid-task** → run marked `failed` with exit info, task retried once, orchestrator informed; server never blocks forever. Test in Task 7 (`supervisor kills run after idleTimeoutMs and marks failed`).
2. **Server restarts while a task waits for user approval/registration** → pending request still visible after restart and the task resumes when answered. Test in Task 9 (`pending user action survives store reopen`).
3. **Agent calls a tool outside its role or with a stale/unknown run token** → rejected with an error result, logged, no side effect. Test in Task 6 (`rejects tool not in role scope`, `rejects unknown token`).
4. **Reviewer returns malformed output (no `submit_review` call, score out of range)** → round counts as failed with a synthetic `blocking` issue, loop continues; never treated as a pass. Test in Task 8.
5. **Same artifact saved twice / huge page snapshot** → deduped by sha256; files > 50 MB rejected with clear error. Test in Task 3.

---

## Section A — Foundation

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`node_modules`, `data/`, `dist/`), `src/core/config/schema.ts`, `src/core/config/load.ts`, `bif.config.example.json`
- Test: `test/core/config.test.ts`

**Interfaces:**
- Produces:
  - `type ProviderId = 'claude' | 'codex' | 'opencode'`
  - `type Role = 'orchestrator' | 'worker' | 'reviewer' | 'interviewer' | 'persona' | 'synthesizer'`
  - `type TaskType = 'audience_segments' | 'persona_profile' | 'discover_competitors' | 'flow_walkthrough' | 'news_scan' | 'public_filings' | 'customer_pain_points' | 'own_company_audit' | 'symptom_hypotheses' | 'synthesize_recommendations' | 'persona_panel'`
  - `type ModelRef = { provider: ProviderId; model: string }`
  - `BifConfig` (zod-inferred) with keys: `providers: Record<ProviderId,{ enabled: boolean; command: string; models: string[] }>`, `roles: { orchestrator, interviewer, reviewer, synthesizer, persona: ModelRef; workers: Partial<Record<TaskType, ModelRef>> & { default: ModelRef } }`, `loop: { maxRounds: number; passThreshold: number; perTaskType: Partial<Record<TaskType,{maxRounds?:number;passThreshold?:number}>> }`, `limits: { maxParallelWorkers: number /*3*/; maxBrowserRuns: number /*2*/; maxTasksPerRun: number /*30*/; idleTimeoutMs: number /*600000*/ }`, `browser: { backend: 'mcp' | 't3'; mcpServers: Record<string, unknown> /*passed verbatim to CLIs*/ ; profileDir: string }`, `identity: { emailProvider: 'catchall' | 'mailtm'; catchallDomain?: string }`, `actionPolicy: { allowed: string[]; approvalRequired: string[]; never: string[] }`, `scoring: { personaWeight: number /*0*/; weights: Record<string, number> }`, `server: { port: number /*4317*/ }`, `dataDir: string /*'data'*/`
  - `loadConfig(path?: string): BifConfig` — reads JSON, deep-merges over `defaultConfig`, validates with zod, throws `ConfigError` listing paths.
  - `reviewerFor(worker: ModelRef, cfg: BifConfig): ModelRef` — returns `cfg.roles.reviewer` unless same provider as worker and another enabled provider exists, then the first model of that other provider.

- [ ] **Step 1:** `npm init`, add deps listed in Tech Stack, scripts: `test: vitest run`, `dev: tsx watch src/api/main.ts`, `typecheck: tsc --noEmit`, `web: vite web`.
- [ ] **Step 2: Failing tests** in `test/core/config.test.ts`: `defaults load with no file` (expect `loop.maxRounds===3`, `loop.passThreshold===8`, `scoring.personaWeight===0`); `invalid passThreshold 11 throws ConfigError mentioning loop.passThreshold`; `reviewerFor picks other provider when worker is claude and codex enabled`.
- [ ] **Step 3:** Run `npx vitest run test/core/config.test.ts` → FAIL.
- [ ] **Step 4:** Implement schema/load/reviewerFor.
- [ ] **Step 5:** Tests pass; `npm run typecheck` clean. Commit `feat: scaffold and config`.

### Task 2: Store (SQLite schema + repositories)

**Files:**
- Create: `src/core/store/db.ts`, `src/core/store/migrations.ts`, `src/core/store/repos.ts`, `src/core/types.ts`
- Test: `test/core/store.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`, all ids are `string` ULID-like via `newId(prefix)`):
  - `Workspace { id; name; sector; createdAt }`
  - `Artifact { id; workspaceId; kind: 'screenshot'|'page_snapshot'|'document'|'text'|'upload'; path; sha256; mime; sourceUrl?; title?; flow?: string; step?: number; note?: string; capturedAt }`
  - `Finding { id; workspaceId; runId; taskId; subject; claim; criteria: Record<string, number|string>; evidence: string[]; status: 'verified'|'unverified'|'pending'; createdAt }`
  - `Task { id; workspaceId; runId; phase: Phase; type: TaskType; brief; subject?; model: ModelRef; needsBrowser: boolean; acceptanceCriteria: string[]; status: 'queued'|'running'|'reviewing'|'waiting_user'|'verified'|'unverified'|'failed'; round: number; result?: unknown; createdAt }`
  - `type Phase = 'market_research'|'competitor_discovery'|'deep_dives'|'synthesis'|'persona_panel'|'scoring'`
  - `ResearchRun { id; workspaceId; phase: Phase; status: 'running'|'done'|'failed'; startedAt; endedAt? }`
  - `AgentRun { id; workspaceId; taskId?; role: Role; model: ModelRef; token; status: 'running'|'done'|'failed'; exitCode?; startedAt; endedAt? }`
  - `Decision { id; workspaceId; agentRunId; role; model: ModelRef; kind: 'decision'|'review'|'pushback'|'task_proposal'|'persona_feedback'|'score'; payload: unknown; refs: string[]; promptVersion: string; createdAt }`
  - `Rating { id; workspaceId; targetType: 'finding'|'recommendation'|'symptom'|'competitor'|'persona'|'persona_feedback'|'decision'; targetId; criterion: string; agentValue: number|string|null; verdict: 'agree'|'disagree'; userValue?: number|string; reason?: string; createdAt }`
  - `UserRequest { id; workspaceId; agentRunId; taskId; kind: 'register'|'login'|'captcha'|'approval'|'other'; site?; details: string; status: 'pending'|'resolved'|'denied'; response?: string; createdAt }`
  - `Recommendation { id; workspaceId; title; summary; criteria: Record<string, number|string>; findingIds: string[]; personaFeedback: PersonaFeedback[]; priority: number; createdAt }`
  - `PersonaFeedback { personaId; scores: { appeal: number; adoption: number; willingnessToPay: number; friction: number }; concerns: string[]; reasoning: string; wouldChangeMind: string; simulated: true }`
  - `Persona { id; workspaceId; slug; segment; profile: Record<string, { value: string; confidence: number; evidence: string[] }>; agentMdPath; version: number }`
  - `Symptom { id; workspaceId; kind: 'symptom'|'strength'; title; detail; criteria: Record<string, number|string>; evidence: string[] }`
  - `Schedule { id; workspaceId; name; cron: string; phases: Phase[]; lastRunAt?; enabled: boolean }`
  - `InterviewTurn { id; workspaceId; role: 'user'|'agent'; text; createdAt }`, `Profile { workspaceId; data: Record<string, unknown> }`
- `openStore(dbPath: string): Store` where `Store` exposes typed repos: `store.workspaces`, `.artifacts`, `.findings`, `.tasks`, `.researchRuns`, `.agentRuns`, `.decisions`, `.ratings`, `.userRequests`, `.recommendations`, `.personas`, `.symptoms`, `.schedules`, `.interview`, `.profiles`. Each repo has `insert(x)`, `get(id)`, `update(id, patch)`, `list(filter)` (filter by any top-level scalar field). JSON fields stored as TEXT.
- `newId(prefix: string): string`

- [ ] **Step 1: Failing tests:** `roundtrips a finding with JSON criteria`; `list filters by workspaceId`; `migrations idempotent on reopen`; `pending user request survives reopen` (insert, close, reopen, list status=pending → 1).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `node:sqlite` `DatabaseSync`, WAL mode, `user_version` migrations. **Step 4:** Pass. **Step 5:** Commit `feat: sqlite store`.

### Task 3: Artifact store

**Files:**
- Create: `src/core/evidence/artifacts.ts`
- Test: `test/core/artifacts.test.ts`

**Interfaces:**
- Consumes: `Store`, `Artifact`.
- Produces: `class ArtifactStore { constructor(store: Store, dataDir: string); save(input: { workspaceId: string; kind: Artifact['kind']; bytes: Uint8Array | string; mime: string; sourceUrl?; title?; flow?; step?; note? }): Artifact; saveFromPath(input: same minus bytes, plus filePath): Artifact; read(id): { artifact: Artifact; bytes: Buffer }; exists(workspaceId, ids: string[]): string[] /* returns missing ids */ }`. Files at `data/<ws>/artifacts/<sha256[0:2]>/<sha256>.<ext>`. `MAX_ARTIFACT_BYTES = 50 * 1024 * 1024`.

- [ ] **Step 1: Failing tests:** `save then read returns same bytes`; `same bytes twice returns same artifact id (dedupe per workspace)`; `rejects > 50MB with ArtifactTooLargeError`; `exists reports missing ids and ids from other workspaces as missing`.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat: artifact store`.

**Section A verify gate** (see "Verification protocol" at end).

---

## Section B — Harness

### Task 4: Adapter interface + Claude adapter

**Files:**
- Create: `src/core/harness/adapter.ts`, `src/core/harness/adapters/claude.ts`, `src/core/harness/adapters/fake.ts`
- Test: `test/core/adapters/claude.test.ts`, fixture `test/fixtures/claude-stream.jsonl`

**Interfaces:**
- Produces:
  - `type RunEvent = { t: 'message'; text: string } | { t: 'tool_call'; name: string; input: unknown } | { t: 'tool_result'; name: string; ok: boolean } | { t: 'usage'; inputTokens?: number; outputTokens?: number } | { t: 'error'; message: string; rateLimited: boolean } | { t: 'done'; exitCode: number }`
  - `type SpawnSpec = { prompt: string; systemPrompt: string; model: string; mcpUrl: string; extraMcpServers: Record<string, unknown>; cwd: string; env?: Record<string,string> }`
  - `interface CliAdapter { id: ProviderId; buildCommand(spec: SpawnSpec): { cmd: string; args: string[]; files: Array<{ path: string; content: string }> }; parseLine(line: string): RunEvent[] }`
  - `FakeAdapter` is NOT a CliAdapter; it is `type FakeScript = (tools: ToolClient) => Promise<void>` used by the supervisor's in-process mode (Task 7). `ToolClient = { call(name: string, input: unknown): Promise<unknown> }`.
- Claude: `claude -p <prompt> --output-format stream-json --verbose --model <m> --mcp-config <file> --strict-mcp-config --append-system-prompt <sys> --dangerously-skip-permissions`. MCP file: `{ mcpServers: { bif: { type: 'http', url: mcpUrl }, ...extraMcpServers } }` written to `cwd/.bif-mcp.json`. `parseLine` maps `assistant` text blocks → message, `tool_use` → tool_call, `result` → usage+done; lines containing `rate_limit`/`429`/`usage limit` → error with `rateLimited: true`.

- [ ] **Step 1: Failing tests:** `buildCommand includes --strict-mcp-config and writes mcp file with bif url`; `parseLine fixture yields message, tool_call(save_finding), done(0)`; `rate limit line → error rateLimited true`; `garbage line → []`.
- [ ] **Steps 2–5:** fail → implement (capture fixture from a real `claude -p "say hi" --output-format stream-json --verbose` run, trimmed) → pass → commit.

### Task 5: Codex + OpenCode adapters

**Files:** Create `src/core/harness/adapters/codex.ts`, `src/core/harness/adapters/opencode.ts`, `src/core/harness/adapters/index.ts` (`getAdapter(id: ProviderId): CliAdapter`). Tests `test/core/adapters/codex.test.ts`, `opencode.test.ts` with captured fixtures.

- Codex: `codex exec --json -m <m> -s danger-full-access --skip-git-repo-check -c mcp_servers.bif.url="<mcpUrl>"` plus each extra MCP server as `-c mcp_servers.<name>.<key>=<toml>`; system prompt prepended to prompt in a `<system>` block. Parse its JSONL (`item.completed` agent_message → message, `mcp_tool_call` → tool_call, `turn.completed` usage, `error`).
- OpenCode: `opencode run --format json -m <provider/model> <prompt>`; MCP via generated `opencode.json` in `cwd` (`mcp.bif = { type: 'remote', url }`). Verify actual flags with `--help` and record any deviation in a code comment.

- [ ] Tests per adapter: command shape; fixture parse → message/tool_call/done; rate-limit detection. Fail → implement → pass → commit.

### Task 6: Harness MCP server + tool handlers

**Files:**
- Create: `src/core/harness/tools/registry.ts`, `src/core/harness/tools/handlers.ts`, `src/core/harness/tokens.ts`, `src/api/mcp.ts`
- Test: `test/core/tools.test.ts`

**Interfaces:**
- Consumes: `Store`, `ArtifactStore`, `BifConfig`.
- Produces:
  - `type RunContext = { agentRunId; workspaceId; taskId?: string; role: Role; model: ModelRef; promptVersion: string }`
  - `TokenRegistry { issue(ctx: RunContext): string; resolve(token: string): RunContext | null; revoke(token) }` (tokens persisted on `AgentRun.token` so they survive restart).
  - `ROLE_TOOLS: Record<Role, ToolName[]>`: all roles get `log_decision`, `save_artifact`, `request_user_action`, `request_approval`; worker += `save_finding`, `submit_result`, `respond_to_review`, `get_identity`, `save_persona`; orchestrator += `propose_tasks`; reviewer gets only `log_decision`, `submit_review`, `read_artifact`; persona gets `log_decision`, `submit_persona_feedback`; interviewer gets `log_decision`, `update_profile`, `save_symptom`; synthesizer += `save_recommendation`, `save_finding`, `submit_result`.
  - `createToolHandlers(deps: { store; artifacts; config; events: EventBus }): (ctx: RunContext, name: ToolName, input: unknown) => Promise<ToolResult>` — zod-validated per tool; every successful call that is a judgment (`log_decision`, `submit_review`, `respond_to_review`, `propose_tasks`, `submit_persona_feedback`, `save_finding` criteria) also inserts a `Decision` row.
  - `request_user_action` / `request_approval` insert a `UserRequest` and **block** (await) until resolved via `resolveUserRequest(id, status, response)`; return `{ status, response }`. Implement via `EventBus` waiters keyed by request id; on restart, pending requests stay pending and the task is resumed by Task 9.
  - `EventBus { emit(e: BusEvent); on(fn): () => void; waitFor(pred, signal?): Promise<BusEvent> }` in `src/core/events.ts`; `BusEvent` is a tagged union used by SSE (Task 14).
  - `mountMcp(app: Hono, deps)`: route `POST/GET /mcp/:token` → MCP streamable HTTP server whose `tools/list` returns only the role's tools.

- [ ] **Step 1: Failing tests:** `save_finding rejects empty evidence`; `save_finding rejects artifact from other workspace`; `rejects tool not in role scope` (reviewer calling save_finding → error, no row); `rejects unknown token` at the resolve layer; `log_decision writes Decision with promptVersion`; `request_approval blocks until resolveUserRequest(approved)`; `tools/list for reviewer returns exactly its 3 tools` (via in-memory MCP client).
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat: harness tools and mcp`.

### Task 7: Run supervisor

**Files:** Create `src/core/harness/supervisor.ts`, `src/core/harness/semaphore.ts`. Test `test/core/supervisor.test.ts` (uses `test/fixtures/fake-cli.mjs`, a node script that prints scripted JSONL and optionally sleeps forever).

**Interfaces:**
- Produces: `class Supervisor { constructor(deps: { store; config; tokens; events; mcpBaseUrl: string; dataDir }); run(opts: { ctx: Omit<RunContext,'agentRunId'>; prompt: string; systemPrompt: string; needsBrowser: boolean; fake?: FakeScript }): Promise<{ agentRunId: string; exitCode: number; events: RunEvent[] }> }`.
  - Global semaphore `maxParallelWorkers` (applies to worker+reviewer+persona roles), browser semaphore `maxBrowserRuns`.
  - Appends every parsed event to `data/<ws>/runs/<agentRunId>/events.jsonl` and emits `BusEvent{type:'run_event'}`.
  - Idle timeout `limits.idleTimeoutMs` with no output → SIGTERM then SIGKILL after 5 s → status `failed`. **Waiting on a user request pauses the idle timer.**
  - Rate-limited error → retry with back-off per Global Constraints.
  - `fake` provided → run `FakeScript` in-process with a `ToolClient` bound to the handlers (no subprocess).
  - Adds browser MCP servers from `config.browser.mcpServers` only when `needsBrowser`.

- [ ] Tests: `persists events.jsonl and marks done`; `supervisor kills run after idleTimeoutMs and marks failed` (idle 200 ms); `respects maxParallelWorkers=1` (two runs serialize); `retries on rateLimited then succeeds` (back-off injected as 10 ms in test); `idle timer paused while user request pending`. Fail → implement → pass → commit.

**Section B verify gate.**

---

## Section C — Research engine

### Task 8: Review loop

**Files:** Create `src/core/research/reviewLoop.ts`, `src/core/prompts/` (`worker.md`, `reviewer.md`, `revise.md`, `index.ts` exporting `loadPrompt(name): { text; version /* sha256[0:8] */ }`). Test `test/core/reviewLoop.test.ts`.

**Interfaces:**
- Consumes: `Supervisor`, `Store`, `reviewerFor`.
- Produces: `runTaskWithReview(task: Task, deps): Promise<Task>` implementing spec §7.2 exactly:
  - worker run → must call `submit_result` (else round fails, worker retried once).
  - each round spawns a **new** reviewer run whose prompt contains only: task brief, acceptance criteria, current deliverable JSON, evidence artifact ids (+ `read_artifact` tool). Test asserts reviewer prompt does not contain worker transcript text or previous review text.
  - `score >= passThreshold` → `verified`; `round == maxRounds` → `unverified` (findings of that task set `unverified`).
  - otherwise worker revise run receives issues; must call `respond_to_review` per issue (`fix|pushback`); then `submit_result`.
  - Malformed review (no `submit_review` call or score ∉ [0,10]) → treated as score 0 with synthetic `blocking` issue `"reviewer produced no valid review"`.
  - Prompts instruct: reviewers don't fail for nits/out-of-scope; workers push back on `nit`/`scope_expansion` with reason.
- [ ] Tests (FakeScripts): `passes in round 1 at score 8`; `score 7,7,7 → unverified after 3 rounds`; `perTaskType maxRounds=1 honored`; `reviewer prompt minimal`; `malformed review counts as fail`; `pushbacks logged as Decision kind pushback`. Fail → implement → pass → commit.

### Task 9: Orchestrator phases

**Files:** Create `src/core/research/orchestrator.ts`, `src/core/research/phases.ts`, `src/core/prompts/orchestrator.md`. Test `test/core/orchestrator.test.ts`.

**Interfaces:**
- Produces:
  - `startPhase(workspaceId, phase: Phase, deps): Promise<ResearchRun>` — fresh orchestrator run with context: profile, symptoms/strengths, existing findings summary (titles + ids), personas list, phase goal from `PHASE_GOALS: Record<Phase,string>`, allowed task types `PHASE_TASK_TYPES: Record<Phase, TaskType[]>`, allowed models from config.
  - `propose_tasks` handler validation: task type allowed for phase, model enabled, count ≤ `maxTasksPerRun`; rejected items returned to the agent with reasons; accepted inserted as `queued` Tasks + `Decision(kind:'task_proposal')`.
  - After the orchestrator run ends, queued tasks execute via `runTaskWithReview` with concurrency from the supervisor. Orchestrator may be re-invoked once with results summary to propose follow-ups (max 2 orchestrator rounds per phase).
  - `runPipeline(workspaceId, phases = ALL_PHASES, deps)` — sequential; `scoring` phase calls Task 13's `scoreRecommendations` (no agent). `persona_panel` calls Task 12's `runPersonaPanel`.
  - `resumeInterrupted(deps)` — on startup: tasks in `running|reviewing` → re-queued with same round; tasks in `waiting_user` with pending request stay; research runs `running` continue.
- [ ] Tests: `rejects task type not allowed in phase`; `runs accepted tasks through review loop`; `max 2 orchestrator rounds`; `pending user action survives store reopen and task resumes when resolved`; `runPipeline runs phases in order`. Fail → implement → pass → commit.

### Task 10: Action policy, identities, browser config

**Files:** Create `src/core/policy/actionPolicy.ts`, `src/core/identity/identities.ts`, `src/core/identity/email.ts` (`interface EmailProvider { createInbox(): Promise<{address; password?}>; latest(address): Promise<{subject; body}[]> }` with `CatchallEmailProvider` and `MailTmProvider`), `src/core/harness/browser.ts` (`browserMcpServers(cfg): Record<string, unknown>`; for `t3` backend returns `{}` and sets a prompt note that the T3 browser tools must be used). Prompts: `src/core/prompts/policy.md` rendered from config and appended to every worker system prompt. Test `test/core/policy.test.ts`.

- `get_identity({site})` → returns existing identity for workspace+site or creates one: generic name from a fixed list, inbox from provider; stored in a new `identities` table (add migration) with password; credentials never logged in Decisions (redacted).
- [ ] Tests: `policy prompt lists approval-required actions verbatim`; `get_identity reuses identity per site`; `identity password redacted in decision payloads`; `mailtm provider createInbox parses API response` (mock fetch). Fail → implement → pass → commit.

### Task 10b: Scope and audiences

**Files:** Modify `src/core/types.ts`, `src/core/store/migrations.ts` (append migration), `src/core/research/phases.ts`, `src/core/research/orchestrator.ts`. Test `test/core/scope.test.ts`.

**Interfaces:**
- `Workspace` gains `scope: { level: 'company'|'division'|'slice'; name: string; description: string }`, `audiences: Array<'external'|'internal'>` (default `['external']`), `parentWorkspaceId?: string`.
- `Persona` gains `audience: 'external'|'internal'`.
- Orchestrator context includes scope + audiences + (if parent) parent profile and parent findings as read-only references; findings/artifacts of the parent may be cited as evidence by the child (`ArtifactStore.exists` treats parent artifacts as present for the child).
- `PHASE_GOALS` text is templated with scope; when audiences include `internal`, `competitor_discovery` goal = "alternatives: vendor tools, outsourcing, peer-company practices for this function" and `audience_segments` covers internal roles.
- [ ] Tests: `old rows get default scope company and audiences external`; `child workspace can cite parent artifact as evidence`; `internal audience changes competitor_discovery goal text`; `persona audience persisted`. Fail → implement → pass → commit.

**Section C verify gate.**

---

## Section D — Domain modules

### Task 11: Interview + uploads

**Files:** Create `src/core/interview/interview.ts`, `src/core/prompts/interviewer.md`, `src/core/internal/uploads.ts`. Test `test/core/interview.test.ts`.

**Interfaces:**
- `sendInterviewMessage(workspaceId, text, deps): Promise<InterviewTurn>` — stores user turn, runs interviewer agent (role `interviewer`) with profile + full transcript + coverage checklist `INTERVIEW_TOPICS = ['basics','revenue_model','customers','going_well','going_badly']`; agent replies via its final message and may call `update_profile` (merge patch) and `save_symptom` (kind symptom|strength, high-level first, criteria severity/trend/causeConfidence).
- `interviewCoverage(workspaceId): Record<topic, boolean>`.
- `uploadInternal(workspaceId, file: {name; bytes; mime}): Artifact` (kind `upload`), linked into profile `uploads[]`; included in orchestrator context as id+title only.
- [ ] Tests (fake interviewer): `stores both turns`; `save_symptom creates Symptom with criteria`; `coverage flips going_well when a strength exists`; `upload stored as artifact kind upload`. Fail → implement → pass → commit.

### Task 12: Market research, personas, persona panel

**Files:** Create `src/core/market/personas.ts`, `src/core/market/agentMd.ts`, `src/core/market/panel.ts`, prompts `persona_profile.md`, `persona_panel.md`. Test `test/core/personas.test.ts`.

**Interfaces:**
- `PERSONA_FIELDS = ['demographics','socioeconomic','personality_values','goals','needs','pain_points','jobs_to_be_done','buying_behavior','channels_media','alternatives_switching','tech_attitude','voice','segment_size_value']`.
- `save_persona` handler: requires `audience` and every field in `PERSONA_FIELDS` with `{value, confidence 0–1, evidence: artifactId[]}` (evidence ≥1 except `personality_values` and `voice` may cite the same artifacts); upserts by slug, bumps `version`, writes agent.md via `compileAgentMd(persona): string` to `data/<ws>/personas/<slug>.md`.
- `compileAgentMd` output starts with YAML frontmatter `name`, `description`, `version`, `simulated: true`, then sections per field, then fixed instructions: stay in character, be candid not agreeable, say when something is irrelevant to you.
- `runPersonaPanel(workspaceId, deps)`: for each recommendation × persona, run role `persona` with system prompt = agent.md contents; must call `submit_persona_feedback`; stored in `Recommendation.personaFeedback` with `simulated: true` and a `Decision(kind:'persona_feedback')`.
- [ ] Tests: `save_persona rejects missing field`; `agentMd has frontmatter simulated: true and all field headings`; `panel stores one feedback per persona per recommendation`; `version bumps on update and file rewritten`. Fail → implement → pass → commit.

### Task 13: Scoring, ratings, calibration, export

**Files:** Create `src/core/scoring/criteria.ts`, `src/core/scoring/priority.ts`, `src/core/scoring/ratings.ts`, `src/core/scoring/calibration.ts`, `src/core/scoring/export.ts`. Test `test/core/scoring.test.ts`.

**Interfaces:**
- `CRITERIA: Record<targetType, Array<{ key; scale: '1-5'|'pct'|'trend'|'range' }>>` per spec §9 (recommendation keys: `upside, difficulty, cost, timeToValue, risk, confidence, strategicFit, competitiveUrgency`).
- `computePriority(rec, cfg): number` = Σ w·normalized(c) / Σ w over evidence criteria (difficulty, cost, risk, timeToValue inverted) + `personaWeight`·mean(persona appeal, adoption, willingnessToPay, 6−friction normalized). Default weights 1. Range 0–5, 2 decimals.
- `scoreRecommendations(workspaceId, deps)` recomputes and stores priority.
- `rateCriterion(input: Omit<Rating,'id'|'createdAt'|'agentValue'>): Rating` — looks up the current agent value; validates criterion exists for target type.
- `calibrationReport(workspaceId): { byCriterion: Array<{ targetType; criterion; n; agreeRate; meanDelta }> }`; `proposeWeights(workspaceId): Record<string, number>` (least squares of user priority overrides vs criteria; returns current weights if n < 5).
- `proposePromptPatch(workspaceId, role: Role): { role; examples: Array<{ criterion; agentValue; userValue; reason }>; patchText: string }` — top-10 largest disagreements formatted as a few-shot "calibration examples" block; `applyPromptPatch(patch)` writes `src/core/prompts/calibration/<role>.md` (appended by `loadPrompt`, so the prompt version changes). Only applied when called from the API (user approval).
- `exportTrainingData(workspaceId, includeUploads = false): string` JSONL of decisions joined with ratings; excludes decisions whose refs include `upload` artifacts unless `includeUploads`.
- [ ] Tests: `persona weight 0 → priority unaffected by persona scores`; `difficulty inverted`; `rateCriterion stores agentValue snapshot`; `rejects unknown criterion`; `export excludes upload-linked decisions by default`; `proposeWeights returns current when n<5`. Fail → implement → pass → commit.

**Section D verify gate.**

---

## Section E — Delivery

### Task 14: API server

**Files:** Create `src/api/main.ts` (boot: load config, open store, build deps, mount MCP, `resumeInterrupted`, start scheduler), `src/api/routes.ts`, `src/api/sse.ts`. Test `test/api/routes.test.ts` (Hono `app.request`).

Routes (JSON): `GET/POST /api/workspaces` (POST accepts `scope`, `audiences`, `parentWorkspaceId`); `GET /api/workspaces/:id/profile`; `GET/POST /api/workspaces/:id/interview` (POST `{text}`); `POST /api/workspaces/:id/uploads` (multipart); `POST /api/workspaces/:id/research` `{phases?}`; `GET /api/workspaces/:id/runs`, `/tasks?runId=`, `/findings`, `/symptoms`, `/personas`, `/recommendations`, `/decisions?kind=`, `/requests?status=pending`; `POST /api/requests/:id` `{status, response?}`; `GET /api/artifacts/:id` (bytes with mime); `POST /api/ratings`; `GET /api/workspaces/:id/review-queue` (items with criteria not yet rated); `GET /api/workspaces/:id/calibration`; `GET /api/workspaces/:id/export`; `GET/POST/PATCH /api/workspaces/:id/schedules`; `GET/PUT /api/config`; `GET /api/events?workspaceId=` (SSE of `BusEvent`).

- [ ] Tests: create workspace → list contains it; `POST /api/ratings` with unknown criterion → 400; resolving a request unblocks a pending `request_approval` (fake); artifact bytes served with mime; SSE emits `run_event`. Fail → implement → pass → commit.

### Task 15: Web logic layer

**Files:** Create `web/index.html`, `web/vite.config.ts` (proxy `/api` and `/mcp` to 4317), `web/src/logic/api.ts`, `web/src/logic/sse.ts`, `web/src/logic/hooks.ts`. Test `test/web/logic.test.ts` (vitest + jsdom + `@testing-library/react` `renderHook`, mocked fetch).

Hooks (all views use only these): `useWorkspaces()`, `useWorkspace(id)`, `useInterview(wsId) → { turns, coverage, send(text), upload(file), sending }`, `useResearch(wsId) → { runs, tasks, start(phases?), liveEvents }`, `useFindings(wsId)`, `useEvidence(artifactIds)`, `usePersonas(wsId)`, `useRecommendations(wsId)`, `useRatings() → { rate(input) }`, `useReviewQueue(wsId)`, `useRequests(wsId) → { pending, resolve(id, status, response?) }`, `useDecisions(wsId, kind?)`, `useSchedules(wsId)`, `useConfig()`.
- [ ] Tests: `useInterview.send appends turn`; `useRequests.resolve posts and removes from pending`; `SSE event updates useResearch.liveEvents`. Fail → implement → pass → commit.

### Task 16: Web views (minimal)

**Files:** Create `web/src/main.tsx`, `web/src/views/App.tsx` (hash router), one file per page in spec §13: `Workspaces.tsx`, `Interview.tsx`, `Personas.tsx`, `Research.tsx`, `Findings.tsx`, `Strategy.tsx`, `ReviewQueue.tsx`, `DecisionLog.tsx`, `Schedule.tsx`, `Settings.tsx`, shared `CriterionRating.tsx` (agree / disagree→value+reason), `EvidenceList.tsx` (screenshots as ordered thumbnails per flow, archived pages/docs as links), `views/styles.css` (plain, minimal). Persona feedback rendered in a separate column labeled "Simulated".
- [ ] Verify: `npm run typecheck` clean; `npx vite build web` succeeds; grep check `! grep -rn "fetch(" web/src/views` returns nothing. Commit.

### Task 17: Scheduler + diffing

**Files:** Create `src/core/scheduler/scheduler.ts`, `src/core/scheduler/diff.ts`. Test `test/core/scheduler.test.ts`.
- `startScheduler(deps, now = Date.now): { stop() }` checks every 60 s; cron parsed with `cron-parser`; missed runs since `lastRunAt` run once at start; runs `runPipeline(workspaceId, schedule.phases)`.
- `diffRuns(prevRunId, nextRunId): { newFindings: string[]; removedSubjects: string[]; changedArtifacts: Array<{ flow; step; prev; next }> }` (screenshots compared by sha256 per flow+step; pricing changes surface as new findings).
- [ ] Tests: `missed run executes on start`; `disabled schedule never runs`; `diff detects changed screenshot for same flow step`. Fail → implement → pass → commit.

### Task 18: Real-CLI smoke + README

**Files:** Create `scripts/smoke.ts` (spawns one real worker run per enabled CLI with a trivial task: call `log_decision` then `submit_result`; prints pass/fail per provider), `README.md` (setup, config, research browser profile setup for MCP backend and T3 backend, how to run).
- [ ] Run `npx tsx scripts/smoke.ts` for claude and codex; record output in `docs/smoke-results.md`. Failures for a provider are documented, not hidden. Commit.

**Section E verify gate.**

---

## Verification protocol (each section gate)

After a section's tasks are committed, the manager runs **two independent verifiers in parallel**, each given: the spec path, this plan path, the section letter, and `git diff <section-start-sha>..HEAD`. Not given: implementer reports or prior reviews.

1. Codex `gpt-6.1-sol` (personal Codex provider, via `delegate_task`, role `review`).
2. Claude Opus 5.5 (native subagent, model `opus`).

Each returns `score 0–10` and issues classified `blocking | substantive | nit | scope_expansion`, and must run `npm test` and `npm run typecheck` itself. **The section passes only when both score ≥ 8.** Otherwise a fix subagent addresses blocking/substantive issues (pushing back on nits/scope expansions with reasons, recorded in `docs/superpowers/verify-log.md`) and fresh verifiers are run. Max 3 rounds; if still failing after round 3, record unresolved issues in the verify log and proceed (user is away; they review the log in the morning).
