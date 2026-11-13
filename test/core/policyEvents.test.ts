import { afterEach, describe, expect, it } from 'vitest';
import { resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import {
  listPolicyEvents,
  policyDenialsSection,
  recentPolicyDenials,
  recordPolicyEvent,
} from '../../src/core/policy/policyEvents.js';
import { orchestratorPrompt } from '../../src/core/research/orchestrator.js';
import { revisePrompt, workPrompt } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { attachEventRecorders, type EventRecorders } from '../../src/core/telemetry/recorders.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, tick } from './helpers/research.js';

const opened: Store[] = [];
const recorders: EventRecorders[] = [];
afterEach(async () => {
  for (const r of recorders.splice(0)) await r.stop();
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const s = researchSetup(opened);
  const rec = attachEventRecorders({ store: s.store, events: s.events, config: s.config });
  recorders.push(rec);
  const root = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(s.store, { name: 'Acme EU', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(s.store, { name: 'Globex', sector: 'saas' });
  return { ...s, root, child, other };
}

/** Starts a real (token-issued) run context so the recorder can resolve the requesting role. */
function runCtx(s: ReturnType<typeof setup>, workspaceId: string, extra: Partial<RunContext> = {}): RunContext {
  const ctx: RunContext = {
    agentRunId: newId('arun'), workspaceId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'v1', ...extra,
  };
  s.tokens.issue(ctx);
  return ctx;
}

async function askApproval(s: ReturnType<typeof setup>, ctx: RunContext, action: string) {
  const call = s.handle(ctx, 'request_approval', { action, site: 'vendor.com', details: 'they want a call' });
  await tick(10);
  const req = s.store.userRequests.list({ agentRunId: ctx.agentRunId }).at(-1)!;
  return { call, req };
}

describe('policy events', () => {
  it('records approval requested / granted / denied and role-scope blocks', async () => {
    const s = setup();
    const ctx = runCtx(s, s.root.id);
    const a = await askApproval(s, ctx, 'request a demo');
    resolveUserRequest(s, a.req.id, 'denied', 'no sales contact');
    await a.call;
    const b = await askApproval(s, ctx, 'contact support');
    resolveUserRequest(s, b.req.id, 'resolved');
    await b.call;
    // A worker calling an orchestrator-only tool is blocked by role scope.
    const blocked = await s.handle(ctx, 'propose_tasks', { tasks: [] });
    expect(blocked.ok).toBe(false);
    // A rejected input (validation error) is not a policy event.
    await s.handle(ctx, 'log_decision', {});

    const events = listPolicyEvents(s.store, { workspaceId: s.root.id });
    expect(events.map((e) => e.kind)).toEqual([
      'approval_requested', 'approval_denied', 'approval_requested', 'approval_granted', 'blocked',
    ]);
    expect(events[1]).toMatchObject({
      role: 'worker', action: 'request a demo', site: 'vendor.com', detail: 'no sales contact', requestId: a.req.id,
      agentRunId: ctx.agentRunId, rootWorkspaceId: s.root.id,
    });
    expect(events[4]).toMatchObject({ kind: 'blocked', action: 'propose_tasks', role: 'worker' });
    expect(events[4]!.detail).toMatch(/not available to role 'worker'/);
  });

  it('flags an approval request for a never-allowed action as blocked', async () => {
    const s = setup();
    const ctx = runCtx(s, s.root.id);
    const a = await askApproval(s, ctx, 'Complete a purchase of the pro plan');
    resolveUserRequest(s, a.req.id, 'denied');
    await a.call;
    const kinds = listPolicyEvents(s.store, { workspaceId: s.root.id }).map((e) => e.kind);
    expect(kinds).toEqual(['approval_requested', 'blocked', 'approval_denied']);
  });

  it('recent denials are per role and per business tree; prompts carry them, bounded', async () => {
    const s = setup();
    const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    for (let i = 0; i < 8; i++) {
      recordPolicyEvent(s.store, {
        workspaceId: s.child.id, role: 'worker', kind: 'approval_denied', action: `ACTION_${i} ${'x'.repeat(400)}`,
        site: 'vendor.com', createdAt: at(i),
      });
    }
    recordPolicyEvent(s.store, { workspaceId: s.root.id, role: 'orchestrator', kind: 'blocked', action: 'ORCH_ONLY', createdAt: at(9) });
    recordPolicyEvent(s.store, { workspaceId: s.other.id, role: 'worker', kind: 'approval_denied', action: 'OTHER_TREE', createdAt: at(10) });
    recordPolicyEvent(s.store, { workspaceId: s.root.id, role: 'worker', kind: 'approval_granted', action: 'GRANTED', createdAt: at(11) });

    // Tree-scoped: a denial in the EU child counts for the root's workers, never for Globex.
    const denials = recentPolicyDenials(s.store, { workspaceId: s.root.id, role: 'worker' });
    expect(denials).toHaveLength(5);
    expect(denials[0]!.action).toMatch(/^ACTION_7/);
    expect(recentPolicyDenials(s.store, { workspaceId: s.other.id, role: 'worker' }).map((d) => d.action)).toEqual(['OTHER_TREE']);
    expect(listPolicyEvents(s.store, { workspaceId: s.child.id, scope: 'workspace' })).toHaveLength(8);
    expect(listPolicyEvents(s.store, { workspaceId: s.child.id })).toHaveLength(10);

    const section = policyDenialsSection(s.store, s.root.id, 'worker');
    expect(section).toContain('ACTION_7');
    expect(section).not.toContain('ACTION_2');
    expect(section).not.toContain('ORCH_ONLY');
    expect(section).not.toContain('OTHER_TREE');
    expect(section).not.toContain('GRANTED');
    expect(section.length).toBeLessThan(1500);
    expect(policyDenialsSection(s.store, s.other.id, 'orchestrator')).toBe('');

    // Fed into the requesting role's task prompts (worker) and the orchestrator's prompt.
    const task = addTask(s.store, { workspaceId: s.child.id });
    expect(workPrompt(s.deps, task)).toContain('ACTION_7');
    expect(revisePrompt(task, [], s.deps)).toContain('ACTION_7');
    expect(workPrompt(s.deps, task)).not.toContain('ORCH_ONLY');
    const rr = { id: 'rrun_x', workspaceId: s.root.id, phase: 'deep_dives' as const, status: 'running' as const, startedAt: at(0) };
    expect(orchestratorPrompt(s.store, s.config, rr, 1)).toContain('ORCH_ONLY');
    // No denials → no section at all.
    const clean = addTask(s.store, { workspaceId: s.other.id });
    expect(workPrompt(s.deps, { ...clean, workspaceId: 'ws_none' })).not.toMatch(/policy denials/i);
  });
});
