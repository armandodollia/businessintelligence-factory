/**
 * Lessons engine (learning loop WP-E). Per business-tree root and role, from `collectLessonSignals`:
 *
 * - **add**: a category that recurs in ≥ `minTasks` (3) distinct tasks, with no active rule or pending
 *   proposal for it, gets a rule proposal. After a rejection, retirement or revert of that category,
 *   only tasks that started later count. At most `maxRulesPerRole` (15) active rules plus pending
 *   additions per role; the most frequent categories are proposed first.
 * - **effect** of an active rule: every run of the role carries the rule in its prompt text as
 *   `[<marker>.v<version>]` (the tracking marker), so each task (unit) is "under the rule's current
 *   version", "before the rule" (no marker, started before the rule) or neither (e.g. lessons off).
 *   Rates = units with the category / units, per group; per prompt version as well (with WP-B's
 *   `promptVersionMetrics` pass rate, agreement and cost alongside).
 * - **revert**: after ≥ `minEffectTasks` (5) tasks under the current version, the rate did not drop
 *   below the rate before the rule.
 * - **retire**: the last `retireAfterCleanTasks` (10) tasks under the rule (any version) were clean.
 * - **strengthen**: the category still recurred in ≥ `minTasks` tasks under the current version
 *   (strength < 3) and the rate did drop (else revert comes first).
 *
 * Every outcome is a PENDING proposal: nothing changes a prompt until the user accepts it
 * (`acceptLessonProposalAsUser`, feedback/actions.ts). One pending proposal per rule / category.
 * Retro prompt edits (`retro:` categories) have no signal to measure: the engine leaves them to the user
 * (`proposeRuleRetirement`).
 */
import type { BifConfig } from '../../config/schema.js';
import { promptVersionMetrics } from '../../metrics/promptMetrics.js';
import type { Store } from '../../store/db.js';
import { newId } from '../../store/repos.js';
import { usageRepos } from '../../store/usageRepos.js';
import type { Role } from '../../types.js';
import { activeRules, markerPrefix } from './appendix.js';
import { LessonPrivacy } from './privacy.js';
import { MAX_STRENGTH, lessonsSettings, type LessonsSettings } from './settings.js';
import { collectLessonSignals, treeIds, type LessonSignal } from './signals.js';
import { lessonRepos } from './store.js';
import { categoryLabel, ruleText } from './templates.js';
import type { LessonEvidence, LessonProposal, LessonRule, LessonStats } from './types.js';

/** A task (or a task-less run) of a role: the unit lessons are counted in. */
export type LessonUnit = { id: string; taskId?: string; startedAt: string; promptVersions: string[] };

