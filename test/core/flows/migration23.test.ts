import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { MIGRATIONS } from '../../../src/core/store/migrations.js';

/** Migration 23 (index 22): existing schedules gain the flow ranking step. Never asserts the total migration count. */
const M23 = 22;
const T0 = '2026-11-01T10:00:00.000Z';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** A database at migration 22 with schedules and pipelines of every phase list shape that can exist. */
function legacyDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bif-m23-')), 'bif.db');
  const raw = new DatabaseSync(path);
  for (const [i, m] of MIGRATIONS.slice(0, M23).entries()) {
    raw.exec(m);
    raw.exec(`PRAGMA user_version = ${i + 1}`);
  }
  const schedule = raw.prepare('INSERT INTO schedules (id, workspace_id, name, cron, phases, enabled) VALUES (?, ?, ?, ?, ?, 1)');
  const rows: Array<[string, string]> = [
    ['sch_default', '["market_research","competitor_discovery","deep_dives","synthesis","persona_panel","scoring"]'],
    ['sch_last', '["deep_dives"]'],
    ['sch_mapping', '["mapping","deep_dives","scoring"]'],
    ['sch_has', '["deep_dives","flow_ranking","scoring"]'],
    ['sch_has_elsewhere', '["flow_ranking","deep_dives"]'],
    ['sch_none', '["market_research","synthesis"]'],
    ['sch_twice', '["deep_dives","synthesis","deep_dives"]'],
    ['sch_odd', '[{"phase":"deep_dives"},"deep_dives"]'],
    ['sch_broken', 'not json'],
    ['sch_object', '{"phases":["deep_dives"]}'],
  ];
  for (const [id, phases] of rows) schedule.run(id, 'ws_a', id, '0 6 * * 1', phases);
  const pipeline = raw.prepare('INSERT INTO pipelines (id, workspace_id, phases, next_index, status, started_at) VALUES (?, ?, ?, ?, ?, ?)');
  pipeline.run('pip_running', 'ws_a', '["deep_dives","synthesis"]', 1, 'running', T0);
  pipeline.run('pip_done', 'ws_a', '["deep_dives","synthesis"]', 2, 'done', T0);
  raw.close();
  return path;
}

describe('migration 23: existing schedules run the flow ranking step', () => {
  it('inserts flow_ranking directly after deep_dives in every stored schedule that lacks it; nothing else changes', () => {
    expect(MIGRATIONS[M23]).toMatch(/UPDATE schedules/);
    const s = openStore(legacyDb());
    opened.push(s);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    const phases = (id: string) => (s.db.prepare('SELECT phases FROM schedules WHERE id = ?').get(id) as { phases: string }).phases;
    expect(JSON.parse(phases('sch_default'))).toEqual(['market_research', 'competitor_discovery', 'deep_dives', 'flow_ranking', 'synthesis', 'persona_panel', 'scoring']);
    expect(JSON.parse(phases('sch_last'))).toEqual(['deep_dives', 'flow_ranking']);
    expect(JSON.parse(phases('sch_mapping'))).toEqual(['mapping', 'deep_dives', 'flow_ranking', 'scoring']);
    // Only after the first deep_dives.
    expect(JSON.parse(phases('sch_twice'))).toEqual(['deep_dives', 'flow_ranking', 'synthesis', 'deep_dives']);
    // Untouched: already has flow_ranking (wherever), no deep_dives, or a shape that is not a list of names.
    expect(phases('sch_has')).toBe('["deep_dives","flow_ranking","scoring"]');
    expect(phases('sch_has_elsewhere')).toBe('["flow_ranking","deep_dives"]');
    expect(phases('sch_none')).toBe('["market_research","synthesis"]');
    expect(phases('sch_odd')).toBe('[{"phase":"deep_dives"},"deep_dives"]');
    expect(phases('sch_broken')).toBe('not json');
    expect(phases('sch_object')).toBe('{"phases":["deep_dives"]}');
    // Pipelines are only ever running or finished: left alone.
    for (const id of ['pip_running', 'pip_done']) {
      expect((s.db.prepare('SELECT phases FROM pipelines WHERE id = ?').get(id) as { phases: string }).phases).toBe('["deep_dives","synthesis"]');
    }
    // The repository reads the updated list.
    expect(s.schedules.get('sch_default')!.phases).toContain('flow_ranking');
  });

  it('runs once: a schedule saved later without flow_ranking keeps its list', () => {
    const path = legacyDb();
    const s = openStore(path);
    s.db.prepare("UPDATE schedules SET phases = '[\"deep_dives\"]' WHERE id = 'sch_none'").run();
    s.close();
    const again = openStore(path);
    opened.push(again);
    expect((again.db.prepare("SELECT phases FROM schedules WHERE id = 'sch_none'").get() as { phases: string }).phases).toBe('["deep_dives"]');
  });
});
