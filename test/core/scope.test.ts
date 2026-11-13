import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { createToolHandlers, type HandleTool } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { orchestratorPrompt, startPhase } from '../../src/core/research/orchestrator.js';
import { ALL_PHASES, orderPhases, PHASE_TASK_TYPES, phaseGoal } from '../../src/core/research/phases.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import { newId } from '../../src/core/store/repos.js';
import type { Persona, Symptom, Task, Workspace } from '../../src/core/types.js';
import {
  acceptUnitProposal,
  crossCuttingSymptoms,
  normalizeTitle,
  rejectUnitProposal,
  rollup,
} from '../../src/core/workspace/businessMap.js';
import { ancestors, createWorkspace, descendants, rootOf, sameTree, siblings, workspaceTree } from '../../src/core/workspace/tree.js';
import { researchSetup, review } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-scope-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  const handle: HandleTool = createToolHandlers({
    store, artifacts, config: defaultConfig, events: new EventBus(), extraHandlers: researchToolHandlers(),
  });
  return { dir, store, artifacts, handle };
}

/** company → division → product (+ sibling division), and an unrelated company. */
function tree(store: Store) {
  const company = createWorkspace(store, { name: 'Acme', sector: 'saas' });
  const division = createWorkspace(store, { name: 'Payments', sector: 'saas', parentWorkspaceId: company.id });
  const sibling = createWorkspace(store, { name: 'Lending', sector: 'saas', parentWorkspaceId: company.id });
  const product = createWorkspace(store, {
    name: 'Card API', sector: 'saas', parentWorkspaceId: division.id, scope: { level: 'slice', description: 'card processing API' },
  });
  const other = createWorkspace(store, { name: 'Globex', sector: 'retail' });
  return { company, division, sibling, product, other };
}

const ctx = (workspaceId: string, extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

function addTask(store: Store, workspaceId: string): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId, runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b',
    model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['c'], status: 'running',
    round: 1, createdAt: new Date().toISOString(),
  });
}

const symptom = (workspaceId: string, title: string, kind: Symptom['kind'] = 'symptom'): Symptom => ({
  id: newId('sym'), workspaceId, kind, title, detail: 'd', criteria: {}, evidence: [],
});

