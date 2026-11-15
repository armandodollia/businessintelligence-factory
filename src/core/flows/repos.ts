/**
 * Flow records and flow ranking (migration 22) repositories, kept out of `createRepos` like
 * `usageRepos`. `flowRepos(store)` is memoized per database connection.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { LinkRepo, Repo, type LinkSpec, type TableSpec } from '../store/repos.js';
import type {
  Checklist,
  Flow,
  FlowCheck,
  FlowOverride,
  FlowRankSnapshot,
  FlowStep,
  FlowType,
  FlowVerdict,
  ReviewMention,
} from './types.js';

export const flowSpecs = {
  flowTypes: {
    table: 'flow_types',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', key: 'text', name: 'text', definition: 'text', status: 'text', mergedIntoId: 'text',
      proposedByRun: 'text', createdAt: 'text', updatedAt: 'text',
    },
  } satisfies TableSpec<FlowType>,
  checklists: {
    table: 'checklists',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', flowTypeId: 'text', version: 'int', status: 'text', coverage: 'real', items: 'json',
      origin: 'text', createdAt: 'text', acceptedAt: 'text',
    },
  } satisfies TableSpec<Checklist>,
  flows: {
    table: 'flows',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', subjectEntityId: 'text', flowTypeId: 'text', variant: 'text',
      variantKey: 'text', isPrimary: 'bool', name: 'text', goal: 'text', entryUrl: 'text', reachedGoal: 'bool', stopReason: 'text',
      notable: 'text', stepsHash: 'text', lineageId: 'text', version: 'int', replacesId: 'text', lifecycle: 'text', status: 'text',
      taskId: 'text', taskRound: 'int', includeOverride: 'bool', runId: 'text', entityId: 'text', firstSeenAt: 'text',
      lastConfirmedAt: 'text', confirmCount: 'int', createdAt: 'text',
    },
  } satisfies TableSpec<Flow>,
  flowSteps: {
    table: 'flow_steps',
    keys: ['flowId', 'seq'],
    fields: {
      flowId: 'text', seq: 'int', action: 'text', observation: 'text', asked: 'json', error: 'text', artifactId: 'text',
      pageUrl: 'text',
    },
  } satisfies LinkSpec<FlowStep>,
  flowChecks: {
    table: 'flow_checks',
    keys: ['flowId', 'checklistId', 'itemKey'],
    fields: {
      flowId: 'text', checklistId: 'text', itemKey: 'text', answer: 'text', value: 'json', stepRefs: 'json', mentionRefs: 'json',
      note: 'text', origin: 'text', updatedAt: 'text',
    },
  } satisfies LinkSpec<FlowCheck>,
  reviewMentions: {
    table: 'review_mentions',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', subjectEntityId: 'text', sourceType: 'text', sourceUrl: 'text',
      artifactId: 'text', chunkId: 'text', quote: 'text', quoteHash: 'text', publishedAt: 'text', rating: 'real', polarity: 'text',
      flowTypeId: 'text', checkKey: 'text', attributionConfidence: 'real', taskId: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<ReviewMention>,
  flowVerdicts: {
    table: 'flow_verdicts',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', flowTypeId: 'text', flowAId: 'text', flowBId: 'text', personaId: 'text', personaVersion: 'int',
      stage: 'text', winner: 'text', strength: 'int', confidence: 'real', reason: 'text', agentRunId: 'text', supersededById: 'text',
      createdAt: 'text',
    },
  } satisfies TableSpec<FlowVerdict>,
  flowOverrides: {
    table: 'flow_overrides',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', flowTypeId: 'text', winnerFlowId: 'text', loserFlowId: 'text', reason: 'text', actor: 'text',
      needsConfirm: 'bool', createdAt: 'text', revokedAt: 'text',
    },
  } satisfies TableSpec<FlowOverride>,
  rankSnapshots: {
    table: 'flow_rank_snapshots',
    key: 'id',
    fields: { id: 'text', workspaceId: 'text', flowTypeId: 'text', researchRunId: 'text', ranking: 'json', createdAt: 'text' },
  } satisfies TableSpec<FlowRankSnapshot>,
} as const;

function create(db: DatabaseSync) {
  return {
    flowTypes: new Repo<FlowType, 'id'>(db, flowSpecs.flowTypes),
    checklists: new Repo<Checklist, 'id'>(db, flowSpecs.checklists),
    flows: new Repo<Flow, 'id'>(db, flowSpecs.flows),
    flowSteps: new LinkRepo<FlowStep>(db, flowSpecs.flowSteps),
    flowChecks: new LinkRepo<FlowCheck>(db, flowSpecs.flowChecks),
    reviewMentions: new Repo<ReviewMention, 'id'>(db, flowSpecs.reviewMentions),
    flowVerdicts: new Repo<FlowVerdict, 'id'>(db, flowSpecs.flowVerdicts),
    flowOverrides: new Repo<FlowOverride, 'id'>(db, flowSpecs.flowOverrides),
    rankSnapshots: new Repo<FlowRankSnapshot, 'id'>(db, flowSpecs.rankSnapshots),
  };
}

export type FlowRepos = ReturnType<typeof create>;

const cache = new WeakMap<DatabaseSync, FlowRepos>();

/** Flow repositories bound to `store`'s connection. */
export function flowRepos(store: Pick<Store, 'db'>): FlowRepos {
  let r = cache.get(store.db);
  if (!r) {
    r = create(store.db);
    cache.set(store.db, r);
  }
  return r;
}
