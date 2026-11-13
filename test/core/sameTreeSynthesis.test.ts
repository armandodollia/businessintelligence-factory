import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { synthesisFindingsSection } from '../../src/core/evidence/synthesis.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { scoringToolHandlers } from '../../src/core/scoring/priority.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Finding } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-tree-synth-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({
    store, artifacts, config: defaultConfig, events: new EventBus(),
    extraHandlers: { ...researchToolHandlers(), ...scoringToolHandlers() },
  });
  const company = createWorkspace(store, { name: 'Acme', sector: 'saas' });
  const division = createWorkspace(store, { name: 'Payments', sector: 'saas', parentWorkspaceId: company.id });
  const sibling = createWorkspace(store, { name: 'Lending', sector: 'saas', parentWorkspaceId: company.id });
  const other = createWorkspace(store, { name: 'Globex', sector: 'retail' });
  const art = artifacts.save({ workspaceId: company.id, kind: 'text', mime: 'text/plain', bytes: 'annual report' });
  const finding = (id: string, workspaceId: string, status: Finding['status'], claim: string): Finding =>
    store.findings.insert({
      id, workspaceId, runId: 'r', taskId: `tsk_${id}`, subject: 'Acme', claim, criteria: {}, evidence: [art.id], status, createdAt: 'now',
    });
  finding('fnd_parent', company.id, 'verified', 'PARENT_CLAIM churn is up');
  finding('fnd_sibling', sibling.id, 'verified', 'SIBLING_CLAIM loans grow');
  finding('fnd_unverified', company.id, 'unverified', 'UNVERIFIED_CLAIM');
  finding('fnd_other', other.id, 'verified', 'OTHER_TREE_CLAIM');
  return { store, handle, company, division, sibling, other, art };
}

const ctx = (workspaceId: string, extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId, role: 'synthesizer', model: { provider: 'claude', model: 'opus' }, promptVersion: 'pv', ...extra,
});

const recInput = (finding_ids: string[]) => ({ title: 'Bundle payments and lending', summary: 's', criteria: { upside: 4 }, finding_ids });

describe('same-tree synthesis', () => {
  it('synthesis findings list covers eligible findings of the whole tree, tagged by source node', () => {
    const t = setup();
    const section = synthesisFindingsSection(t.store, t.division.id);
    expect(section).toContain(`[fnd_parent] Acme: PARENT_CLAIM churn is up (source ${t.company.id})`);
    expect(section).toContain(`[fnd_sibling] Acme: SIBLING_CLAIM loans grow (source ${t.sibling.id})`);
    expect(section).not.toContain('UNVERIFIED_CLAIM');
    expect(section).not.toContain('OTHER_TREE_CLAIM');
  });

  it('save_recommendation accepts eligible same-tree findings and rejects other trees / unverified', async () => {
    const t = setup();
    const ok = await t.handle(ctx(t.division.id), 'save_recommendation', recInput(['fnd_parent', 'fnd_sibling']));
    expect(ok.ok).toBe(true);
    const otherTree = await t.handle(ctx(t.division.id), 'save_recommendation', { ...recInput(['fnd_other']), title: 'x' });
    expect(otherTree).toMatchObject({ ok: false, error: expect.stringMatching(/not in this business tree\): fnd_other/) });
    const unverified = await t.handle(ctx(t.division.id), 'save_recommendation', { ...recInput(['fnd_unverified']), title: 'y' });
    expect(unverified).toMatchObject({ ok: false, error: expect.stringMatching(/not verified.*fnd_unverified/) });
  });

  it('read_workspace returns findings with their evidence ids', async () => {
    const t = setup();
    const r = await t.handle(ctx(t.division.id, { role: 'orchestrator' }), 'read_workspace', { workspace_id: t.company.id });
    if (!r.ok) throw new Error(r.error);
    expect((r.data as { findings: unknown[] }).findings).toContainEqual(
      expect.objectContaining({ id: 'fnd_parent', evidence: [t.art.id] }),
    );
  });
});
