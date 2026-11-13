import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { TOOL_DESCRIPTIONS, toolJsonSchema } from '../../../src/core/harness/tools/registry.js';
import { interviewToolHandlers } from '../../../src/core/interview/interview.js';
import { companyEntity, resolveEntity } from '../../../src/core/knowledge/entities.js';
import { linkArtifactEntity } from '../../../src/core/knowledge/entityLinks.js';
import { neighbours } from '../../../src/core/knowledge/relations.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { marketToolHandlers } from '../../../src/core/market/personas.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { addTask, researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ks3tools-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...researchToolHandlers(), ...marketToolHandlers({ dataDir: dir }), ...interviewToolHandlers() }),
  });
  const ws = (id: string, name: string, parent?: string) =>
    t.store.workspaces.insert({
      id, name, sector: 'saas', createdAt: 'now', scope: { level: parent ? 'division' : 'company', name, description: '' },
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('ws_a', 'Acme');
  ws('ws_c', 'Acme Payments', 'ws_a');
  ws('ws_b', 'Beta');
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Globex pricing page' }).id;
  const task = addTask(t.store);
  return { ...t, art, task };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

type Ok = { ok: true; data: Record<string, string> };

describe('save_finding resolves its entity (design §7.4, §9)', () => {
  it('documents the subject rule in the tool description and schema', () => {
    expect(TOOL_DESCRIPTIONS.save_finding).toMatch(/subject names it/);
    const props = (toolJsonSchema('save_finding') as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['entity', 'relations']));
  });

  it('without entity: existing competitor / company entity by subject, else a topic', async () => {
    const t = setup();
    const c = ctx({ taskId: t.task.id });
    const globex = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
    const save = async (claim: string, subject: string) =>
      ((await t.handle(c, 'save_finding', { claim, subject, evidence: [t.art] })) as Ok).data;
    const r1 = await save('Globex raised prices', 'globex');
    expect(r1.entityId).toBe(globex.id);
    expect(t.store.findings.get(r1.findingId!)!.entityId).toBe(globex.id);
    const r2 = await save('Acme hides pricing', 'Acme');
    expect(knowledgeRepos(t.store).entities.get(r2.entityId!)).toMatchObject({ kind: 'company', name: 'Acme', workspaceId: 'ws_a' });
    const r3 = await save('Pricing pages are long', 'Pricing pages');
    expect(knowledgeRepos(t.store).entities.get(r3.entityId!)).toMatchObject({ kind: 'topic', name: 'Pricing pages', createdByRun: c.agentRunId });
    // Re-save with a changed subject moves the finding; an explicit entity wins.
    const r4 = (await t.handle(c, 'save_finding', { claim: 'Pricing pages are long', subject: 'Globex', evidence: [t.art] })) as Ok;
    expect(r4.data.entityId).toBe(globex.id);
    expect(t.store.findings.get(r3.findingId!)!.entityId).toBe(globex.id);
  });

  it('explicit entity by kind/name or id; an id of another tree fails like an unknown id and saves nothing', async () => {
    const t = setup();
    const c = ctx({ taskId: t.task.id });
    const r = (await t.handle(c, 'save_finding', {
      claim: 'Widget has SSO', subject: 'Globex', evidence: [t.art], entity: { kind: 'product', name: 'Widget' },
      relations: [{ type: 'part_of', to: { kind: 'competitor', name: 'Globex' } }],
    })) as Ok;
    const widget = knowledgeRepos(t.store).entities.get(r.data.entityId!)!;
    expect(widget).toMatchObject({ kind: 'product', name: 'Widget' });
    const edges = neighbours(t.store, scopeFor(t.store, 'ws_a'), widget.id, { depth: 1, usableOnly: false });
    expect(edges).toMatchObject([{ type: 'part_of', fromEntityId: widget.id, sourceKind: 'fact', sourceId: r.data.findingId, usable: false }]);

    const foreign = resolveEntity(t.store, scopeFor(t.store, 'ws_b'), { kind: 'product', name: 'Secret' });
    const before = t.store.findings.list().length;
    const bad = await t.handle(c, 'save_finding', { claim: 'x', subject: 'y', evidence: [t.art], entity: { id: foreign.id } });
    const unknown = await t.handle(c, 'save_finding', { claim: 'x', subject: 'y', evidence: [t.art], entity: { id: 'ent_nope' } });
    expect(bad).toEqual({ ok: false, error: `save_finding failed: entity '${foreign.id}' not found` });
    expect(unknown).toEqual({ ok: false, error: `save_finding failed: entity 'ent_nope' not found` });
    const badRel = await t.handle(c, 'save_finding', {
      claim: 'z', subject: 'y', evidence: [t.art], relations: [{ type: 'offers', to: { id: foreign.id } }],
    });
    expect(badRel).toEqual({ ok: false, error: `save_finding failed: entity '${foreign.id}' not found` });
    expect(t.store.findings.list()).toHaveLength(before);
    expect(knowledgeRepos(t.store).entities.list({ rootWorkspaceId: 'ws_a', kind: 'topic' })).toEqual([]); // rolled back
    expect(await t.handle(c, 'save_finding', { claim: 'x', subject: 'y', evidence: [t.art], entity: { kind: 'planet', name: 'x' } })).toMatchObject({
      ok: false,
    });
  });
});

describe('typed records resolve their entity on save, with automatic edges', () => {
  it('save_competitor → competitor entity competes_with the node’s company entity', async () => {
    const t = setup();
    const c = ctx({ workspaceId: 'ws_c' });
    const art = t.artifacts.save({ workspaceId: 'ws_c', kind: 'text', mime: 'text/plain', bytes: 'g' }).id;
    const input = { name: 'Globex', threat: 4, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence: [art] };
    const r = (await t.handle(c, 'save_competitor', input)) as Ok;
    const cmp = t.store.competitors.get(r.data.competitorId!)!;
    const sc = scopeFor(t.store, 'ws_c');
    const company = companyEntity(t.store, sc);
    expect(company).toMatchObject({ name: 'Acme Payments', workspaceId: 'ws_c' });
    expect(knowledgeRepos(t.store).entities.get(cmp.entityId!)).toMatchObject({ kind: 'competitor', name: 'Globex', workspaceId: 'ws_c' });
    const edges = neighbours(t.store, sc, cmp.entityId!, { depth: 1, usableOnly: false });
    expect(edges).toMatchObject([{ type: 'competes_with', toEntityId: company.id, sourceKind: 'competitor', sourceId: cmp.id }]);
    // A second save (other values) keeps the entity and adds no edge; a competitor of the same name elsewhere in the tree shares it.
    await t.handle(c, 'save_competitor', { ...input, threat: 2 });
    expect(knowledgeRepos(t.store).relations.list({ rootWorkspaceId: 'ws_a' })).toHaveLength(1);
    const r2 = (await t.handle(ctx(), 'save_competitor', { ...input, evidence: [t.art] })) as Ok;
    expect(t.store.competitors.get(r2.data.competitorId!)!.entityId).toBe(cmp.entityId);
  });

  it('save_persona, save_symptom (strength → topic) and save_hypothesis (cause causes symptom)', async () => {
    const t = setup();
    const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: 'v', confidence: 0.5, evidence: [t.art] }]));
    const p = (await t.handle(ctx(), 'save_persona', { segment: 'Ops leads', audience: 'external', profile })) as Ok;
    const per = t.store.personas.get(p.data.personaId!)!;
    expect(knowledgeRepos(t.store).entities.get(per.entityId!)).toMatchObject({ kind: 'persona', name: 'Ops leads' });

    const ic = ctx({ role: 'interviewer' });
    const criteria = { severity: 4, trend: 'up', causeConfidence: 50 };
    const sy = (await t.handle(ic, 'save_symptom', { kind: 'symptom', title: 'Churn up', detail: 'd', criteria })) as Ok;
    const st = (await t.handle(ic, 'save_symptom', { kind: 'strength', title: 'Fast support', detail: 'd', criteria })) as Ok;
    const symptomEntity = t.store.symptoms.get(sy.data.symptomId!)!.entityId!;
    expect(knowledgeRepos(t.store).entities.get(symptomEntity)).toMatchObject({ kind: 'symptom', name: 'Churn up' });
    expect(knowledgeRepos(t.store).entities.get(t.store.symptoms.get(st.data.symptomId!)!.entityId!)).toMatchObject({ kind: 'topic' });

    const h = (await t.handle(ctx(), 'save_hypothesis', {
      symptom_id: sy.data.symptomId, hypothesis: 'Onboarding emails stopped in March', confidence: 60, evidence: [t.art],
    })) as Ok;
    const hyp = t.store.symptomHypotheses.get(h.data.hypothesisId!)!;
    const cause = knowledgeRepos(t.store).entities.get(hyp.entityId!)!;
    expect(cause).toMatchObject({ kind: 'cause', name: 'Onboarding emails stopped in March' });
    expect(neighbours(t.store, scopeFor(t.store, 'ws_a'), cause.id, { depth: 1, usableOnly: false })).toMatchObject([
      { fromEntityId: cause.id, type: 'causes', toEntityId: symptomEntity, sourceKind: 'hypothesis', sourceId: hyp.id },
    ]);
  });

  it('linkArtifactEntity (KS-1 seam): capture entity and has_flow to the flow entity', () => {
    const t = setup();
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'signup step 1', flow: 'Signup', step: 1 });
    const e = linkArtifactEntity(t.store, a, { kind: 'product', name: 'Widget' }, { agentRunId: 'arun_1' })!;
    expect(e).toMatchObject({ kind: 'product', name: 'Widget' });
    const edges = neighbours(t.store, scopeFor(t.store, 'ws_a'), e.id, { depth: 1, usableOnly: true });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ type: 'has_flow', sourceKind: 'artifact', sourceId: a.id });
    expect(knowledgeRepos(t.store).entities.get(edges[0]!.toEntityId)).toMatchObject({ kind: 'flow', name: 'Signup' });
    expect(linkArtifactEntity(t.store, a, undefined)).toBeUndefined();
    const foreign = resolveEntity(t.store, scopeFor(t.store, 'ws_b'), { kind: 'product', name: 'Widget' });
    expect(() => linkArtifactEntity(t.store, a, { id: foreign.id })).toThrow(`entity '${foreign.id}' not found`);
  });
});
