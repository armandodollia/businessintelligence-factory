/**
 * Where the input tokens of an agent run go (docs/context-measurements.md). Usage:
 *
 *   npx tsx scripts/measure-context.ts --no-model            # part A only: sizes, no model call
 *   npx tsx scripts/measure-context.ts                       # part A + every real run of part B
 *   npx tsx scripts/measure-context.ts --runs overhead,research   # part A + the named run groups only
 *   npx tsx scripts/measure-context.ts --reanalyze <dir>     # part B tables again from a kept capture dir
 *   npx tsx scripts/measure-context.ts --runs research --pages 1   # only the first research page (and its reviewer)
 *
 * Run groups (part B): `overhead` (Claude: smallest tool list, worker list, worker + browser list),
 * `codex` (Codex: smallest and worker list), `research` (3 browser research runs on public pages, and one
 * reviewer run on the first one's task), `worker` (a non-browser worker on a local page copy), `interviewer`
 * (one interview message over HTTP). At most 9 Claude runs and 2 Codex runs per full invocation.
 *
 * Part A (no model): per role, the system prompt BIF gives it and its tool list as `tools/list` serves it
 * (read over HTTP from the real MCP endpoint with a run token); per worker task type, the system prompt
 * and the tool list a task of that type plausibly needs (`NEEDS`, see its comment); the research browser's
 * tool list (the shipped `@playwright/mcp` started on a free port, listing only: no browser opens) and the
 * subset a research worker is told to use; typical work prompts and knowledge briefings on a seeded tree.
 *
 * Part B (real runs, cheapest models): every run goes through the real Supervisor of a freshly booted
 * server (temporary data dir and config, removed afterwards). From each run's kept raw output
 * (`stdout.log`): the CLI's usage, the context size of every model call (Claude reports it per message),
 * and every tool call with the size of its arguments and of its result. From those: the fixed overhead
 * of each CLI and of each tool list, where the tokens of a run go, and two offline rules for browser
 * results tested on the captured results (cap at N tokens; main content only).
 *
 * Token estimates are characters / 4 (as scripts/measure-knowledge.ts); measured numbers come from the
 * CLIs' usage reports. Env: BIF_MEASURE_CLAUDE_MODEL (default haiku), BIF_MEASURE_CODEX_MODEL (default
 * gpt-6.1-sol), BIF_MEASURE_TIMEOUT_MS (default 300000), BIF_MEASURE_KEEP=1 keeps the capture dir and
 * data dirs (the capture dir is always kept when part B ran: it is what `--reanalyze` reads).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type Booted } from '../src/api/main.js';
import { defaultConfig, TASK_TYPES, type BifConfig, type ProviderId, type TaskType } from '../src/core/config/schema.js';
import { escalationPrompt, escalationSystemPrompt } from '../src/core/escalation/escalation.js';
import { withSystemBlock } from '../src/core/harness/adapter.js';
import { CodexAdapter } from '../src/core/harness/adapters/codex.js';
import { browserPromptNote } from '../src/core/harness/browser.js';
import { claudeFolders, claudeProjectDirName, cliSessionId } from '../src/core/harness/cliLeftovers.js';
import { linkLogin } from '../src/core/harness/platform.js';
import { runCwdOf, runDirOf } from '../src/core/harness/paths.js';
import { getRunOutputs } from '../src/core/harness/tools/handlers.js';
import { ROLE_TOOLS, type ToolName } from '../src/core/harness/tools/registry.js';
import { buildInterviewPrompt } from '../src/core/interview/interview.js';
import { backfillKnowledge } from '../src/core/knowledge/backfill.js';
import { retroSystemPrompt } from '../src/core/learning/lessons/retro.js';
import { compileAgentMd } from '../src/core/market/agentMd.js';
import { loadPrompt, promptTemplate } from '../src/core/prompts/index.js';
import { orchestratorPrompt } from '../src/core/research/orchestrator.js';
import { PRIVATE_TASK_TOOLS } from '../src/core/research/phases.js';
import { reviewerRunInput, roleForTask, workPrompt } from '../src/core/research/reviewLoop.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../src/core/research/systemPrompts.js';
import { PERSONA_FIELDS } from '../src/core/scoring/criteria.js';
import type { Store } from '../src/core/store/db.js';
import { knowledgeRepos, newId } from '../src/core/store/repos.js';
import type { Persona, Role, Task } from '../src/core/types.js';

// ---------------------------------------------------------------------------------------------------
// options

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NO_MODEL = flag('no-model');
const REANALYZE = opt('reanalyze');
const GROUPS = ['overhead', 'builtin', 'codex', 'research', 'worker', 'interviewer'] as const;
type Group = (typeof GROUPS)[number];
const RUN_GROUPS: Group[] = NO_MODEL ? [] : ((opt('runs')?.split(',') ?? [...GROUPS]) as Group[]);
for (const g of RUN_GROUPS) if (!GROUPS.includes(g)) throw new Error(`unknown run group '${g}' (known: ${GROUPS.join(', ')})`);
const KEEP = process.env.BIF_MEASURE_KEEP === '1';
const CLAUDE_MODEL = process.env.BIF_MEASURE_CLAUDE_MODEL ?? 'haiku';
const CODEX_MODEL = process.env.BIF_MEASURE_CODEX_MODEL ?? 'gpt-6.1-sol';
const TIMEOUT_MS = Number(process.env.BIF_MEASURE_TIMEOUT_MS ?? 300_000);
const MODELS: Record<'claude' | 'codex', string> = { claude: CLAUDE_MODEL, codex: CODEX_MODEL };
/** `--pages 1,3`: only these research pages (1-based; the reviewer runs only with page 1). Default: all. */
const PAGE_PICK = opt('pages')?.split(',').map(Number);

/** Estimated tokens: characters / 4 (the estimate used across BIF's measurements). */
const est = (chars: number) => Math.ceil(chars / 4);
const k = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function table(title: string, head: string[], rows: Array<Array<string | number>>): void {
  console.log(`\n### ${title}\n`);
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`);
  for (const r of rows) console.log(`| ${r.map((c) => (typeof c === 'number' ? k(c) : c)).join(' | ')} |`);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------
// a booted server on a temporary data dir and config

type Server = { booted: Booted; dir: string; base: string };

function measureConfig(dataDir: string, port: number): BifConfig {
  const cfg = structuredClone(defaultConfig) as BifConfig;
  cfg.providers.claude = { ...cfg.providers.claude, enabled: true, models: [CLAUDE_MODEL] };
  cfg.providers.codex = { ...cfg.providers.codex, enabled: true, models: [CODEX_MODEL] };
  cfg.providers.opencode = { ...cfg.providers.opencode, enabled: false };
  const claude = { provider: 'claude' as const, model: CLAUDE_MODEL };
  cfg.roles = { ...cfg.roles, orchestrator: claude, interviewer: claude, reviewer: claude, synthesizer: claude, persona: claude, workers: { default: claude } };
  cfg.limits = { ...cfg.limits, idleTimeoutMs: Math.min(cfg.limits.idleTimeoutMs, TIMEOUT_MS) };
  cfg.browser = { ...cfg.browser, profileDir: join(dataDir, 'browser-profile') };
  if (cfg.browser.shared) cfg.browser.shared = { ...cfg.browser.shared, args: [...cfg.browser.shared.args, '--headless'] };
  cfg.dataDir = dataDir;
  cfg.server = { ...cfg.server, port };
  return cfg;
}

async function startServer(label: string): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), `bif-measure-${label}-`));
  const port = await freePort();
  const configPath = join(dir, 'bif.config.json');
  writeFileSync(configPath, JSON.stringify(measureConfig(join(dir, 'data'), port), null, 2));
  const booted = await boot({ configPath, dataDir: join(dir, 'data'), port });
  return { booted, dir, base: `http://127.0.0.1:${port}` };
}

async function stopServer(s: Server): Promise<void> {
  await s.booted.close();
  if (!KEEP) rmSync(s.dir, { recursive: true, force: true });
  else console.error(`[measure] kept ${s.dir}`);
}

// ---------------------------------------------------------------------------------------------------
// tool lists as served over MCP

type ToolDef = { name: string; description?: string; inputSchema?: unknown };
/** Characters of one tool as a CLI hands it to the model: name, description and input schema as JSON. */
const toolChars = (t: ToolDef) => JSON.stringify({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} }).length;

async function listTools(url: string, headers: Record<string, string> = {}): Promise<ToolDef[]> {
  const client = new Client({ name: 'measure-context', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as ToolDef[];
  } finally {
    await client.close();
  }
}

/** `tools/list` of a role from the real MCP endpoint, with a token issued for a measurement run. */
async function bifToolsOf(s: Server, wsId: string, role: Role): Promise<ToolDef[]> {
  const { tokens } = s.booted.runtime;
  const token = tokens.issue({ agentRunId: newId('arun'), workspaceId: wsId, role, model: { provider: 'claude', model: CLAUDE_MODEL }, promptVersion: 'measure' });
  try {
    return await listTools(`${s.base}/mcp/${token}`);
  } finally {
    tokens.revoke(token);
  }
}

// ---------------------------------------------------------------------------------------------------
// the research browser (shipped @playwright/mcp), listing only

const PLAYWRIGHT_CLI = resolve(import.meta.dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');

/** Starts the shipped browser server on a free port (it only listens: no browser opens until a tool is called). */
async function startBrowser(): Promise<{ url: string; pid: number | undefined; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'bif-measure-browser-'));
  const port = await freePort();
  const child = spawn(process.execPath, [
    PLAYWRIGHT_CLI, '--host', '127.0.0.1', '--port', String(port), '--shared-browser-context', '--headless',
    '--user-data-dir', join(dir, 'profile'), '--output-dir', join(dir, 'out'), '--file-paths', 'absolute',
  ], { stdio: 'ignore', cwd: dir });
  const pid = child.pid;
  const url = `http://127.0.0.1:${port}/mcp`;
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await sleep(250);
    }
  }
  const stop = async () => {
    // Stop exactly the process started here, by its id.
    if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // gone
      }
      for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
      if (child.exitCode === null && child.signalCode === null) process.kill(pid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { url, pid, stop };
}

