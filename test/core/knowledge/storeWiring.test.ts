import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../../src/core/harness/tools/handlers.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Finding, Task } from '../../../src/core/types.js';

// Cross-wiring of KS-1 (extraction, captures), KS-2 (living facts) and KS-3 (entities) through the
// real tool dispatcher: nothing here inserts capture rows or text rows by hand.

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';

function setup(config: BifConfig = defaultConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-wiring-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const ws = (id: string, name: string, parent?: string) =>
    store.workspaces.insert({
      id, name, sector: 'saas', createdAt: T0, scope: { level: parent ? 'division' : 'company', name, description: '' },
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('R', 'Acme');
  ws('D', 'Acme Payments', 'R');
  ws('Q', 'Other');
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({ store, artifacts, config, events: new EventBus() });
  return { store, artifacts, handle, k: knowledgeRepos(store) };
}
type Env = ReturnType<typeof setup>;

function task(store: Store, ws = 'R'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId: ws, runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
  });
}

const ctxFor = (t: Task): RunContext => ({
  agentRunId: newId('arun'), workspaceId: t.workspaceId, taskId: t.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
});

const data = <T = Record<string, unknown>>(r: { ok: boolean }): T => {
  if (!r.ok) throw new Error(`tool failed: ${(r as unknown as { error: string }).error}`);
  return (r as unknown as { data: T }).data;
};

async function saveText(env: Env, ctx: RunContext, content: string, extra: Record<string, unknown> = {}) {
  return data<{ artifactId: string; captureId: string; extraction: { status: string; queued?: true } }>(
    await env.handle(ctx, 'save_artifact', { kind: 'text', mime: 'text/plain', content, ...extra }),
  );
}

/** A verified current fact saved by an earlier task, through the tools. */
async function earlierFact(env: Env, claim: string, extra: Record<string, unknown> = {}): Promise<Finding> {
  const t = task(env.store);
  const c = ctxFor(t);
  const a = await saveText(env, c, `earlier evidence for ${claim}`);
  const r = data<{ findingId: string }>(
    await env.handle(c, 'save_finding', { claim, subject: 'Globex', evidence: [a.artifactId], relation: 'new', ...extra }),
  );
  env.store.findings.update(r.findingId, { status: 'verified' });
  return env.store.findings.get(r.findingId)!;
}

describe('KS-1 × KS-2: captures written by save_artifact carry the task (design §7.3)', () => {
  it('confirm_finding, retract_finding and the exact-match auto-confirm accept artifacts saved through save_artifact', async () => {
    const env = setup();
    const f1 = await earlierFact(env, 'Globex Pro plan costs $10 per month');
    const f2 = await earlierFact(env, 'Globex offers a free tier for teams');
    const f3 = await earlierFact(env, 'Globex supports single sign-on on every plan');

    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'Globex pricing page, visited today');
    expect(env.k.artifactCaptures.list({ artifactId: a.artifactId })).toMatchObject([{ taskId: t.id, agentRunId: c.agentRunId }]);

    expect(data(await env.handle(c, 'confirm_finding', { finding_id: f1.id, evidence: [a.artifactId] }))).toMatchObject({
      findingId: f1.id, relation: 'confirms', status: 'pending',
    });
    expect(
      data(await env.handle(c, 'retract_finding', { finding_id: f2.id, reason: 'free tier removed', evidence: [a.artifactId] })),
    ).toMatchObject({ findingId: f2.id, relation: 'retracts', status: 'pending' });
    const auto = data(await env.handle(c, 'save_finding', { claim: f3.claim, subject: 'Globex', evidence: [a.artifactId] }));
    expect(auto).toMatchObject({ findingId: f3.id, autoConfirmed: true });
    expect(env.k.factObservations.list({ taskId: t.id }).map((o) => o.kind).sort()).toEqual(['confirm', 'confirm', 'retract']);
  });

  it('identical bytes saved earlier by another task still count once this task saves them (captures never dedupe)', async () => {
    const env = setup();
    const f = await earlierFact(env, 'Globex Pro plan costs $10 per month');
    const other = task(env.store);
    const first = await saveText(env, ctxFor(other), 'the same pricing page bytes');
    const t = task(env.store);
    const c = ctxFor(t);
    // Not saved by this task yet: rejected.
    const refused = await env.handle(c, 'confirm_finding', { finding_id: f.id, evidence: [first.artifactId] });
    expect(refused).toMatchObject({ ok: false });
    const again = await saveText(env, c, 'the same pricing page bytes');
    expect(again.artifactId).toBe(first.artifactId);
    expect(again.captureId).not.toBe(first.captureId);
    expect(await env.handle(c, 'confirm_finding', { finding_id: f.id, evidence: [again.artifactId] })).toMatchObject({ ok: true });
  });

  it('a quote on a still-queued artifact extracts it inline through the KS-1 pipeline (stored, chunk-resolved)', async () => {
    const env = setup({ ...defaultConfig, knowledge: { extraction: { inlineMaxBytes: 4 } } });
    const t = task(env.store);
    const c = ctxFor(t);
    const a = await saveText(env, c, 'Globex Pricing. The Pro plan costs 12 dollars per seat per month.');
    expect(a.extraction).toMatchObject({ status: 'pending', queued: true });
    // The background queue must not be what extracts it.
    await ingestorFor({ store: env.store, artifacts: env.artifacts }).stop();
    expect(env.k.artifactTexts.get(a.artifactId)?.status).toBe('pending');

    const r = data<{ findingId: string }>(
      await env.handle(c, 'save_finding', {
        claim: 'Globex Pro costs $12 per seat', subject: 'Globex', evidence: [a.artifactId], relation: 'new',
        evidence_refs: [{ artifact_id: a.artifactId, quote: 'The Pro plan costs 12 dollars per seat' }],
      }),
    );
    expect(env.k.artifactTexts.get(a.artifactId)?.status).toBe('ok');
    const chunks = env.k.chunks.list({ artifactId: a.artifactId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(env.k.findingEvidence.list({ findingId: r.findingId })).toMatchObject([
      { artifactId: a.artifactId, chunkId: chunks[0]!.id, quote: 'The Pro plan costs 12 dollars per seat' },
    ]);
  });
});
