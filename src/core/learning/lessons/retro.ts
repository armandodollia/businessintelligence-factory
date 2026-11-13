/**
 * Weekly retro (learning loop WP-E). Per business tree, through the existing scheduler (`retroJobs` →
 * `SchedulerDeps.systemJobs`): runs the lessons engine, then digests the period (task results, costs,
 * outcomes, review issues, failures, policy denials, feedback and ratings, knowledge signals, lesson
 * rules and pending proposals) and lets the `retro` agent propose prompt and calibration edits as
 * PENDING proposals with evidence ids (`submit_retro`). The user accepts or rejects each one.
 *
 * The digest follows the knowledge-store briefing rules (design §11, KS-4/KS-5): one section within the
 * retro role's `briefing` budget (`fitBriefing`: the degrade ladder), every line redacted whole then cut
 * (`servedLine`), the lines fenced as untrusted data, and the section logged as a `prompt_context` read
 * on the retro run BEFORE it starts (`AgentRequest.promptReads` → `beforeStart`). Lines carry counts and
 * ids; text is quoted only under the upload rules (`LessonPrivacy`), so a retro run is never shown
 * upload-derived text. A retro run that was exposed anyway has its proposals refused.
 */
import type { BifConfig } from '../../config/schema.js';
import type { ExtraToolHandler, ToolResult } from '../../harness/tools/handlers.js';
import type { ToolInput, ToolName } from '../../harness/tools/registry.js';
import { budgetFor } from '../../knowledge/budget.js';
import { fitBriefing, type BriefLine, type Briefing } from '../../knowledge/briefing.js';
import { runIsUploadExposed } from '../../knowledge/retrievalLog.js';
import { servedLine } from '../../knowledge/texts.js';
import { loadPrompt, promptVersion, type CalibrationScope } from '../../prompts/index.js';
import { runAgent, type ResearchDeps } from '../../research/deps.js';
import { calibrationScope } from '../../scoring/calibration.js';
import { nextDue, type SystemJob } from '../../scheduler/scheduler.js';
import type { Store } from '../../store/db.js';
import { newId } from '../../store/repos.js';
import type { Decision, Role } from '../../types.js';
import { rootOf } from '../../workspace/tree.js';
import { listFeedback } from '../../feedback/events.js';
import { activeRules } from './appendix.js';
import { evaluateLessons, rulesWithEffect } from './engine.js';
import { LessonPrivacy } from './privacy.js';
import { lessonsSettings } from './settings.js';
import { collectLessonSignals, treeIds, type LessonSignal } from './signals.js';
import { lessonRepos } from './store.js';
import { categoryLabel } from './templates.js';
import type { LessonProposal, RetroRecord } from './types.js';

const DAY = 86_400_000;
/** Ids named per digest line. */
const IDS_PER_LINE = 3;
/** Quoted examples per signal group, and in the whole digest. */
const QUOTES_PER_GROUP = 2;
const MAX_QUOTES = 12;
const LINE_CHARS = 300;

export type RetroDigest = {
  windowStart: string;
  windowEnd: string;
  briefing: Briefing;
  /** Counts of what the digest covers (no text). */
  counts: Record<string, number>;
  /** Anything happened in the window. */
  active: boolean;
};

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const ids = (xs: string[]) => (xs.length ? ` [${xs.slice(0, IDS_PER_LINE).join(', ')}${xs.length > IDS_PER_LINE ? ', …' : ''}]` : '');

/** Default digest budget (tokens) unless `knowledge.budgets.roles.retro.briefing` is configured. */
export const RETRO_BRIEFING_TOKENS = 4000;

/** The retro digest budget: the configured retro briefing budget, else 4 000; provider scale and `hardMaxTokens` apply. */
export function retroBudget(config: Pick<BifConfig, 'knowledge'>, provider?: BifConfig['roles']['orchestrator']['provider']): number {
  const k = config.knowledge ?? {};
  if (k.budgets?.roles?.retro?.briefing !== undefined) return budgetFor(config, 'retro', provider, 'briefing');
  const roles = { ...k.budgets?.roles, retro: { ...k.budgets?.roles?.retro, briefing: RETRO_BRIEFING_TOKENS } };
  return budgetFor({ knowledge: { ...k, budgets: { ...k.budgets, roles } } }, 'retro', provider, 'briefing');
}

