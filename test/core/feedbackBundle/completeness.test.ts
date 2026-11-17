/**
 * The completeness test of the feedback bundle (design §3.3; plan review focus 2).
 *
 * It reads the three places analytics are read from — `retroDigest` (learning/lessons/retro.ts),
 * `collectLessonSignals` (learning/lessons/signals.ts) and `metricsReport` (metrics/report.ts) — and
 * lists what they read: every imported function, every repository and every table read by SQL. Each
 * of those must be either a source named in `RETRO_SOURCES`, or listed below as not a source, with the
 * reason. So a signal added to the retro later fails this test until someone says which section of
 * the bundle carries it.
 *
 * It then checks that every source has a section, and that building that section calls the source's
 * own query function or repository (the same function, not a copy of its SQL).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { ratingsWithSignals } from '../../../src/core/feedback/signals.js';
import { buildBundle } from '../../../src/core/feedbackBundle/bundle.js';
import { buildSection, QUERIES, SECTION_BUILDERS, sectionContext, type Queries, type TreeSectionName } from '../../../src/core/feedbackBundle/sections.js';
import { RETRO_SOURCES, SECTION_NAMES, SECTION_OF_SOURCE, type RetroSource } from '../../../src/core/feedbackBundle/sources.js';
import { knowledgeMetrics, knowledgeSignals } from '../../../src/core/knowledge/metrics.js';
import { rulesWithEffect } from '../../../src/core/learning/lessons/engine.js';
import { collectLessonSignals } from '../../../src/core/learning/lessons/signals.js';
import { lessonRepos } from '../../../src/core/learning/lessons/store.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import { auditMisses } from '../../../src/core/learning/reviewerAudit.js';
import { issueRecurrence, listReviewIssues } from '../../../src/core/learning/reviewIssues.js';
import { learningRepos } from '../../../src/core/learning/store.js';
import { metricsReport } from '../../../src/core/metrics/report.js';
import { usageByRun } from '../../../src/core/metrics/usage.js';
import { listPolicyEvents } from '../../../src/core/policy/policyEvents.js';
import type { Store } from '../../../src/core/store/db.js';
import { usageRepos } from '../../../src/core/store/usageRepos.js';
import { seedWorld, type Seeded } from './seed.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const READERS = {
  retroDigest: 'src/core/learning/lessons/retro.ts',
  collectLessonSignals: 'src/core/learning/lessons/signals.ts',
  metricsReport: 'src/core/metrics/report.ts',
} as const;

/**
 * What the three files read that is not a source of analytics, each with the reason. A name that is
 * neither here nor in `RETRO_SOURCES` fails the test.
 */
const NOT_A_SOURCE: Record<string, string> = {
  // retro.ts
  budgetFor: 'size of the digest',
  fitBriefing: 'fits the digest into its budget',
  runIsUploadExposed: 'refuses the proposals of an exposed retro run',
  servedLine: 'redacts and cuts a digest line',
  loadPrompt: 'the retro prompt',
  promptVersion: 'the retro prompt',
  runAgent: 'starts the retro agent',
  calibrationScope: 'the retro prompt',
  CronExpressionParser: 'the retro schedule',
  newId: 'makes ids',
  rootOf: 'finds the tree (the bundle is built per tree)',
  runPersonaLearning: 'runs persona learning; its runs and proposals are in the personas section',
  runUserPersonaLearning: 'runs user persona learning; its runs and proposals are in the personas section',
  activeRules: 'the cap on rules when a retro proposes one; the rules are in the lessons section (rulesWithEffect)',
  evaluateLessons: 'runs the lessons engine; what it writes is in the lessons section',
  LessonPrivacy: 'decides what a digest may quote',
  lessonsSettings: 'configuration (the configuration section)',
  treeIds: 'the nodes of a tree',
  categoryLabel: 'wording of a category',
  'store.workspaces': 'finds the tree (the trees section carries the nodes)',
  'store.decisions': 'the retro agent writes its own Decision; not read as a signal',
  'lessonRepos.rules': 'rules reach the digest and the bundle through rulesWithEffect',
  // signals.ts
  ROLES: 'the list of roles',
  TOOL_NAMES: 'the list of tools, for the class of a policy action',
  DENIAL_KINDS: 'which policy events are denials',
  KNOWLEDGE_BLOCK_SITE: 'which policy events are left out',
  descendants: 'the nodes of a tree',
  experimentTaskIds: 'leaves experiment tasks out; a run carries its tag in the runs section (kind)',
  isTaggedDecision: 'leaves experiment and audit decisions out',
  taggedRunIds: 'leaves experiment and audit runs out; a run carries its tag in the runs section (kind)',
  // report.ts
  treeWorkspaceIds: 'the nodes of a tree',
  learningRepos: 'reached as learningRepos.reviewIssues, which is a source',
  OUTCOME_LABELS: 'the list of outcome labels',
  ratingDelta: 'arithmetic on a rating',
  experimentRunFilter: 'leaves experiment and audit runs out; a run carries its tag in the runs section (kind)',
  originRunOfRating: 'attributes a rating to the run that produced the rated value',
  ratingOriginIndex: 'attributes a rating to the run that produced the rated value',
  usageRepos: 'reached as usageRepos.agentRunAttempts, which is a source',
  lessonRepos: 'reached as lessonRepos.proposals / retros / signals, which are sources',
};