/** Units of `role` in the tree (finished runs only), oldest first. */
export function roleUnits(store: Store, rootWorkspaceId: string, role: Role): LessonUnit[] {
  const units = new Map<string, LessonUnit>();
  for (const ws of treeIds(store, rootWorkspaceId)) {
    for (const run of store.agentRuns.list({ workspaceId: ws, role })) {
      if (run.status === 'running') continue;
      const id = run.taskId ?? run.id;
      let u = units.get(id);
      if (!u) {
        u = { id, startedAt: run.startedAt, promptVersions: [], ...(run.taskId ? { taskId: run.taskId } : {}) };
        units.set(id, u);
      }
      if (run.startedAt < u.startedAt) u.startedAt = run.startedAt;
      if (run.promptVersion && !u.promptVersions.includes(run.promptVersion)) u.promptVersions.push(run.promptVersion);
    }
  }
  return [...units.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/** Prompt text lookup with a cache (prompt store, WP-B). */
function promptTexts(store: Store): (pv: string) => string {
  const cache = new Map<string, string>();
  return (pv) => {
    let t = cache.get(pv);
    if (t === undefined) {
      t = usageRepos(store).promptVersions.get(pv)?.text ?? '';
      cache.set(pv, t);
    }
    return t;
  };
}

/** Highest version of the rule with `marker` that the prompt text carries, if any. */
export function ruleVersionIn(text: string, marker: string): number | undefined {
  const prefix = markerPrefix(marker);
  let best: number | undefined;
  for (let i = text.indexOf(prefix); i >= 0; i = text.indexOf(prefix, i + 1)) {
    const m = /^(\d+)\]/.exec(text.slice(i + prefix.length));
    if (m) best = Math.max(best ?? 0, Number(m[1]));
  }
  return best;
}

export type VersionEffect = {
  promptVersion: string;
  /** Version of the rule in this prompt version's text (absent: the rule is not in it). */
  ruleVersion?: number;
  firstSeen: string;
  tasks: number;
  hits: number;
  rate: number | null;
  /** WP-B per-version metrics summed over the tree (null without data). */
  passRate: number | null;
  agreeRate: number | null;
  costUsd: number;
};

export type RuleEffect = {
  ruleId: string;
  marker: string;
  version: number;
  /** Units under the rule's current version, and how many had the category. */
  withRule: number;
  withRuleHits: number;
  rateWithRule: number | null;
  /** Units under any version of the rule. */
  anyVersion: number;
  /** Units before the rule (no marker, started before the rule was accepted). */
  beforeRule: number;
  beforeRuleHits: number;
  rateBeforeRule: number | null;
  /** Latest units under the rule without the category, counted back from the newest. */
  cleanStreak: number;
  versions: VersionEffect[];
};

const rate = (hits: number, n: number) => (n ? Math.round((hits / n) * 1000) / 1000 : null);

/** Per prompt version of `role` in the tree: WP-B metrics summed over the tree's workspaces. */
function treeVersionMetrics(store: Store, rootWorkspaceId: string, role: Role) {
  const acc = new Map<string, { tasks: number; verified: number; ratings: number; agrees: number; costUsd: number }>();
  for (const ws of treeIds(store, rootWorkspaceId)) {
    for (const m of promptVersionMetrics(store, ws, { role })) {
      const a = acc.get(m.promptVersion) ?? { tasks: 0, verified: 0, ratings: 0, agrees: 0, costUsd: 0 };
      a.tasks += m.tasks;
      a.verified += m.verified;
      a.ratings += m.ratings;
      a.agrees += Math.round((m.agreeRate ?? 0) * m.ratings);
      a.costUsd += m.costUsd;
      acc.set(m.promptVersion, a);
    }
  }
  return acc;
}

/** Effect of a rule on its category (see module doc); `hits` = units with the category (default: computed). */
export function ruleEffect(store: Store, rule: LessonRule, opts: { hits?: ReadonlySet<string>; units?: LessonUnit[] } = {}): RuleEffect {
  const units = opts.units ?? roleUnits(store, rule.rootWorkspaceId, rule.role);
  const hits =
    opts.hits ??
    new Set(collectLessonSignals(store, rule.rootWorkspaceId).filter((s) => s.role === rule.role && s.category === rule.category).map((s) => s.unit));
  const text = promptTexts(store);
  const versionOf = (u: LessonUnit) => {
    let v: number | undefined;
    for (const pv of u.promptVersions) {
      const x = ruleVersionIn(text(pv), rule.marker);
      if (x !== undefined) v = Math.max(v ?? 0, x);
    }
    return v;
  };
  const withRule: LessonUnit[] = [];
  const anyVersion: LessonUnit[] = [];
  const before: LessonUnit[] = [];
  for (const u of units) {
    const v = versionOf(u);
    if (v !== undefined) {
      anyVersion.push(u);
      if (v === rule.version) withRule.push(u);
    } else if (u.startedAt < rule.createdAt) before.push(u);
  }
  let cleanStreak = 0;
  for (let i = anyVersion.length - 1; i >= 0 && !hits.has(anyVersion[i]!.id); i--) cleanStreak++;
  const count = (xs: LessonUnit[]) => xs.filter((u) => hits.has(u.id)).length;

  // Per prompt version (trend): units per version of the role's runs.
  const metrics = treeVersionMetrics(store, rule.rootWorkspaceId, rule.role);
  const byVersion = new Map<string, { first: string; units: Set<string>; hits: number }>();
  for (const u of units) {
    for (const pv of u.promptVersions) {
      const g = byVersion.get(pv) ?? { first: u.startedAt, units: new Set<string>(), hits: 0 };
      if (!g.units.has(u.id)) {
        g.units.add(u.id);
        if (hits.has(u.id)) g.hits++;
      }
      if (u.startedAt < g.first) g.first = u.startedAt;
      byVersion.set(pv, g);
    }
  }
  const versions: VersionEffect[] = [...byVersion.entries()]
    .map(([pv, g]) => {
      const m = metrics.get(pv);
      const v: VersionEffect = {
        promptVersion: pv, firstSeen: g.first, tasks: g.units.size, hits: g.hits, rate: rate(g.hits, g.units.size),
        passRate: m && m.tasks ? rate(m.verified, m.tasks) : null,
        agreeRate: m && m.ratings ? rate(m.agrees, m.ratings) : null,
        costUsd: Math.round((m?.costUsd ?? 0) * 1e6) / 1e6,
      };
      const rv = ruleVersionIn(text(pv), rule.marker);
      if (rv !== undefined) v.ruleVersion = rv;
      return v;
    })
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.promptVersion.localeCompare(b.promptVersion));

  const withHits = count(withRule);
  const beforeHits = count(before);
  return {
    ruleId: rule.id, marker: rule.marker, version: rule.version,
    withRule: withRule.length, withRuleHits: withHits, rateWithRule: rate(withHits, withRule.length),
    anyVersion: anyVersion.length,
    beforeRule: before.length, beforeRuleHits: beforeHits, rateBeforeRule: rate(beforeHits, before.length),
    cleanStreak,
    versions,
  };
}

