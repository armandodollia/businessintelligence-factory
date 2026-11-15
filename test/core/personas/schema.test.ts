import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bifConfigSchema, defaultConfig } from '../../../src/core/config/schema.js';
import { lessonsSettings } from '../../../src/core/learning/lessons/settings.js';
import { personaLearningSettings } from '../../../src/core/personas/settings.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { PersonaAdjustment, PersonaLearningRun, PersonaProposal } from '../../../src/core/personas/types.js';
import { openStore, type Store } from '../../../src/core/store/db.js';

const TABLES = ['persona_adjustments', 'persona_proposals', 'persona_learning_runs'];
const NOW = '2026-11-15T10:00:00.000Z';
const LATER = '2026-11-16T10:00:00.000Z';

const adjustment = (over: Partial<PersonaAdjustment> = {}): PersonaAdjustment => ({
  id: 'pad_1', rootWorkspaceId: 'ws_root', workspaceId: 'ws_1', personaId: 'per_1', field: 'goals', marker: 'P-7F3A2C',
  text: 'Cares more about price than speed', version: 2, status: 'retired', source: 'retro', proposalId: 'ppr_1',
  actor: 'local-user', stats: { n: 8, agree: 2, disagree: 6, items: 5, lower: 0.41 }, internal: true, createdAt: NOW,
  changedAt: NOW, endedAt: LATER, personaVersion: 3,
  ...over,
});

const proposal = (over: Partial<PersonaProposal> = {}): PersonaProposal => ({
  id: 'ppr_1', rootWorkspaceId: 'ws_root', workspaceId: 'ws_1', personaId: 'per_1', runId: 'plr_1', action: 'replace',
  adjustmentId: 'pad_1', field: 'goals', text: 'Cares more about price', rationale: 'Overrode six verdicts on price',
  evidence: ['fbe_1', 'fbe_2', 'fbe_3'], stats: { n: 8, disagree: 6 }, source: 'retro', status: 'accepted',
  finalText: 'Cares most about price', createdAt: NOW, decidedAt: LATER, actor: 'local-user', reason: 'Matches interviews',
  decisionId: 'dec_1', feedbackEventId: 'fbe_9',
  ...over,
});

const run = (over: Partial<PersonaLearningRun> = {}): PersonaLearningRun => ({
  id: 'plr_1', rootWorkspaceId: 'ws_root', personaId: 'per_1', retroId: 'rtr_1', status: 'failed', signalsThrough: NOW,
  shownSignalIds: ['sig_a', 'sig_b'], stats: { n: 8, agree: 2, disagree: 6, items: 5, lower: 0.41 },
  assumption: 'The user reacts on price', agentRunId: 'run_1', failureReason: 'timeout', createdAt: NOW, endedAt: LATER,
  ...over,
});

describe('persona learning storage (migration 24)', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('migration 24 creates the three tables, each indexed on (root_workspace_id, persona_id)', () => {
    for (const table of TABLES) {
      expect(store.db.prepare(`PRAGMA table_info(${table})`).all().length, table).toBeGreaterThan(0);
      const indexes = store.db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
      const cols = indexes.map((i) =>
        (store.db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join(','),
      );
      expect(cols, table).toContain('root_workspace_id,persona_id');
    }
    const runCols = (store.db.prepare('PRAGMA table_info(persona_learning_runs)').all() as { name: string }[]).map((c) => c.name);
    expect(runCols).toContain('shown_signal_ids');
    const adjustmentCols = store.db.prepare('PRAGMA table_info(persona_adjustments)').all() as { name: string; type: string }[];
    expect(adjustmentCols.find((c) => c.name === 'persona_version')?.type).toBe('INTEGER');
  });

  it('an adjustment marker is unique', () => {
    const r = personaLearningRepos(store);
    r.adjustments.insert(adjustment());
    expect(() => r.adjustments.insert(adjustment({ id: 'pad_2' }))).toThrow();
    r.adjustments.insert(adjustment({ id: 'pad_3', marker: 'P-000001' }));
  });

  it('each repo round-trips a row with every field', () => {
    const r = personaLearningRepos(store);
    expect(personaLearningRepos(store)).toBe(r);
    const a = adjustment();
    r.adjustments.insert(a);
    expect(r.adjustments.get('pad_1')).toEqual(a);
    const p = proposal();
    r.proposals.insert(p);
    expect(r.proposals.get('ppr_1')).toEqual(p);
    const l = run();
    r.runs.insert(l);
    expect(r.runs.get('plr_1')).toEqual(l);
    // A minimal row: optional fields stay absent, `internal` false reads back false.
    const bare = adjustment({ id: 'pad_9', marker: 'P-9', field: undefined, proposalId: undefined, endedAt: undefined, personaVersion: undefined, internal: false, stats: {} });
    delete bare.field;
    delete bare.personaVersion;
    delete bare.proposalId;
    delete bare.endedAt;
    r.adjustments.insert(bare);
    expect(r.adjustments.get('pad_9')).toEqual(bare);
  });
});

describe('config.personaLearning', () => {
  it('personaLearningSettings applies every default; the model defaults to the retro model', () => {
    const roles = defaultConfig.roles;
    expect(personaLearningSettings({ roles })).toEqual({
      enabled: true,
      minSignals: 6,
      minDistinctItems: 4,
      disagreeFloor: 0.3,
      windowDays: 180,
      maxPersonasPerRetro: 5,
      maxProposalsPerPersona: 3,
      minEvidence: 3,
      maxAdjustments: 8,
      minEffectSignals: 6,
      model: lessonsSettings({ roles }).retro.model,
    });
    const retroModel = { provider: 'claude' as const, model: 'sonnet' };
    expect(personaLearningSettings({ roles, lessons: { retro: { model: retroModel } } }).model).toEqual(retroModel);
    const own = { provider: 'claude' as const, model: 'haiku' };
    const s = personaLearningSettings({ roles, personaLearning: { model: own, minSignals: 10, enabled: false } });
    expect(s.model).toEqual(own);
    expect(s.minSignals).toBe(10);
    expect(s.enabled).toBe(false);
    expect(s.minEvidence).toBe(3);
  });

  it('the config schema accepts a valid block and rejects an out-of-range floor or an unknown key', () => {
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, personaLearning: { disagreeFloor: 0.5, maxAdjustments: 20 } }).success).toBe(true);
    const floor = bifConfigSchema.safeParse({ ...base, personaLearning: { disagreeFloor: 1.5 } });
    expect(floor.success).toBe(false);
    expect(floor.error?.issues[0]?.path).toEqual(['personaLearning', 'disagreeFloor']);
    const unknown = bifConfigSchema.safeParse({ ...base, personaLearning: { bogus: 1 } });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]?.path).toEqual(['personaLearning']);
    for (const bad of [{ minSignals: 0 }, { maxProposalsPerPersona: 6 }, { maxAdjustments: 21 }, { maxAdjustments: 0 }, { windowDays: 1.5 }]) {
      expect(bifConfigSchema.safeParse({ ...base, personaLearning: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(bifConfigSchema.safeParse({ ...base, personaLearning: { maxProposalsPerPersona: 0 } }).success).toBe(true);
  });

  it('a model of a disabled provider is rejected', () => {
    const base = structuredClone(defaultConfig);
    base.providers.opencode.enabled = false;
    const bad = bifConfigSchema.safeParse({ ...base, personaLearning: { model: { provider: 'opencode', model: 'x' } } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.some((i) => i.path.join('.') === 'personaLearning.model' && /not enabled/.test(i.message))).toBe(true);
  });
});
