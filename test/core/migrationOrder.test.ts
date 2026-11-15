/**
 * Learning-loop wave 2 integration: the migration array ends with KS-0 (18), WP-E (19), WP-F (20),
 * two-pass OCR (21), flow records (22), the flow ranking step for existing schedules (23) and persona
 * learning (24), in that order. Positions are counted from the end, so no total is hard-coded.
 */
import { describe, expect, it } from 'vitest';
import { openStore } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';

describe('migration order after wave 2', () => {
  it('ends with KS-0, then WP-E (lessons), then WP-F (audits and experiments), then OCR, then flows, then the schedules update, then persona learning', () => {
    const [ks0, wpE, wpF, ocr, flows, schedules, personaLearning] = MIGRATIONS.slice(-7);
    expect(ks0).toMatch(/upload_derived/);
    expect(wpE).toMatch(/CREATE TABLE lesson_rules/);
    expect(wpF).toMatch(/CREATE TABLE reviewer_audits/);
    expect(ocr).toMatch(/CREATE TABLE ocr_runs/);
    expect(flows).toMatch(/CREATE TABLE flow_types/);
    expect(schedules).toMatch(/UPDATE schedules SET phases/);
    expect(personaLearning).toMatch(/CREATE TABLE persona_adjustments/);
    expect(MIGRATIONS.filter((m) => /CREATE TABLE lesson_rules|CREATE TABLE reviewer_audits/.test(m))).toHaveLength(2);
    const store = openStore(':memory:');
    try {
      expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    } finally {
      store.close();
    }
  });
});
