import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bifConfigSchema, defaultConfig } from '../../../src/core/config/schema.js';
import { flowsSettings } from '../../../src/core/flows/config.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import type { Flow, FlowCheck, FlowStep, ReviewMention } from '../../../src/core/flows/types.js';
import { openStore, type Store } from '../../../src/core/store/db.js';

const FLOW_TABLES = [
  'flow_types', 'checklists', 'flows', 'flow_steps', 'flow_checks', 'review_mentions', 'flow_verdicts', 'flow_overrides',
  'flow_rank_snapshots',
];

const NOW = '2026-11-14T10:00:00.000Z';

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'flw_1', workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', subjectEntityId: 'ent_acme', flowTypeId: 'fty_signup',
  variant: 'Email', variantKey: 'email', isPrimary: true, name: 'Acme sign-up by email', goal: 'Create an account',
  entryUrl: 'https://acme.example/signup', reachedGoal: false, stopReason: 'phone', notable: 'Asks for a phone number early',
  stepsHash: 'h1', lineageId: 'flw_1', version: 1, lifecycle: 'current', status: 'pending', taskId: 'tsk_1', taskRound: 1,
  includeOverride: false, runId: 'run_1', entityId: 'ent_flow', firstSeenAt: NOW, confirmCount: 0, createdAt: NOW,
  ...over,
});

const mention = (over: Partial<ReviewMention> = {}): ReviewMention => ({
  id: 'rvm_1', workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', subjectEntityId: 'ent_acme', sourceType: 'app_store',
  sourceUrl: 'https://apps.example/acme', artifactId: 'art_1', quote: 'Never got the reset email', quoteHash: 'q1',
  polarity: 'negative', attributionConfidence: 0.8, createdAt: NOW,
  ...over,
});

describe('flow records schema (migration 22)', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('migration 22 creates the nine flow tables', () => {
    for (const table of FLOW_TABLES) {
      const cols = store.db.prepare(`PRAGMA table_info(${table})`).all();
      expect(cols.length, table).toBeGreaterThan(0);
    }
  });

  it('repos round-trip a flow with steps and JSON columns', () => {
    const r = flowRepos(store);
    expect(flowRepos(store)).toBe(r);
    const f = flow();
    r.flows.insert(f);
    expect(r.flows.get('flw_1')).toEqual(f);

    const steps: FlowStep[] = [
      { flowId: 'flw_1', seq: 1, action: 'Open sign-up', observation: 'A form with email and password', asked: ['email', 'password'], artifactId: 'art_1', pageUrl: 'https://acme.example/signup' },
      { flowId: 'flw_1', seq: 2, action: 'Submit', observation: 'Phone number required', asked: ['email', 'password'], error: 'phone required' },
    ];
    for (const s of steps) r.flowSteps.insert(s);
    expect(r.flowSteps.list({ flowId: 'flw_1' })).toEqual(steps);

    const check: FlowCheck = {
      flowId: 'flw_1', checklistId: 'ckl_1', itemKey: 'steps_to_goal', answer: 'recorded', value: { count: 2 }, stepRefs: [1, 2],
      mentionRefs: ['rvm_1'], origin: 'walkthrough', updatedAt: NOW,
    };
    expect(r.flowChecks.insertIgnore(check)).toBe(true);
    expect(r.flowChecks.insertIgnore(check)).toBe(false);
    expect(r.flowChecks.list({ flowId: 'flw_1' })).toEqual([check]);
    expect(() => r.flowChecks.delete({ stepRefs: [1] } as never)).toThrow(/cannot filter/);
    expect(r.flowChecks.delete({ flowId: 'flw_1', itemKey: 'steps_to_goal' })).toBe(1);

    r.checklists.insert({
      id: 'ckl_1', rootWorkspaceId: 'ws_1', version: 1, status: 'active', coverage: 0.3, origin: 'builtin', createdAt: NOW,
      items: [{ key: 'steps_to_goal', question: 'Steps to the goal?', kind: 'count', pass: { max: 5 }, weight: 1, scored: true, answeredBy: 'walkthrough' }],
    });
    expect(r.checklists.get('ckl_1')?.items[0]?.pass).toEqual({ max: 5 });

    r.rankSnapshots.insert({ id: 'frs_1', workspaceId: 'ws_1', flowTypeId: 'fty_signup', ranking: [{ flowId: 'flw_1', position: 1, rankScore: 62.5 }], createdAt: NOW });
    expect(r.rankSnapshots.get('frs_1')?.ranking).toEqual([{ flowId: 'flw_1', position: 1, rankScore: 62.5 }]);
  });

  it('the same quote for the same subject is refused twice', () => {
    const r = flowRepos(store);
    r.reviewMentions.insert(mention());
    expect(() => r.reviewMentions.insert(mention({ id: 'rvm_2', sourceUrl: 'https://forum.example/t/1' }))).toThrow();
    // Another subject, or another tree, may hold the same quote.
    r.reviewMentions.insert(mention({ id: 'rvm_3', subjectEntityId: 'ent_other' }));
    r.reviewMentions.insert(mention({ id: 'rvm_4', rootWorkspaceId: 'ws_2', workspaceId: 'ws_2' }));
    expect(r.reviewMentions.list({ quoteHash: 'q1' })).toHaveLength(3);
  });

  it('a flow type key and a checklist version are unique per tree', () => {
    const r = flowRepos(store);
    const type = { id: 'fty_1', rootWorkspaceId: 'ws_1', key: 'sign_up', name: 'Sign-up', definition: 'Create an account', status: 'active' as const, createdAt: NOW, updatedAt: NOW };
    r.flowTypes.insert(type);
    expect(r.flowTypes.get('fty_1')).toEqual(type);
    expect(() => r.flowTypes.insert({ ...type, id: 'fty_2' })).toThrow();
    r.flowTypes.insert({ ...type, id: 'fty_3', rootWorkspaceId: 'ws_2' });

    const general = { id: 'ckl_g1', rootWorkspaceId: 'ws_1', version: 1, status: 'active' as const, coverage: 0.3, items: [], origin: 'builtin' as const, createdAt: NOW };
    r.checklists.insert(general);
    expect(() => r.checklists.insert({ ...general, id: 'ckl_g2' })).toThrow();
    r.checklists.insert({ ...general, id: 'ckl_s1', flowTypeId: 'fty_1' });
    expect(() => r.checklists.insert({ ...general, id: 'ckl_s2', flowTypeId: 'fty_1' })).toThrow();
  });

  it('a verdict stores its pair in order', () => {
    const r = flowRepos(store);
    const v = {
      id: 'fvd_1', workspaceId: 'ws_1', flowTypeId: 'fty_1', flowAId: 'flw_a', flowBId: 'flw_b', personaId: 'per_1', personaVersion: 1,
      stage: 'broad' as const, winner: 'a' as const, strength: 2 as const, confidence: 0.7, reason: 'Fewer steps', createdAt: NOW,
    };
    r.flowVerdicts.insert(v);
    expect(r.flowVerdicts.get('fvd_1')).toEqual(v);
    expect(() => r.flowVerdicts.insert({ ...v, id: 'fvd_2', flowAId: 'flw_b', flowBId: 'flw_a' })).toThrow();

    const o = { id: 'fov_1', workspaceId: 'ws_1', flowTypeId: 'fty_1', winnerFlowId: 'flw_a', loserFlowId: 'flw_b', actor: 'local-user', needsConfirm: false, createdAt: NOW };
    r.flowOverrides.insert(o);
    expect(r.flowOverrides.get('fov_1')).toEqual(o);
  });
});