/** Start of the next retro's window: the end of the last finished (or skipped) retro, else `windowDays` back. */
export function retroWindowStart(store: Store, rootWorkspaceId: string, now: Date, windowDays: number): string {
  const last = lessonRepos(store)
    .retros.list({ rootWorkspaceId })
    .filter((r) => r.status !== 'running' && r.status !== 'failed')
    .at(-1);
  return last?.windowEnd ?? new Date(now.getTime() - windowDays * DAY).toISOString();
}

/**
 * The digest of one business tree over [since, until) as a fitted briefing section (see module doc).
 * `provider`: the retro model's provider (its budget scale).
 */
export function retroDigest(
  deps: { store: Store; config: BifConfig },
  rootWorkspaceId: string,
  window: { since: string; until: string },
  provider?: BifConfig['roles']['orchestrator']['provider'],
): RetroDigest {
  const { store, config } = deps;
  const wsIds = treeIds(store, rootWorkspaceId);
  const inWin = (at: string | undefined) => !!at && at >= window.since && at < window.until;
  const clip = (s: string) => servedLine(store, rootWorkspaceId, s, LINE_CHARS);
  const heading = (text: string): BriefLine => ({ text, refs: [], upload: false, heading: true });
  const line = (text: string, refs: Array<{ id: string; kind: string }>): BriefLine => ({ text: clip(text), refs, upload: false });
  const counts: Record<string, number> = {};
  const lines: BriefLine[] = [];
  const quotes: BriefLine[] = [];

  // Task results per role / task type.
  const tasks = wsIds.flatMap((ws) => store.tasks.list({ workspaceId: ws })).filter((t) => inWin(t.createdAt) && ['verified', 'unverified', 'failed'].includes(t.status));
  counts.tasks = tasks.length;
  if (tasks.length) {
    lines.push(heading('# Task results'));
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const role = t.type === 'synthesize_recommendations' ? 'synthesizer' : 'worker';
      const k = `${role} ${t.type}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    for (const [k, ts] of groups) {
      const by = (s: string) => ts.filter((t) => t.status === s).length;
      lines.push(line(`${k}: ${ts.length} task(s), ${by('verified')} verified, ${by('unverified')} unverified, ${by('failed')} failed${ids(ts.map((t) => t.id))}`,
        ts.slice(0, IDS_PER_LINE).map((t) => ({ id: t.id, kind: 'task' }))));
    }
  }

  // Costs per role (agent_usage rows of the window; same cost rule as WP-B's reports).
  const usage = store.db
    .prepare(
      `SELECT role, COUNT(DISTINCT run_id) AS runs, COALESCE(SUM(COALESCE(cost_usd, cli_reported_cost_usd, 0)), 0) AS cost,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
       FROM agent_usage WHERE workspace_id IN (${wsIds.map(() => '?').join(', ')}) AND created_at >= ? AND created_at < ?
       GROUP BY role ORDER BY cost DESC`,
    )
    .all(...wsIds, window.since, window.until) as Array<{ role: string; runs: number; cost: number; tokens: number }>;
  counts.costRows = usage.length;
  if (usage.length) {
    lines.push(heading('# Costs'));
    for (const u of usage) lines.push(line(`${u.role}: $${Number(u.cost).toFixed(4)}, ${Number(u.tokens)} tokens, ${Number(u.runs)} run(s)`, []));
  }

  // Lesson rules in the prompts (with their effect) and proposals waiting for the user.
  const rules = rulesWithEffect(store, rootWorkspaceId).filter((r) => r.rule.status === 'active');
  const pending = lessonRepos(store).proposals.list({ rootWorkspaceId, status: 'pending' });
  counts.activeRules = rules.length;
  counts.pendingProposals = pending.length;
  if (rules.length || pending.length) {
    lines.push(heading('# Lesson rules and pending proposals'));
    for (const { rule, effect: e } of rules) {
      lines.push(line(
        `active ${rule.role} ${rule.marker}.v${rule.version} (${categoryLabel(rule.category)}): before ${pct(e.beforeRuleHits, e.beforeRule)} of ${e.beforeRule}, ` +
          `with it ${pct(e.withRuleHits, e.withRule)} of ${e.withRule}, clean streak ${e.cleanStreak} [${rule.id}] — ${rule.text}`,
        [{ id: rule.id, kind: 'lesson_rule' }],
      ));
    }
    for (const p of pending) lines.push(line(`pending ${p.action} for ${p.role}${p.category ? ` (${categoryLabel(p.category)})` : ''} [${p.id}] — ${p.text}`, [{ id: p.id, kind: 'lesson_proposal' }]));
  }

  // Signals of the window, grouped by source / role / category.
  const signals = collectLessonSignals(store, rootWorkspaceId, { since: window.since, until: window.until }, config);
  counts.signals = signals.length;
  const privacy = new LessonPrivacy(store);
  const SOURCE_TITLES: Record<LessonSignal['source'], string> = {
    outcome: '# Decision outcomes', review_issue: '# Review issues', feedback: '# User feedback on agent output', rating: '# Rating disagreements',
    failure: '# Run failures', policy: '# Policy denials', knowledge: '# Knowledge-store signals', recorded: '# Recorded signals (audits, ...)',
  };
  for (const source of Object.keys(SOURCE_TITLES) as Array<LessonSignal['source']>) {
    const mine = signals.filter((s) => s.source === source);
    if (!mine.length) continue;
    lines.push(heading(SOURCE_TITLES[source]));
    const groups = new Map<string, LessonSignal[]>();
    for (const s of mine) groups.set(`${s.role}\u0000${s.category}`, [...(groups.get(`${s.role}\u0000${s.category}`) ?? []), s]);
    for (const [, g] of [...groups.entries()].sort((a, b) => new Set(b[1].map((s) => s.unit)).size - new Set(a[1].map((s) => s.unit)).size)) {
      const units = [...new Set(g.map((s) => s.unit))];
      // Ids that name no content (tasks, runs, log rows), so the read never resolves to upload-derived items.
      const refs = [...new Set(g.map((s) => (s.source === 'knowledge' ? s.unit : s.refId)))];
      lines.push(line(`${g[0]!.role} ${categoryLabel(g[0]!.category)}: ${g.length} in ${units.length} task(s)${ids(refs)}`,
        refs.slice(0, IDS_PER_LINE).map((id) => ({ id, kind: source }))));
      let quoted = 0;
      for (const s of g) {
        if (quoted >= QUOTES_PER_GROUP || quotes.length >= MAX_QUOTES) break;
        const q = s.text ? privacy.quote(s, rootWorkspaceId) : undefined;
        if (!q) continue;
        quotes.push({ text: `${s.refId}: ${q}`, refs: [{ id: s.refId, kind: s.source }], upload: false });
        quoted++;
      }
    }
  }

  // Other human actions of the window (counts by kind).
  const fb = wsIds.flatMap((ws) => listFeedback(store, { workspaceId: ws })).filter((f) => inWin(f.createdAt));
  counts.feedbackEvents = fb.length;
  if (fb.length) {
    lines.push(heading('# All user actions (feedback events)'));
    const kinds = new Map<string, string[]>();
    for (const f of fb) kinds.set(f.kind, [...(kinds.get(f.kind) ?? []), f.id]);
    for (const [k, xs] of kinds) lines.push(line(`${k}: ${xs.length}${ids(xs)}`, xs.slice(0, IDS_PER_LINE).map((id) => ({ id, kind: 'feedback' }))));
  }
  if (quotes.length) lines.push(heading('# Examples (text shown only when it is not upload-derived)'), ...quotes);

  const budget = retroBudget(config, provider);
  const briefing = fitBriefing(
    { store, config },
    {
      title: '## Digest of the period',
      intro: [`Business tree ${rootWorkspaceId}, from ${window.since} to ${window.until}. Ids in [brackets] may be cited as evidence.`],
      lines,
      empty: 'Nothing happened in this period.',
      budget,
      query: `retro digest ${window.since}..${window.until}`,
      scope: 'tree',
      label: 'retro',
    },
  );
  const active = counts.tasks! + counts.signals! + counts.feedbackEvents! + counts.costRows! > 0;
  return { windowStart: window.since, windowEnd: window.until, briefing, counts, active };
}

/** Retro agent system prompt: `retro.md` (+ calibration and accepted lessons of the tree, like every role). */
export function retroSystemPrompt(scope?: CalibrationScope): string {
  return loadPrompt('retro', scope).text;
}

/** Retro task prompt: the period, the digest section, and the call to make. */
export function retroPrompt(rootName: string, digest: RetroDigest, maxProposals: number): string {
  return [
    `# Weekly retro: ${rootName}`,
    `Period: ${digest.windowStart} to ${digest.windowEnd}.`,
    digest.briefing.section,
    '## What to do',
    `Call \`submit_retro\` exactly once: a short summary and at most ${maxProposals} proposal(s) (prompt_edit or calibration_edit, ` +
      'one role each), each citing ids shown in the digest. Write general rules; never copy evidence text into a proposal.',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// running

const inflight = new Set<string>();

export type RunRetroOptions = { triggeredBy?: RetroRecord['triggeredBy']; now?: Date };

/**
 * Runs the retro of one business tree: the lessons engine, then (when anything happened since the
 * last retro) the retro agent on the digest. Returns the retro row, or undefined when lessons or the
 * retro are disabled or one is already running for the tree. Never throws for an agent failure (the
 * row ends `failed`).
 */
export async function runRetro(deps: ResearchDeps, workspaceId: string, opts: RunRetroOptions = {}): Promise<RetroRecord | undefined> {
  const { store, config } = deps;
  const settings = lessonsSettings(config);
  if (!settings.enabled || !settings.retro.enabled) return undefined;
  const ws = store.workspaces.get(workspaceId);
  if (!ws) throw new Error(`workspace '${workspaceId}' not found`);
  const root = rootOf(store, workspaceId);
  if (inflight.has(root)) return undefined;
  inflight.add(root);
  const repo = lessonRepos(store).retros;
  try {
    // A `running` row nobody is running (the server stopped mid-retro) is closed out.
    for (const r of repo.list({ rootWorkspaceId: root, status: 'running' })) {
      repo.update(r.id, { status: 'failed', failureReason: 'interrupted', endedAt: new Date().toISOString() });
    }
    const now = opts.now ?? new Date();
    evaluateLessons({ store, config }, root, { now });
    const window = { since: retroWindowStart(store, root, now, settings.retro.windowDays), until: now.toISOString() };
    const digest = retroDigest({ store, config }, root, window, settings.retro.model.provider);
    const base: RetroRecord = {
      id: newId('retro'), rootWorkspaceId: root, status: 'running', triggeredBy: opts.triggeredBy ?? 'user', windowStart: window.since,
      windowEnd: window.until, digest: digest.counts, evidenceIds: digest.briefing.results.map((r) => r.id), proposalIds: [], createdAt: now.toISOString(),
    };
    if (!digest.active || !digest.briefing.section) {
      return repo.insert({ ...base, status: 'skipped', endedAt: now.toISOString() });
    }
    const retro = repo.insert(base);
    const scope = calibrationScope(store, config.dataDir, root);
    const system = retroSystemPrompt(scope);
    const rootWs = store.workspaces.get(root);
    try {
      const res = await runAgent(deps, {
        kind: 'retro', role: 'retro', workspaceId: root, round: 1, attempt: 1,
        prompt: retroPrompt(rootWs?.name ?? root, digest, settings.retro.maxProposals),
        systemPrompt: system, model: settings.retro.model, needsBrowser: false, promptVersion: promptVersion(system),
        ...(digest.briefing.read ? { promptReads: [digest.briefing.read] } : {}),
      });
      const cur = repo.get(retro.id)!;
      return repo.update(retro.id, {
        agentRunId: res.agentRunId,
        status: res.status === 'done' && cur.summary !== undefined ? 'done' : 'failed',
        ...(res.status !== 'done' ? { failureReason: res.reason ?? 'retro run failed' } : cur.summary === undefined ? { failureReason: 'retro ended without submit_retro' } : {}),
        endedAt: new Date().toISOString(),
      });
    } catch (e) {
      return repo.update(retro.id, { status: 'failed', failureReason: (e as Error).message, endedAt: new Date().toISOString() });
    }
  } finally {
    inflight.delete(root);
  }
}

// ---------------------------------------------------------------------------
// submit_retro

const fail = (error: string): ToolResult => ({ ok: false, error });

/**
 * `submit_retro` (retro role): stores the summary and each proposal as a PENDING lesson proposal of
 * the tree (source `retro`), after checking that every evidence id was shown in the digest, the
 * proposal count, the per-role rule cap, and that the run was not shown upload-derived text. Records
 * one Decision. A replay from the same run returns the first proposals.
 */
export const submitRetroHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'submit_retro'>;
  const { store, config, events } = deps;
  const root = rootOf(store, ctx.workspaceId);
  const repos = lessonRepos(store);
  const retro = repos.retros.list({ rootWorkspaceId: root, status: 'running' }).at(-1);
  if (!retro || (retro.agentRunId && retro.agentRunId !== ctx.agentRunId)) return fail('submit_retro needs a running retro of this business');
  if (retro.summary !== undefined) return { ok: true, data: { proposalIds: retro.proposalIds, duplicate: true } };
  const settings = lessonsSettings(config);
  if (input.proposals.length > settings.retro.maxProposals) return fail(`at most ${settings.retro.maxProposals} proposal(s) per retro (lessons.retro.maxProposals)`);
  if (runIsUploadExposed(store, ctx.agentRunId)) return fail('this retro run was shown upload-derived text: its proposals are refused');
  const allowed = new Set(retro.evidenceIds);
  for (const [i, p] of input.proposals.entries()) {
    const bad = p.evidence.filter((id) => !allowed.has(id));
    if (bad.length) return fail(`proposals[${i}].evidence: ${bad.join(', ')} not shown in the digest`);
  }
  const pending = repos.proposals.list({ rootWorkspaceId: root, status: 'pending' });
  const adds = new Map<Role, number>();
  for (const p of input.proposals.filter((x) => x.kind === 'prompt_edit')) {
    const n = (adds.get(p.role) ?? 0) + 1;
    adds.set(p.role, n);
    const used = activeRules(store, root, p.role).length + pending.filter((x) => x.role === p.role && (x.action === 'add' || x.action === 'prompt_edit')).length;
    if (used + n > settings.maxRulesPerRole) return fail(`role '${p.role}' would exceed ${settings.maxRulesPerRole} lesson rules`);
  }
  const now = new Date().toISOString();
  const outcome = store.transaction(() => {
    const proposals = input.proposals.map((p) =>
      repos.proposals.insert({
        id: newId('lprop'), rootWorkspaceId: root, role: p.role, action: p.kind, source: 'retro', retroId: retro.id, status: 'pending', createdAt: now,
        text: servedLine(store, root, p.text, 600), rationale: servedLine(store, root, p.why, 600),
        evidence: [...new Set(p.evidence)].map((id) => ({ kind: 'digest', id })), stats: {},
      } satisfies LessonProposal),
    );
    const summary = servedLine(store, root, input.summary, 2000);
    const decision: Decision = {
      id: newId('dec'), workspaceId: ctx.workspaceId, agentRunId: ctx.agentRunId, role: ctx.role, model: ctx.model, kind: 'decision',
      payload: { tool: 'submit_retro', retroId: retro.id, summary, proposalIds: proposals.map((p) => p.id) },
      refs: [retro.id, ...proposals.map((p) => p.id)], promptVersion: ctx.promptVersion, createdAt: now,
    };
    store.decisions.insert(decision);
    repos.retros.update(retro.id, { agentRunId: ctx.agentRunId, summary, proposalIds: proposals.map((p) => p.id) });
    return { decision, ids: proposals.map((p) => p.id) };
  });
  events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: outcome.decision });
  return { ok: true, data: { proposalIds: outcome.ids }, recorded: true };
};