// ---------------------------------------------------------------------------------------------------
// Codex: the model-visible input of a run, rendered without a model call (`codex debug prompt-input`)

type CodexInput = { total: number; sections: Array<{ name: string; chars: number }> };

/**
 * Builds the exact command the Codex adapter gives a run (isolated CODEX_HOME, the `-c` MCP overrides, the
 * bearer token in the environment) and asks Codex to render what the model would see, instead of running it.
 */
async function codexPromptInput(s: Server, wsId: string, role: Role, browserUrl?: string): Promise<CodexInput> {
  const { tokens, config } = s.booted.runtime;
  const token = tokens.issue({ agentRunId: newId('arun'), workspaceId: wsId, role, model: { provider: 'codex', model: CODEX_MODEL }, promptVersion: 'measure' });
  const cwd = mkdtempSync(join(tmpdir(), 'bif-measure-codex-'));
  try {
    const built = new CodexAdapter(config.providers.codex.command).buildCommand({
      prompt: ONE_LINE_PROMPT, systemPrompt: ONE_LINE_SYSTEM, model: CODEX_MODEL, mcpUrl: `${s.base}/mcp/${token}`, mcpBearer: { url: `${s.base}/mcp`, token },
      extraMcpServers: browserUrl ? { browser: { type: 'http', url: browserUrl } } : {}, cwd, stateDir: join(cwd, 'cli-state'),
    });
    for (const f of built.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    for (const l of built.links ?? []) linkLogin(l.path, l.target);
    const overrides = built.args.flatMap((x, i) => (built.args[i - 1] === '-c' ? ['-c', x] : []));
    const out = await new Promise<string>((ok, fail) => {
      execFile(built.cmd, ['debug', 'prompt-input', ...overrides, '-c', `model=${JSON.stringify(CODEX_MODEL)}`, withSystemBlock(ONE_LINE_SYSTEM, ONE_LINE_PROMPT)], {
        env: { ...process.env, ...built.env }, cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      }, (err, stdout) => (err ? fail(err) : ok(stdout)));
    });
    const items = JSON.parse(out) as Array<Record<string, unknown>>;
    const sections: CodexInput['sections'] = [];
    for (const it of items) {
      if (it.type === 'additional_tools') {
        for (const ns of (it.tools as Array<Record<string, unknown>>) ?? []) sections.push({ name: `tools: ${String(ns.name ?? ns.type)}`, chars: JSON.stringify(ns).length });
      } else {
        const text = ((it.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? '').join('');
        const tag = /^<([a-z_]+)>/.exec(text.trimStart())?.[1] ?? (text.startsWith('You are Codex') ? 'Codex base instructions' : text.startsWith('<system>') ? 'BIF system + task prompt' : 'other');
        sections.push({ name: `${String(it.role)}: ${tag}`, chars: JSON.stringify(it).length });
      }
    }
    return { total: sum(sections.map((x) => x.chars)), sections };
  } finally {
    tokens.revoke(token);
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Browser tools a research worker is told to use. The worker prompt's browser section (`browserPromptNote`)
 * says: open a new tab, work only in it, close it; keep screenshots via `save_artifact`. Reading a page needs
 * navigate and a snapshot (or a screenshot); following a link needs click / back / wait. Flow walkthroughs
 * (flow_walkthrough.md: sign-up, forms, one screenshot per step) also type, fill forms, press keys, pick
 * options and answer dialogs. Derived from the prompts, not enforced by any code.
 */
const BROWSER_READING = ['browser_tabs', 'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_click', 'browser_wait_for'];
const BROWSER_WALKTHROUGH = [...BROWSER_READING, 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_handle_dialog', 'browser_hover'];

// ---------------------------------------------------------------------------------------------------
// the worker tools each task type plausibly needs

/**
 * Derived from the system prompt each task type gets (`workerSystemPrompt`: worker.md plus the task type's
 * own prompt file), the phase goals (research/phases.ts) and the code that refuses tools:
 * - `own_stakeholders`: `taskToolRefusal` refuses every tool outside `PRIVATE_TASK_TOOLS` (sure: code).
 * - `save_stakeholder`: its handler refuses it outside the two stakeholder task types (sure: code).
 * - the rest: the tools a task type's prompt tells it to use (fairly sure), plus a core every research task
 *   uses (worker.md "How to work" and "Knowledge store": save evidence, save / confirm / retract findings,
 *   search before saving, read artifacts, log decisions, submit, answer the review). Asking the user
 *   (`request_user_action`, `request_approval`, `get_identity`) only for task types that sign up or walk
 *   flows. Rarely needed and left out: `read_workspace`, `list_changes`, `describe_artifact` (worker.md
 *   names the first as an alternative to `search`); `propose_checklist` is named by no prompt at all.
 */
const CORE: ToolName[] = [
  'log_decision', 'save_artifact', 'save_finding', 'confirm_finding', 'retract_finding', 'submit_result', 'respond_to_review',
  'search', 'get_card', 'expand', 'read_artifact',
];
const ASK: ToolName[] = ['request_user_action', 'request_approval', 'get_identity'];
const FLOW: ToolName[] = ['read_flow_catalog', 'save_flow', 'save_flow_checks', 'propose_flow_type'];
type Need = { tools: ToolName[]; basis: string; sure: 'code' | 'prompt' | 'guess' | 'n/a' };
const NEEDS: Record<TaskType, Need> = {
  audience_segments: { tools: [...CORE, 'save_persona'], basis: 'persona_profile.md is attached', sure: 'prompt' },
  persona_profile: { tools: [...CORE, 'save_persona'], basis: 'persona_profile.md is attached', sure: 'prompt' },
  discover_competitors: { tools: [...CORE, 'save_competitor'], basis: 'competitors.md is attached', sure: 'prompt' },
  flow_walkthrough: { tools: [...CORE, ...ASK, ...FLOW, 'save_competitor'], basis: 'flow_walkthrough.md + competitors.md; signs up', sure: 'prompt' },
  flow_reviews: { tools: [...CORE, 'read_flow_catalog', 'save_review_mentions'], basis: 'flow_reviews.md', sure: 'prompt' },
  news_scan: { tools: [...CORE], basis: 'worker.md only', sure: 'prompt' },
  public_filings: { tools: [...CORE], basis: 'worker.md + one-line note', sure: 'prompt' },
  customer_pain_points: { tools: [...CORE], basis: 'worker.md only', sure: 'prompt' },
  own_company_audit: { tools: [...CORE, ...ASK, ...FLOW, 'save_review_mentions'], basis: 'deep_dives goal: same task types on the own company', sure: 'guess' },
  symptom_hypotheses: { tools: [...CORE, 'save_hypothesis'], basis: 'hypotheses.md is attached', sure: 'prompt' },
  synthesize_recommendations: { tools: ROLE_TOOLS.synthesizer.filter((t) => !['request_user_action', 'request_approval', 'list_changes', 'describe_artifact', 'read_workspace'].includes(t)), basis: 'synthesizer role (synthesizer.md)', sure: 'prompt' },
  persona_panel: { tools: [], basis: 'phase runs personas, no worker run', sure: 'n/a' },
  map_business_units: { tools: [...CORE, 'propose_business_unit', 'read_workspace'], basis: 'worker.md + mapping goal', sure: 'prompt' },
  own_stakeholders: { tools: ROLE_TOOLS.worker.filter((t) => PRIVATE_TASK_TOOLS.has(t)), basis: 'taskToolRefusal allows only PRIVATE_TASK_TOOLS', sure: 'code' },
  competitor_stakeholders: { tools: [...CORE, 'save_stakeholder'], basis: 'competitor_stakeholders.md; save_stakeholder refused elsewhere', sure: 'code' },
};

// ---------------------------------------------------------------------------------------------------
// seeded tree for typical prompts (as scripts/measure-knowledge.ts)

const SUBJECTS = ['Rival', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Acme', 'Vandelay', 'Stark', 'Wayne', 'Wonka'];

function seedTree(store: Store, findings: number) {
  const ws = (id: string, name: string, parent?: string, level = 'company') =>
    store.workspaces.insert({
      id, name, sector: 'saas', createdAt: '2026-11-01T00:00:00Z', scope: { level, name, description: '' } as never,
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('ws_co', 'Acme');
  ws('ws_pay', 'Payments', 'ws_co', 'division');
  ws('ws_lend', 'Lending', 'ws_co', 'division');
  ws('ws_cards', 'Cards', 'ws_pay', 'slice');
  const nodes = ['ws_co', 'ws_pay', 'ws_lend', 'ws_cards'];
  for (let i = 0; i < findings; i++) {
    const s = SUBJECTS[i % 10]!;
    store.findings.insert({
      id: newId('fnd'), workspaceId: nodes[i % 4]!, runId: 'rrun_seed', taskId: 'tsk_seed', subject: s,
      claim: `${s} observation number ${i}: pricing tier ${i % 7} costs $${10 + (i % 40)} per seat per month and onboarding takes ${i % 9} steps`,
      criteria: { relevance: 4 }, evidence: [], status: i % 5 === 0 ? 'unverified' : 'verified', createdAt: '2026-10-01T00:00:00Z',
    });
  }
  backfillKnowledge(store);
}

/** A persona as a panel run sees it: every profile field with a ~300-character value (an assumption). */
function syntheticPersona(): Persona {
  const value = 'Runs a small team and decides on tools after a short trial; values clear pricing, quick setup and support that answers the same day. '.repeat(2).trim();
  const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value, confidence: 0.7, evidence: ['art_01JABCDEFGHJKMNPQRSTVWXYZ0', 'art_01JABCDEFGHJKMNPQRSTVWXYZ1'] }]));
  return { id: 'per_x', workspaceId: 'ws_pay', slug: 'small-team-lead', segment: 'Small-team leads buying payment tools', profile, agentMdPath: '', version: 3, audience: 'external' };
}

// ---------------------------------------------------------------------------------------------------
// part A

type PartA = {
  roleTools: Record<string, { tools: number; chars: number; perTool: Array<{ name: string; chars: number }> }>;
  browser: { tools: number; chars: number; perTool: Array<{ name: string; chars: number }>; reading: number; walkthrough: number; serverInstructions?: number };
  systemPrompts: Record<string, number>;
  codex?: Array<{ variant: string } & CodexInput>;
};

async function partA(): Promise<PartA> {
  const s = await startServer('a');
  try {
    const { store, config } = s.booted.runtime;
    seedTree(store, 100);
    const roles = Object.keys(ROLE_TOOLS) as Role[];

    // --- tool lists per role (real tools/list) ---
    const roleTools: PartA['roleTools'] = {};
    const byName = new Map<string, number>();
    for (const role of roles) {
      const tools = await bifToolsOf(s, 'ws_pay', role);
      const perTool = tools.map((t) => ({ name: t.name, chars: toolChars(t) }));
      for (const t of perTool) byName.set(t.name, t.chars);
      roleTools[role] = { tools: tools.length, chars: sum(perTool.map((t) => t.chars)), perTool };
    }

    // --- system prompts per role ---
    const sp: Record<string, string> = {
      worker: workerSystemPrompt(config, 'worker', false, 'news_scan'),
      synthesizer: workerSystemPrompt(config, 'synthesizer', false, 'synthesize_recommendations'),
      orchestrator: loadPrompt('orchestrator').text,
      interviewer: loadPrompt('interviewer').text,
      reviewer: reviewerSystemPrompt(config, undefined, 'news_scan'),
      persona: compileAgentMd(syntheticPersona(), { scopeName: 'Payments' }),
      escalation: escalationSystemPrompt(config),
      retro: retroSystemPrompt(),
    };
    table(
      'A1. Per role: system prompt and tool list (tools/list as served; tokens = chars / 4)',
      ['role', 'system prompt chars', 'system prompt tokens', 'tools', 'tool list chars', 'tool list tokens', 'both, tokens'],
      roles.map((r) => [r, sp[r]!.length, est(sp[r]!.length), roleTools[r]!.tools, roleTools[r]!.chars, est(roleTools[r]!.chars), est(sp[r]!.length + roleTools[r]!.chars)]),
    );
    console.log(`\nworker: news_scan without browser; persona: the agent.md of a synthetic persona, ~270 characters per profile field (${PERSONA_FIELDS.length} fields).`);

    const allTools = [...byName].sort((a, b) => b[1] - a[1]);
    table('A2. Every BIF tool, largest first (name + description + input schema as JSON)', ['tool', 'chars', 'tokens', 'roles offered'], allTools.map(([n, c]) => [n, c, est(c), roles.filter((r) => ROLE_TOOLS[r].includes(n as ToolName)).join(', ')]));

    // --- worker per task type ---
    const workerList = roleTools.worker!;
    const synthList = roleTools.synthesizer!;
    const browserNote = browserPromptNote(config).length + 2;
    const rows: Array<Array<string | number>> = [];
    const perType: Record<string, { prompt: number; full: number; needed: number }> = {};
    for (const type of TASK_TYPES) {
      const role = roleForTask({ type });
      const prompt = workerSystemPrompt(config, role, false, type).length;
      const list = role === 'synthesizer' ? synthList : workerList;
      const need = NEEDS[type];
      const needed = sum(need.tools.map((t) => byName.get(t) ?? 0));
      perType[type] = { prompt, full: list.chars, needed };
      rows.push([type, role, est(prompt), est(prompt + browserNote), list.tools, est(list.chars), need.tools.length, est(needed), est(list.chars - needed), pct(list.chars - needed, list.chars), need.sure]);
    }
    table(
      'A3. Worker per task type: system prompt, full tool list, and the list of the tools it plausibly needs (tokens)',
      ['task type', 'role', 'prompt', 'prompt + browser note', 'tools offered', 'list', 'tools needed', 'needed list', 'saving', 'saving %', 'basis'],
      rows,
    );
    console.log('\nbasis: code = a handler refuses the other tools; prompt = the tools its prompts tell it to use; guess = from the phase goal only.');
    table('A3b. How each task type\'s needed list was derived', ['task type', 'needed tools beyond the core', 'source'], TASK_TYPES.map((t) => [t, NEEDS[t].tools.filter((x) => !CORE.includes(x)).join(', ') || (NEEDS[t].sure === 'n/a' ? '-' : '(core only)'), NEEDS[t].basis]));
    console.log(`\ncore (every research task): ${CORE.join(', ')} = ${k(est(sum(CORE.map((t) => byName.get(t) ?? 0))))} tokens.`);

    // --- browser tool list ---
    const browser = await startBrowser();
    let bt: ToolDef[];
    let codex: Array<[string, CodexInput]> = [];
    try {
      bt = await listTools(browser.url);
      // Codex's model-visible input for the three overhead variants (no model call).
      const smallest = (Object.keys(roleTools) as Role[]).sort((x, y) => roleTools[x]!.chars - roleTools[y]!.chars)[0]!;
      try {
        codex = [
          [`(a) smallest list (${smallest})`, await codexPromptInput(s, 'ws_pay', smallest)],
          ['(b) worker list', await codexPromptInput(s, 'ws_pay', 'worker')],
          ['(c) worker + browser lists', await codexPromptInput(s, 'ws_pay', 'worker', browser.url)],
        ];
      } catch (e) {
        console.warn(`[measure] codex debug prompt-input failed: ${(e as Error).message.slice(0, 300)}`);
      }
    } finally {
      await browser.stop();
    }
    const bPer = bt.map((t) => ({ name: t.name, chars: toolChars(t) })).sort((a, b) => b.chars - a.chars);
    const bChars = sum(bPer.map((t) => t.chars));
    const charsOf = (names: string[]) => sum(bPer.filter((t) => names.includes(t.name)).map((t) => t.chars));
    const missing = [...BROWSER_WALKTHROUGH].filter((n) => !bPer.some((t) => t.name === n));
    if (missing.length) console.warn(`[measure] browser tools not served: ${missing.join(', ')}`);
    table('A4. Research browser (@playwright/mcp, shipped) tools/list', ['tool', 'chars', 'tokens', 'reading set', 'walkthrough set'], bPer.map((t) => [t.name, t.chars, est(t.chars), BROWSER_READING.includes(t.name) ? 'x' : '', BROWSER_WALKTHROUGH.includes(t.name) ? 'x' : '']));
    table('A4b. Browser tool list sizes', ['list', 'tools', 'chars', 'tokens', 'saving vs full'], [
      ['full (as offered today)', bPer.length, bChars, est(bChars), '-'],
      ['research reading set', BROWSER_READING.length, charsOf(BROWSER_READING), est(charsOf(BROWSER_READING)), `${k(est(bChars - charsOf(BROWSER_READING)))} (${pct(bChars - charsOf(BROWSER_READING), bChars)})`],
      ['walkthrough set', BROWSER_WALKTHROUGH.length, charsOf(BROWSER_WALKTHROUGH), est(charsOf(BROWSER_WALKTHROUGH)), `${k(est(bChars - charsOf(BROWSER_WALKTHROUGH)))} (${pct(bChars - charsOf(BROWSER_WALKTHROUGH), bChars)})`],
    ]);

    if (codex.length) {
      const names = [...new Set(codex.flatMap(([, c]) => c.sections.map((x) => x.name)))];
      table('A6. Codex: model-visible input of a one-line run (`codex debug prompt-input`, no model call; tokens = chars / 4)', ['part', ...codex.map(([n]) => n)],
        [...names.map((n) => [n, ...codex.map(([, c]) => est(sum(c.sections.filter((x) => x.name === n).map((x) => x.chars))))]), ['total', ...codex.map(([, c]) => est(c.total))]]);
    }

    // --- typical work prompts and briefings on the seeded tree ---
    const now = new Date().toISOString();
    const rr = store.researchRuns.insert({ id: newId('rrun'), workspaceId: 'ws_pay', phase: 'deep_dives', status: 'running', startedAt: now });
    const taskOf = (type: TaskType, phase: Task['phase'], subject?: string): Task =>
      store.tasks.insert({
        id: newId('tsk'), workspaceId: 'ws_pay', runId: rr.id, phase, type, brief: `Research ${subject ?? 'the market'}: what changed in pricing and onboarding this quarter. Deliverable: {"findings": [ids], "summary": "..."}.`,
        ...(subject ? { subject } : {}), model: { provider: 'claude', model: CLAUDE_MODEL }, needsBrowser: true,
        acceptanceCriteria: ['Every claim cites a saved page', 'At least three findings'], status: 'running', round: 1, createdAt: now,
      });
    const news = taskOf('news_scan', 'deep_dives', 'Globex'); // 20 of the seeded facts are about Globex, on this node and below
    const synth = taskOf('synthesize_recommendations', 'synthesis');
    // A reviewed task: a deliverable and two findings of its own.
    const reviewed = taskOf('news_scan', 'deep_dives', 'Globex');
    const f = [0, 1].map((i) => store.findings.insert({
      id: newId('fnd'), workspaceId: 'ws_pay', runId: rr.id, taskId: reviewed.id, subject: 'Globex', claim: `Globex raised its starter price to $${29 + i} per seat per month in October.`,
      criteria: { relevance: 4, reliability: 4, novelty: 3 }, evidence: [], status: 'pending', createdAt: now,
    }));
    store.tasks.update(reviewed.id, { result: { findings: f.map((x) => x.id), summary: 'Globex raised prices.' }, status: 'reviewing', step: 'review', submittedRound: 1 });
    const prompts: Array<[string, string]> = [];
    const tryAdd = (name: string, fn: () => string) => {
      try {
        prompts.push([name, fn()]);
      } catch (e) {
        console.warn(`[measure] ${name}: ${(e as Error).message}`);
      }
    };
    tryAdd('worker work prompt (news_scan, subject card in the briefing)', () => workPrompt({ store, config }, news));
    tryAdd('synthesizer work prompt (100 findings in the tree)', () => workPrompt({ store, config }, synth));
    tryAdd('orchestrator prompt (deep_dives, round 1)', () => orchestratorPrompt(store, config, rr, 1));
    tryAdd('reviewer prompt (2 findings)', () => reviewerRunInput({ store, config }, store.tasks.get(reviewed.id)!, 1).prompt);
    tryAdd('interviewer prompt (new workspace)', () => buildInterviewPrompt(store.workspaces.get('ws_pay')!, store, config.dataDir));
    tryAdd('escalation prompt (unverified task)', () => escalationPrompt(store, store.tasks.update(reviewed.id, { status: 'unverified' }), 3, config));
    tryAdd('persona panel prompt template (unrendered)', () => promptTemplate('persona_panel'));
    const b = config.knowledge?.budgets;
    table('A5. Typical work prompts on a seeded tree (4 nodes, 100 facts)', ['prompt', 'chars', 'tokens'], prompts.map(([n, p]) => [n, p.length, est(p.length)]));
    console.log(`\nknowledge budgets (config.knowledge.budgets): ${JSON.stringify(b ?? 'defaults: search 1200, card 800, expand 2000, briefing 1500; reviewer expand 3000; synthesizer briefing 4000')}`);

    const systemPrompts = Object.fromEntries(Object.entries(sp).map(([r, t]) => [r, t.length]));
    for (const [type, v] of Object.entries(perType)) systemPrompts[`worker:${type}`] = v.prompt;
    systemPrompts['browser note'] = browserNote;
    return {
      roleTools,
      browser: { tools: bPer.length, chars: bChars, perTool: bPer, reading: charsOf(BROWSER_READING), walkthrough: charsOf(BROWSER_WALKTHROUGH) },
      systemPrompts,
      codex: codex.map(([n, c]) => ({ variant: n, ...c })),
    };
  } finally {
    await stopServer(s);
  }
}

// ---------------------------------------------------------------------------------------------------
// part B: parsing a run's raw output

type Call = {
  id: string; name: string; turn: number; argChars: number; resultChars: number; imageTokens: number; ok: boolean;
  /** Text of the result (browser results are kept for the offline rules). */
  text?: string;
  /** ToolSearch: the tools whose schemas the CLI loaded into the context. */
  refs?: string[];
  /** save_finding: the quotes it cited (to check what a shortened browser result would have lost). */
  quotes?: string[];
  /** A failed call: the start of its error text (refused or unknown tools show here). */
  error?: string;
};
type Turn = { id: string; input: number; cacheRead: number; cacheWrite: number; output: number; context: number; outChars: number };
type RunMeasure = {
  label: string; runId: string; provider: ProviderId; model: string; role: string; status: string; reason?: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number; costUsd?: number };
  turns: Turn[]; calls: Call[];
  systemChars: number; promptChars: number;
  offeredTools?: string[];
  seconds: number;
  /** Claude: the CLI's session id (from its init event), to find what it left in the person's Claude folder. */
  sessionId?: string;
  /** Claude: what of the run was still in the Claude folder or Claude Code's temp root after it ended (`cliLeftovers.ts`). */
  leftovers?: string[];
  /** The run's working directory (Claude names its project folder after it). */
  cwd?: string;
  /** What the run left in the store: the artifacts of its workspace and the findings of its task, with their quotes. */
  outcome?: Outcome;
};

/** A quote is stored only after `save_finding` found it in the artifact's extracted text, so a stored quote is verified. */
type Outcome = {
  artifacts: Array<{ id: string; kind: string; sourceUrl?: string }>;
  findings: Array<{ id: string; claim: string; status: string; quotes: Array<{ artifactId: string; quote: string; verified: boolean; located: boolean }> }>;
};

/** Image tokens as Claude counts them: (width × height) / 750 after fitting within 1568 px on the long edge. */
function imageTokens(b64: string): number {
  const buf = Buffer.from(b64.slice(0, 4096), 'base64');
  let w = 0;
  let h = 0;
  if (buf.subarray(0, 4).toString('hex') === '89504e47') {
    w = buf.readUInt32BE(16);
    h = buf.readUInt32BE(20);
  } else if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        h = buf.readUInt16BE(i + 5);
        w = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  }
  if (!w || !h) return Math.ceil((b64.length * 0.75) / 750); // unknown format: a rough fallback
  const scale = Math.min(1, 1568 / Math.max(w, h));
  return Math.ceil((w * scale * h * scale) / 750);
}

function resultSize(content: unknown): { chars: number; images: number; text: string; refs: string[] } {
  if (typeof content === 'string') return { chars: content.length, images: 0, text: content, refs: [] };
  let chars = 0;
  let images = 0;
  let text = '';
  const refs: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    const b = c as { type?: string; text?: string; source?: { data?: string }; data?: string; tool_name?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      chars += b.text.length;
      text += b.text;
    } else if (b.type === 'image') images += imageTokens(b.source?.data ?? b.data ?? '');
    else if (b.type === 'tool_reference' && b.tool_name) refs.push(b.tool_name);
  }
  return { chars, images, text, refs };
}

/** The quotes a save_finding call cites (`evidence_refs[].quote`). */
function quotesOf(name: string, input: unknown): string[] {
  if (!name.endsWith('save_finding')) return [];
  let i = input as { evidence_refs?: unknown };
  if (typeof i === 'string') {
    try {
      i = JSON.parse(i) as { evidence_refs?: unknown };
    } catch {
      return [];
    }
  }
  let refs = i?.evidence_refs;
  if (typeof refs === 'string') {
    try {
      refs = JSON.parse(refs);
    } catch {
      return [];
    }
  }
  return (Array.isArray(refs) ? refs : []).map((r) => (r as { quote?: unknown }).quote).filter((q): q is string => typeof q === 'string' && q.length > 0);
}

const keepText = (name: string) => name.startsWith('mcp__browser__') || name.startsWith('browser_');

function parseClaude(lines: string[]): Pick<RunMeasure, 'turns' | 'calls' | 'usage' | 'offeredTools' | 'sessionId'> {
  const turns: Turn[] = [];
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  let usage: RunMeasure['usage'] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let offeredTools: string[] | undefined;
  let sessionId: string | undefined;
  for (const line of lines) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.type === 'system' && d.subtype === 'init' && Array.isArray(d.tools)) offeredTools = d.tools as string[];
    if (typeof d.session_id === 'string') sessionId ??= d.session_id;
    if (d.type === 'assistant') {
      const m = d.message as { id?: string; usage?: Record<string, number>; content?: Array<Record<string, unknown>> };
      const id = m.id ?? `t${turns.length}`;
      let turn = turns.find((t) => t.id === id);
      if (!turn) {
        const u = m.usage ?? {};
        const input = u.input_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        turn = { id, input, cacheRead, cacheWrite, output: u.output_tokens ?? 0, context: input + cacheRead + cacheWrite, outChars: 0 };
        turns.push(turn);
      } else if (m.usage?.output_tokens !== undefined) turn.output = Math.max(turn.output, m.usage.output_tokens);
      for (const c of m.content ?? []) {
        if (c.type === 'text') turn.outChars += String(c.text ?? '').length;
        if (c.type === 'thinking') turn.outChars += String(c.thinking ?? '').length;
        if (c.type === 'tool_use') {
          const args = JSON.stringify(c.input ?? {});
          turn.outChars += args.length + String(c.name).length;
          const call: Call = { id: String(c.id), name: String(c.name), turn: turns.length - 1, argChars: args.length, resultChars: 0, imageTokens: 0, ok: true };
          const quotes = quotesOf(call.name, c.input);
          if (quotes.length) call.quotes = quotes;
          calls.push(call);
          byId.set(call.id, call);
        }
      }
    }
    if (d.type === 'user') {
      const m = d.message as { content?: unknown };
      for (const c of Array.isArray(m.content) ? m.content : []) {
        const b = c as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type !== 'tool_result') continue;
        const call = byId.get(String(b.tool_use_id));
        if (!call) continue;
        const r = resultSize(b.content);
        call.resultChars = r.chars;
        call.imageTokens = r.images;
        call.ok = b.is_error !== true;
        if (!call.ok) call.error = r.text.slice(0, 200);
        if (r.refs.length) call.refs = r.refs;
        if (keepText(call.name)) call.text = r.text;
      }
    }
    if (d.type === 'result') {
      const u = (d.usage ?? {}) as Record<string, number>;
      usage = {
        input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0,
        ...(typeof d.total_cost_usd === 'number' ? { costUsd: d.total_cost_usd } : {}),
      };
    }
  }
  return { turns, calls, usage, ...(offeredTools ? { offeredTools } : {}), ...(sessionId ? { sessionId } : {}) };
}

