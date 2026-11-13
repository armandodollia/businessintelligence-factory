import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { Repo, type TableSpec } from '../store/repos.js';
import type { DecisionOutcome, ReviewIssueRecord } from './types.js';

/**
 * Repositories of the learning-loop WP-C tables (migration 16). Kept out of `store/repos.ts` (a
 * shared hot file) and created lazily per database connection.
 */
export const learningSpecs = {
  decisionOutcomes: {
    table: 'decision_outcomes',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', decisionId: 'text', subjectType: 'text', subjectId: 'text', runId: 'text',
      outcome: 'text', label: 'text', evidenceJson: 'json', source: 'text', sourceKey: 'text', actor: 'text', taskId: 'text', targetType: 'text', targetId: 'text', role: 'text',
      taskType: 'text', promptVersion: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<DecisionOutcome>,
  reviewIssues: {
    table: 'review_issues',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', taskId: 'text', round: 'int', issueId: 'text', rawIssueId: 'text', class: 'text',
      text: 'text', evidence: 'json', status: 'text', synthetic: 'bool', reviewerRunId: 'text', reviewDecisionId: 'text',
      workerRunId: 'text', workerPromptVersion: 'text', responseReason: 'text', responseDecisionId: 'text',
      createdAt: 'text', resolvedAt: 'text',
    },
  } satisfies TableSpec<ReviewIssueRecord>,
} as const;

export type LearningRepos = {
  decisionOutcomes: Repo<DecisionOutcome, 'id'>;
  reviewIssues: Repo<ReviewIssueRecord, 'id'>;
};

const cache = new WeakMap<DatabaseSync, LearningRepos>();

/** The WP-C repositories of a store (one set per database connection). */
export function learningRepos(store: Pick<Store, 'db'>): LearningRepos {
  let repos = cache.get(store.db);
  if (!repos) {
    repos = {
      decisionOutcomes: new Repo<DecisionOutcome, 'id'>(store.db, learningSpecs.decisionOutcomes),
      reviewIssues: new Repo<ReviewIssueRecord, 'id'>(store.db, learningSpecs.reviewIssues),
    };
    cache.set(store.db, repos);
  }
  return repos;
}
