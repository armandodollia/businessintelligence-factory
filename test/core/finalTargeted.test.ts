import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { browserStartupWarnings } from '../../src/core/harness/browser.js';
import { resultProvenance } from '../../src/core/harness/tools/handlers.js';
import { drillDown } from '../../src/core/interview/hypotheses.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { marketToolHandlers } from '../../src/core/market/personas.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { PERSONA_FIELDS } from '../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { scoringToolHandlers } from '../../src/core/scoring/priority.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import type { Task } from '../../src/core/types.js';
import { addTask, researchSetup, review, revise } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-final-d-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...researchToolHandlers(), ...marketToolHandlers({ dataDir: dir }), ...scoringToolHandlers() }),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now', audiences: ['external'] });
  t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: {}, evidence: [] });
  return t;
}

const personaProfile = (evidence: string[]) =>
  Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.6, evidence }]));

const competitor = (evidence: string[], name = 'Globex') => ({
  name, threat: 4, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence,
});

/** Runs a task whose worker does `work` then submits `result`, passing review. */
async function runWith(t: ReturnType<typeof setup>, extra: Partial<Task>, work: FakeScript, result: Record<string, unknown>) {
  t.state.pick = (r) =>
    r.kind === 'work'
      ? async (tools) => {
          await work(tools);
          await tools.call('submit_result', result);
        }
      : review(9);
  const task = addTask(t.store, { workspaceId: 'ws_a', ...extra });
  return runTaskWithReview(task, t.deps);
}

describe('export privacy covers every task output', () => {
  it('upload-backed recommendation, persona, competitor and hypothesis: deliverable text never in the default export', async () => {
    const t = setup();
    const upload = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('secret kpis'), mime: 'text/csv' }, t);
    // A verified finding of another task resting on the upload (cited by the recommendation / hypothesis).
    t.store.findings.insert({
      id: 'fnd_up', workspaceId: 'ws_a', runId: 'r0', taskId: 'tsk_other', subject: 'Acme', claim: 'renewals fell 12%', criteria: {},
      evidence: [upload.id], status: 'verified', createdAt: 'now',
    });
    const tasks = [
      await runWith(t, { type: 'synthesize_recommendations', phase: 'synthesis' }, async (tools) => {
        await tools.call('save_recommendation', { title: 'Fix renewals', summary: 's', criteria: { upside: 4 }, finding_ids: ['fnd_up'] });
      }, { summary: 'SECRET_REC_TEXT' }),
      await runWith(t, { type: 'persona_profile', phase: 'market_research' }, async (tools) => {
        await tools.call('save_persona', { segment: 'CFO', audience: 'external', profile: personaProfile([upload.id]) });
      }, { summary: 'SECRET_PERSONA_TEXT' }),
      await runWith(t, { type: 'discover_competitors', phase: 'competitor_discovery' }, async (tools) => {
        await tools.call('save_competitor', competitor([upload.id]));
      }, { summary: 'SECRET_COMPETITOR_TEXT' }),
      await runWith(t, { type: 'symptom_hypotheses', phase: 'synthesis' }, async (tools) => {
        await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'price rise', confidence: 60, evidence: ['fnd_up'] });
      }, { summary: 'SECRET_HYPOTHESIS_TEXT' }),
    ];
    for (const task of tasks) {
      expect(task.status).toBe('verified');
      expect(resultProvenance(t.store, task, task.result)).toContain(upload.id);
    }
    const out = exportTrainingData('ws_a', t);
    for (const secret of ['SECRET_REC_TEXT', 'SECRET_PERSONA_TEXT', 'SECRET_COMPETITOR_TEXT', 'SECRET_HYPOTHESIS_TEXT']) {
      expect(out).not.toContain(secret);
      expect(exportTrainingData('ws_a', t, true)).toContain(secret); // opt-in keeps them
    }
  });
});

describe('superseded against the final submitted round', () => {
  it('a round-1 finding withdrawn in round 2 without replacement is superseded, not verified', async () => {
    const t = setup();
    let reviews = 0;
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          const a = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'blog' })) as { artifactId: string };
          await tools.call('save_finding', { claim: 'WRONG_CLAIM', subject: 'Acme', evidence: [a.artifactId] });
          await tools.call('submit_result', { summary: 'v1' });
        };
      }
      if (r.kind === 'review') return review(++reviews === 1 ? 3 : 9, [{ class: 'blocking', description: 'claim unsupported, drop it' }]);
      return revise('fix', { summary: 'v2 without the claim' }, false)(r); // saves nothing, cites nothing
    };
    const task = addTask(t.store, { workspaceId: 'ws_a' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    expect(t.store.findings.list({ taskId: task.id })[0]!.status).toBe('superseded');
    // The round-2 reviewer no longer sees the withdrawn finding.
    expect(t.requests.filter((r) => r.kind === 'review')[1]!.prompt).not.toContain('WRONG_CLAIM');
  });
});

