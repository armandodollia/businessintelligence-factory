/**
 * Stakeholder personas, task 1 (design 2026-11-15-stakeholder-personas-design.md §5, §12, §13): the
 * persona columns and the three stakeholder tables (migration 25), the `stakeholders` phase in stored
 * schedules (migration 26), settings, and the segment-only persona reads.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { bifConfigSchema, defaultConfig, TASK_TYPES } from '../../../src/core/config/schema.js';
import { ALL_PHASES, PHASE_TASK_TYPES, RUNNER_PHASES } from '../../../src/core/research/phases.js';
import { PERSONA_FIELDS, STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { reviewQueue } from '../../../src/core/scoring/reviewQueue.js';
import { isHidden, segmentPersonas, stakeholderPersonas } from '../../../src/core/stakeholders/personas.js';
import { stakeholdersSettings } from '../../../src/core/stakeholders/settings.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { StakeholderQuestion, StakeholderRead, StakeholderStatement } from '../../../src/core/stakeholders/types.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { MIGRATIONS } from '../../../src/core/store/migrations.js';
import type { Persona } from '../../../src/core/types.js';

const NOW = '2026-11-15T10:00:00.000Z';
const LATER = '2026-11-16T10:00:00.000Z';
/** Migration 25 is MIGRATIONS[24], migration 26 is MIGRATIONS[25]. */
const M25 = 24;
const M26 = 25;

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const memory = () => {
  const s = openStore(':memory:');
  opened.push(s);
  return s;
};

/** A database file migrated up to (not including) migration index `upTo`, seeded by `seed`. */
function legacyDb(upTo: number, seed: (raw: DatabaseSync) => void): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bif-stk-')), 'bif.db');
  const raw = new DatabaseSync(path);
  for (const [i, m] of MIGRATIONS.slice(0, upTo).entries()) {
    raw.exec(m);
    raw.exec(`PRAGMA user_version = ${i + 1}`);
  }
  seed(raw);
  raw.close();
  return path;
}

const persona = (store: Store, slug: string, extra: Partial<Persona> = {}): Persona =>
  store.personas.insert({
    id: `per_${slug}`, workspaceId: 'ws_a', slug, segment: `${slug} segment`, profile: {}, agentMdPath: `${slug}.md`, version: 1,
    status: 'verified', ...extra,
  });

const question = (over: Partial<StakeholderQuestion> = {}): StakeholderQuestion => ({
  id: 'stq_1', rootWorkspaceId: 'ws_root', workspaceId: 'ws_a', personaId: 'per_cfo', field: 'decision_criteria',
  text: 'When CFO decides on something you bring to them, what matters most to them?', status: 'answered', statementId: 'sst_1',
  createdAt: NOW, answeredAt: LATER,
  ...over,
});

const statement = (over: Partial<StakeholderStatement> = {}): StakeholderStatement => ({
  id: 'sst_1', rootWorkspaceId: 'ws_root', workspaceId: 'ws_a', personaId: 'per_cfo', source: 'decision_record', field: 'known_positions',
  text: 'Turned down the pricing change: payback too long.', questionId: 'stq_1', recommendationId: 'rec_1', decision: 'rejected',
  actor: 'local-user', createdAt: NOW, consumedByRunId: 'plr_1',
  ...over,
});

const read = (over: Partial<StakeholderRead> = {}): StakeholderRead => ({
  id: 'srd_1', rootWorkspaceId: 'ws_root', workspaceId: 'ws_a', recommendationId: 'rec_1', personaId: 'per_cfo', personaVersion: 2,
  stance: 'approve_with_conditions', conditions: ['Payback under a year'], concerns: ['Churn of annual plans'], reasoning: 'Fits the plan',
  wouldChangeMind: 'A pilot with numbers', agentRunId: 'arun_1', simulated: true, createdAt: NOW,
  ...over,
});

describe('migration 25: persona columns', () => {
  it('a persona row stored before migration 25 reads back as an open segment persona', () => {
    const path = legacyDb(M25, (raw) => {
      raw.prepare(
        "INSERT INTO personas (id, workspace_id, slug, segment, profile, agent_md_path, version) VALUES ('per_old', 'ws_a', 'smb', 'SMB', '{}', 'smb.md', 1)",
      ).run();
    });
    const s = openStore(path);
    opened.push(s);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    const p = s.personas.get('per_old')!;
    expect(p).toMatchObject({ kind: 'segment', disclosure: 'open' });
    for (const k of ['stakeholderType', 'subjectKind', 'subjectId', 'relation'] as const) expect(p[k], k).toBeUndefined();
  });

  it('a stakeholder persona round-trips every new field', () => {
    const s = memory();
    const p = persona(s, 'stk-cfo', {
      kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'competitor', subjectId: 'cmp_1', relation: 'Approves pricing changes',
      disclosure: 'hidden',
    });
    expect(s.personas.get(p.id)).toMatchObject({
      kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'competitor', subjectId: 'cmp_1', relation: 'Approves pricing changes',
      disclosure: 'hidden',
    });
  });
});