describe('business tree', () => {
  it('ancestors deep chain nearest first', () => {
    const { store } = setup();
    const t = tree(store);
    const leaf = createWorkspace(store, { name: 'Team', sector: 'saas', parentWorkspaceId: t.product.id });
    expect(ancestors(store, leaf.id).map((w) => w.id)).toEqual([t.product.id, t.division.id, t.company.id]);
    expect(rootOf(store, leaf.id)).toBe(t.company.id);
    expect(descendants(store, t.company.id).map((w) => w.id).sort()).toEqual(
      [t.division.id, t.sibling.id, t.product.id, leaf.id].sort(),
    );
    expect(siblings(store, t.division.id).map((w) => w.id)).toEqual([t.sibling.id]);
    expect(workspaceTree(store, t.company.id)!.children.map((c) => c.workspace.id)).toEqual([t.division.id, t.sibling.id]);
    // Cycle-safe.
    store.workspaces.update(t.company.id, { parentWorkspaceId: leaf.id });
    expect(ancestors(store, leaf.id).map((w) => w.id)).toEqual([t.product.id, t.division.id, t.company.id]);
    expect(descendants(store, t.company.id).length).toBe(4);
  });

  it('grandchild can cite grandparent artifact', async () => {
    const { store, artifacts, handle } = setup();
    const t = tree(store);
    const art = artifacts.save({ workspaceId: t.company.id, kind: 'text', mime: 'text/plain', bytes: 'company annual report' });
    const task = addTask(store, t.product.id);
    const r = await handle(ctx(t.product.id, { taskId: task.id }), 'save_finding', {
      claim: 'Card volume is 40% of revenue', subject: 'Acme', evidence: [art.id],
    });
    expect(r.ok).toBe(true);
    expect(artifacts.exists(t.product.id, [art.id])).toEqual([]);
    // Reviewers in the grandchild can read it too.
    const read = await handle(ctx(t.product.id, { role: 'reviewer' }), 'read_artifact', { artifact_id: art.id });
    expect(read.ok).toBe(true);
  });

  it('sibling artifact accepted as evidence', async () => {
    const { store, artifacts, handle } = setup();
    const t = tree(store);
    const art = artifacts.save({ workspaceId: t.sibling.id, kind: 'text', mime: 'text/plain', bytes: 'lending survey' });
    const task = addTask(store, t.division.id);
    const r = await handle(ctx(t.division.id, { taskId: task.id }), 'save_finding', { claim: 'c', subject: 's', evidence: [art.id] });
    expect(r.ok).toBe(true);
  });

  it('artifact from another tree rejected', async () => {
    const { store, artifacts, handle } = setup();
    const t = tree(store);
    const art = artifacts.save({ workspaceId: t.other.id, kind: 'text', mime: 'text/plain', bytes: 'globex secret' });
    const task = addTask(store, t.division.id);
    const r = await handle(ctx(t.division.id, { taskId: task.id }), 'save_finding', { claim: 'c', subject: 's', evidence: [art.id] });
    expect(r).toMatchObject({ ok: false });
    expect(artifacts.exists(t.division.id, [art.id])).toEqual([art.id]);
    expect(sameTree(store, t.product.id, t.other.id)).toBe(false);
    const read = await handle(ctx(t.division.id, { role: 'reviewer' }), 'read_artifact', { artifact_id: art.id });
    expect(read.ok).toBe(false);
  });

  it('read_workspace rejects other tree', async () => {
    const { store, handle } = setup();
    const t = tree(store);
    store.profiles.insert({ workspaceId: t.company.id, data: { revenue: '10M' } });
    store.findings.insert({
      id: 'fnd_root', workspaceId: t.company.id, runId: 'r', taskId: 't', subject: 'Acme', claim: 'Churn rose',
      criteria: {}, evidence: [], status: 'verified', createdAt: '',
    });
    const ok = await handle(ctx(t.product.id, { role: 'orchestrator' }), 'read_workspace', { workspace_id: t.company.id });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.data).toMatchObject({
      sourceWorkspaceId: t.company.id,
      profile: { revenue: '10M' },
      findings: [{ id: 'fnd_root', claim: 'Churn rose' }],
      workspace: { scope: { level: 'company', name: 'Acme' } },
    });
    const denied = await handle(ctx(t.product.id, { role: 'orchestrator' }), 'read_workspace', { workspace_id: t.other.id });
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/not in this business tree/) });
    const persona = await handle(ctx(t.product.id, { role: 'persona' }), 'read_workspace', { workspace_id: t.company.id });
    expect(persona.ok).toBe(false);
  });

  it('orchestrator context has scope, audiences, ancestors and siblings tagged by source', () => {
    const { store } = setup();
    const t = tree(store);
    store.profiles.insert({ workspaceId: t.company.id, data: { hq: 'Berlin' } });
    store.findings.insert({
      id: 'fnd_sib', workspaceId: t.sibling.id, runId: 'r', taskId: 't', subject: 'Lending', claim: 'Loan approvals slow',
      criteria: {}, evidence: [], status: 'verified', createdAt: '',
    });
    const p = orchestratorPrompt(store, defaultConfig, {
      id: 'rrun_x', workspaceId: t.division.id, phase: 'deep_dives', status: 'running', startedAt: '',
    }, 1);
    expect(p).toContain('division "Payments"');
    expect(p).toContain('Audiences: external');
    expect(p).toMatch(new RegExp(`Parent: \\[${t.company.id}\\] Acme`));
    expect(p).toContain('Berlin');
    expect(p).toMatch(new RegExp(`Sibling: \\[${t.sibling.id}\\] Lending`));
    expect(p).toContain('[fnd_sib]');
    expect(p).not.toContain('Globex');
  });
});

