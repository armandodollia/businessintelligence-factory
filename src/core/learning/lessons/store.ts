import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../../store/db.js';
import { Repo, type TableSpec } from '../../store/repos.js';
import type { LessonProposal, LessonRule, LessonSignalRecord, RetroRecord } from './types.js';

/**
 * Repositories of the learning-loop WP-E tables (migration 19). Kept out of `store/repos.ts` (a
 * shared hot file) and created lazily per database connection.
 */
export const lessonSpecs = {
  rules: {
    table: 'lesson_rules',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', role: 'text', category: 'text', marker: 'text', text: 'text', strength: 'int',
      version: 'int', status: 'text', source: 'text', proposalId: 'text', actor: 'text', createdAt: 'text', changedAt: 'text',
      endedAt: 'text', promptVersionBefore: 'text', promptVersionAfter: 'text',
    },
  } satisfies TableSpec<LessonRule>,
  proposals: {
    table: 'lesson_proposals',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', role: 'text', action: 'text', category: 'text', ruleId: 'text', text: 'text',
      rationale: 'text', evidence: 'json', stats: 'json', source: 'text', retroId: 'text', status: 'text', createdAt: 'text',
      decidedAt: 'text', actor: 'text', reason: 'text', decisionId: 'text', feedbackEventId: 'text',
    },
  } satisfies TableSpec<LessonProposal>,
  signals: {
    table: 'lesson_signals',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', role: 'text', category: 'text', source: 'text', sourceKey: 'text',
      taskId: 'text', agentRunId: 'text', promptVersion: 'text', refId: 'text', note: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<LessonSignalRecord>,
  retros: {
    table: 'retros',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', status: 'text', triggeredBy: 'text', windowStart: 'text', windowEnd: 'text', agentRunId: 'text',
      digest: 'json', evidenceIds: 'json', proposalIds: 'json', summary: 'text', failureReason: 'text', createdAt: 'text', endedAt: 'text',
    },
  } satisfies TableSpec<RetroRecord>,
} as const;

export type LessonRepos = {
  rules: Repo<LessonRule, 'id'>;
  proposals: Repo<LessonProposal, 'id'>;
  signals: Repo<LessonSignalRecord, 'id'>;
  retros: Repo<RetroRecord, 'id'>;
};

const cache = new WeakMap<DatabaseSync, LessonRepos>();

/** The WP-E repositories of a store (one set per database connection). */
export function lessonRepos(store: Pick<Store, 'db'>): LessonRepos {
  let repos = cache.get(store.db);
  if (!repos) {
    repos = {
      rules: new Repo<LessonRule, 'id'>(store.db, lessonSpecs.rules),
      proposals: new Repo<LessonProposal, 'id'>(store.db, lessonSpecs.proposals),
      signals: new Repo<LessonSignalRecord, 'id'>(store.db, lessonSpecs.signals),
      retros: new Repo<RetroRecord, 'id'>(store.db, lessonSpecs.retros),
    };
    cache.set(store.db, repos);
  }
  return repos;
}
