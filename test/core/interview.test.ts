import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { Supervisor } from '../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import {
  INTERVIEW_TOPICS,
  buildInterviewPrompt,
  interviewCoverage,
  interviewToolHandlers,
  sendInterviewMessage,
  type InterviewerFake,
} from '../../src/core/interview/interview.js';
import { listUploads, uploadInternal } from '../../src/core/internal/uploads.js';
import { loadPrompt } from '../../src/core/prompts/index.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import type { Workspace } from '../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-int-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  const events = new EventBus();
  const artifacts = new ArtifactStore(store, dir);
  const handle = createToolHandlers({ store, artifacts, config, events, extraHandlers: interviewToolHandlers() });
  const supervisor = new Supervisor({
    store, config, tokens: new TokenRegistry(store), events, handle, dataDir: dir, mcpBaseUrl: 'http://127.0.0.1:1',
  });
  const ws: Workspace = { id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: new Date().toISOString() };
  store.workspaces.insert(ws);
  return { dir, store, config, events, artifacts, supervisor, ws };
}

describe('interview', () => {
  it('stores both turns', async () => {
    const t = setup();
    const fake: InterviewerFake = async () => 'What does Acme sell?';
    const reply = await sendInterviewMessage('ws_a', 'Hi, we run Acme.', { ...t, fake });
    expect(reply).toMatchObject({ role: 'agent', text: 'What does Acme sell?', workspaceId: 'ws_a' });
    const turns = t.store.interview.list({ workspaceId: 'ws_a' });
    expect(turns.map((x) => [x.role, x.text])).toEqual([
      ['user', 'Hi, we run Acme.'],
      ['agent', 'What does Acme sell?'],
    ]);
    const run = t.store.agentRuns.list({ workspaceId: 'ws_a' })[0]!;
    expect(run).toMatchObject({ role: 'interviewer', status: 'done', promptVersion: loadPrompt('interviewer').version });
  });

  it('update_profile merges patch into profile', async () => {
    const t = setup();
    t.store.profiles.insert({ workspaceId: 'ws_a', data: { basics: { sector: 'saas' }, keep: 1 } });
    await sendInterviewMessage('ws_a', 'we sell subscriptions', {
      ...t,
      fake: async (tools) => {
        await tools.call('update_profile', { patch: { basics: { geography: 'EU' }, revenue_model: 'subscriptions', keep: null } });
        return 'ok';
      },
    });
    expect(t.store.profiles.get('ws_a')!.data).toEqual({
      basics: { sector: 'saas', geography: 'EU' },
      revenue_model: 'subscriptions',
    });
  });

  it('save_symptom creates Symptom with criteria', async () => {
    const t = setup();
    await sendInterviewMessage('ws_a', 'renewals are down', {
      ...t,
      fake: async (tools) => {
        await tools.call('save_symptom', {
          kind: 'symptom',
          title: 'enterprise renewals down',
          detail: 'Renewal rate fell this year',
          criteria: { severity: 4, trend: '↓', causeConfidence: 40 },
        });
        return 'Why do you think renewals fell?';
      },
    });
    const symptoms = t.store.symptoms.list({ workspaceId: 'ws_a' });
    expect(symptoms).toHaveLength(1);
    expect(symptoms[0]).toMatchObject({
      kind: 'symptom',
      title: 'enterprise renewals down',
      criteria: { severity: 4, trend: '↓', causeConfidence: 40 },
      evidence: [],
    });
    const dec = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' });
    expect(dec[0]!.refs).toContain(symptoms[0]!.id);
  });

  it('save_symptom rejects bad criteria and unknown evidence', async () => {
    const t = setup();
    const errors: string[] = [];
    await sendInterviewMessage('ws_a', 'x', {
      ...t,
      fake: async (tools) => {
        for (const input of [
          { kind: 'symptom', title: 't', detail: 'd', criteria: { severity: 9, trend: '↓', causeConfidence: 10 } },
          { kind: 'symptom', title: 't', detail: 'd', criteria: { severity: 3 } },
          { kind: 'symptom', title: 't', detail: 'd', criteria: { severity: 3, trend: 'up', causeConfidence: 10 }, evidence: ['art_nope'] },
        ]) {
          await tools.call('save_symptom', input).catch((e: Error) => errors.push(e.message));
        }
        return 'ok';
      },
    });
    expect(errors).toHaveLength(3);
    expect(t.store.symptoms.list({ workspaceId: 'ws_a' })).toHaveLength(0);
  });

  it('coverage flips going_well when a strength exists', async () => {
    const t = setup();
    expect(interviewCoverage('ws_a', t)).toEqual(Object.fromEntries(INTERVIEW_TOPICS.map((k) => [k, false])));
    await sendInterviewMessage('ws_a', 'our onboarding is loved', {
      ...t,
      fake: async (tools) => {
        await tools.call('save_symptom', {
          kind: 'strength',
          title: 'onboarding loved',
          detail: 'NPS comments praise onboarding',
          criteria: { severity: 4, trend: '→', causeConfidence: 70 },
        });
        await tools.call('update_profile', { patch: { customers: 'mid-market IT teams' } });
        return 'Great.';
      },
    });
    const cov = interviewCoverage('ws_a', t);
    expect(cov.going_well).toBe(true);
    expect(cov.customers).toBe(true);
    expect(cov.going_badly).toBe(false);
  });

  it('failed interviewer run keeps user turn and throws', async () => {
    const t = setup();
    await expect(
      sendInterviewMessage('ws_a', 'hello', { ...t, fake: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow(/interviewer/);
    expect(t.store.interview.list({ workspaceId: 'ws_a' }).map((x) => x.role)).toEqual(['user']);
  });

  it('prompt includes scope, audiences, transcript, coverage and uploads (metadata, no title: KS-5 ruling)', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('a,b\n1,2'), mime: 'text/csv' }, t);
    t.store.interview.insert({ id: 'it_1', workspaceId: 'ws_a', role: 'user', text: 'We sell widgets', createdAt: 'x' });
    const ws = { ...t.ws, scope: { level: 'division' as const, name: 'Widgets EU', description: 'EU widget unit' }, audiences: ['external' as const, 'internal' as const] };
    const p = buildInterviewPrompt(ws, t.store, t.dir);
    expect(p).toContain('division');
    expect(p).toContain('Widgets EU');
    expect(p).toContain('external, internal');
    expect(p).toContain('We sell widgets');
    for (const topic of INTERVIEW_TOPICS) expect(p).toContain(topic);
    expect(p).toContain(`- ${up.id} (spreadsheet, 7 B, uploaded ${up.capturedAt.slice(0, 10)})`);
    expect(p).toContain('Use `expand` or `read_artifact`');
    expect(p).not.toContain('kpis.csv'); // a file name is upload-derived text
    expect(p).not.toContain('a,b');
  });

  it('prompt uses default scope (company, workspace name) and audiences (external) when unset', () => {
    const t = setup();
    const p = buildInterviewPrompt(t.ws, t.store);
    expect(p).toContain('- level: company');
    expect(p).toContain('- name: Acme');
    expect(p).toContain('- audiences: external\n');
  });
});

