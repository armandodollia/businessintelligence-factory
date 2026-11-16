import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { Repo, type TableSpec } from '../store/repos.js';
import type { StakeholderPosition, StakeholderQuestion, StakeholderRead, StakeholderStatement } from './types.js';

/**
 * Repositories of the stakeholder tables (migration 25; the position history: migration 28). Kept out
 * of `store/repos.ts` (a shared hot file) and created lazily per database connection. Ids: `stq_`
 * (question), `sst_` (statement), `srd_` (read), `spo_` (position).
 */
export const stakeholderSpecs = {
  questions: {
    table: 'stakeholder_questions',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', personaId: 'text', field: 'text', text: 'text', status: 'text',
      statementId: 'text', createdAt: 'text', answeredAt: 'text',
    },
  } satisfies TableSpec<StakeholderQuestion>,
  statements: {
    table: 'stakeholder_statements',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', personaId: 'text', source: 'text', field: 'text', text: 'text',
      questionId: 'text', recommendationId: 'text', decision: 'text', actor: 'text', createdAt: 'text', consumedByRunId: 'text',
    },
  } satisfies TableSpec<StakeholderStatement>,
  reads: {
    table: 'stakeholder_reads',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', recommendationId: 'text', personaId: 'text', personaVersion: 'int',
      stance: 'text', conditions: 'json', concerns: 'json', reasoning: 'text', wouldChangeMind: 'text', agentRunId: 'text',
      simulated: 'bool', createdAt: 'text',
    },
  } satisfies TableSpec<StakeholderRead>,
  positions: {
    table: 'stakeholder_positions',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', personaId: 'text', change: 'text', placeKind: 'text', workspaceId: 'text', competitorId: 'text',
      companyName: 'text', stakeholderType: 'text', title: 'text', relation: 'text', effectiveOn: 'text', actor: 'text', note: 'text',
      createdAt: 'text',
    },
  } satisfies TableSpec<StakeholderPosition>,
} as const;

export type StakeholderRepos = {
  questions: Repo<StakeholderQuestion, 'id'>;
  statements: Repo<StakeholderStatement, 'id'>;
  reads: Repo<StakeholderRead, 'id'>;
  /** Append-only: `insert`, `get` and `list` are all there is (and the table refuses UPDATE and DELETE). */
  positions: Pick<Repo<StakeholderPosition, 'id'>, 'insert' | 'get' | 'list'>;
};

const cache = new WeakMap<DatabaseSync, StakeholderRepos>();

/** The stakeholder repositories of a store (one set per database connection). */
export function stakeholderRepos(store: Pick<Store, 'db'>): StakeholderRepos {
  let repos = cache.get(store.db);
  if (!repos) {
    const positions = new Repo<StakeholderPosition, 'id'>(store.db, stakeholderSpecs.positions);
    repos = {
      questions: new Repo<StakeholderQuestion, 'id'>(store.db, stakeholderSpecs.questions),
      statements: new Repo<StakeholderStatement, 'id'>(store.db, stakeholderSpecs.statements),
      reads: new Repo<StakeholderRead, 'id'>(store.db, stakeholderSpecs.reads),
      positions: { insert: (row) => positions.insert(row), get: (id) => positions.get(id), list: (filter) => positions.list(filter) },
    };
    cache.set(store.db, repos);
  }
  return repos;
}