describe('competitors and hypotheses in the review-status system', () => {
  it('take their task status (superseded when withdrawn); reviewer sees their content and evidence; drill-down uses usable only', async () => {
    const t = setup();
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'pricing page' });
    let reviews = 0;
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await tools.call('save_competitor', competitor([art.id], 'Initech'));
          await tools.call('save_competitor', competitor([art.id], 'Globex'));
          await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'HYPO_TEXT price rise', confidence: 60, evidence: [art.id] });
          await tools.call('submit_result', { summary: 'v1' });
        };
      }
      if (r.kind === 'review') return review(++reviews === 1 ? 4 : 9, [{ class: 'substantive', description: 'Initech is not a competitor' }]);
      return async (tools) => {
        await tools.call('save_competitor', competitor([art.id], 'Globex')); // re-submitted unchanged
        const hyp = t.store.symptomHypotheses.list()[0]!.id;
        await revise('fix', { summary: 'v2', keep: [hyp] }, false)(r)(tools); // keeps the hypothesis by id
      };
    };
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'discover_competitors', phase: 'competitor_discovery' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    const byName = Object.fromEntries(t.store.competitors.list().map((c) => [c.name, c]));
    expect(byName.Globex).toMatchObject({ status: 'verified', taskRound: 2 });
    expect(byName.Initech!.status).toBe('superseded');
    expect(t.store.symptomHypotheses.list()[0]).toMatchObject({ status: 'verified', taskRound: 1 });
    const firstReview = t.requests.find((r) => r.kind === 'review')!.prompt;
    expect(firstReview).toContain('### Competitors saved by this task');
    expect(firstReview).toMatch(/Globex: threat 4, directness 5/);
    expect(firstReview).toContain('HYPO_TEXT price rise');
    expect(firstReview).toContain(art.id);
    expect(t.requests.filter((r) => r.kind === 'review')[1]!.prompt).not.toContain('Initech');

    expect(drillDown(t.store, 'ws_a').get('sym_1')).toHaveLength(1);
    t.store.symptomHypotheses.update(t.store.symptomHypotheses.list()[0]!.id, { status: 'unverified' });
    expect(drillDown(t.store, 'ws_a').get('sym_1')).toBeUndefined();
  });

  it('migration 13 backfills status from the task and maps legacy competitor ratings by normalized name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-m13-'));
    const path = join(dir, 'bif.db');
    openStore(path).close();
    rmSync(path);
    const raw = new DatabaseSync(path);
    raw.exec('BEGIN');
    for (const m of MIGRATIONS.slice(0, 12)) raw.exec(m);
    raw.exec('PRAGMA user_version = 12');
    raw.exec(`INSERT INTO tasks (id, workspace_id, run_id, phase, type, brief, model, needs_browser, acceptance_criteria, status, round, created_at)
      VALUES ('tsk_c', 'ws', 'r', 'competitor_discovery', 'discover_competitors', 'b', '{}', 0, '[]', 'verified', 1, 'now')`);
    raw.exec(`INSERT INTO competitors (id, workspace_id, name, threat, directness, comparison, evidence, task_id, created_at, updated_at)
      VALUES ('cmp_A', 'ws', 'Globex  Corp', 4, 5, '{}', '[]', 'tsk_c', 'now', 'now'),
             ('cmp_B', 'ws', 'Initech', 2, 2, '{}', '[]', NULL, 'now', 'now')`);
    raw.exec(`INSERT INTO symptom_hypotheses (id, workspace_id, symptom_id, hypothesis, confidence, evidence, task_id, created_at)
      VALUES ('hyp_A', 'ws', 'sym', 'h', 50, '[]', 'tsk_c', 'now')`);
    raw.exec(`INSERT INTO ratings (id, workspace_id, target_type, target_id, criterion, agent_value, verdict, created_at)
      VALUES ('rat_1', 'ws', 'competitor', ' globex corp ', 'threat', 4, 'agree', 'now'),
             ('rat_2', 'ws', 'competitor', 'Unknown Co', 'threat', 3, 'agree', 'now'),
             ('rat_3', 'ws', 'competitor', 'cmp_B', 'threat', 2, 'agree', 'now')`);
    raw.exec('COMMIT');
    raw.close();
    const store = openStore(path);
    opened.push(store);
    expect(store.competitors.get('cmp_A')!.status).toBe('verified');
    expect(store.competitors.get('cmp_B')!.status).toBe('unverified');
    expect(store.symptomHypotheses.get('hyp_A')!.status).toBe('verified');
    expect(store.ratings.get('rat_1')!.targetId).toBe('cmp_A');
    expect(store.ratings.get('rat_2')!.targetId).toBe('Unknown Co');
    expect(store.ratings.get('rat_3')!.targetId).toBe('cmp_B');
  });
});

describe('browser startup warnings', () => {
  it('warns when shared mode is configured but mcpServers is still set (old config)', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.browser.mode = 'shared';
    expect(browserStartupWarnings(cfg).join('\n')).not.toMatch(/mcpServers is ignored/);
    cfg.browser.mcpServers = { pw: { command: 'npx', args: ['@playwright/mcp'] } };
    expect(browserStartupWarnings(cfg).join('\n')).toMatch(/mcpServers is ignored in shared mode/);
  });
});