describe('uploads', () => {
  it('upload stored as artifact kind upload', () => {
    const t = setup();
    const a = uploadInternal('ws_a', { name: 'deck.pdf', bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf' }, t);
    expect(a).toMatchObject({ kind: 'upload', title: 'deck.pdf', mime: 'application/pdf', workspaceId: 'ws_a' });
    expect(t.store.artifacts.get(a.id)!.kind).toBe('upload');
    expect(t.store.profiles.get('ws_a')!.data.uploads).toEqual([a.id]);
    uploadInternal('ws_a', { name: 'deck.pdf', bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf' }, t);
    expect(t.store.profiles.get('ws_a')!.data.uploads).toEqual([a.id]);
    expect(listUploads('ws_a', t)).toEqual([{ id: a.id, title: 'deck.pdf' }]);
  });
});

// --- knowledge store KS-5: the drill-down is a logged prompt read of usable facts only ---------------
describe('interview drill-down (KS-5)', () => {
  it('shows usable facts only, redacted, and logs them as a prompt read before the run starts', async () => {
    const t = setup();
    const { knowledgeRepos } = await import('../../src/core/store/repos.js');
    t.store.identities.insert({ id: 'idn_1', workspaceId: 'ws_a', site: 'x.test', name: 'n', email: 'n@x.test', password: 'Zq9xK2mPw7Lr', createdAt: 'now' });
    t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: {}, evidence: [] });
    const fact = (id: string, claim: string, lifecycle: 'current' | 'replaced') =>
      t.store.findings.insert({ id, workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'Acme', claim, criteria: {}, evidence: [], status: 'verified', lifecycle, createdAt: 'now' });
    fact('fnd_cur', 'CURRENT_CLAIM price rose; login Zq9xK2mPw7Lr', 'current');
    fact('fnd_old', 'OLD_VERSION_CLAIM price was flat', 'replaced');
    t.store.symptomHypotheses.insert({ id: 'hyp_1', workspaceId: 'ws_a', symptomId: 'sym_1', hypothesis: 'price rise drove churn', confidence: 60, evidence: ['fnd_cur', 'fnd_old'], createdAt: 'now', status: 'verified' });
    const prompt = buildInterviewPrompt(t.ws, t.store);
    expect(prompt).toContain('CURRENT_CLAIM');
    expect(prompt).not.toContain('OLD_VERSION_CLAIM');
    expect(prompt).not.toContain('Zq9xK2mPw7Lr');
    await sendInterviewMessage('ws_a', 'hello', { ...t, fake: async () => 'Did churned accounts mention price?' });
    const run = t.store.agentRuns.list({ role: 'interviewer' })[0]!;
    const [row] = knowledgeRepos(t.store).retrievalEvents.list({ agentRunId: run.id });
    expect(row).toMatchObject({ tool: 'prompt_context', role: 'interviewer', promptVersion: run.promptVersion });
    expect(row!.resultIds.map((r) => r.id)).toEqual(expect.arrayContaining(['hyp_1', 'fnd_cur']));
    expect(row!.resultIds.map((r) => r.id)).not.toContain('fnd_old');
  });
});