// ---------------------------------------------------------------------------
// evaluation

type Grouped = Map<Role, Map<string, Map<string, LessonSignal[]>>>;

function group(signals: LessonSignal[]): Grouped {
  const out: Grouped = new Map();
  for (const s of signals) {
    let byCat = out.get(s.role);
    if (!byCat) out.set(s.role, (byCat = new Map()));
    let byUnit = byCat.get(s.category);
    if (!byUnit) byCat.set(s.category, (byUnit = new Map()));
    const list = byUnit.get(s.unit) ?? [];
    list.push(s);
    byUnit.set(s.unit, list);
  }
  return out;
}

/** Evidence of a proposal: up to `max` units, newest first, by id; quoted only when privacy allows. */
function evidenceOf(privacy: LessonPrivacy, rootWorkspaceId: string, byUnit: Map<string, LessonSignal[]>, units?: ReadonlySet<string>, max = 5): LessonEvidence[] {
  const sigs = [...byUnit.entries()]
    .filter(([u]) => !units || units.has(u))
    .map(([, list]) => list[0]!)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, max);
  return sigs.map((s) => {
    const e: LessonEvidence = { kind: s.source, id: s.refId };
    if (s.taskId) e.taskId = s.taskId;
    const q = privacy.quote(s, rootWorkspaceId);
    if (q) e.quote = q;
    return e;
  });
}

function insertProposal(store: Store, p: Omit<LessonProposal, 'id' | 'status' | 'createdAt'>, now: string): LessonProposal {
  const row: LessonProposal = { ...p, id: newId('lprop'), status: 'pending', createdAt: now };
  return lessonRepos(store).proposals.insert(row);
}

export type EvaluateOptions = { now?: Date };

/**
 * Runs the engine for one business tree and stores the new pending proposals (returned). Idempotent:
 * a rule or category that already has a pending proposal gets no second one.
 */
