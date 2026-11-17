import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { mountMcp } from '../../src/api/mcp.js';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../src/core/store/repos.js';
import { createToolHandlers, getRunOutputs, resolveUserRequest, type ToolHandlerDeps } from '../../src/core/harness/tools/handlers.js';
import { ROLE_TOOLS, TOOL_NAMES } from '../../src/core/harness/tools/registry.js';
import { TokenRegistry, type RunContext } from '../../src/core/harness/tokens.js';
import { tagRun } from '../../src/core/learning/runTags.js';
import type { Task } from '../../src/core/types.js';
import { PRIVATE_TASK_TOOLS } from '../../src/core/research/phases.js';
import { STAKEHOLDER_FIELDS } from '../../src/core/scoring/criteria.js';
import { stakeholderToolHandlers } from '../../src/core/stakeholders/personas.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(extra: Partial<ToolHandlerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-tools-'));
  const dbPath = join(dir, 'bif.db');
  const store = openStore(dbPath);
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const deps: ToolHandlerDeps = { store, artifacts, config: defaultConfig, events, ...extra };
  const handle = createToolHandlers(deps);
  return { dir, dbPath, store, artifacts, events, seen, deps, handle };
}

function ctx(role: RunContext['role'], extra: Partial<RunContext> = {}): RunContext {
  return {
    agentRunId: newId('arun'),
    workspaceId: 'ws_a',
    role,
    model: { provider: 'claude', model: 'sonnet' },
    promptVersion: 'pv_1234',
    ...extra,
  };
}