function parseCodex(lines: string[]): Pick<RunMeasure, 'turns' | 'calls' | 'usage'> {
  const calls: Call[] = [];
  const usage: RunMeasure['usage'] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const line of lines) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.type === 'item.completed') {
      const it = d.item as Record<string, unknown>;
      if (it.type === 'mcp_tool_call') {
        const r = resultSize((it.result as { content?: unknown } | undefined)?.content);
        const name = it.server === 'bif' ? String(it.tool) : `mcp__${String(it.server)}__${String(it.tool)}`;
        const ok = it.status === 'completed' && !it.error;
        const quotes = quotesOf(name, it.arguments);
        calls.push({
          id: String(it.id), name, turn: 0, argChars: JSON.stringify(it.arguments ?? {}).length, resultChars: r.chars, imageTokens: r.images, ok,
          ...(keepText(name) ? { text: r.text } : {}), ...(quotes.length ? { quotes } : {}),
          ...(ok ? {} : { error: (r.text || JSON.stringify(it.error ?? '')).slice(0, 200) }),
        });
      }
    }
    if (d.type === 'turn.completed') {
      const u = (d.usage ?? {}) as Record<string, number>;
      // Codex input_tokens include the cached part.
      usage.input += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
      usage.cacheRead += u.cached_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
    }
  }
  return { turns: [], calls, usage };
}

