/**
 * Real-CLI smoke test (Task 18). Spends a few cents of real model usage.
 *
 *   npx tsx scripts/smoke.ts                       # worker + interview smokes, all providers
 *   npx tsx scripts/smoke.ts worker claude codex   # worker smoke for the named providers only
 *   npx tsx scripts/smoke.ts interview             # interview smoke only (claude)
 *   npx tsx scripts/smoke.ts browser [providers]   # browser smoke (default: claude)
 *   npx tsx scripts/smoke.ts knowledge [providers] # knowledge-store flow (KS-8), per provider
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
 * codex isolation (with the codex worker smoke): `codex mcp list --json` under the exact env and
 *            `-c` overrides the adapter gives a run must list only `bif`.
 *
 * Model overrides: BIF_SMOKE_CLAUDE_MODEL (default haiku), BIF_SMOKE_CODEX_MODEL (default
 * gpt-6.1-sol), BIF_SMOKE_OPENCODE_MODEL (default opencode/big-pickle).
 * BIF_SMOKE_TIMEOUT_MS bounds each run (default 300000). BIF_SMOKE_KEEP=1 keeps the knowledge smoke's
 * temp dir (data dir with bif.db and each run's events.jsonl) for inspection.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, type Booted } from '../src/api/main.js';
import { defaultConfig, type BifConfig, type ProviderId } from '../src/core/config/schema.js';
import { ArtifactStore } from '../src/core/evidence/artifacts.js';
import { CodexAdapter } from '../src/core/harness/adapters/codex.js';
import { browserPromptNote } from '../src/core/harness/browser.js';
import { getRunOutputs } from '../src/core/harness/tools/handlers.js';
import { promptVersion } from '../src/core/prompts/index.js';
import { promptStoreGaps } from '../src/core/prompts/store.js';
import { workerSystemPrompt } from '../src/core/research/systemPrompts.js';
import { knowledgeRepos, newId } from '../src/core/store/repos.js';
import { usageRepos } from '../src/core/store/usageRepos.js';

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

/** Config with every provider enabled (only the smoke model each) and all roles on claude. */
function smokeConfig(dataDir: string, port: number): BifConfig {
  const cfg = structuredClone(defaultConfig) as BifConfig;
  for (const p of PROVIDERS) cfg.providers[p] = { ...cfg.providers[p], enabled: true, models: [MODELS[p]] };
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

async function startServer(label: string): Promise<{ booted: Booted; dir: string; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), `bif-smoke-${label}-`));
  const port = await freePort();
  const configPath = join(dir, 'bif.config.json');
  writeFileSync(configPath, JSON.stringify(smokeConfig(join(dir, 'data'), port), null, 2));
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
<p>Customer data is stored in two data centres in the European Union and backed up every night. Backups are kept for 35 days.</p>
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
    '6. Read the whole extracted text of the page with `read_artifact` (mode "text", max_tokens 150), following the',
    '   returned cursor until the response is no longer truncated.',
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
    return { name, ...judgeKnowledge(booted, out, bus, { wsId, taskId: task.id, priorId: prior.id }), seconds: (Date.now() - started) / 1000 };
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

function judgeKnowledge(
  booted: Booted,
  out: Awaited<ReturnType<Booted['runtime']['supervisor']['run']>>,
  bus: ToolCallLog[],
  ids: { wsId: string; taskId: string; priorId: string },
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

  // 7. rejected quote, then recovery
  const s7 = findingCalls(/enterprise/i);
  const rejected = s7.filter((c) => !c.ok && /quote not found/.test(c.error ?? ''));
  const enterprise = findings.filter((f) => /enterprise/i.test(f.claim));
  const wrongSaved = enterprise.some((f) => /\$\s?199/.test(f.claim));
  const recovered = enterprise.filter((f) => !/\$\s?199/.test(f.claim) && quoted(f).length > 0);
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

async function main() {
  const args = process.argv.slice(2);
  const mode = ['worker', 'interview', 'browser', 'knowledge'].includes(args[0] ?? '') ? args.shift()! : 'all';
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