function addTask(store: Store, workspaceId = 'ws_a'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId, runId: 'run_1', phase: 'deep_dives', type: 'flow_walkthrough',
    brief: 'Walk signup', model: { provider: 'claude', model: 'sonnet' }, needsBrowser: true,
    acceptanceCriteria: ['screenshots per step'], status: 'running', round: 1, createdAt: new Date().toISOString(),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('role scope table', () => {
  it('matches the brief', () => {
    const base = ['log_decision', 'save_artifact', 'request_user_action', 'request_approval'];
    // Reviewers judge only the deliverable and its evidence: no read_workspace (final review A4).
    // KS-4: expand joins read_artifact, both limited to the task's review slice by the dispatcher.
    // Flow records: reviewers may read the flow catalog (the questions behind check answers).
    expect(new Set(ROLE_TOOLS.reviewer)).toEqual(new Set(['log_decision', 'submit_review', 'read_artifact', 'expand', 'read_flow_catalog']));
    expect(new Set(ROLE_TOOLS.persona)).toEqual(
      new Set(['log_decision', 'submit_persona_feedback', 'submit_flow_verdicts', 'submit_stakeholder_read']), // + stakeholder reads
    );
    // KS-1: describe_artifact for worker, orchestrator, interviewer, synthesizer.
    expect(new Set(ROLE_TOOLS.interviewer)).toEqual(
      new Set(['log_decision', 'update_profile', 'save_symptom', 'read_workspace', 'read_artifact', 'describe_artifact',
        'search', 'get_card', 'expand', // KS-4
        'note_stakeholder']), // stakeholder personas
    );
    expect(new Set(ROLE_TOOLS.worker)).toEqual(
      new Set([
        ...base, 'save_finding', 'submit_result', 'respond_to_review', 'get_identity', 'save_persona',
        'read_workspace', 'propose_business_unit', 'read_artifact', 'save_competitor', 'save_hypothesis', 'describe_artifact',
        'confirm_finding', 'retract_finding', // knowledge store KS-2
        'search', 'get_card', 'expand', 'list_changes', // KS-4
        'read_flow_catalog', 'save_flow', 'save_flow_checks', 'save_review_mentions', 'propose_flow_type', 'propose_checklist', // flow records
        'save_stakeholder', // stakeholder personas
      ]),
    );
    expect(new Set(ROLE_TOOLS.orchestrator)).toEqual(
      new Set([...base, 'propose_tasks', 'read_workspace', 'read_artifact', 'describe_artifact', 'search', 'get_card', 'expand', 'list_changes']),
    );
    expect(new Set(ROLE_TOOLS.synthesizer)).toEqual(
      new Set([
        ...base, 'save_recommendation', 'save_finding', 'submit_result', 'respond_to_review', 'read_workspace', 'read_artifact',
        'describe_artifact', 'search', 'get_card', 'expand', 'list_changes', // KS-4
      ]),
    );
    for (const tools of Object.values(ROLE_TOOLS)) for (const t of tools) expect(TOOL_NAMES).toContain(t);
  });
});

describe('tool handlers', () => {
  it('save_finding rejects empty evidence', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const r = await handle(ctx('worker', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: { impact: 5 }, evidence: [],
    });
    expect(r.ok).toBe(false);
    expect(store.findings.list()).toHaveLength(0);
  });

  it('save_finding rejects artifact from other workspace', async () => {
    const { store, artifacts, handle } = setup();
    const task = addTask(store);
    const foreign = artifacts.save({ workspaceId: 'ws_b', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const r = await handle(ctx('worker', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: {}, evidence: [foreign.id],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(foreign.id);
    expect(store.findings.list()).toHaveLength(0);
    expect(store.decisions.list()).toHaveLength(0);
  });

  it('save_finding stores finding and a score decision', async () => {
    const { store, artifacts, handle } = setup();
    const task = addTask(store);
    const a = artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'pricing page' });
    const c = ctx('worker', { taskId: task.id });
    const r = await handle(c, 'save_finding', {
      claim: 'Acme hides pricing', subject: 'Acme', criteria: { impact: 7, confidence: 'high' }, evidence: [a.id],
    });
    expect(r.ok).toBe(true);
    const [f] = store.findings.list();
    expect(f).toMatchObject({ workspaceId: 'ws_a', runId: 'run_1', taskId: task.id, status: 'pending', evidence: [a.id] });
    const [d] = store.decisions.list();
    expect(d).toMatchObject({ kind: 'score', agentRunId: c.agentRunId, refs: [f!.id, a.id] });
  });

  it('rejects tool not in role scope', async () => {
    const { store, artifacts, handle, seen } = setup();
    const task = addTask(store);
    const a = artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const r = await handle(ctx('reviewer', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: {}, evidence: [a.id],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not available to role 'reviewer'/);
    expect(store.findings.list()).toHaveLength(0);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'save_finding', ok: false }));
    const unknown = await handle(ctx('worker'), 'no_such_tool' as never, {});
    expect(unknown.ok).toBe(false);
  });

  it('log_decision writes Decision with promptVersion', async () => {
    const { store, handle } = setup();
    const c = ctx('orchestrator');
    const r = await handle(c, 'log_decision', {
      what: 'Focus on pricing', why: 'interview says churn at checkout', alternatives: ['onboarding'],
      signals_positive: ['a'], signals_negative: [], confidence: 0.7,
    });
    expect(r.ok).toBe(true);
    const [d] = store.decisions.list({ agentRunId: c.agentRunId });
    expect(d).toMatchObject({
      kind: 'decision', role: 'orchestrator', promptVersion: 'pv_1234', model: c.model, workspaceId: 'ws_a',
      payload: expect.objectContaining({ tool: 'log_decision', what: 'Focus on pricing', confidence: 0.7 }),
    });
    const bad = await handle(c, 'log_decision', { what: 'x', why: 'y', confidence: 3 });
    expect(bad.ok).toBe(false);
    expect(store.decisions.list()).toHaveLength(1);
  });

  it('request_approval blocks until resolveUserRequest(approved)', async () => {
    const { store, events, handle, deps } = setup();
    const task = addTask(store);
    const c = ctx('worker', { taskId: task.id });
    let settled = false;
    const p = handle(c, 'request_approval', { action: 'request a demo', site: 'acme.test', details: 'demo form' }).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false);
    const [req] = store.userRequests.list({ status: 'pending' });
    expect(req).toMatchObject({ kind: 'approval', site: 'acme.test', taskId: task.id, agentRunId: c.agentRunId });
    expect(req!.details).toContain('request a demo');
    expect(store.tasks.get(task.id)!.status).toBe('waiting_user');
    resolveUserRequest({ store, events }, req!.id, 'resolved', 'go ahead');
    const r = await p;
    expect(r).toEqual({ ok: true, data: { requestId: req!.id, status: 'resolved', approved: true, response: 'go ahead' } });
    expect(store.userRequests.get(req!.id)!.status).toBe('resolved');
    expect(store.tasks.get(task.id)!.status).toBe('running');
    void deps;
  });

  it('request_user_action returns denied and stops waiting on abort', async () => {
    const { store, events, handle } = setup();
    const c = ctx('worker');
    const p = handle(c, 'request_user_action', { kind: 'register', site: 'acme.test', instructions: 'needs phone' });
    await tick();
    const [req] = store.userRequests.list();
    expect(req).toMatchObject({ kind: 'register', details: 'needs phone' });
    expect('taskId' in req!).toBe(false); // no task → taskId absent, not ''
    resolveUserRequest({ store, events }, req!.id, 'denied');
    expect(await p).toMatchObject({ ok: true, data: { status: 'denied', approved: false } });

    const ac = new AbortController();
    const p2 = handle(c, 'request_user_action', { kind: 'captcha', site: 's', instructions: 'i' }, { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await p2).toMatchObject({ ok: false });
    expect(store.userRequests.list({ status: 'pending' })).toHaveLength(1); // stays pending for resume
    expect(() => resolveUserRequest({ store, events }, 'nope', 'resolved')).toThrow();
  });

  it('submit_review stores the optional council fields (action, where, questions, follow_ups) in the Decision payload', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const reviewer = ctx('reviewer', { taskId: task.id, model: { provider: 'codex', model: 'gpt-6.1-sol' } });
    const sent = {
      score: 6,
      issues: [
        { class: 'substantive', description: 'restates its source', action: 'delete', where: ['fnd_1'] },
        { class: 'blocking', description: 'redo it from the filings', action: 'rewrite', where: ['fnd_1', 'fnd_2'] },
        { class: 'nit', description: 'typo' },
      ],
      summary: 's',
      questions: ['Is the 2024 figure audited?'],
      follow_ups: ['The pricing page of the second competitor is out of date'],
    };
    const rev = await handle(reviewer, 'submit_review', sent);
    const issues = [
      { id: 'I1', class: 'substantive', description: 'restates its source', action: 'delete', where: ['fnd_1'] },
      { id: 'I2', class: 'blocking', description: 'redo it from the filings', action: 'rewrite', where: ['fnd_1', 'fnd_2'] },
      { id: 'I3', class: 'nit', description: 'typo' },
    ];
    expect(rev).toMatchObject({ ok: true, data: { score: 6, issues } });
    expect(store.decisions.list({ agentRunId: reviewer.agentRunId })[0]!.payload).toEqual({
      tool: 'submit_review', score: 6, issues, summary: 's',
      questions: ['Is the 2024 figure audited?'],
      followUps: ['The pricing page of the second competitor is out of date'],
    });
    // Unknown actions and empty texts are refused; a review without the new fields stores none of them.
    expect((await handle(reviewer, 'submit_review', { score: 6, issues: [{ class: 'nit', description: 'x', action: 'drop' }] })).ok).toBe(false);
    expect((await handle(reviewer, 'submit_review', { score: 6, issues: [], questions: [''] })).ok).toBe(false);
    const plain = ctx('reviewer', { taskId: task.id });
    await handle(plain, 'submit_review', { score: 9, issues: [{ class: 'nit', description: 'typo' }] });
    expect(store.decisions.list({ agentRunId: plain.agentRunId })[0]!.payload).toEqual({
      tool: 'submit_review', score: 9, issues: [{ id: 'I1', class: 'nit', description: 'typo' }],
    });
  });

  /** A reviewer run that is a council member's: its row is tagged with the round and the member's name. */
  const memberRun = (store: Store, taskId: string): RunContext => {
    const c = ctx('reviewer', { taskId });
    new TokenRegistry(store).issue(c);
    tagRun(store, c.agentRunId, { councilRoundId: `cnl:${taskId}:r_1`, councilMember: 'a' });
    return c;
  };

  it('submit_review accepts `score: null` from a council member run, and only when `summary` says why (review council design §5.5)', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const member = memberRun(store, task.id);
    for (const bad of [{ score: null, issues: [] }, { score: null, issues: [], summary: '   ' }, { issues: [], summary: 'no score at all' }]) {
      const res = await handle(member, 'submit_review', bad);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(store.decisions.list({ agentRunId: member.agentRunId })).toEqual([]);
    const res = await handle(member, 'submit_review', { score: null, issues: [], summary: 'The evidence copies could not be opened' });
    expect(res).toMatchObject({ ok: true, data: { score: null, issues: [] } });
    expect(store.decisions.list({ agentRunId: member.agentRunId })[0]!.payload).toEqual({
      tool: 'submit_review', score: null, issues: [], summary: 'The evidence copies could not be opened',
    });
    expect(getRunOutputs(store, member.agentRunId).review).toEqual({ score: null, issues: [], summary: 'The evidence copies could not be opened' });
  });

  it('submit_review refuses `score: null` from any other run, with the error a score that is no number always gave, and the run can send a number', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    // The single reviewer, and a reviewer run with a row of its own that is no member's (an audit).
    const single = ctx('reviewer', { taskId: task.id });
    const audit = ctx('reviewer', { taskId: task.id });
    new TokenRegistry(store).issue(audit);
    for (const run of [single, audit]) {
      const res = await handle(run, 'submit_review', { score: null, issues: [], summary: 'The evidence copies could not be opened' });
      expect(res).toEqual({ ok: false, error: 'invalid input for submit_review: score: Invalid input: expected number, received null' });
      expect(store.decisions.list({ agentRunId: run.agentRunId })).toEqual([]);
      // The same kind of error as a missing score.
      const missing = await handle(run, 'submit_review', { issues: [], summary: 'no score at all' });
      expect(missing).toEqual({ ok: false, error: 'invalid input for submit_review: score: Invalid input: expected number, received undefined' });
    }
    expect((await handle(single, 'submit_review', { score: 4, issues: [], summary: 'The evidence copies could not be opened' })).ok).toBe(true);
    expect(getRunOutputs(store, single.agentRunId).review).toMatchObject({ score: 4 });
    // The optional council fields stay accepted from everyone.
    const fields = await handle(audit, 'submit_review', { score: 7, issues: [{ class: 'substantive', description: 'x', action: 'delete', where: ['fnd_1'] }], questions: ['q'], follow_ups: ['f'] });
    expect(fields.ok).toBe(true);
  });

  it('submit_review refuses `score: null` from a run that is no council member\'s with the missing-score error in every case, also with no summary (council review C7)', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const single = ctx('reviewer', { taskId: task.id });
    const refusal = { ok: false, error: 'invalid input for submit_review: score: Invalid input: expected number, received null' };
    // No summary, a blank one, and no issues list: never the advice to explain in `summary`, which only a member can follow.
    for (const sent of [{ score: null, issues: [] }, { score: null, issues: [], summary: '   ' }, { score: null }, { score: null, questions: ['Is this audited?'] }]) {
      expect(await handle(single, 'submit_review', sent), JSON.stringify(sent)).toEqual(refusal);
    }
    expect(store.decisions.list({ agentRunId: single.agentRunId })).toEqual([]);
    // A council member is still told what to add.
    const member = memberRun(store, task.id);
    expect(await handle(member, 'submit_review', { score: null, issues: [] })).toEqual({
      ok: false, error: 'invalid input for submit_review: summary: score is null: say in summary why you cannot score',
    });
    // Anything else that is wrong with the input is reported as it is, to everyone.
    expect(await handle(single, 'submit_review', { score: null, issues: [{ class: 'huge', description: 'x' }] })).toMatchObject({ ok: false, error: expect.stringContaining('issues') });
  });

  it('submit_result / submit_review / respond_to_review persist and read back via getRunOutputs', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const worker = ctx('worker', { taskId: task.id });
    expect((await handle(worker, 'submit_result', { summary: 'done', steps: [1, 2] })).ok).toBe(true);
    expect(store.tasks.get(task.id)!.result).toEqual({ summary: 'done', steps: [1, 2] });

    const reviewer = ctx('reviewer', { taskId: task.id, model: { provider: 'codex', model: 'gpt-6.1-sol' } });
    expect((await handle(reviewer, 'submit_review', { score: 11, issues: [] })).ok).toBe(false);
    const rev = await handle(reviewer, 'submit_review', {
      score: 6,
      issues: [
        { class: 'blocking', description: 'missing step 3 screenshot' },
        { id: 'custom', class: 'nit', description: 'typo' },
      ],
    });
    expect(rev.ok).toBe(true);
    const out = getRunOutputs(store, reviewer.agentRunId);
    expect(out.review).toEqual({
      score: 6,
      issues: [
        { id: 'I1', class: 'blocking', description: 'missing step 3 screenshot' },
        { id: 'custom', class: 'nit', description: 'typo' },
      ],
    });
    expect(store.decisions.list({ agentRunId: reviewer.agentRunId })[0]!.kind).toBe('review');

    const revise = ctx('worker', { taskId: task.id });
    await handle(revise, 'respond_to_review', { issue_id: 'I1', action: 'fix', reason: 'added' });
    await handle(revise, 'respond_to_review', { issue_id: 'custom', action: 'pushback', reason: 'nit' });
    await handle(revise, 'submit_result', { summary: 'v2' });
    const o2 = getRunOutputs(store, revise.agentRunId);
    expect(o2.result).toEqual({ summary: 'v2' });
    expect(o2.review).toBeUndefined();
    expect(o2.responses).toEqual([
      { issueId: 'I1', action: 'fix', reason: 'added' },
      { issueId: 'custom', action: 'pushback', reason: 'nit' },
    ]);
    expect(store.decisions.list({ agentRunId: revise.agentRunId }).map((d) => d.kind)).toEqual([
      'decision', 'pushback', 'decision',
    ]);
    expect(getRunOutputs(store, worker.agentRunId).result).toEqual({ summary: 'done', steps: [1, 2] });
    expect(getRunOutputs(store, 'arun_none')).toEqual({ responses: [] });
  });

  it('save_artifact + read_artifact roundtrip, scoped to workspace', async () => {
    const { artifacts, handle } = setup();
    const c = ctx('worker');
    const r = await handle(c, 'save_artifact', {
      kind: 'text', content: 'Pricing: $49/mo', mime: 'text/plain', source_url: 'https://acme.test/pricing', flow: 'pricing', step: 1,
    });
    expect(r.ok).toBe(true);
    const id = (r as { data: { artifactId: string } }).data.artifactId;
    expect(artifacts.read(id).artifact).toMatchObject({ workspaceId: 'ws_a', sourceUrl: 'https://acme.test/pricing', step: 1 });
    const png = await handle(c, 'save_artifact', {
      kind: 'screenshot', content_base64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png',
      description: 'Pricing page with the Pro plan at 49 dollars', // KS-1 caption rule
    });
    expect(png.ok).toBe(true);
    expect((await handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain' })).ok).toBe(false);

    // KS-4: read_artifact serves the extracted text fenced (mode text) — never raw unfenced bytes.
    const read = await handle(c, 'read_artifact', { artifact_id: id, mode: 'text' });
    expect(read).toMatchObject({ ok: true, data: { id, mode: 'text', content_trust: 'untrusted', items: [{ type: 'meta' }, { type: 'chunk', text: `<<<EVIDENCE ${id}\nPricing: $49/mo\n>>>` }] } });
    const img = await handle(c, 'read_artifact', { artifact_id: (png as { data: { artifactId: string } }).data.artifactId });
    expect(img).toMatchObject({ ok: true, images: [{ mimeType: 'image/png' }], data: { mode: 'image', items: [{ type: 'meta' }, { type: 'description', text: expect.stringContaining('Pro plan') }] } });
    const other = await handle(ctx('worker', { workspaceId: 'ws_b' }), 'read_artifact', { artifact_id: id });
    expect(other.ok).toBe(false);
    // A reviewer reads only its task's review slice: without a task, nothing (same "not found").
    expect(await handle(ctx('reviewer'), 'read_artifact', { artifact_id: id })).toEqual({ ok: false, error: `artifact '${id}' not found` });
    // Every role that reads evidence gets read_artifact, still scoped to the business tree.
    for (const role of ['worker', 'orchestrator', 'synthesizer', 'interviewer'] as const) {
      expect((await handle(ctx(role), 'read_artifact', { artifact_id: id })).ok).toBe(true);
      expect((await handle(ctx(role, { workspaceId: 'ws_b' }), 'read_artifact', { artifact_id: id })).ok).toBe(false);
    }
    const rw = await handle(ctx('reviewer'), 'read_workspace', { workspace_id: 'ws_a' });
    expect(rw).toMatchObject({ ok: false, error: expect.stringMatching(/not available to role 'reviewer'/) });
  });

  it('save_artifact file_path: only files inside the run cwd or the OS temp dir', async () => {
    const { dir, handle } = setup();
    const c = ctx('worker');
    const cwd = join(dir, c.workspaceId, 'runs', c.agentRunId, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    const inCwd = await handle(c, 'save_artifact', {
      kind: 'screenshot', mime: 'image/png', file_path: join(cwd, 'shot.png'), description: 'Signup form, step one of three',
    });
    expect(inCwd.ok).toBe(true);
    const tmpFile = join(mkdtempSync(join(tmpdir(), 'bif-shot-')), 'a.txt');
    writeFileSync(tmpFile, 'from tmp');
    expect((await handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', file_path: tmpFile })).ok).toBe(true);

    // Outside both roots: another run's cwd, the data dir itself, a home-dir secret.
    const otherRun = join(dir, c.workspaceId, 'runs', 'arun_other', 'cwd');
    mkdirSync(otherRun, { recursive: true });
    writeFileSync(join(otherRun, 'x.txt'), 'other');
    const outside = [join(otherRun, 'x.txt'), join(dir, 'bif.db'), join(homedir(), '.ssh', 'id_rsa'), '/etc/passwd'];
    for (const file_path of outside) {
      const r = await handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', file_path });
      // This dataDir lives under the OS temp dir: the rest of the data dir is still off limits.
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/file_path must be inside/) });
    }
    // A symlink inside the cwd pointing outside is resolved and refused. Windows: file symlinks need
    // administrator rights or developer mode, so a directory junction (no rights needed) to another
    // run's cwd is the link; it must be resolved and refused the same way.
    if (process.platform === 'win32') symlinkSync(otherRun, join(cwd, 'linkdir'), 'junction');
    else symlinkSync('/etc/passwd', join(cwd, 'link.txt'));
    const linked = process.platform === 'win32' ? join(cwd, 'linkdir', 'x.txt') : join(cwd, 'link.txt');
    const link = await handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain', file_path: linked });
    expect(link).toMatchObject({ ok: false, error: expect.stringMatching(/file_path must be inside/) });
  });

  it('extra handlers: absent → not available; present → validated input + decision for judgments', async () => {
    const calls: unknown[] = [];
    const { store, handle } = setup({
      extraHandlers: {
        propose_tasks: async (_ctx, input) => {
          calls.push(input);
          return { ok: true, data: { accepted: 1, rejected: [] } };
        },
      },
    });
    const orch = ctx('orchestrator');
    const bad = await handle(orch, 'propose_tasks', { tasks: [{ type: 'nope' }] });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const task = {
      type: 'news_scan', brief: 'scan news', model: { provider: 'claude', model: 'sonnet' },
      needs_browser: false, acceptance_criteria: ['3 sources'],
    };
    const ok = await handle(orch, 'propose_tasks', { tasks: [task] });
    expect(ok).toEqual({ ok: true, data: { accepted: 1, rejected: [] } });
    expect(calls).toEqual([{ tasks: [task] }]);
    expect(store.decisions.list({ agentRunId: orch.agentRunId })[0]).toMatchObject({
      kind: 'task_proposal', payload: { tool: 'propose_tasks', input: { tasks: [task] }, result: { accepted: 1, rejected: [] } },
    });
    const missing = await handle(ctx('worker'), 'get_identity', { site: 'acme.test' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/not available/);
  });
});

describe('replayed user requests', () => {
  it('same run + same (kind, site, details) reuses the pending request', async () => {
    const s = setup();
    const task = addTask(s.store);
    const c = ctx('worker', { taskId: task.id });
    const input = { action: 'request a demo', site: 'acme.com', details: 'pricing hidden' };
    const first = s.handle(c, 'request_approval', input);
    await tick();
    const replay = s.handle(c, 'request_approval', input);
    const other = s.handle(c, 'request_approval', { ...input, details: 'something else' });
    await tick();
    const pending = s.store.userRequests.list({ status: 'pending' });
    expect(pending).toHaveLength(2);
    expect(s.seen.filter((e) => e.type === 'user_request')).toHaveLength(2);
    const target = pending.find((r) => r.details.endsWith('pricing hidden'))!;
    resolveUserRequest({ store: s.store, events: s.events }, target.id, 'resolved', 'ok');
    const [a, b] = await Promise.all([first, replay]);
    expect(a).toMatchObject({ ok: true, data: { requestId: target.id, approved: true } });
    expect(b).toMatchObject({ ok: true, data: { requestId: target.id, approved: true, reused: true } });
    resolveUserRequest({ store: s.store, events: s.events }, pending.find((r) => r.id !== target.id)!.id, 'denied');
    expect(await other).toMatchObject({ ok: true, data: { approved: false } });
    // Another run asking the same thing gets its own request.
    const fresh = s.handle(ctx('worker', { taskId: task.id }), 'request_approval', input);
    await tick();
    expect(s.store.userRequests.list({ status: 'pending' })).toHaveLength(1);
    resolveUserRequest({ store: s.store, events: s.events }, s.store.userRequests.list({ status: 'pending' })[0]!.id, 'resolved');
    await fresh;
  });
});

describe('post-cap replays', () => {
  it('save_finding replay updates judgments: reliability 5 -> 1 persists 1', async () => {
    const s = setup();
    const task = addTask(s.store);
    const c = ctx('worker', { taskId: task.id });
    const a = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'one' });
    const b = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'two' });
    const first = await s.handle(c, 'save_finding', { claim: 'Rival cut prices', subject: 'Rival', criteria: { relevance: 4, reliability: 5, novelty: 3 }, evidence: [a.id] });
    const again = await s.handle(c, 'save_finding', { claim: 'Rival cut prices', subject: 'Rival Inc', criteria: { relevance: 4, reliability: 1, novelty: 3 }, evidence: [b.id] });
    if (!first.ok || !again.ok) throw new Error('save_finding failed');
    const id = (first.data as { findingId: string }).findingId;
    expect(again.data).toMatchObject({ findingId: id, duplicate: true, updated: true });
    expect(s.store.findings.list()).toHaveLength(1);
    expect(s.store.findings.get(id)).toMatchObject({ subject: 'Rival Inc', criteria: { reliability: 1 }, evidence: [a.id, b.id] });
    const scores = s.store.decisions.list({ kind: 'score' });
    expect(scores).toHaveLength(2);
    expect(scores[1]!.payload).toMatchObject({ revision: true, criteria: { reliability: 1 }, previous: { criteria: { reliability: 5 } } });
    // An exact replay changes nothing and logs nothing.
    await s.handle(c, 'save_finding', { claim: 'Rival cut prices', subject: 'Rival Inc', criteria: { relevance: 4, reliability: 1, novelty: 3 }, evidence: [b.id] });
    expect(s.store.decisions.list({ kind: 'score' })).toHaveLength(2);
  });

  for (const outcome of ['resolved', 'denied'] as const) {
    it(`replayed request already ${outcome} returns the stored answer at once`, async () => {
      const s = setup();
      const task = addTask(s.store);
      const c = ctx('worker', { taskId: task.id });
      const input = { kind: 'register', site: 'acme.com', instructions: 'Please register' };
      const first = s.handle(c, 'request_user_action', input);
      await tick();
      const [req] = s.store.userRequests.list();
      resolveUserRequest({ store: s.store, events: s.events }, req!.id, outcome, 'done as bob');
      await first;
      const replay = await s.handle(c, 'request_user_action', input);
      expect(replay).toMatchObject({
        ok: true,
        data: { requestId: req!.id, status: outcome, approved: outcome === 'resolved', response: 'done as bob', reused: true },
      });
      expect(s.store.userRequests.list()).toHaveLength(1);
      expect(s.store.userRequests.list({ status: 'pending' })).toHaveLength(0);
      expect(s.seen.filter((e) => e.type === 'user_request')).toHaveLength(1);
    });
  }
});

