import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPipelineLocked } from '../../src/core/research/lock.js';
import { resumeInterrupted, runPipeline } from '../../src/core/research/orchestrator.js';
import { ALL_PHASES } from '../../src/core/research/phases.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { researchSetup, type SetupOptions } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(opts: SetupOptions) {
  const s = researchSetup(opened, { extraHandlers: () => researchToolHandlers(), ...opts });
  if (!s.store.workspaces.get('ws_a')) s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return s;
}

describe('pipeline persistence', () => {
  it('a 7-phase scheduled pipeline interrupted in market research resumes through scoring, then records what changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-pipeline-'));
    // --- process 1: the pipeline starts; the server dies during market research.
    const ac = new AbortController();
    const s1 = setup({ dir, pick: (r) => (r.kind === 'orchestrate' ? async () => ac.abort() : undefined) });
    s1.deps.signal = ac.signal;
    const schedule = s1.store.schedules.insert({
      id: newId('sch'), workspaceId: 'ws_a', name: 'weekly', cron: '0 9 * * 1', phases: ALL_PHASES, enabled: true,
    });
    // An earlier finished scoring run of the same schedule: the "what changed" baseline.
    const prevScoring = s1.store.researchRuns.insert({
      id: newId('rrun'), workspaceId: 'ws_a', phase: 'scoring', status: 'done', scheduleId: schedule.id,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await expect(runPipeline('ws_a', ALL_PHASES, s1.deps, { scheduleId: schedule.id })).rejects.toThrow();
    const [pipeline] = s1.store.pipelines.list({ workspaceId: 'ws_a' });
    expect(pipeline).toMatchObject({ status: 'running', nextIndex: 0, phases: ALL_PHASES, scheduleId: schedule.id });
    const interrupted = s1.store.researchRuns.list({ workspaceId: 'ws_a', status: 'running' });
    expect(interrupted).toEqual([expect.objectContaining({ phase: 'market_research', pipelineId: pipeline!.id })]);
    s1.store.close();

    // --- process 2: fresh store on the same data; resume continues the remaining phases.
    const ran: string[] = [];
    const s2 = setup({ dir, pick: (r) => (r.kind === 'orchestrate' ? async () => {} : undefined) });
    s2.deps.phaseRunners = {
      flow_ranking: async () => void ran.push('flow_ranking'),
      persona_panel: async () => void ran.push('persona_panel'),
      scoring: async () => void ran.push('scoring'),
    };
    const report = resumeInterrupted(s2.deps);
    expect(report.continuedPipelines).toEqual([pipeline!.id]);
    expect(isPipelineLocked(s2.store, 'ws_a')).toBe(true);
    const runs = await report.done;
    expect(runs.map((r) => r.phase)).toEqual(ALL_PHASES);
    expect(runs.every((r) => r.status === 'done' && r.pipelineId === pipeline!.id && r.scheduleId === schedule.id)).toBe(true);
    expect(runs[0]!.id).toBe(interrupted[0]!.id); // the interrupted run was continued, not restarted
    expect(ran).toEqual(['flow_ranking', 'persona_panel', 'scoring']);
    expect(s2.store.pipelines.get(pipeline!.id)).toMatchObject({ status: 'done', nextIndex: 7 });
    expect(isPipelineLocked(s2.store, 'ws_a')).toBe(false);
    const changes = s2.store.decisions
      .list({ workspaceId: 'ws_a', agentRunId: 'scheduler' })
      .filter((d) => (d.payload as { event?: string }).event === 'what_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ phase: 'scoring', prevRunId: prevScoring.id, nextRunId: runs[6]!.id, scheduleName: 'weekly' });
  });

  it('a pipeline stops (failed) after a failed phase and is not resumed', async () => {
    const s = setup({ pick: () => undefined });
    s.deps.phaseRunners = {};
    const runs = await runPipeline('ws_a', ['persona_panel', 'scoring'], s.deps);
    expect(runs.map((r) => [r.phase, r.status])).toEqual([['persona_panel', 'failed']]);
    expect(s.store.pipelines.list()[0]).toMatchObject({ status: 'failed', nextIndex: 0 });
    expect(resumeInterrupted(s.deps).continuedPipelines).toEqual([]);
  });
});
