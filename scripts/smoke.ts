/**
 * Real-CLI smoke test (Task 18). Spends a few cents of real model usage.
 *
 *   npx tsx scripts/smoke.ts                       # worker + interview smokes, all providers
 *   npx tsx scripts/smoke.ts worker claude codex   # worker smoke for the named providers only
 *   npx tsx scripts/smoke.ts interview             # interview smoke only (claude)
 *   npx tsx scripts/smoke.ts browser [providers]   # browser smoke (default: claude)
 *   npx tsx scripts/smoke.ts knowledge [providers] # knowledge-store flow (KS-8), per provider
 *   npx tsx scripts/smoke.ts flows [providers]     # flow records and ranking, per provider
 *   npx tsx scripts/smoke.ts persona-learning [providers] # persona learning in the retro (default: claude)
 *   npx tsx scripts/smoke.ts stakeholders [providers]     # offline own-stakeholder research (default: claude)
 *
 * worker:    boots the real server (temp data dir, temp config, free port) and, per provider,
 *            spawns one real worker run through the Supervisor. The agent must call
 *            `log_decision` and then `submit_result` through the real MCP endpoint. PASS when
 *            the run ends `done`, a log_decision Decision exists for the run and the submitted
 *            result carries the expected marker.
 * interview: boots the real server, creates a workspace over HTTP, sends one interview message
 *            (interviewer = real claude CLI, cheap model) and checks an agent turn is stored.
 * browser:   boots the real server with the default shared browser (Playwright MCP, headless
 *            unless BIF_SMOKE_HEADED=1) and runs one browser worker: open a tab, go to
 *            example.com, screenshot, `save_artifact` the file, close the tab, `submit_result`.
 *            PASS when the run is `done`, the submitted artifact id is a stored PNG of this
 *            workspace and the shared server was started once.
 * knowledge: KS-8. Per provider, a real worker run (real worker system prompt, a real task) walks the
 *            knowledge-store flow on a local static HTML page: save_artifact with a description,
 *            search, expand a passage, save_finding with a verified quote, a near-duplicate save
 *            and its duplicate handshake (against a verified fact seeded from an earlier task),
 *            a paged read_artifact with a cursor, and a quote that fails verification. Each step
 *            is judged from the store (decisions, observations, finding_evidence, retrieval_events)
 *            and from the run's tool calls; tokens and cost come from agent_usage.
 * flows:     flow records and ranking (flow design 2026-11-14 §16). Per provider, (1) a real worker run (real
 *            flow_walkthrough system prompt, a real task) records a fictional product's sign-up from three seeded
 *            screen notes, without a browser: read_flow_catalog, read_artifact, save_flow with one step per screen
 *            citing its note, save_flow_checks, submit_result; (2) the real ranking round (`runFlowRanking`, one
 *            broad sitting, no focused follow-up) with that provider as the persona, over two seeded verified
 *            sign-up flows. Judged from the store: the flow, its steps and walkthrough answers; the persona's
 *            verdict row and the resulting ranking.
 * persona-learning: persona learning (design 2026-11-15 §17). Per provider, seeds four verified sign-up flows, a
 *            verified persona, six of its verdicts on six pairs and the user's reactions to them (five disagree, with
 *            reasons), then runs the real retro (`runRetro`) with that provider as the persona learning model. Judged
 *            from the store: exactly one learning run and one successful `submit_persona_learning` call, the run row
 *            (`proposed` or `no_change`, with its assumption), the stored proposals (pending, evidence among the
 *            signals shown, the evidence and text limits) and an unchanged persona (version 1, no adjustment).
 * stakeholders: stakeholder personas (design 2026-11-15 §18). Per provider, seeds a node with three internal notes
 *            (uploads) about a fictional company, then runs one `own_stakeholders` task through the real review loop
 *            (worker and reviewer offline, no browser) and the phase-end step that creates the question round
 *            (`ensureQuestions`). Judged from the store and the runs' files: every run of the task offline with no
 *            built-in tool (the CLI's offered tools in `stdout.log` and the tool calls in `events.jsonl` are harness
 *            tools only), at least one hidden own stakeholder citing the notes, four template questions per hidden
 *            stakeholder plus the two node questions, and the task's research withheld while they are hidden.
 *            Providers are enabled as in the default config (plus those named), so the reviewer is picked as
 *            on a default install. Codex refuses offline runs, so the codex worker is expected to fail with
 *            that refusal.
 * codex isolation (with the codex worker smoke): `codex mcp list --json` under the exact env and
 *            `-c` overrides the adapter gives a run must list only `bif`.
 *
 * Model overrides: BIF_SMOKE_CLAUDE_MODEL (default haiku), BIF_SMOKE_CODEX_MODEL (default
 * gpt-6.1-sol), BIF_SMOKE_OPENCODE_MODEL (default opencode/big-pickle).
 * BIF_SMOKE_TIMEOUT_MS bounds each run (default 300000). BIF_SMOKE_KEEP=1 keeps the knowledge smoke's
 * temp dir (data dir with bif.db and each run's events.jsonl) for inspection.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, type Booted } from '../src/api/main.js';
import { defaultConfig, type BifConfig, type ModelRef, type ProviderId } from '../src/core/config/schema.js';
import { ArtifactStore } from '../src/core/evidence/artifacts.js';
import { offlineRefusal } from '../src/core/harness/adapter.js';
import { CodexAdapter } from '../src/core/harness/adapters/codex.js';
import { browserPromptNote } from '../src/core/harness/browser.js';
import { getRunOutputs } from '../src/core/harness/tools/handlers.js';
import { promptVersion } from '../src/core/prompts/index.js';
import { promptStoreGaps } from '../src/core/prompts/store.js';
import { workerSystemPrompt } from '../src/core/research/systemPrompts.js';
import { servedChunkText } from '../src/core/knowledge/texts.js';
import { knowledgeRead, type KnowledgeReadInput } from '../src/core/knowledge/tools.js';
import { stripFences } from '../src/core/knowledge/trust.js';
import { knowledgeRepos, newId } from '../src/core/store/repos.js';
import { usageRepos } from '../src/core/store/usageRepos.js';
import { flowTypeByKey } from '../src/core/flows/catalog.js';
import { flowChecks } from '../src/core/flows/checks.js';
import { saveFlow, type FlowStepInput } from '../src/core/flows/flows.js';
import { nodeRanking } from '../src/core/flows/rankings.js';
import { flowRepos } from '../src/core/flows/repos.js';
import { runFlowRanking } from '../src/core/flows/round.js';
import { linkCompetitor } from '../src/core/knowledge/entityLinks.js';
import { PERSONA_FIELDS } from '../src/core/scoring/criteria.js';
import { reactToVerdict } from '../src/core/flows/feedback.js';
import { recordVerdicts } from '../src/core/flows/verdicts.js';
import { runRetro } from '../src/core/learning/lessons/retro.js';
import { personaLearningRepos } from '../src/core/personas/store.js';
import { ADJUSTMENT_TEXT_MAX } from '../src/core/personas/adjustments.js';
import { runDirOf } from '../src/core/harness/paths.js';
import { TOOL_NAMES } from '../src/core/harness/tools/registry.js';
import { uploadInternal } from '../src/core/internal/uploads.js';
import { runTaskWithReview } from '../src/core/research/reviewLoop.js';
import { isHidden, stakeholderPersonas } from '../src/core/stakeholders/personas.js';
import { ensureQuestions, NODE_QUESTIONS, PEOPLE_TEMPLATES, questionText, SYSTEM_TEMPLATES } from '../src/core/stakeholders/questions.js';
import { stakeholdersSettings } from '../src/core/stakeholders/settings.js';
import { stakeholderRepos } from '../src/core/stakeholders/store.js';
import { withholding } from '../src/core/stakeholders/withheld.js';

const MODELS: Record<ProviderId, string> = {
  claude: process.env.BIF_SMOKE_CLAUDE_MODEL ?? 'haiku',
  codex: process.env.BIF_SMOKE_CODEX_MODEL ?? 'gpt-6.1-sol',
  opencode: process.env.BIF_SMOKE_OPENCODE_MODEL ?? 'opencode/big-pickle',
};
const TIMEOUT_MS = Number(process.env.BIF_SMOKE_TIMEOUT_MS ?? 300_000);
const PROVIDERS: ProviderId[] = ['claude', 'codex', 'opencode'];

type Result = { name: string; pass: boolean; seconds: number; detail: string };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

/**
 * Config with every provider enabled (only the smoke model each) and all roles on claude. With
 * `defaultEnabled` (stakeholders mode), a provider is enabled as in the default config or when it is
 * one of `providers`, so offline work is routed as it would be on a default install.
 */
function smokeConfig(dataDir: string, port: number, opts: { defaultEnabled?: boolean; providers?: ProviderId[] } = {}): BifConfig {
  const cfg = structuredClone(defaultConfig) as BifConfig;
  for (const p of PROVIDERS) {
    const enabled = !opts.defaultEnabled || defaultConfig.providers[p].enabled || (opts.providers ?? []).includes(p);
    cfg.providers[p] = { ...cfg.providers[p], enabled, models: [MODELS[p]] };
  }
  const claude = { provider: 'claude' as const, model: MODELS.claude };
  cfg.roles = {
    ...cfg.roles,
    orchestrator: claude,
    interviewer: claude,
    reviewer: claude,
    synthesizer: claude,
    persona: claude,
    workers: { default: claude },
  };
  cfg.limits = { ...cfg.limits, idleTimeoutMs: Math.min(cfg.limits.idleTimeoutMs, TIMEOUT_MS) };
  cfg.browser = { ...cfg.browser, profileDir: join(dataDir, 'browser-profile') };
  if (cfg.browser.shared && process.env.BIF_SMOKE_HEADED !== '1') {
    cfg.browser.shared = { ...cfg.browser.shared, args: [...cfg.browser.shared.args, '--headless'] };
  }
  cfg.dataDir = dataDir;
  cfg.server = { ...cfg.server, port };
  return cfg;
}

