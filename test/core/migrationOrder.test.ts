/**
 * Learning-loop wave 2 integration: the migration array ends with KS-0 (18), WP-E (19), WP-F (20), in
 * that order. Positions are counted from the end, so no total is hard-coded.
 */
import { describe, expect, it } from 'vitest';
import { openStore } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';

describe('migration order after wave 2', () => {
  it('ends with KS-0, then WP-E (lessons), then WP-F (audits and experiments)', () => {
    const [ks0, wpE, wpF] = MIGRATIONS.slice(-3);
    expect(ks0).toMatch(/upload_derived/);
    expect(wpE).toMatch(/CREATE TABLE lesson_rules/);
    expect(wpF).toMatch(/CREATE TABLE reviewer_audits/);
    expect(MIGRATIONS.filter((m) => /CREATE TABLE lesson_rules|CREATE TABLE reviewer_audits/.test(m))).toHaveLength(2);
    const store = openStore(':memory:');
    try {
      expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    } finally {
      store.close();
    }
  });
});