/** Everything a source file reads: imported values, repositories, tables read by SQL. */
function readsOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[^']+';/gm)) {
    if (m[1]) continue;
    for (const part of m[2]!.split(',')) {
      const name = part.replace(/\/\/.*$/gm, '').trim();
      if (name && !name.startsWith('type ')) out.add(name.split(/\s+as\s+/)[0]!);
    }
  }
  for (const m of source.matchAll(/\bstore\s*\.\s*(\w+)\s*\.\s*(?:list|get)\b/g)) out.add(`store.${m[1]}`);
  for (const m of source.matchAll(/\b(\w+Repos)\(\w+\)\s*\.\s*(\w+)/g)) out.add(`${m[1]}.${m[2]}`);
  // `const repos = lessonRepos(store); … repos.proposals.list(…)`
  for (const alias of source.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+Repos)\(\w+\);/g)) {
    for (const m of source.matchAll(new RegExp(`\\b${alias[1]}\\.(\\w+)\\.(?:list|get)\\b`, 'g'))) out.add(`${alias[2]}.${m[1]}`);
  }
  for (const m of source.matchAll(/\bFROM\s+([a-z_]+)/g)) out.add(`sql:${m[1]}`);
  return [...out].sort();
}

const sources: readonly string[] = RETRO_SOURCES;

describe('what the retro, the lessons engine and the metrics view read', () => {
  const reads = Object.fromEntries(Object.entries(READERS).map(([fn, file]) => [fn, readsOf(readFileSync(join(ROOT, file), 'utf8'))]));

  it.each(Object.keys(READERS))('%s: everything it reads is a named source of the bundle, or is listed as not a source', (fn) => {
    const unknown = reads[fn]!.filter((name) => !sources.includes(name) && !(name in NOT_A_SOURCE));
    expect(unknown, `${READERS[fn as keyof typeof READERS]} reads these, and the feedback bundle does not know them: add each to RETRO_SOURCES with its section (src/core/feedbackBundle/sources.ts), or to NOT_A_SOURCE here with the reason`).toEqual([]);
  });

  it('finds the readers themselves (the scan is not empty)', () => {
    expect(reads.retroDigest).toEqual(expect.arrayContaining(['collectLessonSignals', 'listFeedback', 'rulesWithEffect', 'store.tasks', 'sql:agent_usage', 'lessonRepos.proposals', 'lessonRepos.retros']));
    expect(reads.collectLessonSignals).toEqual(
      expect.arrayContaining(['listReviewIssues', 'issueRecurrence', 'listOutcomes', 'listPolicyEvents', 'knowledgeSignals', 'auditMisses', 'store.agentRuns', 'store.ratings', 'usageRepos.agentRunAttempts', 'lessonRepos.signals']),
    );
    expect(reads.metricsReport).toEqual(expect.arrayContaining(['ratingsWithSignals', 'usageByRun', 'knowledgeMetrics', 'listOutcomes', 'learningRepos.reviewIssues', 'sql:agent_run_attempts', 'store.agentRuns', 'store.tasks']));
  });

  it('names no source that none of them reads, and nothing as both a source and not a source', () => {
    const read = new Set(Object.values(reads).flat());
    // `metricsReport` is the metrics view itself: it is a section as a whole.
    expect(sources.filter((s) => s !== 'metricsReport' && !read.has(s))).toEqual([]);
    expect(readFileSync(join(ROOT, READERS.metricsReport), 'utf8')).toContain('export function metricsReport(');
    expect(sources.filter((s) => s in NOT_A_SOURCE)).toEqual([]);
  });
});