/** Extra tool handlers to pass to `createToolHandlers({ extraHandlers })`. */
export function retroToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return { submit_retro: submitRetroHandler };
}

// ---------------------------------------------------------------------------
// scheduling

/**
 * The weekly retro of every business tree as scheduler system jobs (`SchedulerDeps.systemJobs`): one
 * job per root workspace on `lessons.retro.cron`; its last run is the tree's latest retro. Empty when
 * lessons or the retro are disabled.
 */
export function retroJobs(deps: ResearchDeps): SystemJob[] {
  const settings = lessonsSettings(deps.config);
  if (!settings.enabled || !settings.retro.enabled) return [];
  const repo = lessonRepos(deps.store).retros;
  return deps.store.workspaces
    .list()
    .filter((w) => !w.parentWorkspaceId)
    .map((w) => {
      const last = repo.list({ rootWorkspaceId: w.id }).at(-1);
      const job: SystemJob = {
        id: `retro:${w.id}`,
        cron: settings.retro.cron,
        run: () => runRetro(deps, w.id, { triggeredBy: 'schedule' }),
      };
      if (last) job.lastRunAt = last.createdAt;
      return job;
    });
}

/** Next scheduled retro of a tree (for the lessons page), or null when the cron is invalid / disabled. */
export function nextRetroAt(config: BifConfig, after: Date = new Date()): string | null {
  const s = lessonsSettings(config);
  if (!s.enabled || !s.retro.enabled) return null;
  try {
    return nextDue(s.retro.cron, after).toISOString();
  } catch {
    return null;
  }
}
