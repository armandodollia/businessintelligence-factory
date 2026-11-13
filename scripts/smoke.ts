/**
 * Real-CLI smoke test (Task 18). Spends a few cents of real model usage.
 *
 *   npx tsx scripts/smoke.ts                       # worker + interview smokes, all providers
 *   npx tsx scripts/smoke.ts worker claude codex   # worker smoke for the named providers only
 *   npx tsx scripts/smoke.ts interview             # interview smoke only (claude)
 *   npx tsx scripts/smoke.ts browser [providers]   # browser smoke (default: claude)
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
 * codex isolation (with the codex worker smoke): `codex mcp list --json` under the exact env and
 *            `-c` overrides the adapter gives a run must list only `bif`.
 *
 * Model overrides: BIF_SMOKE_CLAUDE_MODEL (default haiku), BIF_SMOKE_CODEX_MODEL (default
 * gpt-6.1-sol), BIF_SMOKE_OPENCODE_MODEL (default opencode/big-pickle).
 * BIF_SMOKE_TIMEOUT_MS bounds each run (default 300000).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, type Booted } from '../src/api/main.js';
import { defaultConfig, type BifConfig, type ProviderId } from '../src/core/config/schema.js';
import { ArtifactStore } from '../src/core/evidence/artifacts.js';
import { CodexAdapter } from '../src/core/harness/adapters/codex.js';
import { browserPromptNote } from '../src/core/harness/browser.js';
import { getRunOutputs } from '../src/core/harness/tools/handlers.js';

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

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] === 'worker' || args[0] === 'interview' || args[0] === 'browser' ? args.shift()! : 'all';
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
