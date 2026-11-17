/**
 * The feedback bundle (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3): its sections
 * per business tree, the manifest, the preview, the file and its format version.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_FORMAT, buildBundle, bundleFileName, decodeBundle, encodeBundle, previewBundle, type BundleOptions } from '../../../src/core/feedbackBundle/bundle.js';
import { firstRows, type TreeBlock } from '../../../src/core/feedbackBundle/sections.js';
import { SECTION_NAMES } from '../../../src/core/feedbackBundle/sources.js';
import type { Store } from '../../../src/core/store/db.js';
import { NAMES, own, seedWorld, tokenOf, USER, type Seeded } from './seed.js';

const opened: Store[] = [];
let w: Seeded;
beforeAll(async () => {
  w = await seedWorld(opened);
});
afterAll(() => {
  for (const s of opened.splice(0)) s.close();
});

const OPTS: BundleOptions = {
  level: 'standard', appVersion: '0.1.0', platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' }, clis: [{ name: 'claude', version: '2.1.0' }, { name: 'codex' }],
};
const build = (extra: Partial<BundleOptions> = {}) => buildBundle({ store: w.store, config: w.config }, { ...OPTS, ...extra });

type Row = Record<string, any>;
/** The rows of one table of a section for one tree. */
function table(bundle: ReturnType<typeof buildBundle>, section: string, name: string, tree: string = w.root.id): Row[] {
  const block = (bundle.sections[section] as TreeBlock[]).find((b) => b.tree === tree);
  if (!block) throw new Error(`section ${section} has no block for tree ${tree}`);
  const rows = block.tables[name];
  if (!rows) throw new Error(`section ${section} has no table ${name} (it has ${Object.keys(block.tables).join(', ')})`);
  return rows as Row[];
}