describe('tokens', () => {
  it('rejects unknown token; resolves after store reopen; revoke', () => {
    const { store, dbPath } = setup();
    const tokens = new TokenRegistry(store);
    expect(tokens.resolve('nope')).toBeNull();
    const c = ctx('worker', { taskId: 'tsk_1' });
    const token = tokens.issue(c);
    expect(tokens.resolve(token)).toEqual(c);
    const row = store.agentRuns.get(c.agentRunId)!;
    expect(row).toMatchObject({ token, status: 'running', role: 'worker', promptVersion: 'pv_1234' });
    store.close();

    const store2 = openStore(dbPath);
    opened.push(store2);
    const tokens2 = new TokenRegistry(store2);
    expect(tokens2.resolve(token)).toEqual(c);
    tokens2.revoke(token);
    expect(tokens2.resolve(token)).toBeNull();
    // revocation persists: a fresh registry on a reopened store still rejects it while running
    store2.close();
    const store3 = openStore(dbPath);
    opened.push(store3);
    expect(store3.agentRuns.get(c.agentRunId)!.status).toBe('running');
    expect(new TokenRegistry(store3).resolve(token)).toBeNull();
    // finished runs never resolve, even from a fresh registry
    const t2 = new TokenRegistry(store3).issue({ ...c, agentRunId: newId('arun') });
    store3.agentRuns.update(store3.agentRuns.list({ token: t2 })[0]!.id, { status: 'done' });
    expect(new TokenRegistry(store3).resolve(t2)).toBeNull();
  });
});