describe('mapping', () => {
  it('mapping is optional, first when present, with map_business_units', () => {
    expect(ALL_PHASES).not.toContain('mapping');
    expect(orderPhases(['market_research', 'mapping'])).toEqual(['mapping', 'market_research']);
    expect(PHASE_TASK_TYPES.mapping).toEqual(['map_business_units']);
  });

  it('acceptUnitProposal creates child with parent link', async () => {
    const { store, artifacts, handle } = setup();
    const { company } = tree(store);
    const art = artifacts.save({ workspaceId: company.id, kind: 'text', mime: 'text/plain', bytes: 'org chart' });
    const run = ctx(company.id);
    const r = await handle(run, 'propose_business_unit', {
      name: 'Platform team', description: 'Internal developer platform', level: 'slice', audiences: ['internal'],
      evidence: [art.id], reasoning: 'Org chart lists it',
    });
    if (!r.ok) throw new Error(r.error);
    const { proposalId } = r.data as { proposalId: string };
    const proposal = store.unitProposals.get(proposalId)!;
    expect(proposal).toMatchObject({ status: 'proposed', workspaceId: company.id, audiences: ['internal'] });
    const decision = store.decisions.get(proposal.decisionId!)!;
    expect(decision.payload).toMatchObject({ tool: 'propose_business_unit', proposalId });
    expect(decision.refs).toContain(art.id);

    const child = acceptUnitProposal(store, proposalId, { name: 'Dev Platform' });
    expect(child).toMatchObject({
      parentWorkspaceId: company.id, name: 'Dev Platform', sector: 'saas', audiences: ['internal'],
      scope: { level: 'slice', name: 'Dev Platform', description: 'Internal developer platform' },
    });
    expect(store.workspaces.get(child.id)).toEqual(child);
    expect(store.unitProposals.get(proposalId)).toMatchObject({ status: 'accepted', childWorkspaceId: child.id, name: 'Dev Platform' });
    expect(() => acceptUnitProposal(store, proposalId)).toThrow(/already accepted/);
    // The accepted child is a full node of the tree.
    expect(ancestors(store, child.id).map((w) => w.id)).toEqual([company.id]);
  });

  it('rejectUnitProposal records a negative rating on the proposal decision', async () => {
    const { store, handle } = setup();
    const { company } = tree(store);
    const r = await handle(ctx(company.id), 'propose_business_unit', {
      name: 'Imaginary unit', description: 'd', level: 'division', audiences: ['external'], reasoning: 'guess',
    });
    if (!r.ok) throw new Error(r.error);
    const { proposalId } = r.data as { proposalId: string };
    const { proposal, rating } = rejectUnitProposal(store, proposalId, 'does not exist');
    expect(proposal.status).toBe('rejected');
    expect(rating).toMatchObject({ targetType: 'decision', targetId: proposal.decisionId, verdict: 'disagree', reason: 'does not exist' });
    expect(store.ratings.list({ targetId: proposal.decisionId! })).toHaveLength(1);
  });

  it('propose_business_unit rejects evidence from another tree', async () => {
    const { store, artifacts, handle } = setup();
    const t = tree(store);
    const art = artifacts.save({ workspaceId: t.other.id, kind: 'text', mime: 'text/plain', bytes: 'x' });
    const r = await handle(ctx(t.company.id), 'propose_business_unit', {
      name: 'U', description: 'd', level: 'division', audiences: ['external'], evidence: [art.id], reasoning: 'r',
    });
    expect(r.ok).toBe(false);
    expect(store.unitProposals.list()).toHaveLength(0);
  });

  it('mapping phase runs map_business_units tasks that propose units', async () => {
    const s = researchSetup(opened, {
      extraHandlers: () => researchToolHandlers(),
      pick: (r) => {
        if (r.kind === 'orchestrate') {
          return r.round === 1
            ? async (t) => {
                await t.call('propose_tasks', {
                  tasks: [{ type: 'map_business_units', brief: 'map units', model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['units listed'] }],
                });
              }
            : async () => {};
        }
        if (r.kind === 'work') {
          return async (t) => {
            await t.call('propose_business_unit', { name: 'Payments', description: 'd', level: 'division', audiences: ['external'], reasoning: 'r' });
            await t.call('submit_result', { units: ['Payments'] });
          };
        }
        return review(9);
      },
    });
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    const rr = await startPhase(ws.id, 'mapping', s.deps);
    expect(rr.status).toBe('done');
    expect(s.store.unitProposals.list({ workspaceId: ws.id }).map((p) => p.name)).toEqual(['Payments']);
    expect(s.requests.find((r) => r.kind === 'orchestrate')!.prompt).toMatch(/Map the business units of the company "Acme"/);
  });
});