// ---------------------------------------------------------------------------------------------------
// part B: real runs

type RunSpec = {
  label: string; provider: 'claude' | 'codex'; role: Role; systemPrompt: string; prompt: string; needsBrowser: boolean;
  workspaceId: string; taskId?: string;
  /** BIF's offline flag: for Claude, `--tools ""` (no built-in tool at all; MCP tools stay). */
  offline?: boolean;
};

async function realRun(s: Server, spec: RunSpec): Promise<RunMeasure> {
  const { supervisor, dataDir } = s.booted.runtime;
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  console.error(`[measure] run ${spec.label} (${spec.provider}/${MODELS[spec.provider]}) …`);
  try {
    const out = await supervisor.run({
      ctx: { workspaceId: spec.workspaceId, role: spec.role, model: { provider: spec.provider, model: MODELS[spec.provider] }, promptVersion: 'measure', ...(spec.taskId ? { taskId: spec.taskId } : {}) },
      prompt: spec.prompt, systemPrompt: spec.systemPrompt, needsBrowser: spec.needsBrowser, signal: abort.signal,
      ...(spec.offline ? { offline: true } : {}),
    });
    const m = measureRun(dataDir, spec.workspaceId, out.agentRunId, { label: spec.label, provider: spec.provider, role: spec.role, status: out.status, reason: out.reason, seconds: (Date.now() - started) / 1000 });
    m.outcome = outcomeOf(s.booted.runtime.store, spec.workspaceId, spec.taskId);
    return m;
  } finally {
    clearTimeout(timer);
  }
}