describe('every source has a section', () => {
  const opened: Store[] = [];
  let w: Seeded;
  beforeAll(async () => {
    w = await seedWorld(opened);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    for (const s of opened.splice(0)) s.close();
  });

  it('each source is given a section that a bundle has', () => {
    expect(Object.keys(SECTION_OF_SOURCE).sort()).toEqual([...sources].sort());
    const bundle = buildBundle({ store: w.store, config: w.config }, { level: 'standard', appVersion: 'x', platform: { os: 'o', arch: 'a', node: 'n' } });
    for (const source of sources) {
      const section = SECTION_OF_SOURCE[source]!;
      expect(SECTION_NAMES, source).toContain(section);
      expect(Object.keys(SECTION_BUILDERS), source).toContain(section);
      expect(bundle.sections, source).toHaveProperty(section);
    }
  });

  it('the query functions of the sections are the functions the retro, the lessons engine and the metrics view call', () => {
    const real: Partial<Queries> = {
      collectLessonSignals, listFeedback, ratingsWithSignals, listReviewIssues, issueRecurrence, listOutcomes, listPolicyEvents, knowledgeSignals,
      knowledgeMetrics, auditMisses, rulesWithEffect, usageByRun, metricsReport,
    };
    for (const [name, fn] of Object.entries(real)) expect(QUERIES[name as keyof Queries], name).toBe(fn);
  });

  /** How a source is seen to be read: the query function called, or the repository listed. */
  type Witness = { query: keyof Queries } | { repo: (store: Store) => { list: (...a: never[]) => unknown } };
  const WITNESS: Record<RetroSource, Witness> = {
    'store.tasks': { repo: (s) => s.tasks },
    // The digest sums `agent_usage` in place; the bundle carries the same table per run through `usageByRun`.
    'sql:agent_usage': { query: 'usageByRun' },
    rulesWithEffect: { query: 'rulesWithEffect' },
    'lessonRepos.proposals': { repo: (s) => lessonRepos(s).proposals },
    'lessonRepos.retros': { repo: (s) => lessonRepos(s).retros },
    collectLessonSignals: { query: 'collectLessonSignals' },
    listFeedback: { query: 'listFeedback' },
    listReviewIssues: { query: 'listReviewIssues' },
    issueRecurrence: { query: 'issueRecurrence' },
    listOutcomes: { query: 'listOutcomes' },
    'store.agentRuns': { repo: (s) => s.agentRuns },
    'usageRepos.agentRunAttempts': { repo: (s) => usageRepos(s).agentRunAttempts },
    listPolicyEvents: { query: 'listPolicyEvents' },
    'store.ratings': { repo: (s) => s.ratings },
    knowledgeSignals: { query: 'knowledgeSignals' },
    auditMisses: { query: 'auditMisses' },
    // Recorded signals reach the bundle as the lessons engine reads them: inside `collectLessonSignals`.
    'lessonRepos.signals': { repo: (s) => lessonRepos(s).signals },
    // The metrics view counts attempts by SQL in place; the bundle carries the rows of the same table.
    'sql:agent_run_attempts': { repo: (s) => usageRepos(s).agentRunAttempts },
    'learningRepos.reviewIssues': { repo: (s) => learningRepos(s).reviewIssues },
    ratingsWithSignals: { query: 'ratingsWithSignals' },
    usageByRun: { query: 'usageByRun' },
    knowledgeMetrics: { query: 'knowledgeMetrics' },
    metricsReport: { query: 'metricsReport' },
  };

  it.each([...RETRO_SOURCES])('the section of %s reads it through its own query function or repository', (source) => {
    const witness = WITNESS[source];
    const calls: string[] = [];
    const recording = Object.fromEntries(
      Object.entries(QUERIES).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          calls.push(name);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as Queries;
    const listed = 'repo' in witness ? vi.spyOn(witness.repo(w.store) as { list: (...a: unknown[]) => unknown }, 'list') : undefined;
    const ctx = sectionContext({ store: w.store, config: w.config }, { level: 'standard' }, recording);
    const blocks = buildSection(ctx, SECTION_OF_SOURCE[source] as TreeSectionName);
    expect(blocks.length).toBeGreaterThan(0);
    if ('query' in witness) expect(calls, `the ${SECTION_OF_SOURCE[source]} section does not call ${witness.query}`).toContain(witness.query);
    else expect(listed!.mock.calls.length, `the ${SECTION_OF_SOURCE[source]} section does not read ${source}`).toBeGreaterThan(0);
  });
});