describe('buildBundle: shape', () => {
  it('has a manifest and every section of the design; texts only at the fuller level', () => {
    const b = build();
    expect(Object.keys(b.sections)).toEqual(SECTION_NAMES.filter((n) => n !== 'texts'));
    expect(Object.keys(build({ level: 'with_texts' }).sections)).toEqual([...SECTION_NAMES]);
    expect(b.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('the manifest says the versions, the platform, the CLIs, the period, the level, the note and the rows per section', () => {
    const b = build({ since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z', note: own('note') });
    expect(b.manifest).toMatchObject({
      format: BUNDLE_FORMAT, id: b.id, appVersion: '0.1.0', schemaVersion: w.store.schemaVersion(), platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' },
      clis: [{ name: 'claude', version: '2.1.0' }, { name: 'codex' }], period: { since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z' },
      level: 'standard', trees: 2,
    });
    expect(b.manifest.note).toContain(tokenOf(own('note')));
    expect(typeof b.manifest.createdAt).toBe('string');
    const rows = b.manifest.rows as Record<string, number>;
    expect(Object.keys(rows)).toEqual(Object.keys(b.sections));
    expect(rows.runs).toBeGreaterThan(0);
    expect(rows.configuration).toBe(1);
  });

  it('every per-tree section has one block per business tree, and a block holds only rows of its tree', () => {
    const b = build({ level: 'with_texts' });
    const inTree = new Map<string, Set<string>>([
      [w.root.id, new Set([w.root.id, w.child.id])],
      [w.other.id, new Set([w.other.id])],
    ]);
    for (const [name, section] of Object.entries(b.sections)) {
      if (name === 'configuration') continue;
      const blocks = section as TreeBlock[];
      expect(blocks.map((x) => x.tree), name).toEqual([w.root.id, w.other.id]);
      for (const block of blocks) {
        for (const [tableName, rows] of Object.entries(block.tables)) {
          for (const r of rows as Row[]) {
            if (typeof r.workspaceId === 'string') expect(inTree.get(block.tree)!.has(r.workspaceId), `${name}.${tableName}`).toBe(true);
          }
        }
      }
    }
    // The other tree's task is in its own block and not in the first tree's.
    expect(table(b, 'tasks', 'tasks', w.other.id).map((t) => t.id)).toEqual([w.otherTask.id]);
    expect(table(b, 'tasks', 'tasks').map((t) => t.id)).not.toContain(w.otherTask.id);
  });

  it('reads the store and writes nothing', () => {
    const changes = () => Number((w.store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
    const before = changes();
    build({ level: 'with_texts' });
    expect(changes()).toBe(before);
  });
});

describe('buildBundle: sections', () => {
  it('configuration: the effective configuration without the user id, the data folder or secrets', () => {
    const c = build().sections.configuration as Row;
    expect(c).toMatchObject({ roles: w.config.roles, loop: w.config.loop, budgets: { workspace: { maxCostUsd: 500 } } });
    expect(c).not.toHaveProperty('dataDir');
    expect(c).not.toHaveProperty('user');
  });

  it('trees: ids, depth and counts, no names', () => {
    const b = build();
    expect(table(b, 'trees', 'nodes')).toEqual([
      expect.objectContaining({ id: w.root.id, parentId: null, depth: 0, level: 'company', tasks: 3, findings: expect.any(Number), recommendations: 1, personas: 1 }),
      // The child holds the withheld research: its task, and the two arm tasks of the experiment on it.
      expect.objectContaining({ id: w.child.id, parentId: w.root.id, depth: 1, level: 'division', tasks: 3, personas: 1 }),
    ]);
    expect(table(b, 'trees', 'totals')).toEqual([expect.objectContaining({ nodes: 2, depth: 1, tasks: 6, recommendations: 1, personas: 2 })]);
    expect(Object.keys(table(b, 'trees', 'nodes')[0]!)).not.toContain('name');
  });

  it('runs: role, provider, model, task type, round, attempts, status, failure class and reason, times, prompt version, usage', () => {
    const b = build();
    const runs = table(b, 'runs', 'runs');
    const worker = runs.find((r) => r.id === w.workerRun.id)!;
    expect(worker).toMatchObject({
      taskId: w.publicTask.id, role: 'worker', provider: 'claude', model: 'sonnet', kind: 'normal', taskType: 'news_scan', round: 1, status: 'done',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10, totalTokens: 1260, costUsd: 0.0123 },
    });
    expect(typeof worker.startedAt).toBe('string');
    expect(typeof worker.promptVersion).toBe('string');
    const failed = runs.find((r) => r.taskId === w.failedTask.id && r.status === 'failed')!;
    expect(failed.failureClass).toBe('error');
    expect(failed.failureReason).toBe("open 'run.log' failed");
    expect(runs.find((r) => r.kind === 'audit')).toMatchObject({ role: 'reviewer', auditId: w.audit!.id });
    expect(table(b, 'runs', 'attempts').find((a) => a.runId === w.workerRun.id && a.exitCode === 1)).toMatchObject({
      attempt: 1, exitCode: 1, rateLimited: false, failureClass: 'spawn', failureReason: 'spawn failed: ENOENT cwd',
    });
  });

  it('tasks: type, status, rounds, failure class, whether a council reviewed it, timings', () => {
    const b = build();
    const tasks = table(b, 'tasks', 'tasks');
    expect(tasks.find((t) => t.id === w.publicTask.id)).toMatchObject({ type: 'news_scan', status: 'verified', round: 2, councilReviewed: true, phase: 'deep_dives', runs: expect.any(Number) });
    expect(tasks.find((t) => t.id === w.uploadTask.id)).toMatchObject({ status: 'verified', councilReviewed: false });
    const failed = tasks.find((t) => t.id === w.failedTask.id)!;
    expect(failed).toMatchObject({ status: 'failed', failureClass: expect.any(String) });
    expect(typeof failed.firstRunAt).toBe('string');
    expect(Object.keys(failed)).not.toContain('brief');
  });

  it('reviewRounds: the issue history, its recurrence, and the council rounds as counts', () => {
    const b = build();
    const issues = table(b, 'reviewRounds', 'issues');
    expect(issues.find((i) => i.taskId === w.publicTask.id)).toMatchObject({ round: 1, class: 'blocking', status: 'fixed', synthetic: false, reviewerModel: 'codex/gpt-6.1-sol' });
    expect(Object.keys(issues[0]!)).not.toContain('text');
    expect(table(b, 'reviewRounds', 'recurrence')).toEqual([expect.objectContaining({ role: 'worker', taskType: 'news_scan', class: 'blocking', issues: 2 })]);
    expect(table(b, 'reviewRounds', 'councilRounds')).toEqual([
      expect.objectContaining({
        taskId: w.publicTask.id, round: 1, pass: false, score: 6, failed: false, upheld: 1, advisory: 1, dropped: 1, questions: 1, followUps: 1,
        members: [
          { name: 'evidence-reader', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, state: 'reviewed', score: 6, countedScore: 6 },
          { name: 'brief-reader', provider: 'codex', model: 'gpt-6.1-sol', lens: 'brief', blocking: false, state: 'unavailable' },
        ],
      }),
    ]);
  });

  it('outcomes: each outcome with its label, and the outcomes report', () => {
    const b = build();
    const outcomes = table(b, 'outcomes', 'outcomes');
    expect(outcomes.some((o) => o.label === 'confirmed' && o.taskId === w.publicTask.id)).toBe(true);
    expect(outcomes.some((o) => o.label === 'run-failed' && o.taskId === w.failedTask.id)).toBe(true);
    expect(outcomes.every((o) => o.actor === 'system' || o.actor === 'tester')).toBe(true);
    expect(table(b, 'outcomes', 'report').length).toBeGreaterThan(0);
  });

  it('lessonSignals: every signal the lessons engine collects, as role, category, unit and source', () => {
    const signals = table(build(), 'lessonSignals', 'signals');
    const kinds = new Set(signals.map((s) => s.source));
    for (const source of ['review_issue', 'outcome', 'failure', 'policy', 'feedback', 'rating', 'audit', 'recorded']) expect(kinds.has(source), source).toBe(true);
    expect(signals.find((s) => s.source === 'review_issue')).toMatchObject({ role: 'worker', category: 'review:blocking:news_scan', unit: expect.any(String) });
    expect(signals.every((s) => !('text' in s))).toBe(true);
  });

  it('lessons: rules with their effect, proposals with how they were decided, retros with their digest counts', () => {
    const b = build();
    expect(table(b, 'lessons', 'rules')).toEqual([
      expect.objectContaining({ role: 'worker', category: 'review:blocking:news_scan', marker: 'L-7F3A2C', status: 'active', effect: expect.objectContaining({ withRule: expect.any(Number) }) }),
    ]);
    expect(table(b, 'lessons', 'proposals')).toEqual([
      expect.objectContaining({ id: w.proposal.id, action: 'add', status: 'rejected', evidence: 1, stats: { tasks: 3 }, reason: expect.stringContaining(tokenOf(own('lesson-reject-reason'))) }),
    ]);
    expect(table(b, 'lessons', 'retros')).toEqual([
      expect.objectContaining({ status: 'done', triggeredBy: 'user', digest: { tasks: 3, signals: 2, key_1: 4 }, evidenceIds: 2 }),
      expect.objectContaining({ status: 'failed', triggeredBy: 'schedule', failureClass: 'error', failureReason: 'retro run failed: no answer' }),
    ]);
  });

  it('feedback: the log with before / after as figures, and the ratings; the tester is written as tester', () => {
    const b = build();
    const events = table(b, 'feedback', 'events');
    expect(events.find((e) => e.id === w.include.id)).toMatchObject({
      actor: 'tester', kind: 'include_override', targetType: 'finding', targetId: w.finding.id, before: { include: null, status: 'verified' }, after: { include: false },
      reason: expect.stringContaining(tokenOf(own('feedback-reason'))),
    });
    expect(events.find((e) => e.kind === 'user_action')).toMatchObject({ after: { action: 'start_research', phases: 2 } });
    const ratings = table(b, 'feedback', 'ratings');
    expect(ratings.find((r) => r.criterion === 'confidence' && r.targetId === w.finding.id)).toMatchObject({ actor: 'tester', agentValue: 4, userValue: 2, verdict: 'disagree' });
    expect(ratings.find((r) => r.criterion === 'severity')).toMatchObject({ agentValue: '[text]' });
    // The rows calibration derives from include overrides are there too.
    expect(ratings.some((r) => r.criterion === 'include' && r.userValue === 'excluded')).toBe(true);
    expect(JSON.stringify(b.sections.feedback)).not.toContain(USER);
  });

  it('feedback: a reason on something upload-derived or internal is left out, as the training export leaves the record out', () => {
    const b = build();
    const events = table(b, 'feedback', 'events');
    expect(events.find((e) => e.targetId === w.uploadFinding.id)).toMatchObject({ reasonWithheld: true });
    expect(events.find((e) => e.targetId === w.uploadFinding.id)).not.toHaveProperty('reason');
    expect(events.find((e) => e.kind === 'stakeholder_note')).toMatchObject({ reasonWithheld: true });
    expect(table(b, 'feedback', 'ratings').find((r) => r.targetId === w.uploadFinding.id && r.criterion === 'confidence')).toMatchObject({ reasonWithheld: true });
  });

  it('policy: kind and action class, never the site or the detail', () => {
    const b = build();
    expect(table(b, 'policy', 'events').map((e) => [e.kind, e.actionClass, e.site])).toEqual([
      ['blocked', 'save_finding', 'site'],
      ['approval_denied', 'other', undefined],
    ]);
    expect(table(b, 'policy', 'counts')).toEqual([
      { kind: 'blocked', actionClass: 'save_finding', count: 1 },
      { kind: 'approval_denied', actionClass: 'other', count: 1 },
    ]);
  });

  it('knowledge: the knowledge-store metrics and signals', () => {
    const b = build();
    expect(table(b, 'knowledge', 'store')).toEqual([expect.objectContaining({ facts: expect.objectContaining({ total: expect.any(Number) }), artifacts: expect.any(Number) })]);
    for (const t of ['freshness', 'retrieval', 'usageTotal', 'ocr']) expect(table(b, 'knowledge', t), t).toHaveLength(1);
    for (const t of ['retrievalByTool', 'retrievalByGroup', 'usageByRole', 'usageByModel', 'usageByPromptVersion', 'usageByTask', 'signals']) expect(Array.isArray(table(b, 'knowledge', t)), t).toBe(true);
  });

  it('metrics: the metrics report by week and by role, task type, model and prompt version', () => {
    const b = build();
    expect(table(b, 'metrics', 'totals')).toEqual([expect.objectContaining({ runs: expect.any(Number), tasks: 4, verified: 2, failed: 2, costUsd: 0.0123 })]);
    expect(table(b, 'metrics', 'byWeek').length).toBeGreaterThan(0);
    expect(table(b, 'metrics', 'byRole').map((g) => g.key)).toEqual(expect.arrayContaining(['worker', 'reviewer']));
    expect(table(b, 'metrics', 'byTaskType').map((g) => g.key)).toContain('news_scan');
    expect(table(b, 'metrics', 'byModel').map((g) => g.key)).toContain('claude/sonnet');
    expect(table(b, 'metrics', 'byPromptVersion').every((g) => /^[a-z]+:/.test(g.key))).toBe(true);
    expect(table(b, 'metrics', 'failuresByReason')).toEqual(expect.arrayContaining([expect.objectContaining({ failureClass: 'error', failureReason: "open 'run.log' failed" })]));
    expect(table(b, 'metrics', 'reviewIssuesByClass')).toEqual([{ class: 'blocking', issues: 2, tasks: 2 }]);
  });

  it('audits: the audits without their issue texts, their summary and the misses', () => {
    const b = build();
    expect(table(b, 'audits', 'audits')).toEqual([
      expect.objectContaining({ id: w.audit!.id, taskId: w.publicTask.id, verdict: 'miss', actor: 'tester', issues: 1, issueClasses: { substantive: 1 }, auditScore: 3 }),
    ]);
    expect(table(b, 'audits', 'summary')).toEqual([expect.objectContaining({ total: 1, miss: 1, missRate: 1 })]);
    expect(table(b, 'audits', 'misses')).toEqual([expect.objectContaining({ auditId: w.audit!.id, role: 'reviewer', classes: ['substantive'] })]);
    // A failed experiment says why in one line; the experiment on the withheld task has its figures, and
    // of itself and of its failed arm tasks only that they failed.
    const experiments = table(b, 'audits', 'experiments');
    expect(experiments).toEqual([
      expect.objectContaining({ id: w.failedExperimentId, status: 'failed', failureClass: 'error', failureReason: 'arm B could not start' }),
      expect.objectContaining({ id: w.experiment.id, sourceTaskId: w.withheldTask.id, status: 'done', actor: 'tester', repeats: 1 }),
    ]);
    expect(experiments[1]).not.toHaveProperty('failureReason');
    expect(experiments[1]).not.toHaveProperty('failureClass');
    const arms = experiments[1]!.arms as Array<{ arm: string; finished: number; verified: number; tasks: unknown[] }>;
    expect(arms.map((a) => [a.arm, a.finished, a.verified])).toEqual([['A', 1, 0], ['B', 1, 0]]);
    expect(arms.flatMap((a) => a.tasks)).toEqual(w.experiment.arms.flatMap((a) => a.taskIds).map((taskId) => ({ taskId, status: 'failed', round: 1, finalScore: null })));
  });

  it('personas: learning runs and proposals as counts and decisions, the panel figures, the user-persona gate', () => {
    const b = build();
    expect(table(b, 'personas', 'learningRuns')).toEqual([
      expect.objectContaining({ personaId: w.persona.id, personaKind: 'segment', status: 'proposed', shownSignals: 2, stats: { n: 5, agree: 1, disagree: 4, items: 3, lower: 0.4 } }),
      expect.objectContaining({ personaId: w.persona.id, status: 'failed', failureClass: 'error', failureReason: 'learning run failed: no answer' }),
    ]);
    expect(table(b, 'personas', 'proposals')).toEqual([
      expect.objectContaining({ action: 'add', status: 'accepted', edited: true, evidence: 1, reason: expect.stringContaining(tokenOf(own('persona-accept-reason'))) }),
    ]);
    expect(table(b, 'personas', 'adjustments')).toEqual([expect.objectContaining({ status: 'active', version: 1 })]);
    expect(table(b, 'personas', 'panel')).toEqual([
      expect.objectContaining({ recommendationId: w.rec.id, reactions: 1, markedSameAsBaseline: 1, earlierRounds: 1, maxRound: 2, unavailable: 0, limitReached: 0, disagreement: [], baseline: { current: false, earlier: 0 } }),
    ]);
    expect(table(b, 'personas', 'panelReads').map((r) => [r.kind, r.round, r.seat])).toEqual([
      ['persona', 1, { provider: 'claude', model: 'sonnet', effort: 'high' }],
      ['baseline', 1, { provider: 'claude', model: 'sonnet', effort: 'high' }],
    ]);
    expect(table(b, 'personas', 'userPersonaGate')).toEqual([expect.objectContaining({ interactions: expect.any(Number), open: expect.any(Number), qualifies: false })]);
    expect(table(b, 'personas', 'userPersonaGate')[0]!.interactions).toBeGreaterThan(0);
  });

  it('escalations: task type, how many questions, how answered', () => {
    expect(table(build(), 'escalations', 'escalations')).toEqual([
      expect.objectContaining({ taskId: w.failedTask.id, taskType: 'news_scan', questions: 1, answered: 1, dismissed: 0, pending: 0, choseRecommended: 0, choseOther: 1, answeredInOwnWords: 0, reruns: 0 }),
    ]);
  });

  it('budgets: the caps and what was spent, and each time a cap was reached with how it was decided', () => {
    const b = build();
    expect(table(b, 'budgets', 'status').find((s) => s.workspaceId === w.root.id)).toMatchObject({ scope: 'workspace', cap: { maxCostUsd: 500 }, extensions: 1, effectiveCap: { maxCostUsd: 1000 }, exceeded: false, spent: { costUsd: 0.0123 } });
    expect(table(b, 'budgets', 'events')).toEqual([expect.objectContaining({ scope: 'workspace', scopeId: w.root.id, decision: 'extended', waitedMs: 180_000 })]);
  });

  it('requests: kind, how long they waited, how answered, no text; one that "Stop research" closed says so', () => {
    const rows = table(build(), 'requests', 'requests');
    expect(rows.map((r) => [r.kind, r.raisedBy, r.status, r.closedBy, r.waitedMs, r.actor])).toEqual([
      ['login', 'agent', 'resolved', undefined, 1_800_000, 'tester'],
      ['escalation', 'agent', 'resolved', undefined, 3_600_000, 'tester'],
      ['approval', 'budget', 'resolved', undefined, 180_000, 'tester'],
      // The store records it as denied, with the stop's response: the person denied nothing.
      ['approval', 'agent', 'denied', 'stop', 60_000, 'tester'],
    ]);
    for (const r of rows) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['details', 'response']));
  });

  it('texts (fuller level): review-issue and council texts by id, failure messages in full, the export decision lines', () => {
    const b = build({ level: 'with_texts' });
    const issue = table(b, 'texts', 'reviewIssues').find((i) => typeof i.text === 'string')!;
    expect(issue.text).toContain('ZQRES-review-issue-7731');
    expect(issue.response).toBe('fix because reasons');
    const round = table(b, 'texts', 'councilFindings')[0]!;
    expect(round.issues.map((i: Row) => [i.id, i.standing])).toEqual([['C1', 'upheld'], ['C2', 'advisory']]);
    expect(JSON.stringify(round)).toContain('ZQRES-council-upheld-7731');
    const failures = table(b, 'texts', 'failures');
    expect(failures.find((f) => f.kind === 'run' && typeof f.message === 'string' && f.message.includes('ZQRES-failure-tail-7731'))).toBeDefined();
    // Every record whose failure a standard section shortens has its whole message here.
    const whole = (kind: string) => failures.filter((f) => f.kind === kind && typeof f.message === 'string').map((f) => f.message as string);
    expect(whole('experiment')).toEqual([expect.stringMatching(/^arm B could not start\n.*ZQRES-experiment-failure-tail-7731/)]);
    expect(whole('retro')).toEqual([expect.stringMatching(/^retro run failed: no answer\n.*ZQRES-retro-failure-tail-7731/)]);
    expect(whole('persona_learning_run')).toEqual([expect.stringMatching(/^learning run failed: no answer\n.*ZQRES-learning-failure-tail-7731/)]);
    for (const kind of ['run', 'attempt', 'task']) expect(whole(kind).length, kind).toBeGreaterThan(0);
    // Withheld research is named by id only, here as in the standard sections.
    expect(failures).toContainEqual({ kind: 'experiment', id: w.experiment.id, withheld: true });
    expect(failures).toContainEqual({ kind: 'task', id: w.withheldTask.id, withheld: true });
    const lines = table(b, 'texts', 'decisionLines');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.type === 'decision')).toBe(true);
  });

  it('texts: what the training export leaves out stays out, named by id only', () => {
    const b = build({ level: 'with_texts' });
    const uploadIssueIds = new Set(table(build(), 'reviewRounds', 'issues').filter((i) => i.taskId === w.uploadTask.id).map((i) => i.id));
    const withheld = table(b, 'texts', 'reviewIssues').filter((i) => uploadIssueIds.has(i.id));
    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.every((i) => i.withheld === true && !('text' in i))).toBe(true);
  });
});

describe('the period', () => {
  it('keeps the rows inside since / until and leaves the others out', () => {
    const all = build();
    const none = build({ until: '2020-01-01T00:00:00.000Z' });
    // Every table whose rows have a time. Not bounded, and said so in docs/feedback-bundle.md: the counts
    // per tree, the lesson rules, the outcomes report, the budget status and the user-persona gate.
    const timed = [
      ['runs', 'runs'], ['runs', 'attempts'], ['tasks', 'tasks'], ['tasks', 'researchRuns'], ['reviewRounds', 'issues'], ['reviewRounds', 'recurrence'],
      ['reviewRounds', 'councilRounds'], ['outcomes', 'outcomes'], ['lessonSignals', 'signals'], ['lessons', 'proposals'], ['lessons', 'retros'], ['feedback', 'events'],
      ['feedback', 'ratings'], ['policy', 'events'], ['policy', 'counts'], ['audits', 'audits'], ['audits', 'misses'], ['audits', 'experiments'], ['personas', 'learningRuns'],
      ['personas', 'proposals'], ['personas', 'adjustments'], ['personas', 'panel'], ['personas', 'panelReads'], ['escalations', 'escalations'], ['budgets', 'events'],
      ['requests', 'requests'],
    ] as const;
    for (const [section, name] of timed) {
      expect(table(all, section, name).length, `${section}.${name}`).toBeGreaterThan(0);
      expect(table(none, section, name), `${section}.${name}`).toEqual([]);
    }
    // 13 minutes after the seed's start: the include override on the public finding.
    const later = build({ since: '2026-11-02T10:12:30.000Z', until: '2026-11-02T10:13:30.000Z' });
    expect(table(later, 'feedback', 'events').map((e) => e.id)).toEqual([w.include.id]);
  });
});

describe('previewBundle', () => {
  it('lists the manifest and every section with its rows and size, and the size of the file', () => {
    const b = build();
    const p = previewBundle(b);
    expect(p.id).toBe(b.id);
    expect(p.sections.map((s) => s.name)).toEqual(['manifest', ...Object.keys(b.sections)]);
    for (const s of p.sections) {
      expect(s.bytes, s.name).toBeGreaterThan(0);
      expect(Number.isInteger(s.rows), s.name).toBe(true);
    }
    expect(p.sections.find((s) => s.name === 'runs')!.rows).toBe((b.manifest.rows as Record<string, number>).runs);
    expect(p.totalBytes).toBe(encodeBundle(b).length);
  });

  it('the first rows of a section come with their tree and table', () => {
    const rows = firstRows(build().sections.runs, 2) as Row[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tree: w.root.id, table: 'runs', row: expect.objectContaining({ role: expect.any(String) }) });
  });
});

describe('encodeBundle / decodeBundle', () => {
  it('the file is gzip of JSON and reads back as the bundle', () => {
    const b = build({ level: 'with_texts', note: 'a note' });
    const file = encodeBundle(b);
    expect(file[0]).toBe(0x1f);
    expect(file[1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(file).toString('utf8'))).toMatchObject({ id: b.id, manifest: { format: BUNDLE_FORMAT } });
    expect(decodeBundle(file)).toEqual(JSON.parse(JSON.stringify(b)));
  });

  it('refuses a file of a format version it does not know, and says which', () => {
    const b = build();
    const other = gzipSync(Buffer.from(JSON.stringify({ ...b, manifest: { ...b.manifest, format: BUNDLE_FORMAT + 1 } })));
    expect(() => decodeBundle(other)).toThrow(`format version ${BUNDLE_FORMAT + 1}`);
    expect(() => decodeBundle(gzipSync(Buffer.from(JSON.stringify({ hello: 1 }))))).toThrow(/format version/);
    expect(() => decodeBundle(Buffer.from('not a gzip file'))).toThrow(/not a feedback bundle/);
    expect(() => decodeBundle(gzipSync(Buffer.from('not json')))).toThrow(/not a feedback bundle/);
  });

  it('the file name carries the date and the short id', () => {
    const b = build();
    expect(bundleFileName(b)).toBe(`bif-feedback-${String(b.manifest.createdAt).slice(0, 10)}-${b.id}.json.gz`);
  });
});

describe('names', () => {
  it('no business or node name is in a bundle', () => {
    const text = JSON.stringify(build({ level: 'with_texts' }));
    for (const name of Object.values(NAMES)) expect(text, name).not.toContain(name);
  });
});