/** The artifacts of a run's workspace and the findings of its task with their quotes (see `Outcome`). */
function outcomeOf(store: Store, wsId: string, taskId: string | undefined): Outcome {
  const ev = knowledgeRepos(store).findingEvidence;
  return {
    artifacts: store.artifacts.list({ workspaceId: wsId }).map((x) => ({ id: x.id, kind: x.kind, ...(x.sourceUrl ? { sourceUrl: x.sourceUrl } : {}) })),
    findings: taskId === undefined ? [] : store.findings.list({ taskId }).map((f) => ({
      id: f.id, claim: f.claim, status: f.status,
      quotes: ev.list({ findingId: f.id }).filter((e) => e.quote).map((e) => ({ artifactId: e.artifactId, quote: e.quote!, verified: true, located: e.charStart !== undefined })),
    })),
  };
}

/** Reads a finished run's files (`stdout.log`, `prompt.md`) and measures it. */
function measureRun(dataDir: string, wsId: string, runId: string, meta: { label: string; provider: ProviderId; role: string; status: string; reason?: string | undefined; seconds: number }): RunMeasure {
  const dir = runDirOf(dataDir, wsId, runId);
  const stdout = existsSync(join(dir, 'stdout.log')) ? readFileSync(join(dir, 'stdout.log'), 'utf8').split('\n') : [];
  const promptMd = existsSync(join(dir, 'prompt.md')) ? readFileSync(join(dir, 'prompt.md'), 'utf8') : '';
  const sys = promptMd.indexOf('# System prompt\n');
  const task = promptMd.indexOf('\n# Task prompt\n');
  const systemChars = sys >= 0 && task > sys ? task - sys - '# System prompt\n\n'.length : 0;
  const promptChars = task >= 0 ? promptMd.length - task - '\n# Task prompt\n\n'.length : 0;
  const parsed = meta.provider === 'codex' ? parseCodex(stdout) : parseClaude(stdout);
  const m: RunMeasure = { ...meta, runId, model: MODELS[meta.provider as 'claude' | 'codex'] ?? '', ...parsed, systemChars, promptChars, cwd: runCwdOf(dataDir, wsId, runId) };
  if (meta.reason === undefined) delete m.reason;
  if (meta.provider === 'claude') {
    const cwd = runCwdOf(dataDir, wsId, runId);
    const f = claudeFolders();
    const names = [cwd, existsSync(cwd) ? realpathSync(cwd) : cwd].map(claudeProjectDirName).filter((n): n is string => n !== undefined);
    const sids = [...new Set([m.sessionId, cliSessionId(runId, 1)].filter((x): x is string => x !== undefined))];
    const candidates = [
      ...names.flatMap((n) => [join(f.configDir, 'projects', n), ...(f.tmpRoot ? [join(f.tmpRoot, n)] : [])]),
      ...sids.map((sid) => join(f.configDir, 'session-env', sid)),
    ];
    m.leftovers = [...new Set(candidates)].filter((p) => existsSync(p));
  }
  return m;
}

// --- run prompts -----------------------------------------------------------------------------------

const ONE_LINE_SYSTEM = 'You are a test agent.';
const ONE_LINE_PROMPT = 'Reply with the single word OK. Do not call any tool.';

/** Public, content-heavy pages that allow automated reading and need no account. */
const PAGES = [
  { label: 'encyclopaedia', url: 'https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol', subject: 'HTTP (Wikipedia article)' },
  { label: 'documentation', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview', subject: 'HTTP overview (MDN documentation)' },
  { label: 'project page', url: 'https://www.postgresql.org/about/', subject: 'PostgreSQL (project about page)' },
];

function researchBrief(page: (typeof PAGES)[number]): string {
  return [
    `Read the public page ${page.url} and record two facts from it.`,
    '1. Open a new browser tab for yourself and go to the page. Read it.',
    '2. Save a copy of the page as evidence with `save_artifact` (kind "page_snapshot", source_url the page address).',
    '3. Save two findings about the subject of the page with `save_finding`, each citing the saved copy with',
    '   `evidence_refs` and a short quote copied exactly from it, relation "new".',
    '4. Close the tab you opened.',
    '5. Call `submit_result` with {"artifact_id": "...", "finding_ids": ["...", "..."]}.',
    'Do not open other pages or search the web.',
  ].join('\n');
}

/** A fictional vendor's page for the non-browser worker run (a local file, no web). */
const LOCAL_PAGE = `<!doctype html><html><head><title>Northwind Widgets - Pricing</title></head><body>
<h1>Northwind Widgets pricing</h1>
<p>Northwind Widgets sells inventory tracking software for small warehouses. Every plan includes barcode scanning, low-stock alerts and a mobile app.</p>
<h2>Plans</h2><p>Starter plan: $19 per month for a single warehouse and up to two users.</p>
<p>Team plan: $49 per user per month, billed annually. Includes unlimited warehouses, role-based permissions and shared dashboards.</p>
<p>Enterprise plan: custom pricing. Contact sales for single sign-on, audit logs and a dedicated success manager.</p>
<h2>Free trial</h2><p>Every plan starts with a 14-day free trial. No credit card is required to start the trial.</p>
<h2>Support</h2><p>Starter customers get email support with a reply within two business days. Team customers get chat support during business hours.</p>
</body></html>
`;

function seedTask(store: Store, wsId: string, type: TaskType, brief: string, needsBrowser: boolean, subject: string): Task {
  const now = new Date().toISOString();
  store.workspaces.insert({ id: wsId, name: `measure ${wsId}`, sector: 'research', createdAt: now });
  const rr = store.researchRuns.insert({ id: newId('rrun'), workspaceId: wsId, phase: 'deep_dives', status: 'running', startedAt: now });
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: wsId, runId: rr.id, phase: 'deep_dives', type, brief, subject, model: { provider: 'claude', model: CLAUDE_MODEL },
    needsBrowser, acceptanceCriteria: ['Two findings, each with an exact quote from the saved page', 'submit_result names the artifact and both findings'],
    status: 'running', round: 1, createdAt: now,
  });
}

async function overheadRuns(provider: 'claude' | 'codex', smallestRole: Role, which: string): Promise<RunMeasure[]> {
  const out: RunMeasure[] = [];
  const all: Array<{ id: string; label: string; role: Role; needsBrowser: boolean; offline?: boolean }> = [
    { id: 'a', label: `${provider} (a) smallest list (${smallestRole})`, role: smallestRole, needsBrowser: false },
    { id: 'b', label: `${provider} (b) worker list`, role: 'worker', needsBrowser: false },
    { id: 'c', label: `${provider} (c) worker + browser lists`, role: 'worker', needsBrowser: true },
    // BIF's offline flag (`--tools ""`): the same call as (a) without the CLI's built-in tools.
    { id: 'd', label: `${provider} (d) smallest list, no built-in tools`, role: smallestRole, needsBrowser: false, offline: true },
    // Without built-in tools there is no ToolSearch either: MCP schemas are then sent in full.
    { id: 'e', label: `${provider} (e) worker list, no built-in tools`, role: 'worker', needsBrowser: false, offline: true },
  ];
  const variants = all.filter((v) => which.includes(v.id));
  for (const v of variants) {
    const s = await startServer('overhead');
    try {
      const wsId = 'ws_measure';
      s.booted.runtime.store.workspaces.insert({ id: wsId, name: 'measure', sector: 'test', createdAt: new Date().toISOString() });
      out.push(await realRun(s, { label: v.label, provider, role: v.role, systemPrompt: ONE_LINE_SYSTEM, prompt: ONE_LINE_PROMPT, needsBrowser: v.needsBrowser, workspaceId: wsId, ...(v.offline ? { offline: true } : {}) }));
    } finally {
      await stopServer(s);
    }
  }
  return out;
}