describe('roll-up', () => {
  it('rollup tags sourceWorkspaceId', () => {
    const { store } = setup();
    const t = tree(store);
    store.symptoms.insert(symptom(t.company.id, 'Margins shrinking'));
    store.symptoms.insert(symptom(t.product.id, 'API latency', 'symptom'));
    store.symptoms.insert(symptom(t.sibling.id, 'Fast approvals', 'strength'));
    store.symptoms.insert(symptom(t.other.id, 'Not ours'));
    store.recommendations.insert({
      id: 'rec_1', workspaceId: t.division.id, title: 'Cut latency', summary: 's', criteria: {}, findingIds: [],
      personaFeedback: [], priority: 1, createdAt: '',
    });
    store.findings.insert({
      id: 'fnd_p', workspaceId: t.product.id, runId: 'r', taskId: 't', subject: 's', claim: 'c', criteria: {}, evidence: [],
      status: 'verified', createdAt: '',
    });
    const r = rollup(store, t.company.id);
    expect(r.symptoms.map((s) => [s.title, s.sourceWorkspaceId]).sort()).toEqual(
      [['API latency', t.product.id], ['Fast approvals', t.sibling.id], ['Margins shrinking', t.company.id]].sort(),
    );
    expect(r.recommendations).toEqual([expect.objectContaining({ id: 'rec_1', sourceWorkspaceId: t.division.id })]);
    expect(r.findings).toEqual([expect.objectContaining({ id: 'fnd_p', sourceWorkspaceId: t.product.id })]);
    // A subtree rolls up only itself and its descendants.
    expect(rollup(store, t.division.id).symptoms.map((s) => s.title)).toEqual(['API latency']);
  });

  it('crossCuttingSymptoms flags symptom present in 2 children', () => {
    const { store } = setup();
    const t = tree(store);
    store.symptoms.insert(symptom(t.division.id, 'Hiring is too slow'));
    store.symptoms.insert(symptom(t.sibling.id, 'hiring slow!'));
    store.symptoms.insert(symptom(t.product.id, 'Hiring  slow'));
    store.symptoms.insert(symptom(t.division.id, 'Only in payments'));
    store.symptoms.insert(symptom(t.division.id, 'Only in payments')); // same child twice: not cross-cutting
    store.symptoms.insert(symptom(t.sibling.id, 'Hiring slow', 'strength')); // strengths are not symptoms
    expect(normalizeTitle('Hiring is too slow')).toBe('hiring slow');
    const groups = crossCuttingSymptoms(store, t.company.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('hiring slow');
    expect(groups[0]!.sourceWorkspaceIds.sort()).toEqual([t.division.id, t.sibling.id, t.product.id].sort());
    expect(groups[0]!.symptoms.every((s) => s.kind === 'symptom')).toBe(true);
  });
});

describe('scope and audiences', () => {
  it('old rows get default scope company and audiences external', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-scope-mig-'));
    const path = join(dir, 'bif.db');
    // A database at schema version 5 (before scope), with existing rows.
    const db = new DatabaseSync(path);
    for (let v = 0; v < 5; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 5');
    db.exec(`INSERT INTO workspaces (id, name, sector, created_at) VALUES ('ws_old', 'OldCo', 'saas', 'then')`);
    db.exec(`INSERT INTO personas (id, workspace_id, slug, segment, profile, agent_md_path, version)
             VALUES ('per_old', 'ws_old', 'olga', 'ops', '{}', 'p.md', 1)`);
    db.close();
    const store = openStore(path);
    opened.push(store);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.workspaces.get('ws_old')).toEqual({
      id: 'ws_old', name: 'OldCo', sector: 'saas', createdAt: 'then',
      scope: { level: 'company', name: 'OldCo', description: '' }, audiences: ['external'],
    });
    expect(store.personas.get('per_old')!.audience).toBe('external');
    // New rows inserted without the new fields get the same defaults.
    store.workspaces.insert({ id: 'ws_new', name: 'NewCo', sector: 's', createdAt: 'now' } as Workspace);
    expect(store.workspaces.get('ws_new')).toMatchObject({ scope: { level: 'company' }, audiences: ['external'] });
  });

  it('internal audience changes competitor_discovery goal text', () => {
    const { store } = setup();
    const ext = createWorkspace(store, { name: 'Acme', sector: 'saas' });
    const int = createWorkspace(store, {
      name: 'IT Helpdesk', sector: 'saas', scope: { level: 'slice', description: 'internal IT support' }, audiences: ['internal'],
    });
    const extGoal = phaseGoal('competitor_discovery', ext);
    const intGoal = phaseGoal('competitor_discovery', int);
    expect(extGoal).toMatch(/Discover the competitors of the company "Acme"/);
    expect(intGoal).toContain('alternatives: vendor tools, outsourcing, peer-company practices for this function');
    expect(intGoal).toContain('the slice "IT Helpdesk" (internal IT support)');
    expect(phaseGoal('market_research', int)).toMatch(/internal roles/);
    expect(phaseGoal('market_research', ext)).not.toMatch(/internal roles/);
    expect(phaseGoal('market_research', int)).toContain('internal users and employees');
  });

  it('persona audience persisted', () => {
    const { store } = setup();
    const persona: Persona = {
      id: newId('per'), workspaceId: 'ws_a', slug: 'it-ivan', segment: 'IT staff', profile: {}, agentMdPath: 'x.md',
      version: 1, audience: 'internal',
    };
    store.personas.insert(persona);
    expect(store.personas.get(persona.id)).toEqual(persona);
    store.personas.update(persona.id, { audience: 'external' });
    expect(store.personas.get(persona.id)!.audience).toBe('external');
  });
});