describe('mcp server', () => {
  async function connect(app: Hono, token: string) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://bif.local/mcp/${token}`), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    return client;
  }

  it('tools/list for reviewer returns exactly its 4 tools', async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const reviewer = ctx('reviewer');
    const client = await connect(app, tokens.issue(reviewer));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['expand', 'log_decision', 'read_artifact', 'read_flow_catalog', 'submit_review']);
    const review = tools.find((t) => t.name === 'submit_review')!;
    expect(review.inputSchema.type).toBe('object');
    expect(review.inputSchema.properties).toHaveProperty('score');

    const res = await client.callTool({
      name: 'log_decision',
      arguments: { what: 'w', why: 'y', alternatives: [], signals_positive: [], signals_negative: [], confidence: 0.5 },
    });
    expect(res.isError).toBeFalsy();
    expect(s.store.decisions.list({ agentRunId: reviewer.agentRunId })).toHaveLength(1);
    const denied = await client.callTool({ name: 'save_finding', arguments: {} });
    expect(denied.isError).toBe(true);
    await client.close();

    const worker = await connect(app, tokens.issue(ctx('worker')));
    expect((await worker.listTools()).tools).toHaveLength(ROLE_TOOLS.worker.length);
    await worker.close();
  });

  it("tools/list: save_persona's field schema is shared for Claude and Codex runs, inline for OpenCode runs (not verified there)", async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const schemaFor = async (provider: 'claude' | 'codex' | 'opencode') => {
      const client = await connect(app, tokens.issue(ctx('worker', { model: { provider, model: 'm' } })));
      const tool = (await client.listTools()).tools.find((t) => t.name === 'save_persona')!;
      await client.close();
      return tool.inputSchema as Record<string, unknown>;
    };
    expect((await schemaFor('claude')).$defs).toHaveProperty('profile_field');
    expect((await schemaFor('codex')).$defs).toHaveProperty('profile_field');
    const open = await schemaFor('opencode');
    expect(open.$defs).toBeUndefined();
    expect(JSON.stringify(open)).not.toContain('$ref');
  });

  it('unknown token is rejected at the HTTP layer', async () => {
    const s = setup();
    const app = new Hono();
    mountMcp(app, { tokens: new TokenRegistry(s.store), handle: s.handle });
    await expect(connect(app, 'tok_unknown')).rejects.toThrow();
    const res = await app.fetch(
      new Request('http://bif.local/mcp/tok_unknown', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('/mcp takes the run token as a bearer header (keeps it out of CLI argv)', async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const token = tokens.issue(ctx('reviewer'));
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://bif.local/mcp'), {
        fetch: async (url, init) => app.fetch(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['expand', 'log_decision', 'read_artifact', 'read_flow_catalog', 'submit_review']);
    await client.close();
    for (const authorization of [undefined, 'Bearer tok_unknown', `Basic ${token}`]) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (authorization) headers.authorization = authorization;
      const res = await app.fetch(
        new Request('http://bif.local/mcp', {
          method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      );
      expect(res.status).toBe(401);
    }
  });

  it('blocking request_approval over a real HTTP server stays open until resolved', async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${tokens.issue(ctx('worker'))}`)),
      );
      const call = client.callTool({ name: 'request_approval', arguments: { action: 'request a demo', site: 's', details: 'd' } });
      await new Promise((r) => setTimeout(r, 300));
      const [req] = s.store.userRequests.list({ status: 'pending' });
      expect(req).toBeDefined();
      resolveUserRequest(s, req!.id, 'resolved', 'ok');
      const res = await call;
      expect(res.isError).toBeFalsy();
      expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ approved: true, response: 'ok' });
      await client.close();
    } finally {
      server.close();
    }
  });
});

describe('persona feedback scores', () => {
  it('are 1–5 (spec §8b): 0 and 6 rejected, 1 and 5 accepted', async () => {
    const { handle } = setup({ extraHandlers: { submit_persona_feedback: async () => ({ ok: true, data: {} }) } });
    const input = (v: number) => ({
      recommendation_id: 'rec_1',
      scores: { appeal: v, adoption: 3, willingness_to_pay: 3, friction: 3 },
      concerns: [], reasoning: 'r', would_change_mind: 'w',
    });
    const c = ctx('persona');
    expect((await handle(c, 'submit_persona_feedback', input(0))).ok).toBe(false);
    expect((await handle(c, 'submit_persona_feedback', input(6))).ok).toBe(false);
    expect((await handle(c, 'submit_persona_feedback', input(1))).ok).toBe(true);
    expect((await handle(c, 'submit_persona_feedback', input(5))).ok).toBe(true);
    const friction6 = { ...input(3), scores: { appeal: 3, adoption: 3, willingness_to_pay: 3, friction: 6 } };
    expect((await handle(c, 'submit_persona_feedback', friction6)).ok).toBe(false);
  });
});

describe('user request insert failure', () => {
  it('tears down the registered waiter', async () => {
    const s = setup();
    const before = (s.events as unknown as { listeners: Set<unknown> }).listeners.size;
    s.store.close(); // makes the insert throw
    const r = await s.handle(ctx('worker'), 'request_user_action', { kind: 'other', site: 's', instructions: 'i' });
    expect(r.ok).toBe(false);
    expect((s.events as unknown as { listeners: Set<unknown> }).listeners.size).toBe(before);
  });
});

describe('concurrent user requests on one task', () => {
  for (const order of ['creation', 'reverse'] as const) {
    it(`restore the task's original status after the last resolves (${order} order)`, async () => {
      const { store, events, handle } = setup();
      const task = addTask(store); // status 'running'
      const c = ctx('worker', { taskId: task.id });
      const p1 = handle(c, 'request_approval', { action: 'request a demo', site: 'a', details: 'd' });
      await tick();
      const p2 = handle(c, 'request_approval', { action: 'contact sales', site: 'b', details: 'd' });
      await tick();
      const pending = store.userRequests.list({ status: 'pending' });
      expect(pending).toHaveLength(2);
      expect(pending.map((r) => r.taskPriorStatus)).toEqual(['running', 'running']);
      expect(store.tasks.get(task.id)!.status).toBe('waiting_user');
      const ids = order === 'creation' ? pending.map((r) => r.id) : pending.map((r) => r.id).reverse();
      resolveUserRequest({ store, events }, ids[0]!, 'resolved');
      expect(store.tasks.get(task.id)!.status).toBe('waiting_user'); // one still pending
      resolveUserRequest({ store, events }, ids[1]!, 'denied');
      await Promise.all([p1, p2]);
      expect(store.tasks.get(task.id)!.status).toBe('running');
      expect(store.userRequests.list({ status: 'pending' })).toHaveLength(0);
    });
  }

  it('restores the task after a restart (no live waiter)', async () => {
    const { store, events, handle, dbPath } = setup();
    const task = addTask(store);
    const ac = new AbortController();
    const p = handle(ctx('worker', { taskId: task.id }), 'request_user_action', { kind: 'login', site: 's', instructions: 'i' }, { signal: ac.signal });
    await tick();
    ac.abort();
    await p;
    store.close();
    const reopened = openStore(dbPath);
    opened.push(reopened);
    const [req] = reopened.userRequests.list({ status: 'pending' });
    resolveUserRequest({ store: reopened, events }, req!.id, 'resolved');
    expect(reopened.tasks.get(task.id)!.status).toBe('running');
  });
});


