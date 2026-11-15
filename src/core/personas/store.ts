import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { Repo, type TableSpec } from '../store/repos.js';
import type { PersonaAdjustment, PersonaLearningRun, PersonaProposal } from './types.js';

/**
 * Repositories of the persona learning tables (migrations 24, 27). Kept out of `store/repos.ts` (a shared
 * hot file) and created lazily per database connection. Ids: `pad_` (adjustment), `ppr_` (proposal),
 * `plr_` (learning run).
 */
export const personaLearningSpecs = {
  adjustments: {
    table: 'persona_adjustments',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', personaId: 'text', field: 'text', marker: 'text', text: 'text',
      version: 'int', status: 'text', source: 'text', proposalId: 'text', actor: 'text', stats: 'json', internal: 'bool',
      createdAt: 'text', changedAt: 'text', endedAt: 'text', personaVersion: 'int',
    },
  } satisfies TableSpec<PersonaAdjustment>,
  proposals: {
    table: 'persona_proposals',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', personaId: 'text', runId: 'text', action: 'text',
      adjustmentId: 'text', field: 'text', text: 'text', rationale: 'text', evidence: 'json', stats: 'json', source: 'text',
      status: 'text', finalText: 'text', createdAt: 'text', decidedAt: 'text', actor: 'text', reason: 'text', decisionId: 'text',
      feedbackEventId: 'text', internal: 'bool',
    },
  } satisfies TableSpec<PersonaProposal>,
  runs: {
    table: 'persona_learning_runs',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', personaId: 'text', retroId: 'text', status: 'text', signalsThrough: 'text',
      shownSignalIds: 'json', shownStatementIds: 'json', stats: 'json', assumption: 'text', agentRunId: 'text', failureReason: 'text', createdAt: 'text',
      endedAt: 'text',
    },
  } satisfies TableSpec<PersonaLearningRun>,
} as const;

export type PersonaLearningRepos = {
  adjustments: Repo<PersonaAdjustment, 'id'>;
  proposals: Repo<PersonaProposal, 'id'>;
  runs: Repo<PersonaLearningRun, 'id'>;
};

const cache = new WeakMap<DatabaseSync, PersonaLearningRepos>();

/** Active adjustments of a persona, oldest first (what its agent.md carries). */
export function activeAdjustments(store: Pick<Store, 'db'>, personaId: string): PersonaAdjustment[] {
  return personaLearningRepos(store)
    .adjustments.list({ personaId, status: 'active' })
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The persona learning repositories of a store (one set per database connection). */
export function personaLearningRepos(store: Pick<Store, 'db'>): PersonaLearningRepos {
  let repos = cache.get(store.db);
  if (!repos) {
    repos = {
      adjustments: new Repo<PersonaAdjustment, 'id'>(store.db, personaLearningSpecs.adjustments),
      proposals: new Repo<PersonaProposal, 'id'>(store.db, personaLearningSpecs.proposals),
      runs: new Repo<PersonaLearningRun, 'id'>(store.db, personaLearningSpecs.runs),
    };
    cache.set(store.db, repos);
  }
  return repos;
}
