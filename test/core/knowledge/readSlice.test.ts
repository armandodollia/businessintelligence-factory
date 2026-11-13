/**
 * KS-4: design §18 "Reviewer slice" (out-of-slice ids rejected with the same "not found" and logged as
 * blocked attempts) and §12 "Upload exposure" through every read tool (a run shown upload-derived text
 * is upload-exposed: snippets, card lines, merged entity aliases, capture descriptions, expansions).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { mergeEntities, resolveEntity } from '../../../src/core/knowledge/entities.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function task(t: ReturnType<typeof ks4>, extra: Record<string, unknown> = {}) {
  return t.store.tasks.insert({
    id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', subject: 'Acme',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['c'], status: 'reviewing', round: 1,
    createdAt: new Date().toISOString(), ...extra,
  });
}

describe('reviewer slice (design §9)', () => {
  it('a reviewer reads its task outputs, their evidence and chunks, and the facts they replace — nothing else', async () => {
    const t = ks4(opened);
    const tk = task(t);
    const ev = await t.page('ws_a', 'Evidence page: Acme Pro costs 12 dollars.');
    const elsewhere = await t.page('ws_a', 'Unrelated page about Acme history.');
    const prior = t.fact('ws_a', 'Acme Pro costs 10 dollars', { evidence: [elsewhere.id], taskId: 'tsk_old' });
    const out = t.fact('ws_a', 'Acme Pro costs 12 dollars', { taskId: tk.id, evidence: [ev.id], status: 'pending', replacesId: prior.id, lineageId: prior.lineageId!, version: 2, lifecycle: 'candidate', taskRound: 1 });
    const unrelated = t.fact('ws_a', 'Acme was founded in 1999');
    const r = t.ctx('ws_a', 'reviewer', { taskId: tk.id });
    const chunk = knowledgeRepos(t.store).chunks.list({ artifactId: ev.id })[0]!;
    for (const id of [out.id, prior.id, ev.id, chunk.id]) expect((await t.handle(r, 'expand', { id })).ok, id).toBe(true);
    expect((await t.handle(r, 'read_artifact', { artifact_id: ev.id, mode: 'text' })).ok).toBe(true);
    // Outside the slice: same text as an unknown id, and a blocked attempt on the bus.
    for (const id of [unrelated.id, elsewhere.id]) {
      expect(await t.handle(r, 'expand', { id })).toEqual({ ok: false, error: `item '${id}' not found` });
    }
    expect(await t.handle(r, 'expand', { id: 'fnd_01AAAAAAAAAAAAAAAAAAAAAAAA' })).toEqual({ ok: false, error: "item 'fnd_01AAAAAAAAAAAAAAAAAAAAAAAA' not found" });
    expect(await t.handle(r, 'read_artifact', { artifact_id: elsewhere.id })).toEqual({ ok: false, error: `artifact '${elsewhere.id}' not found` });
    const blocked = t.seen.filter((e) => e.type === 'policy_blocked') as Array<{ itemId: string; reason: string; agentRunId?: string; taskId?: string }>;
    expect(blocked.map((b) => [b.itemId, b.reason])).toEqual([
      [unrelated.id, 'out_of_slice'], [elsewhere.id, 'out_of_slice'], ['fnd_01AAAAAAAAAAAAAAAAAAAAAAAA', 'out_of_slice'], [elsewhere.id, 'out_of_slice'],
    ]);
    expect(blocked[0]).toMatchObject({ agentRunId: r.agentRunId, taskId: tk.id });
    // The prior fact's own evidence (not in the slice) is left out of its expansion.
    const ex = await t.call<{ items: Array<{ type: string; artifact_id?: string }> }>(r, 'expand', { id: prior.id });
    expect(ex.items.filter((i) => i.type === 'evidence')).toEqual([]);
    // No search, card or list for reviewers (role table).
    expect((await t.handle(r, 'search', { query: 'acme' })).ok).toBe(false);
  });

  it('escalation runs get the same slice; a reviewer without a task reads nothing', async () => {
    const t = ks4(opened);
    const tk = task(t, { status: 'unverified' });
    const ev = await t.page('ws_a', 'Evidence for the escalated task.');
    t.fact('ws_a', 'Escalated claim', { taskId: tk.id, evidence: [ev.id], status: 'unverified', taskRound: 1 });
    const other = await t.page('ws_a', 'Something else.');
    const e = t.ctx('ws_a', 'escalation', { taskId: tk.id });
    expect((await t.handle(e, 'expand', { id: ev.id })).ok).toBe(true);
    expect((await t.handle(e, 'expand', { id: other.id })).ok).toBe(false);
    expect((await t.handle(t.ctx('ws_a', 'reviewer'), 'expand', { id: ev.id })).ok).toBe(false);
  });
});

describe('upload exposure through every read path (design §12)', () => {
  it('search snippets, cards, expansions, read_artifact and read_workspace of upload text flag the run', async () => {
    const t = ks4(opened);
    const up = uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential: churn rose to 14 percent in Q3.'), mime: 'text/plain' }, t);
    await ingestorFor(t).idle();
    const pub = await t.page('ws_a', 'Public page: churn is discussed in the annual report.');
    const read = async (tool: string, input: Record<string, unknown>) => {
      const c = t.ctx('ws_a');
      const r = await t.handle(c, tool as never, input);
      expect(r.ok, tool).toBe(true);
      return { c, data: (r as { data: Record<string, unknown> }).data };
    };
    const s = await read('search', { query: 'churn', kinds: ['passage'] });
    expect(runIsUploadExposed(t.store, s.c.agentRunId)).toBe(true);
    expect(t.rows(s.c.agentRunId)[0]!.resultIds.map((x) => x.id)).toContain(up.id);
    const pubOnly = await read('search', { query: 'annual report', kinds: ['passage'] });
    expect(runIsUploadExposed(t.store, pubOnly.c.agentRunId)).toBe(false);
    for (const [tool, input] of [
      ['expand', { id: up.id }],
      ['read_artifact', { artifact_id: up.id, mode: 'text' }],
      ['expand', { id: knowledgeRepos(t.store).chunks.list({ artifactId: up.id })[0]!.id }],
    ] as const) {
      const r = await read(tool, input);
      expect(runIsUploadExposed(t.store, r.c.agentRunId), tool).toBe(true);
      expect(t.rows(r.c.agentRunId)[0]!.uploadDerived, tool).toBe(true);
    }
    // A fact citing the upload on a card line; read_workspace / node cards listing an upload-derived symptom.
    const ent = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'topic', name: 'Churn' });
    t.fact('ws_a', 'Churn rose to 14 percent', { evidence: [up.id], entityId: ent.id });
    t.fact('ws_a', 'Churn is discussed publicly', { evidence: [pub.id], entityId: ent.id });
    const card = await read('get_card', { entity_id: ent.id });
    expect((card.data.lines as string[]).some((l) => l.includes('[upload]'))).toBe(true);
    expect(runIsUploadExposed(t.store, card.c.agentRunId)).toBe(true);
    t.store.symptoms.insert({ id: newId('sym'), workspaceId: 'ws_a', kind: 'symptom', title: 'Churn rising', detail: 'd', criteria: {}, evidence: [up.id] });
    const ws = await read('read_workspace', { workspace_id: 'ws_a' });
    expect(runIsUploadExposed(t.store, ws.c.agentRunId)).toBe(true);
  });

  it('an upload duplicate served from a public canonical lists the artifact asked for, so the run is exposed', async () => {
    const t = ks4(opened);
    const pub = await t.page('ws_a', 'Identical text: Acme Pro costs 49 dollars.');
    const up = uploadInternal('ws_a', { name: 'same.txt', bytes: new TextEncoder().encode('Identical text: Acme Pro costs 49 dollars.\n'), mime: 'text/plain' }, t);
    await ingestorFor(t).idle();
    expect(knowledgeRepos(t.store).artifactTexts.get(up.id)!.duplicateOf).toBe(pub.id);
    const c = t.ctx('ws_a');
    const r = await t.call<{ items: Array<{ type: string; text: string }> }>(c, 'read_artifact', { artifact_id: up.id, mode: 'text' });
    expect(r.items.find((i) => i.type === 'chunk')!.text).toContain('49 dollars');
    expect(t.rows(c.agentRunId)[0]!.resultIds.map((x) => x.id)).toEqual(expect.arrayContaining([up.id, pub.id]));
    expect(runIsUploadExposed(t.store, c.agentRunId)).toBe(true);
  });

  it('a capture description is served under its artifact\'s upload flag', async () => {
    const t = ks4(opened);
    const up = uploadInternal('ws_a', { name: 'shot.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), mime: 'image/png' }, t);
    knowledgeRepos(t.store).artifactCaptures.insert({ id: newId('cap'), artifactId: up.id, workspaceId: 'ws_a', description: 'Dashboard shows revenue 3.2M', capturedAt: new Date().toISOString() });
    const c = t.ctx('ws_a');
    const ex = await t.call<{ items: Array<{ type: string; description?: string }> }>(c, 'expand', { id: up.id });
    expect(ex.items.find((i) => i.type === 'capture' && i.description)?.description).toContain('revenue 3.2M');
    expect(t.rows(c.agentRunId)[0]!.uploadDerived).toBe(true);
  });

  it('an entity hit through an upload-only alias is flagged and lists the merged row', async () => {
    const t = ks4(opened);
    const up = uploadInternal('ws_a', { name: 'n.txt', bytes: new TextEncoder().encode('Project Falcon'), mime: 'text/plain' }, t);
    const pub = await t.page('ws_a', 'Globex Inc public site.');
    const sc = scopeFor(t.store, 'ws_a');
    const globex = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Globex Inc' });
    const falcon = resolveEntity(t.store, sc, { kind: 'competitor', name: 'Project Falcon' });
    t.fact('ws_a', 'Globex Inc sells widgets', { entityId: globex.id, evidence: [pub.id] });
    t.fact('ws_a', 'Project Falcon is a secret effort', { entityId: falcon.id, evidence: [up.id] });
    mergeEntities(t.store, globex.id, falcon.id, 'u');
    const c = t.ctx('ws_a');
    const s = await t.call<{ hits: Array<{ id: string; title: string; flags?: string[] }> }>(c, 'search', { query: 'falcon', kinds: ['entity'] });
    expect(s.hits).toEqual([expect.objectContaining({ id: globex.id, title: 'Globex Inc (alias: Project Falcon)', flags: ['upload'] })]);
    expect(t.rows(c.agentRunId)[0]!.resultIds).toEqual([{ id: globex.id, kind: 'entity' }, { id: falcon.id, kind: 'entity' }]);
    expect(runIsUploadExposed(t.store, c.agentRunId)).toBe(true);
    // A public match of the survivor is not flagged.
    const c2 = t.ctx('ws_a');
    const s2 = await t.call<{ hits: Array<{ flags?: string[] }> }>(c2, 'search', { query: 'globex', kinds: ['entity'] });
    expect(s2.hits[0]!.flags).toBeUndefined();
    // The card names the upload-only alias marked and lists its row.
    const c3 = t.ctx('ws_a');
    const card = await t.call<{ lines: string[] }>(c3, 'get_card', { entity_id: globex.id });
    expect(card.lines.filter((l) => l.startsWith('alias: '))).toEqual(['alias: Project Falcon [upload]']);
    expect(t.rows(c3.agentRunId)[0]!.resultIds.map((r) => r.id)).toContain(falcon.id);
  });
});