// Stakeholder personas (design §7, task 6 fix round 2): a run of an own_stakeholders task cannot ask the
// user anything and may store only stakeholders and copies of the public pages it relies on (own
// research may use the web, user ruling 2026-11-15); its reviewer keeps the review tools.
describe('runs of a private task (own_stakeholders)', () => {
  function privateSetup() {
    const s = setup({ extraHandlers: stakeholderToolHandlers({ dataDir: mkdtempSync(join(tmpdir(), 'bif-tools-stk-')) }) });
    s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: new Date().toISOString() });
    const task = s.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: 'run_1', phase: 'stakeholders', type: 'own_stakeholders', brief: 'Map stakeholders',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['c'], status: 'running', round: 1, createdAt: new Date().toISOString(),
    });
    const art = s.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart' }).id;
    return { ...s, task, art };
  }
  const refusalOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : r.error ?? '');

  it('every worker tool outside the allowlist is refused, asking the user with "finish with what you have"', async () => {
    const s = privateSetup();
    const c = ctx('worker', { taskId: s.task.id });
    const refused = ROLE_TOOLS.worker.filter((t) => !PRIVATE_TASK_TOOLS.has(t));
    expect(refused).toEqual(expect.arrayContaining([
      'save_finding', 'save_persona', 'save_competitor', 'save_hypothesis', 'propose_business_unit', 'request_user_action',
      'request_approval', 'describe_artifact', 'get_identity', 'confirm_finding', 'retract_finding',
    ]));
    expect(refused).not.toContain('save_artifact');
    for (const tool of refused) {
      const r = await s.handle(c, tool, {});
      expect(refusalOf(r), tool).toMatch(new RegExp(`tool '${tool}' is not available in a own_stakeholders task`));
    }
    for (const tool of ['request_user_action', 'request_approval'] as const) {
      expect(refusalOf(await s.handle(c, tool, { site: 'x', action: 'a', details: 'd', reason: 'r' })), tool).toMatch(/cannot ask the user anything.*Finish with what you have/s);
    }
    expect(s.store.userRequests.list()).toEqual([]);
    expect(s.store.findings.list()).toEqual([]);
  });

  it('the allowlisted tools still work; the reviewer keeps its review tools; other tasks are unaffected', async () => {
    const s = privateSetup();
    const c = ctx('worker', { taskId: s.task.id });
    expect((await s.handle(c, 'log_decision', { what: 'start', why: 'plan', confidence: 0.6 })).ok).toBe(true);
    expect((await s.handle(c, 'read_workspace', { workspace_id: 'ws_a' })).ok).toBe(true);
    expect((await s.handle(c, 'read_artifact', { artifact_id: s.art })).ok).toBe(true);
    // a copy of a public page it relies on, to cite as evidence
    const page = await s.handle(c, 'save_artifact', { kind: 'page_snapshot', mime: 'text/plain', source_url: 'https://acme.example/board', content: 'Leadership page: the board' });
    expect(page.ok).toBe(true);
    expect(s.store.findings.list()).toEqual([]);
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} v`, confidence: 0.5, evidence: [s.art] }]));
    const saved = await s.handle(c, 'save_stakeholder', { label: 'Chief financial officer', stakeholder_type: 'leader', subject: 'own', relation: 'approves', profile });
    expect(saved.ok).toBe(true);
    expect((await s.handle(c, 'submit_result', { summary: 'one stakeholder', evidence: [s.art] })).ok).toBe(true);

    const reviewer = ctx('reviewer', { taskId: s.task.id });
    expect((await s.handle(reviewer, 'submit_review', { score: 8, issues: [] })).ok).toBe(true);

    const other = addTask(s.store);
    expect((await s.handle(ctx('worker', { taskId: other.id }), 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'x' })).ok).toBe(true);
  });

  it('save_artifact stores only page copies: kind, mime, content and an http(s) source_url; every other option is refused; describe_artifact too', async () => {
    const s = privateSetup();
    const c = ctx('worker', { taskId: s.task.id });
    const page = { kind: 'page_snapshot', mime: 'text/plain', content: 'Board of Acme', source_url: 'https://acme.example/about/board?x=1' };
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...page, kind: 'text' }, /kind 'text' is not accepted/],
      [{ ...page, kind: 'screenshot', mime: 'image/png', description: 'A screenshot of the board page of Acme' }, /'description' is not accepted/],
      [{ ...page, kind: 'screenshot' }, /kind 'screenshot' is not accepted/],
      [{ ...page, source_url: undefined }, /source_url .* is required/],
      [{ ...page, source_url: 'file:///etc/hosts' }, /source_url .* is required/],
      [{ ...page, source_url: 'not a url' }, /source_url .* is required/],
      [{ ...page, title: 'Board' }, /'title' is not accepted/],
      [{ ...page, note: 'the CFO is new' }, /'note' is not accepted/],
      [{ ...page, description: 'The board page of Acme, listing its directors.' }, /'description' is not accepted/],
      [{ ...page, flow: 'signup' }, /'flow' is not accepted/],
      [{ ...page, step: 1 }, /'step' is not accepted/],
      [{ ...page, applies_to: ['ws_a'] }, /'applies_to' is not accepted/],
      [{ ...page, entity: { kind: 'company', name: 'Acme' } }, /'entity' is not accepted/],
      [{ ...page, title: 'Board', note: 'n' }, /'note', 'title' are not accepted/],
    ];
    for (const [input, why] of refusals) {
      expect(refusalOf(await s.handle(c, 'save_artifact', input)), JSON.stringify(input)).toMatch(why);
    }
    expect(s.store.artifacts.list({ workspaceId: 'ws_a' }).map((a) => a.id)).toEqual([s.art]);
    const saved = await s.handle(c, 'save_artifact', page);
    expect(saved.ok).toBe(true);
    const id = (saved as { data: { artifactId: string } }).data.artifactId;
    // the stored title is derived from the URL (host and path), never from the worker
    expect(s.store.artifacts.get(id)).toMatchObject({ title: 'acme.example/about/board', sourceUrl: page.source_url });
    const [cap] = knowledgeRepos(s.store).artifactCaptures.list({ artifactId: id });
    expect(cap).toMatchObject({ title: 'acme.example/about/board', taskId: s.task.id });
    expect(cap!.note ?? cap!.description ?? cap!.entityId).toBeUndefined();
    const doc = await s.handle(c, 'save_artifact', { kind: 'document', mime: 'text/plain', content: 'Registry filing', source_url: 'http://registry.example/' });
    expect(s.store.artifacts.get((doc as { data: { artifactId: string } }).data.artifactId)!.title).toBe('registry.example');
    expect(refusalOf(await s.handle(c, 'describe_artifact', { artifact_id: id, description: 'The board page of Acme, listing its directors.' })))
      .toMatch(/tool 'describe_artifact' is not available in a own_stakeholders task/);
  });
});