export function evaluateLessons(
  deps: { store: Store; config: Pick<BifConfig, 'lessons' | 'roles' | 'knowledge' | 'actionPolicy'> },
  rootWorkspaceId: string,
  opts: EvaluateOptions = {},
): LessonProposal[] {
  const { store, config } = deps;
  const settings = lessonsSettings(config);
  if (!settings.enabled) return [];
  const now = (opts.now ?? new Date()).toISOString();
  return store.transaction(() => evaluate(store, config, settings, rootWorkspaceId, now));
}

function evaluate(
  store: Store,
  config: Pick<BifConfig, 'knowledge' | 'actionPolicy'>,
  settings: LessonsSettings,
  root: string,
  now: string,
): LessonProposal[] {
  const repo = lessonRepos(store);
  const signals = collectLessonSignals(store, root, {}, config);
  const grouped = group(signals);
  const rules = repo.rules.list({ rootWorkspaceId: root });
  const proposals = repo.proposals.list({ rootWorkspaceId: root });
  const pending = proposals.filter((p) => p.status === 'pending');
  const privacy = new LessonPrivacy(store);
  const unitsOf = new Map<Role, LessonUnit[]>();
  const units = (role: Role) => {
    let u = unitsOf.get(role);
    if (!u) unitsOf.set(role, (u = roleUnits(store, root, role)));
    return u;
  };
  const out: LessonProposal[] = [];

  // 1. Active rules: revert, retire or strengthen.
  for (const rule of rules.filter((r) => r.status === 'active' && !r.category.startsWith('retro:'))) {
    if (pending.some((p) => p.ruleId === rule.id)) continue;
    const byUnit = grouped.get(rule.role)?.get(rule.category) ?? new Map<string, LessonSignal[]>();
    const eff = ruleEffect(store, rule, { hits: new Set(byUnit.keys()), units: units(rule.role) });
    const stats: LessonStats = {
      withRule: eff.withRule, withRuleHits: eff.withRuleHits, rateWithRule: eff.rateWithRule,
      beforeRule: eff.beforeRule, beforeRuleHits: eff.beforeRuleHits, rateBeforeRule: eff.rateBeforeRule, cleanStreak: eff.cleanStreak,
    };
    const base = { rootWorkspaceId: root, role: rule.role, category: rule.category, ruleId: rule.id, source: 'engine' as const, stats };
    const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
    if (
      eff.withRule >= settings.minEffectTasks &&
      eff.rateBeforeRule !== null &&
      eff.rateWithRule !== null &&
      eff.rateWithRule >= eff.rateBeforeRule
    ) {
      out.push(insertProposal(store, {
        ...base, action: 'revert', text: rule.text,
        rationale: `${categoryLabel(rule.category)}: the rate did not drop under rule ${rule.marker} v${rule.version} ` +
          `(${pct(eff.rateWithRule)} of ${eff.withRule} tasks with it, ${pct(eff.rateBeforeRule)} of ${eff.beforeRule} before it).`,
        evidence: evidenceOf(privacy, root, byUnit),
      }, now));
    } else if (eff.cleanStreak >= settings.retireAfterCleanTasks) {
      out.push(insertProposal(store, {
        ...base, action: 'retire', text: rule.text,
        rationale: `${categoryLabel(rule.category)}: the last ${eff.cleanStreak} tasks under rule ${rule.marker} were clean.`,
        evidence: [],
      }, now));
    } else if (eff.withRuleHits >= settings.minTasks && rule.strength < MAX_STRENGTH) {
      const hitUnits = new Set([...byUnit.keys()]);
      out.push(insertProposal(store, {
        ...base, action: 'strengthen', text: ruleText(rule.category, rule.role, rule.strength + 1, eff.withRuleHits),
        rationale: `${categoryLabel(rule.category)} still recurred in ${eff.withRuleHits} of ${eff.withRule} tasks under rule ${rule.marker} ` +
          `v${rule.version} (before it: ${pct(eff.rateBeforeRule)}).`,
        evidence: evidenceOf(privacy, root, byUnit, hitUnits),
      }, now));
    }
  }

  // 2. New rules, most frequent categories first, within the per-role cap.
  for (const [role, byCat] of grouped) {
    const active = rules.filter((r) => r.role === role && r.status === 'active');
    let used = active.length + pending.filter((p) => p.role === role && (p.action === 'add' || p.action === 'prompt_edit')).length;
    if (used >= settings.maxRulesPerRole) continue;
    const startOf = new Map(units(role).map((u) => [u.id, u.startedAt]));
    const candidates: Array<{ category: string; fresh: Map<string, LessonSignal[]> }> = [];
    for (const [category, byUnit] of byCat) {
      if (active.some((r) => r.category === category)) continue;
      if (pending.some((p) => p.role === role && p.category === category)) continue;
      const closed = [
        ...rules.filter((r) => r.role === role && r.category === category && r.endedAt).map((r) => r.endedAt!),
        ...proposals.filter((p) => p.role === role && p.category === category && p.status === 'rejected' && p.decidedAt).map((p) => p.decidedAt!),
      ].sort().at(-1);
      const fresh = new Map(
        [...byUnit.entries()].filter(([unit, list]) => {
          if (!closed) return true;
          const at = startOf.get(unit) ?? list.map((s) => s.createdAt ?? '').sort()[0] ?? '';
          return at > closed;
        }),
      );
      if (fresh.size >= settings.minTasks) candidates.push({ category, fresh });
    }
    candidates.sort((a, b) => b.fresh.size - a.fresh.size || a.category.localeCompare(b.category));
    for (const c of candidates) {
      if (used >= settings.maxRulesPerRole) break;
      used++;
      out.push(insertProposal(store, {
        rootWorkspaceId: root, role, action: 'add', category: c.category, source: 'engine',
        text: ruleText(c.category, role, 1, c.fresh.size),
        rationale: `${categoryLabel(c.category)} recurred in ${c.fresh.size} tasks of the ${role} role.`,
        evidence: evidenceOf(privacy, root, c.fresh),
        stats: { tasks: c.fresh.size },
      }, now));
    }
  }
  return out;
}