describe('migration 25: stakeholder tables', () => {
  it('each repo round-trips a row with every field, and a minimal row', () => {
    const s = memory();
    const r = stakeholderRepos(s);
    expect(stakeholderRepos(s)).toBe(r);
    const q = question();
    r.questions.insert(q);
    expect(r.questions.get('stq_1')).toEqual(q);
    const st = statement();
    r.statements.insert(st);
    expect(r.statements.get('sst_1')).toEqual(st);
    const rd = read();
    r.reads.insert(rd);
    expect(r.reads.get('srd_1')).toEqual(rd);

    // Node-wide question and a note about someone not yet known: no persona.
    const bareQ: StakeholderQuestion = { id: 'stq_2', rootWorkspaceId: 'ws_root', workspaceId: 'ws_a', field: 'missing', text: 'Is anyone missing?', status: 'open', createdAt: NOW };
    r.questions.insert(bareQ);
    expect(r.questions.get('stq_2')).toEqual(bareQ);
    const bareS: StakeholderStatement = { id: 'sst_2', rootWorkspaceId: 'ws_root', workspaceId: 'ws_a', source: 'note', text: 'The new COO signs off on hiring.', actor: 'local-user', createdAt: NOW };
    r.statements.insert(bareS);
    expect(r.statements.get('sst_2')).toEqual(bareS);
  });

  it('statements are append-only: no delete, no change of the text, but consumed_by_run_id can be set', () => {
    const s = memory();
    const r = stakeholderRepos(s);
    r.statements.insert(statement({ consumedByRunId: undefined }));
    expect(() => s.db.prepare("DELETE FROM stakeholder_statements WHERE id = 'sst_1'").run()).toThrow(/append-only/);
    expect(() => r.statements.update('sst_1', { text: 'Something else' })).toThrow(/append-only/);
    expect(() => r.statements.update('sst_1', { personaId: 'per_other' })).toThrow(/append-only/);
    expect(r.statements.update('sst_1', { consumedByRunId: 'plr_9' }).consumedByRunId).toBe('plr_9');
    expect(r.statements.get('sst_1')).toEqual(statement({ consumedByRunId: 'plr_9' }));
  });

  it('one read per persona and recommendation', () => {
    const s = memory();
    const r = stakeholderRepos(s);
    r.reads.insert(read());
    expect(() => r.reads.insert(read({ id: 'srd_2' }))).toThrow();
    r.reads.insert(read({ id: 'srd_3', recommendationId: 'rec_2' }));
  });
});

describe('stakeholder settings and config', () => {
  it('stakeholdersSettings applies every default', () => {
    expect(stakeholdersSettings({})).toEqual({ enabled: true, maxOwn: 8, maxCompetitors: 3, maxPerCompetitor: 3, maxReadsPerPanel: 40, maxFollowed: 5 });
    expect(stakeholdersSettings({ stakeholders: { enabled: false, maxOwn: 2 } })).toEqual({
      enabled: false, maxOwn: 2, maxCompetitors: 3, maxPerCompetitor: 3, maxReadsPerPanel: 40, maxFollowed: 5,
    });
  });

  it('the config schema accepts a valid block and rejects maxOwn 0 or an unknown key', () => {
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, stakeholders: { maxOwn: 4, maxCompetitors: 1, maxPerCompetitor: 2, maxReadsPerPanel: 10, enabled: true } }).success).toBe(true);
    const zero = bifConfigSchema.safeParse({ ...base, stakeholders: { maxOwn: 0 } });
    expect(zero.success).toBe(false);
    expect(zero.error?.issues[0]?.path).toEqual(['stakeholders', 'maxOwn']);
    expect(bifConfigSchema.safeParse({ ...base, stakeholders: { maxOwners: 3 } }).success).toBe(false);
  });

  it('the two task types exist and belong to the stakeholders phase', () => {
    expect(TASK_TYPES).toContain('own_stakeholders');
    expect(TASK_TYPES).toContain('competitor_stakeholders');
    expect(PHASE_TASK_TYPES.stakeholders).toEqual(['own_stakeholders', 'competitor_stakeholders']);
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, loop: { ...base.loop, perTaskType: { own_stakeholders: { maxRounds: 2 } } } }).success).toBe(true);
  });

  it('STAKEHOLDER_FIELDS lists the eleven profile fields in order', () => {
    expect(STAKEHOLDER_FIELDS).toEqual([
      'role_mandate', 'goals_incentives', 'decision_criteria', 'constraints', 'risk_tolerance', 'dependencies', 'known_positions',
      'objections', 'information_needs', 'communication_style', 'influence',
    ]);
  });
});