async function researchRuns(): Promise<RunMeasure[]> {
  const out: RunMeasure[] = [];
  for (const [i, page] of PAGES.entries()) {
    if (PAGE_PICK && !PAGE_PICK.includes(i + 1)) continue;
    const s = await startServer('research');
    try {
      const { store, config } = s.booted.runtime;
      const task = seedTask(store, `ws_research_${i}`, 'news_scan', researchBrief(page), true, page.subject);
      const m = await realRun(s, {
        label: `research ${page.label}`, provider: 'claude', role: 'worker', needsBrowser: true, workspaceId: task.workspaceId, taskId: task.id,
        systemPrompt: workerSystemPrompt(config, 'worker', true, 'news_scan'), prompt: workPrompt({ store, config }, task),
      });
      out.push(m);
      // The reviewer of the first task, on what the worker saved (the real review prompt).
      if (i === 0) {
        const result = getRunOutputs(store, m.runId).result;
        store.tasks.update(task.id, { result: result ?? { note: 'no result submitted' }, status: 'reviewing', step: 'review', submittedRound: 1 });
        const input = reviewerRunInput({ store, config }, store.tasks.get(task.id)!, 1);
        out.push(await realRun(s, { label: 'reviewer (of research encyclopaedia)', provider: 'claude', role: 'reviewer', needsBrowser: false, workspaceId: task.workspaceId, taskId: task.id, systemPrompt: input.systemPrompt, prompt: input.prompt }));
      }
    } finally {
      await stopServer(s);
    }
  }
  return out;
}

async function workerRun(): Promise<RunMeasure> {
  const s = await startServer('worker');
  try {
    const { store, config } = s.booted.runtime;
    const pagePath = join(s.dir, 'northwind-pricing.html');
    writeFileSync(pagePath, LOCAL_PAGE);
    const brief = [
      `A copy of the pricing page of the fictional company "Northwind Widgets" is stored at ${pagePath} (public address https://northwind-widgets.example/pricing).`,
      'Do not browse the web. 1. Save it with `save_artifact` (kind "page_snapshot", mime "text/html", file_path as given, source_url as given,',
      'a one-sentence description). 2. `search` the knowledge store for what is already known about Northwind Widgets.',
      '3. Save two findings with `save_finding`, each citing the page with `evidence_refs` and an exact quote, relation "new".',
      '4. Call `submit_result` with {"artifact_id": "...", "finding_ids": ["...", "..."]}.',
    ].join('\n');
    const task = seedTask(store, 'ws_worker', 'news_scan', brief, false, 'Northwind Widgets');
    return await realRun(s, {
      label: 'worker without browser (local page)', provider: 'claude', role: 'worker', needsBrowser: false, workspaceId: task.workspaceId, taskId: task.id,
      systemPrompt: workerSystemPrompt(config, 'worker', false, 'news_scan'), prompt: workPrompt({ store, config }, task),
    });
  } finally {
    await stopServer(s);
  }
}

async function interviewerRun(): Promise<RunMeasure> {
  const s = await startServer('interview');
  const started = Date.now();
  try {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    console.error(`[measure] run interviewer (claude/${CLAUDE_MODEL}) …`);
    const created = await post('/api/workspaces', { name: 'Corner Bakery', sector: 'food retail' });
    const wsId = String(created.body.id);
    const sent = await post(`/api/workspaces/${wsId}/interview`, {
      text: 'We run a single neighbourhood bakery selling bread and pastries to walk-in customers. Sales are flat this year and morning queues are long.',
    });
    const run = s.booted.runtime.store.agentRuns.list({ workspaceId: wsId, role: 'interviewer' })[0];
    if (!run) throw new Error(`no interviewer run (POST ${sent.status})`);
    return measureRun(s.booted.runtime.dataDir, wsId, run.id, { label: 'interviewer (first message)', provider: 'claude', role: 'interviewer', status: run.status === 'running' ? 'unknown' : (s.booted.runtime.store.agentRuns.get(run.id)?.status ?? 'unknown'), seconds: (Date.now() - started) / 1000 });
  } finally {
    await stopServer(s);
  }
}

// ---------------------------------------------------------------------------------------------------
// part B: analysis

const isBrowser = (name: string) => name.startsWith('mcp__browser__');
const isBif = (name: string) => name.startsWith('mcp__bif__') || (!name.includes('__') && !/^[A-Z]/.test(name));
/** Claude Code's own tool that loads deferred tool schemas into the context. */
const isToolSearch = (name: string) => name === 'ToolSearch';
const shortName = (name: string) => name.replace(/^mcp__(bif|browser)__/, '');
const callTokens = (c: Call) => est(c.resultChars) + c.imageTokens;
const isOverhead = (r: RunMeasure) => /^\w+ \([abcde]\)/.test(r.label);

/**
 * Splits a Claude run's input tokens (the sum of the context of every model call) into parts:
 * - fixed: the first call's context (CLI instructions and built-in tools, tool lists, system prompt, task
 *   prompt), sent with every call;
 * - each tool result: its estimated size (text chars / 4, images by their pixel size, a ToolSearch result as
 *   the schemas it loaded at the measured rate), capped at the growth of the context it came in with,
 *   times the number of later calls that carried it;
 * - the model's own messages: the rest of each growth (its tool calls, text and the thinking the CLI keeps
 *   in the context but does not print), likewise carried.
 */
function attribute(m: RunMeasure, schemaTokens: (tool: string) => number) {
  const N = m.turns.length;
  const ctx = m.turns.map((t) => t.context);
  const total = sum(ctx);
  const fixed = N ? ctx[0]! * N : 0;
  let browser = 0;
  let bif = 0;
  let schemas = 0;
  let other = 0;
  let own = 0;
  const perCall: Array<Call & { tokens: number; carried: number; contribution: number }> = [];
  for (let t = 1; t < N; t++) {
    const delta = Math.max(0, ctx[t]! - ctx[t - 1]!);
    const stepCalls = m.calls.filter((c) => c.turn === t - 1);
    const estimates = stepCalls.map((c) => (isToolSearch(c.name) ? sum((c.refs ?? []).map(schemaTokens)) : callTokens(c)));
    const scale = Math.min(1, delta / (sum(estimates) || 1));
    const carried = N - t; // calls t..N-1 carry it
    let results = 0;
    stepCalls.forEach((c, i) => {
      const tokens = estimates[i]! * scale;
      results += tokens;
      const contribution = tokens * carried;
      perCall.push({ ...c, tokens, carried, contribution });
      if (isBrowser(c.name)) browser += contribution;
      else if (isBif(c.name)) bif += contribution;
      else if (isToolSearch(c.name)) schemas += contribution;
      else other += contribution;
    });
    own += (delta - results) * carried;
  }
  return { N, total, fixed, browser, bif, schemas, other, own, first: ctx[0] ?? 0, peak: Math.max(0, ...ctx), perCall };
}

type Calibration = {
  /** Claude: measured tokens per offered tool (Claude Code defers MCP schemas: only names are listed). */
  claude?: { perBifTool?: number; perBrowserTool?: number; cliRest?: number; builtin?: number; deferred?: boolean; schemaPerChar?: number };
  /** Codex: measured tokens per character of tool list, and its own part of a call. */
  codex?: { perChar?: number; cliRest?: number };
};

/** First-call context of an overhead run (Codex reports one usage per turn: a one-call run's input is its context). */
const firstContext = (runs: RunMeasure[], prefix: string) => {
  const r = runs.find((x) => x.label.startsWith(prefix));
  return r ? (r.turns[0]?.context ?? r.usage.input + r.usage.cacheRead + r.usage.cacheWrite) : undefined;
};

function calibrate(runs: RunMeasure[], a: PartA | undefined, smallestRole: string): Calibration {
  const out: Calibration = {};
  if (!a) return out;
  const small = a.roleTools[smallestRole]!;
  const worker = a.roleTools.worker!;
  const onePrompt = est(ONE_LINE_SYSTEM.length + ONE_LINE_PROMPT.length);
  const [ca, cb, cc, cd] = ['a', 'b', 'c', 'd'].map((x) => firstContext(runs, `claude (${x})`));
  if (ca !== undefined && cb !== undefined) {
    const perBifTool = (cb - ca) / (worker.tools - small.tools);
    const deferred = (cb - ca) / (worker.chars - small.chars) < 0.1; // far below ~0.25 per char: schemas are not sent
    const tools = deferred ? small.tools * perBifTool : small.chars * ((cb - ca) / (worker.chars - small.chars));
    out.claude = { perBifTool, deferred, cliRest: ca - tools - onePrompt };
    if (cc !== undefined) out.claude.perBrowserTool = (cc - cb) / a.browser.tools;
    if (cd !== undefined) out.claude.builtin = ca - cd;
    const ce = firstContext(runs, 'claude (e)');
    if (cd !== undefined && ce !== undefined) out.claude.schemaPerChar = (ce - cd) / (worker.chars - small.chars);
  }
  const [xa, xb] = ['a', 'b'].map((x) => firstContext(runs, `codex (${x})`));
  if (xa !== undefined && xb !== undefined) {
    const perChar = (xb - xa) / (worker.chars - small.chars);
    out.codex = { perChar, cliRest: xa - small.chars * perChar - onePrompt };
  }
  return out;
}

