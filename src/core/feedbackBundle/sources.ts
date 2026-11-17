/**
 * What the retro, the lessons engine and the metrics view read, and which section of the feedback
 * bundle carries each of them (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.3).
 *
 * `RETRO_SOURCES` names every source read by `retroDigest` (learning/lessons/retro.ts),
 * `collectLessonSignals` (learning/lessons/signals.ts) and `metricsReport` (metrics/report.ts):
 * - a query function by its name (`listOutcomes`);
 * - a repository by how the code reaches it (`store.tasks`, `lessonRepos.proposals`);
 * - a table read by SQL in place as `sql:<table>`.
 *
 * The completeness test (test/core/feedbackBundle/completeness.test.ts) reads those three files and
 * fails when one of them reads something that is not listed here, when a source has no section, and
 * when the section of a source does not call that source's query function. So a signal added to the
 * retro later cannot be left out of the bundle unnoticed: add it here, with the section that carries it.
 */

export const RETRO_SOURCES = [
  // retroDigest
  'store.tasks',
  'sql:agent_usage',
  'rulesWithEffect',
  'lessonRepos.proposals',
  'lessonRepos.retros',
  'collectLessonSignals',
  'listFeedback',
  // collectLessonSignals
  'listReviewIssues',
  'issueRecurrence',
  'listOutcomes',
  'store.agentRuns',
  'usageRepos.agentRunAttempts',
  'listPolicyEvents',
  'store.ratings',
  'knowledgeSignals',
  'auditMisses',
  'lessonRepos.signals',
  // metricsReport
  'sql:agent_run_attempts',
  'learningRepos.reviewIssues',
  'ratingsWithSignals',
  'usageByRun',
  'knowledgeMetrics',
  'metricsReport',
] as const satisfies readonly string[];

export type RetroSource = (typeof RETRO_SOURCES)[number];

/** The bundle section that carries each source. */
export const SECTION_OF_SOURCE: Record<string, string> = {
  'store.tasks': 'tasks',
  'sql:agent_usage': 'runs',
  rulesWithEffect: 'lessons',
  'lessonRepos.proposals': 'lessons',
  'lessonRepos.retros': 'lessons',
  collectLessonSignals: 'lessonSignals',
  listFeedback: 'feedback',
  listReviewIssues: 'reviewRounds',
  issueRecurrence: 'reviewRounds',
  listOutcomes: 'outcomes',
  'store.agentRuns': 'runs',
  'usageRepos.agentRunAttempts': 'runs',
  listPolicyEvents: 'policy',
  'store.ratings': 'feedback',
  knowledgeSignals: 'knowledge',
  auditMisses: 'audits',
  'lessonRepos.signals': 'lessonSignals',
  'sql:agent_run_attempts': 'runs',
  'learningRepos.reviewIssues': 'reviewRounds',
  ratingsWithSignals: 'feedback',
  usageByRun: 'runs',
  knowledgeMetrics: 'knowledge',
  metricsReport: 'metrics',
} satisfies Record<RetroSource, string>;

/** Every section of a bundle besides the manifest, in file order. `texts` only at the fuller level. */
export const SECTION_NAMES = [
  'configuration',
  'trees',
  'runs',
  'tasks',
  'reviewRounds',
  'outcomes',
  'lessonSignals',
  'lessons',
  'feedback',
  'policy',
  'knowledge',
  'metrics',
  'audits',
  'personas',
  'escalations',
  'budgets',
  'requests',
  'texts',
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];