describe('the stakeholders phase', () => {
  it('comes directly after deep_dives (before flow_ranking) and is an agent phase', () => {
    expect(ALL_PHASES.indexOf('stakeholders')).toBe(ALL_PHASES.indexOf('deep_dives') + 1);
    expect(ALL_PHASES.indexOf('flow_ranking')).toBe(ALL_PHASES.indexOf('stakeholders') + 1);
    expect(RUNNER_PHASES.has('stakeholders')).toBe(false);
  });

  function seededSchedules(): string {
    return legacyDb(M26, (raw) => {
      const schedule = raw.prepare('INSERT INTO schedules (id, workspace_id, name, cron, phases, enabled) VALUES (?, ?, ?, ?, ?, 1)');
      const rows: Array<[string, string]> = [
        ['sch_default', '["market_research","competitor_discovery","deep_dives","flow_ranking","synthesis","persona_panel","scoring"]'],
        ['sch_last', '["deep_dives"]'],
        ['sch_twice', '["deep_dives","synthesis","deep_dives"]'],
        ['sch_has', '["deep_dives","stakeholders","flow_ranking"]'],
        ['sch_none', '["market_research","synthesis"]'],
        ['sch_odd', '[{"phase":"deep_dives"},"deep_dives"]'],
        ['sch_broken', 'not json'],
      ];
      for (const [id, phases] of rows) schedule.run(id, 'ws_a', id, '0 6 * * 1', phases);
      raw.prepare('INSERT INTO pipelines (id, workspace_id, phases, next_index, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('pip_done', 'ws_a', '["deep_dives","synthesis"]', 2, 'done', NOW);
    });
  }

  it('migration 26 inserts stakeholders once, directly after the first deep_dives; other lists are left alone', () => {
    expect(MIGRATIONS[M26]).toMatch(/UPDATE schedules/);
    const s = openStore(seededSchedules());
    opened.push(s);
    const phases = (id: string) => (s.db.prepare('SELECT phases FROM schedules WHERE id = ?').get(id) as { phases: string }).phases;
    expect(JSON.parse(phases('sch_default'))).toEqual([
      'market_research', 'competitor_discovery', 'deep_dives', 'stakeholders', 'flow_ranking', 'synthesis', 'persona_panel', 'scoring',
    ]);
    expect(JSON.parse(phases('sch_last'))).toEqual(['deep_dives', 'stakeholders']);
    expect(JSON.parse(phases('sch_twice'))).toEqual(['deep_dives', 'stakeholders', 'synthesis', 'deep_dives']);
    expect(phases('sch_has')).toBe('["deep_dives","stakeholders","flow_ranking"]');
    expect(phases('sch_none')).toBe('["market_research","synthesis"]');
    expect(phases('sch_odd')).toBe('[{"phase":"deep_dives"},"deep_dives"]');
    expect(phases('sch_broken')).toBe('not json');
    expect((s.db.prepare("SELECT phases FROM pipelines WHERE id = 'pip_done'").get() as { phases: string }).phases).toBe('["deep_dives","synthesis"]');
    expect(s.schedules.get('sch_default')!.phases).toContain('stakeholders');
  });

  it('migration 26 runs once: a schedule saved later without stakeholders keeps its list', () => {
    const path = seededSchedules();
    const s = openStore(path);
    s.db.prepare("UPDATE schedules SET phases = '[\"deep_dives\"]' WHERE id = 'sch_none'").run();
    s.close();
    const again = openStore(path);
    opened.push(again);
    expect((again.db.prepare("SELECT phases FROM schedules WHERE id = 'sch_none'").get() as { phases: string }).phases).toBe('["deep_dives"]');
  });
});

describe('segment and stakeholder persona reads', () => {
  it('segmentPersonas excludes a stakeholder row; stakeholderPersonas returns only it', () => {
    const s = memory();
    const smb = persona(s, 'smb');
    const user = persona(s, 'me', { kind: 'user' });
    const cfo = persona(s, 'stk-cfo', { kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: 'Approves budgets', disclosure: 'hidden' });
    persona(s, 'other', { workspaceId: 'ws_b' });
    expect(segmentPersonas(s, 'ws_a').map((p) => p.id)).toEqual([smb.id]);
    expect(stakeholderPersonas(s, 'ws_a').map((p) => p.id)).toEqual([cfo.id]);
    expect(user.kind).toBe('user');
  });

  it('the rating queue lists segment personas only', () => {
    const s = memory();
    const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: f, confidence: 0.5, evidence: [] }]));
    persona(s, 'smb', { profile });
    persona(s, 'stk-cfo', { profile, kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', disclosure: 'hidden' });
    expect(reviewQueue('ws_a', { store: s }).filter((i) => i.targetType === 'persona').map((i) => i.targetId)).toEqual(['per_smb']);
  });

  it('isHidden: only a stakeholder persona marked hidden', () => {
    expect(isHidden({ kind: 'stakeholder', disclosure: 'hidden' })).toBe(true);
    expect(isHidden({ kind: 'stakeholder', disclosure: 'open' })).toBe(false);
    expect(isHidden({ kind: 'segment', disclosure: 'open' })).toBe(false);
    expect(isHidden({})).toBe(false);
  });
});