/** Tool-list tokens of a run's first call, at the measured rates. */
function toolListTokens(cal: Calibration, a: PartA | undefined, r: RunMeasure, browser: boolean): number {
  const list = a?.roleTools[r.role];
  if (!list || !a) return 0;
  if (r.provider === 'claude' && cal.claude?.deferred) return list.tools * (cal.claude.perBifTool ?? 0) + (browser ? a.browser.tools * (cal.claude.perBrowserTool ?? 0) : 0);
  const perChar = (r.provider === 'codex' ? cal.codex?.perChar : undefined) ?? 0.25;
  return (list.chars + (browser ? a.browser.chars : 0)) * perChar;
}

function report(runs: RunMeasure[], a: PartA | undefined, smallestRole: string): void {
  table(
    'B1. Runs: the CLI\'s reported usage (input = uncached input; total input = input + cache read + cache write)',
    ['run', 'status', 'calls to model', 'tool calls', 'input', 'cache read', 'cache write', 'total input', 'output', 'first call context', 'peak context', 'cost USD'],
    runs.map((r) => [
      r.label, r.status, r.turns.length || '-', r.calls.length, r.usage.input, r.usage.cacheRead, r.usage.cacheWrite,
      r.usage.input + r.usage.cacheRead + r.usage.cacheWrite, r.usage.output, r.turns[0]?.context ?? '-', r.turns.length ? Math.max(...r.turns.map((t) => t.context)) : '-',
      r.usage.costUsd !== undefined ? r.usage.costUsd.toFixed(4) : '-',
    ]),
  );
  console.log('\nCodex reports usage per turn only (no context per model call): its "calls to model" and context columns are empty.');
  for (const r of runs.filter((x) => x.offeredTools)) {
    const bifN = r.offeredTools!.filter((t) => t.startsWith('mcp__bif__')).length;
    const brN = r.offeredTools!.filter((t) => t.startsWith('mcp__browser__')).length;
    console.log(`- ${r.label}: CLI offered ${r.offeredTools!.length} tools (${bifN} bif, ${brN} browser, ${r.offeredTools!.length - bifN - brN} built in)`);
  }
  for (const r of runs.filter((x) => x.leftovers)) {
    console.log(`- ${r.label}: left in the Claude folder or temp root after it ended: ${r.leftovers!.length ? r.leftovers!.join(', ') : 'nothing'}`);
  }

  // --- what each run delivered, and every failed tool call ---
  const outRows = runs.filter((r) => r.outcome && (r.outcome.findings.length || r.outcome.artifacts.length)).map((r) => {
    const o = r.outcome!;
    const quotes = o.findings.flatMap((f) => f.quotes);
    return [r.label, r.status, o.artifacts.map((x) => x.kind).join(', ') || '-', o.findings.length, quotes.length, quotes.filter((q) => q.verified).length, o.findings.map((f) => `${f.status}: ${f.claim.slice(0, 60)}`).join(' / ')];
  });
  if (outRows.length) table('B0. What each run delivered (artifacts of its workspace, findings of its task, stored quotes = verified)', ['run', 'status', 'artifacts', 'findings', 'quotes', 'verified', 'claims'], outRows);
  const failed = runs.flatMap((r) => r.calls.filter((c) => !c.ok).map((c) => [r.label, shortName(c.name), (c.error ?? '').replace(/\s+/g, ' ').slice(0, 140)]));
  table('B0b. Failed tool calls (refused or unknown tools would show here)', ['run', 'tool', 'error'], failed.length ? failed : [['-', '-', 'none']]);
  for (const r of runs.filter((x) => x.offeredTools)) {
    const builtin = r.offeredTools!.filter((t) => !t.startsWith('mcp__'));
    console.log(`- ${r.label}: built-in tools offered (${builtin.length}): ${builtin.join(', ') || 'none'}`);
  }

  // --- fixed overhead and tool lists ---
  const cal = calibrate(runs, a, smallestRole);
  if (runs.some(isOverhead) && a) {
    const small = a.roleTools[smallestRole]!;
    const worker = a.roleTools.worker!;
    const rows: Array<Array<string | number>> = [];
    for (const p of ['claude', 'codex']) {
      const [xa, xb, xc, xd] = ['a', 'b', 'c', 'd'].map((x) => firstContext(runs, `${p} (${x})`));
      if (xa !== undefined) rows.push([`${p} (a): one-line prompt, smallest list (${smallestRole}, ${small.tools} tools)`, xa, '-', `${k(est(small.chars))} (list)`, '-']);
      if (xa !== undefined && xb !== undefined) rows.push([`${p} (b): worker list instead (+${worker.tools - small.tools} tools)`, xb, xb - xa, est(worker.chars - small.chars), `${((xb - xa) / (worker.chars - small.chars)).toFixed(3)} per char, ${k((xb - xa) / (worker.tools - small.tools))} per tool`]);
      if (xb !== undefined && xc !== undefined) rows.push([`${p} (c): worker + browser list (+${a.browser.tools} tools)`, xc, xc - xb, est(a.browser.chars), `${((xc - xb) / a.browser.chars).toFixed(3)} per char, ${k((xc - xb) / a.browser.tools)} per tool`]);
      if (xa !== undefined && xd !== undefined) rows.push([`${p} (d): as (a), built-in tools off (BIF offline flag)`, xd, xd - xa, '-', '-']);
      const xe = firstContext(runs, `${p} (e)`);
      if (xd !== undefined && xe !== undefined) rows.push([`${p} (e): as (b), built-in tools off: full schemas (+${worker.tools - small.tools} tools)`, xe, xe - xd, est(worker.chars - small.chars), `${((xe - xd) / (worker.chars - small.chars)).toFixed(3)} per char`]);
    }
    table('B2. Fixed overhead per model call (first call\'s context) and the measured cost of tool lists', ['run', 'context of the call', 'measured difference', 'estimate from part A (chars/4)', 'measured rate'], rows);
    if (cal.claude?.cliRest !== undefined) {
      console.log(`\nClaude Code: the CLI's own part of every call ≈ ${k(cal.claude.cliRest)} tokens` +
        (cal.claude.builtin !== undefined ? `, of which its ${k(cal.claude.builtin)} tokens of built-in tool definitions can be switched off (run d)` : '') +
        `. MCP tools cost ≈ ${k(cal.claude.perBifTool ?? 0)} tokens per BIF tool and ≈ ${k(cal.claude.perBrowserTool ?? 0)} per browser tool: ${cal.claude.deferred ? 'Claude Code lists them by name only and loads a schema when the model searches for it (ToolSearch)' : 'schemas are sent in full'}.`);
    }
    if (cal.codex?.cliRest !== undefined) console.log(`Codex: its own part of every call ≈ ${k(cal.codex.cliRest)} tokens; tool lists cost ${(cal.codex.perChar ?? 0).toFixed(3)} tokens per character: ${(cal.codex.perChar ?? 0) < 0.1 ? 'MCP tools are not in the first call (Codex defers them; see A6)' : 'schemas sent in full'}.`);
  }

  // --- tool calls ---
  const callRows: Array<Array<string | number>> = [];
  for (const r of runs) for (const c of r.calls) callRows.push([r.label, shortName(c.name), c.ok ? 'ok' : 'error', c.argChars, c.resultChars, c.imageTokens || '', callTokens(c)]);
  if (callRows.length) table('B3. Every tool call: arguments and result (chars; result tokens = chars/4 + image tokens)', ['run', 'tool', 'ok', 'args chars', 'result chars', 'image tokens', 'result tokens'], callRows);

  // --- where the tokens go ---
  const where: Array<Array<string | number>> = [];
  const att = new Map<string, ReturnType<typeof attribute>>();
  // A schema loaded by ToolSearch: its JSON at the rate full schemas measured (run e vs d), else chars / 4.
  const schemaChars = new Map<string, number>([
    ...Object.values(a?.roleTools ?? {}).flatMap((l) => l.perTool.map((x): [string, number] => [`mcp__bif__${x.name}`, x.chars])),
    ...(a?.browser.perTool ?? []).map((x): [string, number] => [`mcp__browser__${x.name}`, x.chars]),
  ]);
  const schemaTokens = (tool: string) => (schemaChars.get(tool) ?? 0) * (cal.claude?.schemaPerChar ?? 0.25);
  for (const r of runs.filter((x) => x.provider === 'claude' && x.turns.length && !isOverhead(x))) {
    const t = attribute(r, schemaTokens);
    att.set(r.label, t);
    const tools = toolListTokens(cal, a, r, /research/.test(r.label));
    const prompts = est(r.systemChars + r.promptChars);
    const cli = Math.max(0, t.first - tools - prompts);
    const parts: Array<[string, number]> = [
      ['CLI own', cli * t.N], ['tool lists', tools * t.N], ['BIF prompts', prompts * t.N], ['browser results', t.browser], ['BIF tool results', t.bif],
      ['tool schemas loaded (ToolSearch)', t.schemas], ['built-in tool results', t.other], ["model's own messages", t.own],
    ];
    const measured = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
    where.push([r.label, measured, t.N, t.first, t.peak, ...parts.map(([, v]) => `${k(v)} (${pct(v, t.total)})`), k(t.total - sum(parts.map(([, v]) => v)))]);
  }
  if (where.length) {
    table(
      'B4. Where the input tokens of a run go (sum over every model call; fixed parts are sent with every call)',
      ['run', 'total input (CLI)', 'model calls', 'first call', 'peak', 'CLI own', 'tool lists', 'BIF prompts', 'browser results', 'BIF tool results', 'schemas loaded (ToolSearch)', 'built-in tool results', 'own messages', 'unexplained'],
      where,
    );
    console.log('\nThe first call\'s context is split into the CLI\'s own part, tool lists (at the measured rates, B2) and BIF\'s prompts (chars/4); every later growth of the context is attributed to the tool results and messages that caused it.');
  }

  // --- browser results ---
  const browserCalls = runs.flatMap((r) => r.calls.filter((c) => isBrowser(c.name)).map((c) => ({ ...c, run: r.label, carried: att.get(r.label)?.perCall.find((p) => p.id === c.id)?.carried ?? 1 })));
  if (browserCalls.length) {
    const byTool = new Map<string, typeof browserCalls>();
    for (const c of browserCalls) byTool.set(shortName(c.name), [...(byTool.get(shortName(c.name)) ?? []), c]);
    table('B5. Browser results by tool (tokens per result: chars/4 + image tokens)', ['tool', 'calls', 'min', 'median', 'max', 'total', 'carried total (× later calls)'],
      [...byTool].map(([n, cs]) => {
        const t = cs.map(callTokens).sort((x, y) => x - y);
        return [n, cs.length, t[0]!, t[Math.floor(t.length / 2)]!, t[t.length - 1]!, sum(t), sum(cs.map((c) => callTokens(c) * c.carried))];
      }));

    // --- offline rules ---
    const capText = (t: string, n: number) => (est(t.length) > n ? `${t.slice(0, n * 4)}\n[cut: ask for more]` : t);
    const shortened = (rule: string, c: (typeof browserCalls)[number]): string => {
      const t = c.text ?? '';
      const cap = /cap at (\d+)/.exec(rule);
      if (rule.startsWith('main content only + cap')) return capText(mainOnly(t), 2000);
      if (cap) return capText(t, Number(cap[1]));
      if (rule.startsWith('main content only')) return mainOnly(t);
      if (rule.startsWith('no page snapshot')) return shortName(c.name) === 'browser_snapshot' ? t : dropSnapshot(t);
      return t;
    };
    const rules: Array<[string, (c: (typeof browserCalls)[number]) => number]> = [
      ['as captured', (c) => callTokens(c)],
      ...[1000, 2000, 4000].map((n): [string, (c: (typeof browserCalls)[number]) => number] => [`cap at ${n} tokens + "ask for more" note`, (c) => Math.min(callTokens(c), n + 25)]),
      ['main content only (snapshot: keep the main landmark)', (c) => est(mainOnly(c.text ?? '').length) + c.imageTokens],
      ['no page snapshot in action results (snapshot only on browser_snapshot)', (c) => (shortName(c.name) === 'browser_snapshot' ? callTokens(c) : est(dropSnapshot(c.text ?? '').length) + c.imageTokens)],
      ['main content only + cap at 2000', (c) => Math.min(est(mainOnly(c.text ?? '').length), 2025) + c.imageTokens],
    ];
    const base = sum(browserCalls.map((c) => callTokens(c)));
    const baseCarried = sum(browserCalls.map((c) => callTokens(c) * c.carried));
    table('B6. Browser results under offline rules (all captured browser results of the research runs)', ['rule', 'result tokens', 'saved', 'carried into later calls', 'saved per run (carried, avg of runs)'],
      rules.map(([n, f]) => {
        const t = sum(browserCalls.map(f));
        const carried = sum(browserCalls.map((c) => f(c) * c.carried));
        const runsN = new Set(browserCalls.map((c) => c.run)).size || 1;
        return [n, t, `${k(base - t)} (${pct(base - t, base)})`, carried, `${k((baseCarried - carried) / runsN)} (${pct(baseCarried - carried, baseCarried)})`];
      }));
    console.log('\nCarried: a result is sent again with every later model call of its run, so a token saved early saves that many times over.');

    // What a rule would have lost: is the text the agent quoted in its findings still in some browser result of its run?
    const norm = (x: string) => x.toLowerCase().replace(/\\n|\\"/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    const qrows: Array<Array<string | number>> = [];
    for (const [n, f] of rules) {
      let quotes = 0;
      let foundOrig = 0;
      let kept = 0;
      for (const r of runs) {
        const bcalls = browserCalls.filter((c) => c.run === r.label);
        if (!bcalls.length) continue;
        const orig = bcalls.map((c) => norm(c.text ?? ''));
        const short = bcalls.map((c) => norm(shortened(n, c)));
        for (const q of r.calls.flatMap((c) => c.quotes ?? [])) {
          quotes++;
          const nq = norm(q);
          if (orig.some((t) => t.includes(nq))) {
            foundOrig++;
            if (short.some((t) => t.includes(nq))) kept++;
          }
        }
      }
      qrows.push([n, quotes, foundOrig, `${kept} of ${foundOrig}`]);
    }
    table('B7. Quotes the agent saved in its findings: still inside the shortened browser results?', ['rule', 'quotes saved', 'found in the results as captured', 'still inside after the rule'], qrows);
    console.log('\nA quote is matched on letters and digits only (case, punctuation and line breaks ignored). Quotes not found as captured came from elsewhere (e.g. the saved copy) or were reworded.');
  }
}

/** The snapshot section of a Playwright MCP result (a YAML aria tree), or undefined. */
function splitSnapshot(text: string): { before: string; yaml: string; after: string } | undefined {
  const m = /(### (?:Page state|Snapshot)[\s\S]*?```yaml\n)([\s\S]*?)(\n```)/.exec(text);
  if (!m) return undefined;
  return { before: text.slice(0, m.index + m[1]!.length), yaml: m[2]!, after: text.slice(m.index + m[1]!.length + m[2]!.length) };
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * Main content only: in the snapshot's aria tree, keep the subtree of the `main` landmark when there is one;
 * otherwise drop the subtrees of `banner`, `navigation`, `contentinfo` (footer) and `complementary`.
 * Text outside the snapshot (the code that ran, the page URL and title, console lines) is kept.
 */
function mainOnly(text: string): string {
  const s = splitSnapshot(text);
  if (!s) return text;
  const lines = s.yaml.split('\n');
  const subtree = (start: number) => {
    const ind = indentOf(lines[start]!);
    let end = start + 1;
    while (end < lines.length && (indentOf(lines[end]!) > ind || !lines[end]!.trim())) end++;
    return end;
  };
  const mainAt = lines.findIndex((l) => /^\s*- main\b/.test(l));
  let kept: string[];
  if (mainAt >= 0) kept = lines.slice(mainAt, subtree(mainAt));
  else {
    kept = [];
    for (let i = 0; i < lines.length; ) {
      if (/^\s*- (banner|navigation|contentinfo|complementary)\b/.test(lines[i]!)) i = subtree(i);
      else kept.push(lines[i++]!);
    }
  }
  return s.before + kept.join('\n') + s.after;
}

/** An action's result without its page snapshot (what `--snapshot-mode none` would return, approximately). */
function dropSnapshot(text: string): string {
  const s = splitSnapshot(text);
  return s ? s.before.replace(/```yaml\n$/, '') + s.after.replace(/^\n```/, '') : text;
}

// ---------------------------------------------------------------------------------------------------
// main

function smallestRoleOf(a: PartA): Role {
  return (Object.entries(a.roleTools).sort((x, y) => x[1].chars - y[1].chars)[0]![0]) as Role;
}

async function main() {
  if (REANALYZE) {
    // One or more capture dirs (comma-separated): their runs are reported together, part A from the first.
    const saved = REANALYZE.split(',').map((d) => JSON.parse(readFileSync(join(d, 'measurements.json'), 'utf8')) as { a: PartA; runs: RunMeasure[]; smallestRole: Role });
    report(saved.flatMap((x) => x.runs), saved[0]!.a, saved[0]!.smallestRole);
    return;
  }
  console.log(`# Context measurements (${new Date().toLocaleDateString('sv-SE')}; models: claude ${CLAUDE_MODEL}, codex ${CODEX_MODEL})`);
  const a = await partA();
  if (!RUN_GROUPS.length) return;
  const smallestRole = smallestRoleOf(a);
  const capture = mkdtempSync(join(tmpdir(), 'bif-measure-context-'));
  const runs: RunMeasure[] = [];
  const save = () => writeFileSync(join(capture, 'measurements.json'), JSON.stringify({ a, runs, smallestRole }, null, 1));
  const step = async (name: string, fn: () => Promise<RunMeasure | RunMeasure[]>) => {
    try {
      const r = await fn();
      runs.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      console.error(`[measure] ${name} failed: ${(e as Error).message}`);
    }
    save();
  };
  // `--variants` narrows a group to some of its variants (e.g. to re-measure one run).
  const variants = (dflt: string) => opt('variants') ?? dflt;
  if (RUN_GROUPS.includes('overhead')) await step('overhead', () => overheadRuns('claude', smallestRole, variants('abc')));
  if (RUN_GROUPS.includes('builtin')) await step('builtin', () => overheadRuns('claude', smallestRole, variants('de')));
  if (RUN_GROUPS.includes('codex')) await step('codex', () => overheadRuns('codex', smallestRole, variants('ab')));
  if (RUN_GROUPS.includes('worker')) await step('worker', workerRun);
  if (RUN_GROUPS.includes('interviewer')) await step('interviewer', interviewerRun);
  if (RUN_GROUPS.includes('research')) await step('research', researchRuns);
  report(runs, a, smallestRole);
  console.log(`\ncaptures (re-analyse with --reanalyze): ${capture}`);
}

await main();