/**
 * Proposes taking an active rule out of the prompt (any rule, including retro prompt edits); the user
 * still accepts the proposal. Returns the pending proposal (an existing one for the rule is reused).
 */
export function proposeRuleRetirement(store: Store, ruleId: string, rootWorkspaceId: string, now: Date = new Date()): LessonProposal | undefined {
  const repo = lessonRepos(store);
  const rule = repo.rules.get(ruleId);
  if (!rule || rule.rootWorkspaceId !== rootWorkspaceId || rule.status !== 'active') return undefined;
  const existing = repo.proposals.list({ ruleId, status: 'pending' })[0];
  if (existing) return existing;
  return insertProposal(store, {
    rootWorkspaceId, role: rule.role, action: 'retire', category: rule.category, ruleId, source: 'engine', text: rule.text,
    rationale: `Retirement of rule ${rule.marker} requested from the lessons page.`, evidence: [], stats: {},
  }, now.toISOString());
}

/** Rules (all statuses) of a tree with their effect, newest change first. */
export function rulesWithEffect(store: Store, rootWorkspaceId: string): Array<{ rule: LessonRule; effect: RuleEffect }> {
  const rules = lessonRepos(store).rules.list({ rootWorkspaceId });
  const signals = rules.length ? collectLessonSignals(store, rootWorkspaceId) : [];
  const unitsOf = new Map<Role, LessonUnit[]>();
  return rules
    .map((rule) => {
      let units = unitsOf.get(rule.role);
      if (!units) unitsOf.set(rule.role, (units = roleUnits(store, rootWorkspaceId, rule.role)));
      const hits = new Set(signals.filter((s) => s.role === rule.role && s.category === rule.category).map((s) => s.unit));
      return { rule, effect: ruleEffect(store, rule, { hits, units }) };
    })
    .sort((a, b) => b.rule.changedAt.localeCompare(a.rule.changedAt));
}

export { activeRules };
