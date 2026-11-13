/**
 * Learning loop WP-B (migration 15) repositories, kept out of `createRepos` so parallel work
 * packages merge cleanly. `usageRepos(store)` is memoized per database connection.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRunAttempt, AgentUsage, CalibrationVersion, PromptVersionRecord } from '../types.js';
import type { Store } from './db.js';
import { Repo, type TableSpec } from './repos.js';

export const usageSpecs = {
  agentUsage: {
    table: 'agent_usage',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', taskId: 'text', researchRunId: 'text', pipelineId: 'text',
      role: 'text', provider: 'text', model: 'text', promptVersion: 'text', attempt: 'int', inputTokens: 'int',
      outputTokens: 'int', cacheReadTokens: 'int', cacheWriteTokens: 'int', costUsd: 'real', cliReportedCostUsd: 'real',
      priceVersion: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<AgentUsage>,
  agentRunAttempts: {
    table: 'agent_run_attempts',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', attempt: 'int', startedAt: 'text', endedAt: 'text',
      exitCode: 'int', rateLimited: 'bool', failureReason: 'text', backoffMs: 'int',
    },
  } satisfies TableSpec<AgentRunAttempt>,
  promptVersions: {
    table: 'prompt_versions',
    key: 'hash',
    fields: { hash: 'text', role: 'text', text: 'text', createdAt: 'text' },
  } satisfies TableSpec<PromptVersionRecord>,
  calibrationVersions: {
    table: 'calibration_versions',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', role: 'text', text: 'text', source: 'text', revertedFrom: 'text',
      decisionId: 'text', actor: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<CalibrationVersion>,
} as const;

function create(db: DatabaseSync) {
  return {
    agentUsage: new Repo<AgentUsage, 'id'>(db, usageSpecs.agentUsage),
    agentRunAttempts: new Repo<AgentRunAttempt, 'id'>(db, usageSpecs.agentRunAttempts),
    promptVersions: new Repo<PromptVersionRecord, 'hash'>(db, usageSpecs.promptVersions),
    calibrationVersions: new Repo<CalibrationVersion, 'id'>(db, usageSpecs.calibrationVersions),
  };
}

export type UsageRepos = ReturnType<typeof create>;

const cache = new WeakMap<DatabaseSync, UsageRepos>();

/** WP-B repositories bound to `store`'s connection. */
export function usageRepos(store: Pick<Store, 'db'>): UsageRepos {
  let r = cache.get(store.db);
  if (!r) {
    r = create(store.db);
    cache.set(store.db, r);
  }
  return r;
}