async function startServer(label: string, opts: Parameters<typeof smokeConfig>[2] = {}): Promise<{ booted: Booted; dir: string; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), `bif-smoke-${label}-`));
  const port = await freePort();
  const configPath = join(dir, 'bif.config.json');
  writeFileSync(configPath, JSON.stringify(smokeConfig(join(dir, 'data'), port, opts), null, 2));
  const booted = await boot({ configPath, dataDir: join(dir, 'data'), port });
  return { booted, dir, base: `http://127.0.0.1:${port}` };
}

const SYSTEM = [
  'You are a smoke-test worker for a local research harness.',
  'You have MCP tools from the server named "bif". Use only those tools; do not run shell commands,',
  'read files or browse the web.',
].join(' ');

function workerPrompt(provider: ProviderId): string {
  return [
    'Do exactly these two steps, in order, then stop:',
    '1. Call the bif tool `log_decision` with what="smoke test", why="verify the harness",',
    '   alternatives=[], signals_positive=[], signals_negative=[], confidence=1, refs=[].',
    `2. Call the bif tool \`submit_result\` with the JSON object {"smoke": "ok", "provider": "${provider}"}.`,
    'After submit_result succeeds, reply with the single word DONE.',
  ].join('\n');
}

async function workerSmoke(provider: ProviderId, booted: Booted): Promise<Result> {
  const { supervisor, store } = booted.runtime;
  const name = `worker/${provider} (${MODELS[provider]})`;
  const started = Date.now();
  const ws = store.workspaces.insert({ id: `ws_smoke_${provider}`, name: `smoke ${provider}`, sector: 'test', createdAt: new Date().toISOString() });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const out = await supervisor.run({
      ctx: { workspaceId: ws.id, role: 'worker', model: { provider, model: MODELS[provider] }, promptVersion: 'smoke' },
      prompt: workerPrompt(provider),
      systemPrompt: SYSTEM,
      needsBrowser: false,
      signal: abort.signal,
    });
    const decisions = store.decisions
      .list({ agentRunId: out.agentRunId })
      .filter((d) => (d.payload as { tool?: string } | null)?.tool === 'log_decision');
    const result = getRunOutputs(store, out.agentRunId).result as { smoke?: string; provider?: string } | undefined;
    const errors = out.events.filter((e) => e.t === 'error').map((e) => (e as { message: string }).message);
    const checks = {
      status: out.status === 'done',
      log_decision: decisions.length > 0,
      submit_result: result?.smoke === 'ok',
    };
    const pass = Object.values(checks).every(Boolean);
    const detail = [
      `status=${out.status} exit=${out.exitCode} attempts=${out.attempts}`,
      `log_decision=${checks.log_decision ? 'yes' : 'no'} submit_result=${result ? JSON.stringify(result) : 'none'}`,
      out.reason ? `reason=${out.reason}` : '',
      errors.length ? `errors=${errors.slice(0, 3).join(' | ').slice(0, 400)}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return { name, pass, seconds: (Date.now() - started) / 1000, detail };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** What Codex would load for a run: `codex mcp list --json` with the adapter's env and `-c` overrides. */
function codexIsolationCheck(booted: Booted): Result {
  const name = 'codex isolation (mcp servers a run loads)';
  const started = Date.now();
  try {
    const { config, dataDir, port } = booted.runtime;
    const built = new CodexAdapter(config.providers.codex.command).buildCommand({
      prompt: 'x', systemPrompt: '', model: MODELS.codex, mcpUrl: `http://127.0.0.1:${port}/mcp/tok_check`,
      mcpBearer: { url: `http://127.0.0.1:${port}/mcp`, token: 'tok_check' }, extraMcpServers: {},
      cwd: dataDir, stateDir: join(dataDir, 'cli-state'),
    });
    const overrides = built.args.flatMap((a, i) => (built.args[i - 1] === '-c' ? ['-c', a] : []));
    const out = execFileSync(built.cmd, ['mcp', 'list', '--json', ...overrides], {
      env: { ...process.env, ...built.env }, encoding: 'utf8', timeout: 60_000,
    });
    const names = (JSON.parse(out) as Array<{ name: string }>).map((s) => s.name).sort();
    const pass = names.length === 1 && names[0] === 'bif';
    return { name, pass, seconds: (Date.now() - started) / 1000, detail: `CODEX_HOME=${built.env?.CODEX_HOME}; servers=${JSON.stringify(names)}` };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message.slice(0, 400)}` };
  }
}

function browserPrompt(): string {
  return [
    'Do exactly these steps, in order, then stop:',
    '1. Open a new browser tab for yourself (browser_tabs with action "new").',
    '2. Navigate that tab to https://example.com.',
    '3. Take a screenshot of the page (browser_take_screenshot) with filename "example.png".',
    '4. Call the bif tool `save_artifact` with kind="screenshot", mime="image/png", source_url="https://example.com",',
    '   title="example.com", and file_path = the absolute path of the screenshot file the browser tool reported.',
    '5. Close the tab you opened (browser_tabs with action "close" and its index).',
    '6. Call the bif tool `submit_result` with the JSON object {"smoke": "ok", "artifact_id": "<the artifactId from step 4>"}.',
    'After submit_result succeeds, reply with the single word DONE.',
  ].join('\n');
}

async function browserSmoke(provider: ProviderId): Promise<Result> {
  const name = `browser/${provider} (${MODELS[provider]}) shared Playwright MCP`;
  const started = Date.now();
  const { booted, dir } = await startServer(`browser-${provider}`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const { supervisor, store, config } = booted.runtime;
    const ws = store.workspaces.insert({ id: `ws_smoke_browser_${provider}`, name: 'smoke browser', sector: 'test', createdAt: new Date().toISOString() });
    const out = await supervisor.run({
      ctx: { workspaceId: ws.id, role: 'worker', model: { provider, model: MODELS[provider] }, promptVersion: 'smoke' },
      prompt: browserPrompt(),
      systemPrompt: `${SYSTEM.replace(' or browse the web', '')}\n\n${browserPromptNote(config)}`,
      needsBrowser: true,
      signal: abort.signal,
    });
    const result = getRunOutputs(store, out.agentRunId).result as { smoke?: string; artifact_id?: string } | undefined;
    const art = result?.artifact_id ? store.artifacts.get(result.artifact_id) : undefined;
    let png = false;
    if (art) {
      const { bytes } = new ArtifactStore(store, booted.runtime.dataDir).read(art.id);
      png = bytes.subarray(0, 4).toString('hex') === '89504e47';
    }
    const browserTools = out.events.filter((e) => e.t === 'tool_call' && /browser_/.test(e.name)).map((e) => (e as { name: string }).name);
    const errors = out.events.filter((e) => e.t === 'error').map((e) => (e as { message: string }).message);
    const checks = {
      status: out.status === 'done',
      artifact: art?.workspaceId === ws.id && art.mime === 'image/png' && png,
      browser: browserTools.length > 0,
    };
    const pass = Object.values(checks).every(Boolean);
    const detail = [
      `status=${out.status} exit=${out.exitCode} attempts=${out.attempts}`,
      `artifact=${art ? `${art.id} ${art.mime} png=${png}` : 'none'}`,
      `browser tool calls=${browserTools.length} [${[...new Set(browserTools)].join(', ')}]`,
      out.reason ? `reason=${out.reason}` : '',
      errors.length ? `errors=${errors.slice(0, 3).join(' | ').slice(0, 400)}` : '',
    ].filter(Boolean).join('; ');
    return { name, pass, seconds: (Date.now() - started) / 1000, detail };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
    await booted.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function interviewSmoke(): Promise<Result> {
  const name = `interview/claude (${MODELS.claude}) via HTTP`;
  const started = Date.now();
  const { booted, dir, base } = await startServer('interview');
  try {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const created = await post('/api/workspaces', { name: 'Smoke Bakery', sector: 'food retail' });
    if (created.status !== 201) return { name, pass: false, seconds: 0, detail: `create workspace: ${created.status} ${JSON.stringify(created.body)}` };
    const wsId = String(created.body.id);
    const sent = await post(`/api/workspaces/${wsId}/interview`, {
      text: 'We run a single neighbourhood bakery selling bread and pastries to walk-in customers. Keep your reply short.',
    });
    const state = (await (await fetch(`${base}/api/workspaces/${wsId}/interview`)).json()) as {
      turns: Array<{ role: string; text: string }>;
      coverage: Record<string, boolean>;
    };
    const agentTurns = state.turns.filter((t) => t.role === 'agent');
    const pass = sent.status === 200 && agentTurns.length === 1 && state.turns.length === 2;
    const reply = agentTurns[0]?.text.replace(/\s+/g, ' ').slice(0, 200) ?? '';
    const detail =
      `POST interview=${sent.status}; turns=${state.turns.length} (agent ${agentTurns.length}); ` +
      `coverage=${JSON.stringify(state.coverage)}` +
      (sent.status !== 200 ? `; error=${JSON.stringify(sent.body).slice(0, 400)}` : `; reply="${reply}"`);
    return { name, pass, seconds: (Date.now() - started) / 1000, detail };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message}` };
  } finally {
    await booted.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// knowledge store smoke (KS-8)

/** A fictional vendor's pricing page (generic names only). Long enough to page at 150 tokens. */
const KS_PAGE = `<!doctype html>
<html><head><title>Northwind Widgets - Pricing</title></head>
<body>
<h1>Northwind Widgets pricing</h1>
<p>Northwind Widgets sells inventory tracking software for small warehouses. Every plan includes barcode scanning, low-stock alerts and a mobile app.</p>
<h2>Plans</h2>
<p>Starter plan: $19 per month for a single warehouse and up to two users.</p>
<p>Team plan: $49 per user per month, billed annually. Includes unlimited warehouses, role-based permissions and shared dashboards.</p>
<p>Enterprise plan: custom pricing. Contact sales for single sign-on, audit logs and a dedicated success manager.</p>
<h2>Free trial</h2>
<p>Every plan starts with a 14-day free trial. No credit card is required to start the trial.</p>
<h2>Frequently asked questions</h2>
<h3>Can I change plans later?</h3>
<p>Yes. You can move between Starter and Team at any time from the billing page; the price difference is prorated to the day.</p>
<h3>Do you offer discounts for non-profits?</h3>
<p>Registered non-profit organisations receive 30 percent off the Team plan after a short eligibility check by our billing team.</p>
<h3>Which integrations are included?</h3>
<p>All plans connect to common accounting tools and online storefronts. The Team plan adds a public API with a limit of 10,000 requests per day.</p>
<h3>Where is my data stored?</h3>
<p>Customer data is stored in two data centres in the European Union and backed up every night. Backups are kept for 35 days. Each data centre holds a full copy of every account, so either one can serve all customers on its own if the other is offline. Backups are encrypted at rest and in transit, and restore tests run every quarter on a randomly chosen account. Customers on the Team and Enterprise plans can request an export of all their data at any time from the settings page; the export arrives as a set of CSV files within one business day. When an account is closed, its data is deleted from both data centres within 30 days and from the backups once those expire, after which nothing can be recovered.</p>
<h3>How does support work?</h3>
<p>Starter customers get email support with a reply within two business days. Team customers get chat support during business hours. Enterprise customers get a named support contact.</p>
</body></html>
`;
const KS_SOURCE_URL = 'https://northwind-widgets.example/pricing';
const KS_SUBJECT = 'Northwind Widgets';
/** The verified fact an earlier task saved; the near-duplicate of step 5 must hit it. */
const KS_PRIOR_CLAIM = 'Northwind Widgets Team plan costs $49 per user per month.';

function knowledgePrompt(pagePath: string): string {
  return [
    '## Brief',
    `Smoke test of the knowledge store. A copy of the pricing page of the fictional company "${KS_SUBJECT}" is stored`,
    `at ${pagePath} (its public address is ${KS_SOURCE_URL}). Use only the bif tools; do not run shell commands,`,
    'read files or browse the web yourself. Do these steps in order:',
    '1. Save the page with `save_artifact` (kind "page_snapshot", mime "text/html", file_path as given above, source_url',
    '   as given above, a title, and a one-sentence description of what the page shows).',
    '2. `search` the knowledge store for the Team plan price and find a passage of the page you saved.',
    '3. `expand` that passage to read its text.',
    `4. Save a finding (subject "${KS_SUBJECT}") that every plan starts with a 14-day free trial without a credit card,`,
    '   citing the page with `evidence_refs` and a quote copied exactly from the page text.',
    `5. Save a finding (subject "${KS_SUBJECT}"): "${KS_SUBJECT} charges $49 per user per month for its Team plan.",`,
    '   citing the page with a quote. Handle whatever the tool answers.',
    '6. Read the whole extracted text of the page with `read_artifact` (mode "text", max_tokens 250), following the',
    '   returned cursor until a response has none.',
    '7. A colleague says the Enterprise plan costs $199 per month. Save that as a finding with the quote',
    '   "Enterprise plan: $199 per month". If the harness rejects it, record what the page really says instead.',
    '8. Call `submit_result` with {"artifact_id": "...", "finding_ids": [...], "handshake": "<how you answered the',
    '   duplicate check>", "text_pages_read": <number>}.',
    '',
    '## Acceptance criteria',
    '- Every finding cites the saved page with a verified quote.',
    '- No claim the page does not support is saved.',
  ].join('\n');
}

type ToolCallLog = { tool: string; ok: boolean; error?: string; input?: Record<string, unknown> };
type KsStep = { step: string; pass: boolean; calls: number; did: string };
type KsResult = Result & { steps: KsStep[]; usage: string; toolCalls: number; confusion: string[] };

/** Seeds the workspace, the research run, an earlier verified task with one verified fact, and the run's task. */
function seedKnowledge(booted: Booted, provider: ProviderId) {
  const { store, dataDir } = booted.runtime;
  const now = new Date().toISOString();
  const wsId = `ws_smoke_ks_${provider}`;
  store.workspaces.insert({ id: wsId, name: `knowledge smoke ${provider}`, sector: 'test', createdAt: now });
  const rr = store.researchRuns.insert({ id: newId('rrun'), workspaceId: wsId, phase: 'deep_dives', status: 'running', startedAt: now });
  const taskBase = {
    workspaceId: wsId, runId: rr.id, phase: 'deep_dives' as const, type: 'news_scan' as const, round: 1, createdAt: now,
    model: { provider, model: MODELS[provider] }, needsBrowser: false, acceptanceCriteria: ['cite the page'],
  };
  const earlier = store.tasks.insert({ ...taskBase, id: newId('tsk'), brief: 'earlier pricing check', status: 'verified' });
  const old = new ArtifactStore(store, dataDir).save({
    workspaceId: wsId, kind: 'text', mime: 'text/plain', bytes: `Earlier note: ${KS_PRIOR_CLAIM}`, title: 'earlier note',
  });
  knowledgeRepos(store).artifactCaptures.insert({ id: newId('cap'), artifactId: old.id, workspaceId: wsId, taskId: earlier.id, capturedAt: now });
  const prior = store.findings.insert({
    id: newId('fnd'), workspaceId: wsId, runId: rr.id, taskId: earlier.id, subject: KS_SUBJECT, claim: KS_PRIOR_CLAIM,
    criteria: {}, evidence: [old.id], status: 'verified', lifecycle: 'current', createdAt: now, lastConfirmedAt: now,
  });
  const task = store.tasks.insert({ ...taskBase, id: newId('tsk'), brief: 'knowledge store smoke', status: 'running' });
  return { wsId, task, prior };
}

async function knowledgeSmoke(provider: ProviderId, booted: Booted, dir: string): Promise<KsResult> {
  const { supervisor, store, config, events } = booted.runtime;
  const name = `knowledge/${provider} (${MODELS[provider]})`;
  const started = Date.now();
  const { wsId, task, prior } = seedKnowledge(booted, provider);
  const pageDir = join(dir, 'pages');
  mkdirSync(pageDir, { recursive: true });
  const pagePath = join(pageDir, `northwind-pricing-${provider}.html`);
  writeFileSync(pagePath, KS_PAGE);
  const bus: ToolCallLog[] = [];
  const off = events.on((e) => {
    if (e.type === 'tool_call' && e.workspaceId === wsId) bus.push({ tool: e.tool, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
  });
  const system = workerSystemPrompt(config, 'worker', false, 'news_scan');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const fail = (detail: string): KsResult => ({
    name, pass: false, seconds: (Date.now() - started) / 1000, detail, steps: [], usage: '', toolCalls: bus.length, confusion: [],
  });
  try {
    const out = await supervisor.run({
      ctx: { workspaceId: wsId, taskId: task.id, role: 'worker', model: { provider, model: MODELS[provider] }, promptVersion: promptVersion(system) },
      prompt: knowledgePrompt(pagePath),
      systemPrompt: system,
      needsBrowser: false,
      signal: abort.signal,
      meta: { round: 1, taskType: task.type, researchRunId: task.runId },
    });
    return { name, ...judgeKnowledge(booted, out, bus, { wsId, taskId: task.id, priorId: prior.id, model: { provider, model: MODELS[provider] } }), seconds: (Date.now() - started) / 1000 };
  } catch (e) {
    return fail(`threw: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** Joins the run's tool_call events (inputs) with the dispatcher's bus events (ok / error), per tool in order. */
function toolLog(out: Awaited<ReturnType<Booted['runtime']['supervisor']['run']>>, bus: ToolCallLog[]): ToolCallLog[] {
  const inputs = new Map<string, Array<Record<string, unknown>>>();
  for (const e of out.events) {
    if (e.t !== 'tool_call') continue;
    const list = inputs.get(e.name) ?? [];
    list.push((e.input ?? {}) as Record<string, unknown>);
    inputs.set(e.name, list);
  }
  return bus.map((b) => {
    const input = inputs.get(b.tool)?.shift();
    return input ? { ...b, input } : b;
  });
}

/**
 * Replays the agent's `read_artifact` calls with the same caller key (workspace, role, model), so each
 * cursor is valid, to see what every page served: pieces marked `cut`, placeholders, which pages carried
 * the artifact header, and whether every passage was served whole across the pages (its pieces joined).
 * Called after the run's own retrieval rows were judged: the replay writes rows without a run id.
 */
function replayReads(booted: Booted, wsId: string, artifactId: string, model: ModelRef, reads: ToolCallLog[]) {
  const { store, config } = booted.runtime;
  const files = new ArtifactStore(store, booted.runtime.dataDir);
  const served = new Map<string, string>();
  let pages = 0;
  let headerPages = 0;
  let cut = 0;
  let omitted = 0;
  for (const c of reads) {
    if (!c.ok || !c.input) continue;
    const r = knowledgeRead({ store, config, files }, { workspaceId: wsId, role: 'worker', model }, 'read_artifact', c.input as KnowledgeReadInput);
    if (!r.ok) continue;
    pages++;
    if ('title' in r.data || 'description' in r.data) headerPages++;
    for (const it of (r.data.items ?? []) as Array<Record<string, unknown>>) {
      if (it.omitted) omitted++;
      if (it.type !== 'chunk') continue;
      if (it.cut) cut++;
      const inner = String(it.text).replace(/^<<<EVIDENCE \S+\n/, '').replace(/\n>>>$/, '');
      served.set(String(it.chunk_id), (served.get(String(it.chunk_id)) ?? '') + inner);
    }
  }
  const chunks = knowledgeRepos(store).chunks.list({ artifactId });
  let covered = 0;
  let missingChars = 0;
  for (const ch of chunks) {
    const full = stripFences(servedChunkText(store, wsId, ch));
    const got = served.get(ch.id) ?? '';
    if (got === full) covered++;
    else missingChars += Math.max(0, full.length - got.length);
  }
  return { pages, headerPages, cut, omitted, covered, total: chunks.length, missingChars };
}

function judgeKnowledge(
  booted: Booted,
  out: Awaited<ReturnType<Booted['runtime']['supervisor']['run']>>,
  bus: ToolCallLog[],
  ids: { wsId: string; taskId: string; priorId: string; model: ModelRef },
): Omit<KsResult, 'name' | 'seconds'> {
  const { store } = booted.runtime;
  const k = knowledgeRepos(store);
  const calls = toolLog(out, bus);
  const runId = out.agentRunId;
  const of = (tool: string) => calls.filter((c) => c.tool === tool);
  const claimOf = (c: ToolCallLog) => String(c.input?.claim ?? '');
  const findingCalls = (re: RegExp) => of('save_finding').filter((c) => re.test(claimOf(c)));
  const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const confusion: string[] = [];

  // 1. save_artifact with a description, text extracted into passages
  const artifacts = store.artifacts.list({ workspaceId: ids.wsId }).filter((a) => a.sourceUrl === KS_SOURCE_URL || a.mime.startsWith('text/html'));
  const art = artifacts[0];
  const chunks = art ? k.chunks.list({ artifactId: art.id }) : [];
  const s1 = of('save_artifact');
  const step1: KsStep = {
    step: '1 save_artifact', calls: s1.length,
    pass: !!art && !!art.description && chunks.length > 0,
    did: art ? `${art.id} ${art.mime} description=${art.description ? `"${short(art.description, 80)}"` : 'none'} passages=${chunks.length}` : `no page artifact; errors=${s1.filter((c) => !c.ok).map((c) => c.error).join(' | ')}`,
  };

  // 2. search finds a passage of the page; 3. expand a passage
  const retrievals = k.retrievalEvents.list({ agentRunId: runId });
  const searches = retrievals.filter((r) => r.tool === 'search');
  const chunkIds = new Set(chunks.map((c) => c.id));
  const searchHit = searches.some((r) => r.resultIds.some((x) => chunkIds.has(x.id)));
  const step2: KsStep = {
    step: '2 search', calls: of('search').length, pass: searchHit,
    did: `queries=${JSON.stringify(of('search').map((c) => c.input?.query ?? ''))}; page passage returned=${searchHit}`,
  };
  const expands = of('expand');
  const expandedChunk = expands.some((c) => c.ok && typeof c.input?.id === 'string' && (c.input.id as string).startsWith('chk_'));
  const step3: KsStep = {
    step: '3 expand passage', calls: expands.length, pass: expandedChunk,
    did: `ids=${JSON.stringify(expands.map((c) => c.input?.id))}${expands.some((c) => !c.ok) ? ` errors=${expands.filter((c) => !c.ok).map((c) => c.error).join(' | ')}` : ''}`,
  };

  // 4. finding with a verified quote
  const findings = store.findings.list({ taskId: ids.taskId });
  const quoted = (f: { id: string }) => k.findingEvidence.list({ findingId: f.id }).filter((r) => r.quote);
  const trial = findings.filter((f) => /trial/i.test(f.claim));
  const s4 = findingCalls(/trial/i);
  const step4: KsStep = {
    step: '4 finding + verified quote', calls: s4.length,
    pass: trial.some((f) => quoted(f).length > 0),
    did: trial.length ? trial.map((f) => `${f.id} quotes=${JSON.stringify(quoted(f).map((r) => short(r.quote!, 80)))}`).join('; ') : 'no trial finding',
  };

  // 5. duplicate handshake against the seeded fact, then an explicit relation
  const handshakes = store.decisions
    .list({ agentRunId: runId })
    .filter((d) => (d.payload as { event?: string } | null)?.event === 'duplicate_handshake');
  const obs = k.factObservations.list({ taskId: ids.taskId });
  const confirmedPrior = obs.some((o) => o.findingId === ids.priorId && o.kind === 'confirm');
  const replacedPrior = obs.some((o) => o.priorFindingId === ids.priorId && o.kind === 'replace');
  const teamNew = findings.filter((f) => /team plan/i.test(f.claim) && f.lifecycle === 'current');
  const s5 = findingCalls(/team plan|\$49/i);
  const relations = s5.map((c) => JSON.stringify(c.input?.relation ?? 'omitted'));
  const answer = confirmedPrior ? 'confirms' : replacedPrior ? 'replaces' : teamNew.length ? 'new' : 'none';
  const step5: KsStep = {
    step: '5 duplicate handshake', calls: s5.length + of('confirm_finding').length,
    pass: handshakes.length > 0 && confirmedPrior,
    did: `handshakes=${handshakes.length}; relations sent=${relations.join(', ')}; answered=${answer}` +
      (of('confirm_finding').length ? `; confirm_finding calls=${of('confirm_finding').length}` : ''),
  };
  if (handshakes.length > 0 && answer === 'new') confusion.push('answered the handshake for the same Team-plan fact with relation "new" (duplicate fact)');
  if (handshakes.length > 2) confusion.push(`hit the duplicate handshake ${handshakes.length} times`);

  // 6. paged read with a cursor
  const reads = of('read_artifact');
  const cursorCalls = calls.filter((c) => typeof c.input?.cursor === 'string');
  const firstRead = calls.findIndex((c) => c.tool === 'read_artifact');
  const laterExpands = firstRead < 0 ? [] : calls.slice(firstRead).filter((c) => c.tool === 'expand' && String(c.input?.id ?? '').startsWith('chk_'));
  const truncated = retrievals.filter((r) => r.truncated).length;
  const lastRead = retrievals.filter((r) => r.tool === 'read_artifact').at(-1);
  const step6: KsStep = {
    step: '6 paged read (cursor)', calls: reads.length,
    pass: cursorCalls.length > 0 && truncated > 0 && lastRead?.truncated === false,
    did: `read_artifact calls=${reads.length} (modes ${JSON.stringify([...new Set(reads.map((c) => c.input?.mode ?? 'default'))])}, max_tokens ${JSON.stringify([...new Set(reads.map((c) => c.input?.max_tokens))])}); with cursor=${cursorCalls.length}; truncated responses=${truncated}; last page truncated=${lastRead?.truncated}; passages expanded after reading=${laterExpands.length}`,
  };
  if (reads.length > 12) confusion.push(`read_artifact called ${reads.length} times`);
  const replay = art ? replayReads(booted, ids.wsId, art.id, ids.model, reads) : undefined;
  if (replay) {
    step6.pass &&= replay.covered === replay.total;
    step6.did += `; replay: pages=${replay.pages} (with artifact header ${replay.headerPages}), pieces cut=${replay.cut}, placeholders=${replay.omitted}, passages served whole=${replay.covered}/${replay.total}, chars never served=${replay.missingChars}`;
  }

  // 7. rejected quote, then recovery
  const s7 = findingCalls(/enterprise/i);
  const rejected = s7.filter((c) => !c.ok && /quote not found/.test(c.error ?? ''));
  const enterprise = findings.filter((f) => /enterprise/i.test(f.claim));
  // Saving the colleague's price as true (a claim that only says the page does NOT state $199 is fine).
  const asserts199 = (claim: string) => /\$\s?199/.test(claim) && !/\b(not|no|never|unsupported)\b/i.test(claim);
  const wrongSaved = enterprise.some((f) => asserts199(f.claim));
  const recovered = enterprise.filter((f) => !asserts199(f.claim) && quoted(f).length > 0);
  const step7: KsStep = {
    step: '7 failed quote + recovery', calls: s7.length,
    pass: rejected.length > 0 && !wrongSaved && recovered.length > 0,
    did: `rejected=${rejected.length}; saved=${JSON.stringify(enterprise.map((f) => short(f.claim, 90)))}`,
  };
  if (rejected.length > 2) confusion.push(`retried the rejected quote ${rejected.length} times`);
  if (wrongSaved) confusion.push('saved the unsupported $199 Enterprise claim');

  const result = getRunOutputs(store, runId).result;
  const usageRows = usageRepos(store).agentUsage.list({ runId });
  const sum = (f: (u: (typeof usageRows)[number]) => number | undefined) => usageRows.reduce((a, u) => a + (f(u) ?? 0), 0);
  const cost = sum((u) => u.costUsd ?? u.cliReportedCostUsd);
  const usage =
    `in=${sum((u) => u.inputTokens)} out=${sum((u) => u.outputTokens)} cacheRead=${sum((u) => u.cacheReadTokens)} ` +
    `cacheWrite=${sum((u) => u.cacheWriteTokens)} cost=$${cost.toFixed(4)} (rows ${usageRows.length})`;
  const byTool = Object.entries(retrievals.reduce<Record<string, number>>((a, r) => ({ ...a, [r.tool]: (a[r.tool] ?? 0) + 1 }), {}));
  const gaps = promptStoreGaps(store);
  const failedCalls = calls.filter((c) => !c.ok);
  for (const c of failedCalls) {
    if (c.tool === 'save_finding' && /quote not found/.test(c.error ?? '') && /enterprise/i.test(claimOf(c))) continue;
    confusion.push(`${c.tool} failed: ${short(c.error ?? '', 160)}`);
  }
  // The same call twice in a row (same tool, same input) is a retry the response did not ask for.
  calls.forEach((c, i) => {
    const prev = calls[i - 1];
    if (prev && prev.tool === c.tool && c.input && JSON.stringify(prev.input) === JSON.stringify(c.input)) {
      confusion.push(`repeated an identical ${c.tool} call (${short(JSON.stringify(c.input), 120)})`);
    }
  });
  const steps = [step1, step2, step3, step4, step5, step6, step7];
  const checks = {
    status: out.status === 'done',
    submitted: result !== undefined,
    steps: steps.every((s) => s.pass),
    retrievals: retrievals.length > 0,
    gaps: gaps.length === 0,
  };
  const detail = [
    `status=${out.status} exit=${out.exitCode} attempts=${out.attempts}`,
    `submit_result=${result !== undefined ? 'yes' : 'no'}`,
    `retrieval_events=${retrievals.length} ${JSON.stringify(Object.fromEntries(byTool))}`,
    `promptStoreGaps=${JSON.stringify(gaps)}`,
    out.reason ? `reason=${out.reason}` : '',
  ].filter(Boolean).join('; ');
  return { pass: Object.values(checks).every(Boolean), detail, steps, usage, toolCalls: calls.length, confusion };
}

function printKnowledge(r: KsResult): void {
  console.log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.seconds.toFixed(1)}s — ${r.detail}`);
  console.log(`[smoke]   tool calls=${r.toolCalls}; usage ${r.usage}`);
  for (const s of r.steps) console.log(`[smoke]   ${s.pass ? 'PASS' : 'FAIL'} ${s.step} (calls ${s.calls}): ${s.did}`);
  for (const c of r.confusion) console.log(`[smoke]   confusion: ${c}`);
}

// ---------------------------------------------------------------------------
// flow records and ranking smoke (flow design 2026-11-14 §16)

/** A fictional product's sign-up, as three screens captured earlier (text notes; generic names only). */
const FL_SUBJECT = 'Pinecrest Tasks';
const FL_SCREENS = [
  `${FL_SUBJECT} sign-up, screen 1 of 3. Address: https://pinecrest-tasks.example/signup. ` +
    'The page shows a form with two fields: work email and password. The password rule (at least 12 characters) is shown ' +
    'under the field while typing, and an eye icon shows the password. Paste works in both fields. Button: "Create account".',
  `${FL_SUBJECT} sign-up, screen 2 of 3. Address: https://pinecrest-tasks.example/verify. ` +
    'After pressing "Create account", the page asks for the 6-digit code sent to the work email. The code field accepts paste ' +
    'and the browser offers to autofill it. A "Resend code" link is under the field. The code arrived within a minute.',
  `${FL_SUBJECT} sign-up, screen 3 of 3. Address: https://pinecrest-tasks.example/board. ` +
    'The code is accepted and an empty task board opens with a short checklist of three first steps. The account exists; ' +
    'no card, phone number or sales call was asked for.',
];

function flowsWorkerPrompt(artifactIds: string[]): string {
  return [
    '## Brief',
    `Smoke test of the flow records. The sign-up of the fictional product "${FL_SUBJECT}" (a competitor) was walked earlier and`,
    `each screen was saved as a text note: ${artifactIds.map((id, i) => `screen ${i + 1} = ${id}`).join(', ')}.`,
    'Do not browse, do not take screenshots and do not save new artifacts: record the flow from these notes. Use only the bif tools.',
    '1. Call `read_flow_catalog` (no input) and pick the flow type of a sign-up.',
    '2. Read each note with `read_artifact` (mode "text").',
    `3. Save the flow with \`save_flow\`: subject {"kind": "competitor", "name": "${FL_SUBJECT}"}, the sign-up flow type, variant "Email",`,
    '   primary true, one step per screen in order (action, observation, asked, page_url, artifact_id = that screen\'s note).',
    '4. Answer the checks with `save_flow_checks` for the flow id `save_flow` returned: at least `goal_reached_without_help`,',
    '   `password_can_be_shown` and `code_entry_paste_autofill_resend`, plus any others the notes clearly show. Skip the rest.',
    '5. Call `submit_result` with {"flow_id": "...", "checks_answered": <number>}.',
    '',
    '## Acceptance criteria',
    '- Every step cites its screen note.',
    '- Every check answer rests on what the notes say.',
  ].join('\n');
}

type FlStep = KsStep;
type FlResult = Result & { steps: FlStep[]; usage: string; toolCalls: number; confusion: string[] };

/** Usage summed over runs (agent_usage). */
function usageOf(booted: Booted, runIds: string[]): string {
  const rows = runIds.flatMap((runId) => usageRepos(booted.runtime.store).agentUsage.list({ runId }));
  const sum = (f: (u: (typeof rows)[number]) => number | undefined) => rows.reduce((a, u) => a + (f(u) ?? 0), 0);
  return `in=${sum((u) => u.inputTokens)} out=${sum((u) => u.outputTokens)} cost=$${sum((u) => u.costUsd ?? u.cliReportedCostUsd).toFixed(4)} (rows ${rows.length})`;
}

/** Worker part: a workspace with a competitor, a research run, a walkthrough task and the three screen notes captured by it. */
function seedFlowsWorker(booted: Booted, provider: ProviderId) {
  const { store, dataDir } = booted.runtime;
  const now = new Date().toISOString();
  const wsId = `ws_smoke_flows_${provider}`;
  store.workspaces.insert({ id: wsId, name: `flows smoke ${provider}`, sector: 'test', createdAt: now });
  linkCompetitor(store, store.competitors.insert({
    id: newId('cmp'), workspaceId: wsId, name: FL_SUBJECT, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
    evidence: [], createdAt: now, updatedAt: now, status: 'verified',
  }));
  const rr = store.researchRuns.insert({ id: newId('rrun'), workspaceId: wsId, phase: 'deep_dives', status: 'running', startedAt: now });
  const task = store.tasks.insert({
    id: newId('tsk'), workspaceId: wsId, runId: rr.id, phase: 'deep_dives', type: 'flow_walkthrough', round: 1, createdAt: now,
    model: { provider, model: MODELS[provider] }, needsBrowser: false, acceptanceCriteria: ['every step cites its screen'],
    brief: `walk the ${FL_SUBJECT} sign-up`, subject: FL_SUBJECT, status: 'running',
  });
  const files = new ArtifactStore(store, dataDir);
  const notes = FL_SCREENS.map((text, i) => {
    const a = files.save({ workspaceId: wsId, kind: 'text', mime: 'text/plain', bytes: text, title: `${FL_SUBJECT} sign-up screen ${i + 1}` });
    knowledgeRepos(store).artifactCaptures.insert({ id: newId('cap'), artifactId: a.id, workspaceId: wsId, taskId: task.id, capturedAt: now });
    return a.id;
  });
  return { wsId, task, notes };
}

/** Persona part: a workspace with its own company and one competitor, a verified sign-up flow of each, and one verified persona. */
function seedFlowsPersona(booted: Booted, provider: ProviderId) {
  const { store, dataDir } = booted.runtime;
  const now = new Date().toISOString();
  const wsId = `ws_smoke_flows_persona_${provider}`;
  store.workspaces.insert({ id: wsId, name: 'Larkspur Notes', sector: 'test', createdAt: now });
  linkCompetitor(store, store.competitors.insert({
    id: newId('cmp'), workspaceId: wsId, name: FL_SUBJECT, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
    evidence: [], createdAt: now, updatedAt: now, status: 'verified',
  }));
  const flow = (subject: { kind: 'company' | 'competitor'; name: string }, steps: FlowStepInput[]) => {
    const r = saveFlow(store, { workspaceId: wsId }, {
      subject, flowTypeKey: 'sign_up', variant: 'Email', primary: true, name: `${subject.name} sign-up`, goal: 'Create an account', reachedGoal: true, steps,
    });
    if (!r.saved) throw new Error('seed flow not saved');
    return flowRepos(store).flows.update(r.flow.id, { status: 'verified' });
  };
  const own = flow({ kind: 'company', name: 'Larkspur Notes' }, [
    { action: 'Open the sign-up page', observation: 'A form asks for name, work email, phone number, company size and a password', asked: ['name', 'email', 'phone', 'company size', 'password'] },
    { action: 'Submit the form', observation: 'A page says a sales representative will call to activate the account' },
  ]);
  const rival = flow({ kind: 'competitor', name: FL_SUBJECT }, [
    { action: 'Open the sign-up page', observation: 'A form asks for work email and password; the password can be shown', asked: ['email', 'password'] },
    { action: 'Enter the emailed code', observation: 'The code arrives within a minute; paste works' },
    { action: 'Submit the code', observation: 'An empty task board opens' },
  ]);
  const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f.replace(/_/g, ' ')}: an office manager at a 20-person design studio who sets up tools for the team`, confidence: 0.7, evidence: [] }]));
  const persona = store.personas.insert({
    id: newId('per'), workspaceId: wsId, slug: 'office-manager', segment: 'office managers at small studios', profile, version: 1, status: 'verified',
    agentMdPath: join(dataDir, 'personas', `office-manager-${provider}.md`),
  });
  return { wsId, own, rival, persona };
}

async function flowsSmoke(provider: ProviderId, booted: Booted): Promise<FlResult> {
  const { supervisor, store, config, events, research } = booted.runtime;
  const name = `flows/${provider} (${MODELS[provider]})`;
  const started = Date.now();
  const model = { provider, model: MODELS[provider] };
  const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const steps: FlStep[] = [];
  const confusion: string[] = [];
  const runIds: string[] = [];
  let toolCalls = 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    // --- worker: save a flow with steps and answer its checks through the real MCP tools ---------------
    const w = seedFlowsWorker(booted, provider);
    const bus: ToolCallLog[] = [];
    const off = events.on((e) => {
      if (e.type === 'tool_call' && e.workspaceId === w.wsId) bus.push({ tool: e.tool, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    });
    const system = workerSystemPrompt(config, 'worker', false, 'flow_walkthrough');
    let out: Awaited<ReturnType<typeof supervisor.run>>;
    try {
      out = await supervisor.run({
        ctx: { workspaceId: w.wsId, taskId: w.task.id, role: 'worker', model, promptVersion: promptVersion(system) },
        prompt: flowsWorkerPrompt(w.notes),
        systemPrompt: system,
        needsBrowser: false,
        signal: abort.signal,
        meta: { round: 1, taskType: w.task.type, researchRunId: w.task.runId },
      });
    } finally {
      off();
    }
    runIds.push(out.agentRunId);
    const calls = toolLog(out, bus);
    toolCalls += calls.length;
    const of = (tool: string) => calls.filter((c) => c.tool === tool);
    steps.push({ step: 'W1 read_flow_catalog', calls: of('read_flow_catalog').length, pass: of('read_flow_catalog').some((c) => c.ok), did: `ok=${of('read_flow_catalog').filter((c) => c.ok).length}` });
    const saved = flowRepos(store).flows.list({ rootWorkspaceId: w.wsId });
    const flow = saved.find((f) => f.taskId === w.task.id);
    const flowSteps = flow ? flowRepos(store).flowSteps.list({ flowId: flow.id }) : [];
    const signUp = flowTypeByKey(store, w.wsId, 'sign_up');
    const subject = flow ? knowledgeRepos(store).entities.get(flow.subjectEntityId)?.name : undefined;
    const cited = flowSteps.filter((s) => s.artifactId && w.notes.includes(s.artifactId)).length;
    steps.push({
      step: 'W2 save_flow (steps)', calls: of('save_flow').length,
      pass: !!flow && flow.flowTypeId === signUp?.id && subject === FL_SUBJECT && flowSteps.length >= 3 && cited === flowSteps.length && flow.reachedGoal,
      did: flow
        ? `${flow.id} type=${flow.flowTypeId === signUp?.id ? 'sign_up' : flow.flowTypeId} subject=${subject} variant=${flow.variant} primary=${flow.isPrimary} reached=${flow.reachedGoal} steps=${flowSteps.length} citing notes=${cited} asked=${JSON.stringify(flowSteps.map((s) => s.asked))}`
        : `no flow saved; errors=${of('save_flow').filter((c) => !c.ok).map((c) => short(c.error ?? '')).join(' | ')}`,
    });
    const answers = flow ? flowChecks(store, flow.id).filter((c) => c.origin === 'walkthrough') : [];
    const answerOf = (key: string) => answers.find((c) => c.itemKey === key)?.answer ?? 'none';
    const expected = { goal_reached_without_help: 'pass', password_can_be_shown: 'pass', code_entry_paste_autofill_resend: 'pass' };
    steps.push({
      step: 'W3 save_flow_checks', calls: of('save_flow_checks').length,
      pass: Object.entries(expected).every(([k, v]) => answerOf(k) === v) && answers.every((c) => c.stepRefs.every((n) => n >= 1 && n <= flowSteps.length)),
      did: `walkthrough answers=${answers.length}; ${Object.keys(expected).map((k) => `${k}=${answerOf(k)}`).join(' ')}; refused calls=${of('save_flow_checks').filter((c) => !c.ok).length}`,
    });
    const result = getRunOutputs(store, out.agentRunId).result as { flow_id?: string } | undefined;
    steps.push({ step: 'W4 submit_result', calls: of('submit_result').length, pass: out.status === 'done' && result?.flow_id === flow?.id, did: `status=${out.status} result=${short(JSON.stringify(result ?? null), 100)}` });
    for (const c of calls.filter((x) => !x.ok)) confusion.push(`worker: ${c.tool} failed: ${short(c.error ?? '', 160)}`);
    if (of('save_artifact').length) confusion.push(`worker saved ${of('save_artifact').length} artifacts although told not to`);

    // --- persona: verdicts for two seeded flows through the real round ---------------------------------
    const p = seedFlowsPersona(booted, provider);
    const pbus: ToolCallLog[] = [];
    const poff = events.on((e) => {
      if (e.type === 'tool_call' && e.workspaceId === p.wsId) pbus.push({ tool: e.tool, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    });
    let report: Awaited<ReturnType<typeof runFlowRanking>>;
    try {
      // The persona runs on the provider under test; one broad sitting, no focused follow-up.
      const cfg: BifConfig = { ...config, flows: { ...(config.flows ?? {}), model, maxFocusedComparisons: 0 } };
      report = await runFlowRanking(p.wsId, { ...research, config: cfg, signal: abort.signal });
    } finally {
      poff();
    }
    const personaRuns = store.agentRuns.list({ workspaceId: p.wsId }).filter((r) => r.role === 'persona');
    runIds.push(...personaRuns.map((r) => r.id));
    toolCalls += pbus.length;
    const verdicts = flowRepos(store).flowVerdicts.list({ workspaceId: p.wsId });
    const pair = [p.own.id, p.rival.id].sort();
    const v = verdicts[0];
    steps.push({
      step: 'P1 submit_flow_verdicts', calls: pbus.filter((c) => c.tool === 'submit_flow_verdicts').length,
      pass: personaRuns.length === 1 && personaRuns[0]!.status === 'done' && verdicts.length === 1 && v!.flowAId === pair[0] && v!.flowBId === pair[1] &&
        v!.personaId === p.persona.id && v!.stage === 'broad' && v!.reason.trim().length > 0 && report.notJudged.length === 0,
      did: v
        ? `runs=${personaRuns.length} (${personaRuns.map((r) => r.status).join(',')}); verdict winner=${v.winner === 'tie' ? 'tie' : (v.winner === 'a' ? v.flowAId : v.flowBId) === p.own.id ? 'own company' : FL_SUBJECT} strength=${v.strength} confidence=${v.confidence} reason="${short(v.reason, 120)}"`
        : `runs=${personaRuns.length} (${personaRuns.map((r) => `${r.status}${r.failureReason ? ` ${short(r.failureReason, 80)}` : ''}`).join(',')}); no verdict; notJudged=${JSON.stringify(report.notJudged)}`,
    });
    const ranking = nodeRanking(store, config, p.wsId, flowTypeByKey(store, p.wsId, 'sign_up')!.id);
    steps.push({
      step: 'P2 ranking', calls: 0,
      pass: ranking.ranked.length === 2 && ranking.ranked.every((f) => f.comparisons === 1),
      did: ranking.ranked.map((f) => `${f.position}. ${f.flowId === p.own.id ? 'own company' : FL_SUBJECT} persona=${f.persona} decidedBy=${f.decidedBy}`).join('; '),
    });
    for (const c of pbus.filter((x) => !x.ok)) confusion.push(`persona: ${c.tool} failed: ${short(c.error ?? '', 160)}`);
    const pass = steps.every((s) => s.pass);
    return {
      name, pass, seconds: (Date.now() - started) / 1000, steps, usage: usageOf(booted, runIds), toolCalls, confusion,
      detail: `worker status=${out.status} exit=${out.exitCode}${out.reason ? ` reason=${short(out.reason, 120)}` : ''}; persona runs=${personaRuns.length}; promptStoreGaps=${JSON.stringify(promptStoreGaps(store))}`,
    };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message}`, steps, usage: usageOf(booted, runIds), toolCalls, confusion };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// persona learning smoke (persona learning design 2026-11-15 §17)

/**
 * A workspace with its own company and three fictional competitors, a verified sign-up flow of each, one
 * verified persona, six verdicts of that persona (one per pair, the shorter form always wins) and the user's
 * reactions: five disagree, each with a reason pointing the same way, one agrees.
 */
function seedPersonaLearning(booted: Booted, provider: ProviderId) {
  const { store, dataDir } = booted.runtime;
  const now = new Date().toISOString();
  const wsId = `ws_smoke_persona_learning_${provider}`;
  const company = 'Larkspur Books';
  store.workspaces.insert({ id: wsId, name: company, sector: 'test', createdAt: now });
  const rivals = ['Pinecrest Ledger', 'Tamarind Accounts', 'Quillfield Invoices'];
  for (const name of rivals) {
    linkCompetitor(store, store.competitors.insert({
      id: newId('cmp'), workspaceId: wsId, name, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
      evidence: [], createdAt: now, updatedAt: now, status: 'verified',
    }));
  }
  // Fields asked at sign-up: 2, 3, 5, 7 (the persona prefers fewer every time).
  const shapes: Array<{ subject: { kind: 'company' | 'competitor'; name: string }; asked: string[]; after: string }> = [
    { subject: { kind: 'competitor', name: rivals[0]! }, asked: ['email', 'password'], after: 'An empty ledger opens; pricing is shown only when the 14-day trial ends' },
    { subject: { kind: 'competitor', name: rivals[1]! }, asked: ['email', 'password', 'company name'], after: 'A page lists the yearly price and what an accountant seat costs, then opens the ledger' },
    { subject: { kind: 'company', name: company }, asked: ['name', 'email', 'password', 'company name', 'country'], after: 'A setup page shows the yearly total including tax before the ledger opens' },
    { subject: { kind: 'competitor', name: rivals[2]! }, asked: ['name', 'email', 'phone', 'password', 'company name', 'country', 'VAT number'], after: 'A call is booked to walk through the yearly plan and the invoice import' },
  ];
  const flows = shapes.map(({ subject, asked, after }) => {
    const r = saveFlow(store, { workspaceId: wsId }, {
      subject, flowTypeKey: 'sign_up', variant: 'Email', primary: true, name: `${subject.name} sign-up`, goal: 'Create an account', reachedGoal: true,
      steps: [
        { action: 'Open the sign-up page', observation: `A form asks for ${asked.join(', ')}`, asked },
        { action: 'Submit the form', observation: after },
      ],
    });
    if (!r.saved) throw new Error('seed flow not saved');
    return flowRepos(store).flows.update(r.flow.id, { status: 'verified' });
  });
  const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f.replace(/_/g, ' ')}: the owner of a 6-person bookkeeping practice who picks the tools`, confidence: 0.7, evidence: [] }]));
  const persona = store.personas.insert({
    id: newId('per'), workspaceId: wsId, slug: 'practice-owner', segment: 'owners of small bookkeeping practices', profile, version: 1, status: 'verified',
    agentMdPath: join(dataDir, 'personas', `practice-owner-${provider}.md`),
  });
  const flowTypeId = flowTypeByKey(store, wsId, 'sign_up')!.id;
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const reasons = [
    'they pay once a year, so the yearly total matters more than a short form',
    'a form of five fields is fine for them if the yearly price is clear up front',
    'they want to see the yearly cost before they sign up, not a trial that hides it',
    'they never mind a few more fields; surprises on the invoice are what they hate',
    'the call about the yearly plan is a plus for them, not a cost',
  ];
  let disagree = 0;
  for (const [i, [x, y]] of pairs.entries()) {
    const a = flows[x]!;
    const b = flows[y]!;
    recordVerdicts(store, { workspaceId: wsId, flowTypeId, persona, stage: 'broad', allowed: [a.id, b.id] }, [
      { a: a.id, b: b.id, winner: 'a', strength: 2, confidence: 0.8, reason: 'Fewer fields to fill in before I can start.' },
    ]);
    const v = flowRepos(store).flowVerdicts.list({ personaId: persona.id }).at(-1)!;
    if (i === 0) reactToVerdict(store, 'smoke-user', v.id, 'agree');
    else reactToVerdict(store, 'smoke-user', v.id, 'disagree', reasons[disagree++]);
  }
  return { wsId, persona };
}

async function personaLearningSmoke(provider: ProviderId, booted: Booted): Promise<FlResult> {
  const { store, config, events, research } = booted.runtime;
  const name = `persona-learning/${provider} (${MODELS[provider]})`;
  const started = Date.now();
  const model = { provider, model: MODELS[provider] };
  const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const steps: FlStep[] = [];
  const confusion: string[] = [];
  const runIds: string[] = [];
  let toolCalls = 0;
  try {
    const s = seedPersonaLearning(booted, provider);
    const bus: ToolCallLog[] = [];
    const off = events.on((e) => {
      if (e.type === 'tool_call' && e.workspaceId === s.wsId) bus.push({ tool: e.tool, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    });
    let retro: Awaited<ReturnType<typeof runRetro>>;
    try {
      // The learning run (and the lessons retro, when the period has anything to digest) on the provider under test.
      const lessons = config.lessons ?? {};
      const cfg: BifConfig = {
        ...config,
        personaLearning: { ...(config.personaLearning ?? {}), model },
        lessons: { ...lessons, retro: { ...(lessons.retro ?? {}), model } },
      };
      retro = await runRetro({ ...research, config: cfg }, s.wsId, { triggeredBy: 'user' });
    } finally {
      off();
    }
    toolCalls = bus.length;
    const repos = personaLearningRepos(store);
    const runs = repos.runs.list({ personaId: s.persona.id });
    const run = runs[0];
    if (run?.agentRunId) runIds.push(run.agentRunId);
    if (retro?.agentRunId) runIds.push(retro.agentRunId);
    const agentRun = run?.agentRunId ? store.agentRuns.get(run.agentRunId) : undefined;
    steps.push({
      step: 'L1 learning run', calls: 0,
      pass: runs.length === 1 && (run!.status === 'proposed' || run!.status === 'no_change') && agentRun?.status === 'done' && agentRun.role === 'retro',
      did: run
        ? `runs=${runs.length} status=${run.status}${run.failureReason ? ` failure=${short(run.failureReason, 120)}` : ''} agent=${agentRun?.status ?? 'none'} shown=${run.shownSignalIds.length} gate n=${run.stats.n} disagree=${run.stats.disagree} items=${run.stats.items}; retro digest=${JSON.stringify({ personasEvaluated: retro?.digest.personasEvaluated, personasQualified: retro?.digest.personasQualified, personaLearningRuns: retro?.digest.personaLearningRuns, personaProposals: retro?.digest.personaProposals })}`
        : `no learning run; retro=${retro ? `${retro.status} digest=${JSON.stringify(retro.digest)}` : 'none'}`,
    });
    const submits = bus.filter((c) => c.tool === 'submit_persona_learning');
    const decisions = run?.agentRunId ? store.decisions.list({ agentRunId: run.agentRunId }).filter((d) => (d.payload as { tool?: string }).tool === 'submit_persona_learning') : [];
    steps.push({
      step: 'L2 submit_persona_learning', calls: submits.length,
      pass: submits.filter((c) => c.ok).length === 1 && decisions.length === 1 && !!run?.assumption?.trim(),
      did: `ok=${submits.filter((c) => c.ok).length} refused=${submits.filter((c) => !c.ok).map((c) => short(c.error ?? '', 160)).join(' | ') || 0}; decisions=${decisions.length}; assumption="${short(run?.assumption ?? '', 200)}"`,
    });
    const proposals = repos.proposals.list({ personaId: s.persona.id });
    const shown = new Set(run?.shownSignalIds ?? []);
    const bad = proposals.filter(
      (p) => p.status !== 'pending' || p.runId !== run?.id || !p.evidence.every((id) => shown.has(id)) ||
        (p.action !== 'retire' && (p.evidence.length < 3 || p.text.length > ADJUSTMENT_TEXT_MAX)),
    );
    steps.push({
      step: 'L3 stored proposals', calls: 0,
      pass: bad.length === 0 && proposals.length <= 3 && (run?.status === 'proposed' ? proposals.length >= 1 : proposals.length === 0),
      did: proposals.length
        ? proposals.map((p) => `${p.action}${p.field ? ` (${p.field})` : ''} evidence=${p.evidence.length} "${short(p.text, 160)}"`).join('; ') + (bad.length ? `; bad=${bad.map((p) => p.id).join(',')}` : '')
        : 'no proposals (no_change)',
    });
    const persona = store.personas.get(s.persona.id)!;
    steps.push({
      step: 'L4 persona unchanged until the user decides', calls: 0,
      pass: persona.version === 1 && repos.adjustments.list({ personaId: persona.id }).length === 0,
      did: `version=${persona.version} adjustments=${repos.adjustments.list({ personaId: persona.id }).length}`,
    });
    for (const c of bus.filter((x) => !x.ok)) confusion.push(`${c.tool} failed: ${short(c.error ?? '', 160)}`);
    return {
      name, pass: steps.every((x) => x.pass), seconds: (Date.now() - started) / 1000, steps, usage: usageOf(booted, runIds), toolCalls, confusion,
      detail: `retro=${retro?.status ?? 'none'}; learning run=${run?.status ?? 'none'}; promptStoreGaps=${JSON.stringify(promptStoreGaps(store))}`,
    };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - started) / 1000, detail: `threw: ${(e as Error).message}`, steps, usage: usageOf(booted, runIds), toolCalls, confusion };
  }
}

// ---------------------------------------------------------------------------
// stakeholder personas smoke (stakeholder design 2026-11-15 §18)

const SH_COMPANY = 'Larkspur Freight';
/** Internal notes about a fictional company (uploads: the own-stakeholder task reads what the store holds, never the web). */
const SH_NOTES: Array<{ name: string; text: string }> = [
  {
    name: 'org-notes.txt',
    text: `${SH_COMPANY} org notes. The chief financial officer approves every spend above 10,000 EUR and asks for the payback period first; ` +
      'last quarter she turned down a new routing tool because it paid back in three years.',
  },
  {
    name: 'platform-notes.txt',
    text: 'The billing platform team runs invoicing for every product line. Any change to invoices needs two weeks of notice and a slot ' +
      'on their quarterly roadmap; they refuse changes during the month-end close.',
  },
  {
    name: 'board-minutes.txt',
    text: `Board minutes, ${SH_COMPANY}: the board approves new markets and any price change above 5%. It asked for a churn forecast ` +
      'before the next price proposal.',
  },
];

/** Names of the tools a run's CLI offered (Claude's stream-json `system/init` line in stdout.log); undefined when not found. */
function offeredTools(dataDir: string, wsId: string, agentRunId: string): string[] | undefined {
  const path = join(runDirOf(dataDir, wsId, agentRunId), 'stdout.log');
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const d = JSON.parse(line) as { type?: string; subtype?: string; tools?: unknown };
      if (d.type === 'system' && d.subtype === 'init' && Array.isArray(d.tools)) return d.tools.map(String);
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/** Tool names in a run's events.jsonl (`tool_call` events; MCP prefixes already stripped by the adapter). */
function calledTools(dataDir: string, wsId: string, agentRunId: string): string[] {
  const path = join(runDirOf(dataDir, wsId, agentRunId), 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      const e = JSON.parse(l) as { t?: string; name?: string };
      return e.t === 'tool_call' && typeof e.name === 'string' ? [e.name] : [];
    });
}

async function stakeholdersSmoke(provider: ProviderId, booted: Booted): Promise<FlResult> {
  const { store, artifacts, config, events, research, dataDir } = booted.runtime;
  const name = `stakeholders/${provider} (${MODELS[provider]})`;
  const startedAt = Date.now();
  const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const steps: FlStep[] = [];
  const confusion: string[] = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS * 3);
  const wsId = `ws_smoke_stakeholders_${provider}`;
  let runIds: string[] = [];
  try {
    const now = new Date().toISOString();
    store.workspaces.insert({
      id: wsId, name: SH_COMPANY, sector: 'logistics', createdAt: now, scope: { level: 'company', name: SH_COMPANY, description: 'a fictional freight company' },
    });
    const notes = SH_NOTES.map((n) => uploadInternal(wsId, { name: n.name, bytes: new TextEncoder().encode(n.text), mime: 'text/plain' }, { store, artifacts, config }).id);
    const rr = store.researchRuns.insert({ id: newId('rrun'), workspaceId: wsId, phase: 'stakeholders', status: 'running', startedAt: now });
    const task = store.tasks.insert({
      id: newId('tsk'), workspaceId: wsId, runId: rr.id, phase: 'stakeholders', type: 'own_stakeholders', round: 1, createdAt: now,
      model: { provider, model: MODELS[provider] }, needsBrowser: false, status: 'queued',
      acceptanceCriteria: ['each stakeholder cites the internal notes it rests on'],
      brief: `Identify the people, teams and boards whose approval, budget or data ${SH_COMPANY} depends on, from its internal notes.`,
    });
    const bus: ToolCallLog[] = [];
    const off = events.on((e) => {
      if (e.type === 'tool_call' && e.workspaceId === wsId) bus.push({ tool: e.tool, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
    });
    let final: Awaited<ReturnType<typeof runTaskWithReview>>;
    try {
      final = await runTaskWithReview(task, { ...research, signal: abort.signal });
    } finally {
      off();
    }
    // The phase-end step of the `stakeholders` phase (orchestrator `afterPhase`).
    const created = ensureQuestions(store, wsId);
    store.researchRuns.update(rr.id, { status: 'done', endedAt: new Date().toISOString() });

    const runs = store.agentRuns.list({ workspaceId: wsId }).filter((r) => r.taskId === task.id);
    runIds = runs.map((r) => r.id);
    const harness = new Set<string>(TOOL_NAMES);
    const perRun = runs.map((r) => {
      // A run on a provider that cannot enforce offline is refused before its CLI starts (no tools at all).
      const refused = (r.failureReason ?? '').includes(offlineRefusal(r.model.provider));
      const offered = offeredTools(dataDir, wsId, r.id);
      const builtInOffered = offered?.filter((t) => !t.startsWith('mcp__bif__')) ?? [];
      const builtInCalled = calledTools(dataDir, wsId, r.id).filter((t) => !harness.has(t));
      // Claude prints the tools it offers; for the other CLIs only the calls can be checked.
      const ok = builtInCalled.length === 0 && (refused || r.model.provider !== 'claude' || (offered !== undefined && builtInOffered.length === 0));
      return { r, refused, offered, builtInOffered, builtInCalled, ok };
    });
    const started = perRun.filter((x) => !x.refused);
    steps.push({
      step: 'S1 offline: no built-in tool', calls: 0,
      pass: started.length > 0 && perRun.every((x) => x.ok),
      did: perRun.map((x) => `${x.r.role} ${x.r.model.provider}/${x.r.model.model} ${x.r.status}: ${x.refused ? 'refused (offline)' : `offered=${x.offered ? `${x.offered.length} (${x.builtInOffered.length} built-in${x.builtInOffered.length ? `: ${x.builtInOffered.join(',')}` : ''})` : 'unknown'} built-in calls=${x.builtInCalled.length}${x.builtInCalled.length ? ` (${x.builtInCalled.join(',')})` : ''}`}${x.r.failureReason && !x.refused ? ` failure=${short(x.r.failureReason, 100)}` : ''}`).join('; ') || 'no runs',
    });

    const own = stakeholderPersonas(store, wsId).filter((p) => p.subjectKind === 'own');
    const hidden = own.filter(isHidden);
    const { maxOwn } = stakeholdersSettings(config);
    const cites = (p: (typeof own)[number]) =>
      Object.values(p.profile).some((f) => (f?.evidence ?? []).some((id) => typeof id === 'string' && notes.includes(id)));
    steps.push({
      step: 'S2 hidden own stakeholders', calls: bus.filter((c) => c.tool === 'save_stakeholder').length,
      pass: hidden.length >= 1 && hidden.length === own.length && own.length <= maxOwn && own.every(cites),
      did: `task ${final.status} (round ${final.round}); own=${own.length} hidden=${hidden.length}: ${own.map((p) => `${p.segment} (${p.stakeholderType}, ${p.status}, cites notes=${cites(p)})`).join('; ')}`,
    });

    const repo = stakeholderRepos(store).questions;
    const askable = hidden.filter((p) => p.status !== 'superseded' && p.status !== 'failed');
    const templated = askable.every((p) => {
      const qs = repo.list({ personaId: p.id, status: 'open' });
      const templates = p.stakeholderType === 'team' || p.stakeholderType === 'system' ? SYSTEM_TEMPLATES : PEOPLE_TEMPLATES;
      return qs.length === 4 && templates.every((t) => qs.some((q) => q.field === t.field && q.text === questionText(t.text, p.segment)));
    });
    const nodeQs = repo.list({ workspaceId: wsId, status: 'open' }).filter((q) => !q.personaId);
    steps.push({
      step: 'S3 question round', calls: 0,
      pass: askable.length >= 1 && templated && nodeQs.length === NODE_QUESTIONS.length,
      did: `created=${created.length}; per stakeholder ${askable.map((p) => `${p.segment}=${repo.list({ personaId: p.id, status: 'open' }).length}`).join(', ')}; node questions=${nodeQs.length}; texts are the templates=${templated}`,
    });

    const w = withholding(store);
    steps.push({ step: 'S4 research withheld while hidden', calls: 0, pass: w.task(store.tasks.get(task.id)), did: `task withheld=${w.task(store.tasks.get(task.id))}` });

    for (const c of bus.filter((x) => !x.ok)) confusion.push(`${c.tool} failed: ${short(c.error ?? '', 160)}`);
    return {
      name, pass: steps.every((x) => x.pass), seconds: (Date.now() - startedAt) / 1000, steps, usage: usageOf(booted, runIds), toolCalls: bus.length, confusion,
      detail: `task=${final.status}; runs=${runs.map((r) => `${r.role}:${r.status}`).join(',')}; promptStoreGaps=${JSON.stringify(promptStoreGaps(store))}`,
    };
  } catch (e) {
    return { name, pass: false, seconds: (Date.now() - startedAt) / 1000, detail: `threw: ${(e as Error).message}`, steps, usage: usageOf(booted, runIds), toolCalls: 0, confusion };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = ['worker', 'interview', 'browser', 'knowledge', 'flows', 'persona-learning', 'stakeholders'].includes(args[0] ?? '') ? args.shift()! : 'all';
  const only = args.filter((a): a is ProviderId => (PROVIDERS as string[]).includes(a));
  const providers = only.length ? only : PROVIDERS;
  const results: Result[] = [];

  if (mode === 'all' || mode === 'worker') {
    const { booted, dir } = await startServer('worker');
    try {
      for (const p of providers) {
        console.log(`[smoke] worker ${p} (${MODELS[p]}) …`);
        const r = await workerSmoke(p, booted);
        console.log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.seconds.toFixed(1)}s — ${r.detail}`);
        results.push(r);
        if (p === 'codex') {
          const iso = codexIsolationCheck(booted);
          console.log(`[smoke] ${iso.pass ? 'PASS' : 'FAIL'} ${iso.name} — ${iso.detail}`);
          results.push(iso);
        }
      }
    } finally {
      await booted.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (mode === 'all' || mode === 'browser') {
    for (const p of only.length ? only : (['claude'] as ProviderId[])) {
      console.log(`[smoke] browser ${p} (${MODELS[p]}) …`);
      const r = await browserSmoke(p);
      console.log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.seconds.toFixed(1)}s — ${r.detail}`);
      results.push(r);
    }
  }
  if (mode === 'all' || mode === 'knowledge') {
    const { booted, dir } = await startServer('knowledge');
    try {
      for (const p of providers) {
        console.log(`[smoke] knowledge ${p} (${MODELS[p]}) …`);
        const r = await knowledgeSmoke(p, booted, dir);
        printKnowledge(r);
        results.push(r);
      }
    } finally {
      await booted.close();
      if (process.env.BIF_SMOKE_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
      else console.log(`[smoke] kept ${dir}`);
    }
  }
  if (mode === 'all' || mode === 'flows') {
    const { booted, dir } = await startServer('flows');
    try {
      for (const p of providers) {
        console.log(`[smoke] flows ${p} (${MODELS[p]}) …`);
        const r = await flowsSmoke(p, booted);
        printKnowledge(r);
        results.push(r);
      }
    } finally {
      await booted.close();
      if (process.env.BIF_SMOKE_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
      else console.log(`[smoke] kept ${dir}`);
    }
  }
  if (mode === 'persona-learning') {
    const { booted, dir } = await startServer('persona-learning');
    try {
      for (const p of only.length ? only : (['claude'] as ProviderId[])) {
        console.log(`[smoke] persona-learning ${p} (${MODELS[p]}) …`);
        const r = await personaLearningSmoke(p, booted);
        printKnowledge(r);
        results.push(r);
      }
    } finally {
      await booted.close();
      if (process.env.BIF_SMOKE_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
      else console.log(`[smoke] kept ${dir}`);
    }
  }
  if (mode === 'stakeholders') {
    const shProviders = only.length ? only : (['claude'] as ProviderId[]);
    const { booted, dir } = await startServer('stakeholders', { defaultEnabled: true, providers: shProviders });
    try {
      for (const p of shProviders) {
        console.log(`[smoke] stakeholders ${p} (${MODELS[p]}) …`);
        const r = await stakeholdersSmoke(p, booted);
        printKnowledge(r);
        results.push(r);
      }
    } finally {
      await booted.close();
      if (process.env.BIF_SMOKE_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
      else console.log(`[smoke] kept ${dir}`);
    }
  }
  if (mode === 'all' || mode === 'interview') {
    console.log(`[smoke] interview (claude ${MODELS.claude}) …`);
    const r = await interviewSmoke();
    console.log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.seconds.toFixed(1)}s — ${r.detail}`);
    results.push(r);
  }

  console.log('\n| Check | Result | Time | Detail |\n|---|---|---|---|');
  for (const r of results) console.log(`| ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.seconds.toFixed(1)}s | ${r.detail.replace(/\|/g, '\\|')} |`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

void main();