describe('config.flows', () => {
  it('flowsSettings applies every default and merges a partial block', () => {
    expect(flowsSettings({})).toEqual({
      tieMargin: 5,
      minMentionsForCheck: 3,
      mentionWindowDays: 365,
      minAttributionConfidence: 0.6,
      maxFocusedComparisons: 20,
      lowConfidence: 0.5,
      maxFlowsPerSitting: 8,
      generalCoverage: 0.3,
    });
    expect(flowsSettings({ flows: { tieMargin: 2 } }).tieMargin).toBe(2);
    expect(flowsSettings({ flows: { tieMargin: 2 } }).maxFlowsPerSitting).toBe(8);
    const model = { provider: 'claude' as const, model: 'sonnet' };
    expect(flowsSettings({ flows: { model } }).model).toEqual(model);
  });

  it('the config schema rejects unknown flows keys', () => {
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, flows: { tieMargin: 3 } }).success).toBe(true);
    const bad = bifConfigSchema.safeParse({ ...base, flows: { tieMargin: 3, bogus: 1 } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['flows']);
  });

  it('maxFlowsPerSitting is between 2 (a sitting compares pairs) and 20 (190 pairs fit one 200-verdict call)', () => {
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, flows: { maxFlowsPerSitting: 2 } }).success).toBe(true);
    expect(bifConfigSchema.safeParse({ ...base, flows: { maxFlowsPerSitting: 20 } }).success).toBe(true);
    for (const n of [1, 0, 21]) {
      const bad = bifConfigSchema.safeParse({ ...base, flows: { maxFlowsPerSitting: n } });
      expect(bad.success).toBe(false);
      expect(bad.error?.issues[0]?.path).toEqual(['flows', 'maxFlowsPerSitting']);
    }
  });
});
