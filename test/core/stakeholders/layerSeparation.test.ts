/**
 * Stakeholder positions, layer separation (design 2026-11-15-stakeholder-positions-design.md §6, §7.1;
 * task 1 review, ruling 10): a run of a `competitor_stakeholders` task does the follow research with
 * web access and is told former colleagues by id, so the knowledge read paths serve it no internal text
 * of a persona whose text is internal (`holdsInternal`): only its label and type, as for a hidden
 * stakeholder. Every other reader is served what it was served before.
 *
 * Each internal text carries a marker no label holds, so "not served" is checked on the whole response.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkPersona } from '../../../src/core/knowledge/entityLinks.js';
import { knowledgeRead, type KnowledgeReadInput, type KnowledgeReadTool } from '../../../src/core/knowledge/tools.js';
import { agentMdPath } from '../../../src/core/market/personas.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import { workPrompt } from '../../../src/core/research/reviewLoop.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { FOLLOW_TASK_TYPES } from '../../../src/core/stakeholders/kinds.js';
import { stakeholderSlug } from '../../../src/core/stakeholders/personas.js';
import { markLeft } from '../../../src/core/stakeholders/positions.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, PersonaProfileField, Task } from '../../../src/core/types.js';
import { addTask, researchSetup } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const LEFT = '2026-10-31';
const MARKS = /PROFILEMARK|RELATIONMARK|ADJUSTMARK|TITLEMARK/;

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const profileOf = (label: string): Record<string, PersonaProfileField> =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f, i) => [f, { value: `PROFILEMARK ${f} of ${label}`, confidence: 0.9 - i * 0.01, evidence: [] }]));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-layers-'));
  const t = researchSetup(opened, { dir });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'division', name: 'Acme Payments', description: 'payments' } });
  t.store.competitors.insert({
    id: 'cmp_rival', workspaceId: 'ws_a', name: 'Rival Pay', threat: 4, directness: 5, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [],
    createdAt: T0, updatedAt: T0, status: 'verified',
  });
  const stakeholder = (label: string, extra: Partial<Persona> = {}): Persona => {
    const slug = extra.slug ?? stakeholderSlug(label);
    const p = t.store.personas.insert({
      id: newId('per'), workspaceId: 'ws_a', slug, segment: label, profile: profileOf(label), version: 1, status: 'verified',
      agentMdPath: agentMdPath(dir, 'ws_a', slug), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: `RELATIONMARK of ${label}`,
      disclosure: 'open', ...extra,
    });
    linkPersona(t.store, p);
    personaLearningRepos(t.store).adjustments.insert({
      id: newId('pad'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, marker: `m-${slug}`, text: `ADJUSTMARK of ${label}`, version: 1, status: 'active',
      source: 'user', actor: 'tester', stats: {}, internal: true, createdAt: T0, changedAt: T0,
    });
    return t.store.personas.get(p.id)!;
  };
  const pos = { store: t.store, dataDir: dir };
  const own = stakeholder('Head of finance');
  const gone = markLeft(pos, 'tester', 'ws_a', stakeholder('Head of sales').id, { date: LEFT, to: { competitorId: 'cmp_rival' }, title: 'TITLEMARK VP Sales' });
  const parked = markLeft(pos, 'tester', 'ws_a', stakeholder('Head of legal').id, { date: LEFT, to: { elsewhere: {} }, title: 'TITLEMARK Partner' });
  const rival = stakeholder('Chief executive', { slug: 'stk-rival-pay-chief-executive', subjectKind: 'competitor', subjectId: 'cmp_rival' });
  const follow = addTask(t.store, { phase: 'stakeholders', type: 'competitor_stakeholders', brief: 'follow', subject: undefined });
  const other = addTask(t.store, { phase: 'deep_dives', type: 'news_scan', brief: 'scan', subject: undefined });
  const read = (task: Task | undefined, tool: KnowledgeReadTool, input: KnowledgeReadInput, role: 'worker' | 'reviewer' = 'worker'): string => {
    const r = knowledgeRead(
      { store: t.store, config: t.config, events: t.events, files: t.artifacts },
      { workspaceId: 'ws_a', role, ...(task ? { taskId: task.id } : {}) },
      tool,
      input,
    );
    if (!r.ok) throw new Error(r.error);
    return JSON.stringify(r.data);
  };
  return { ...t, own, gone, parked, rival, follow, other, read };
}

describe('the task type that follows former colleagues', () => {
  it('is competitor_stakeholders, and no other', () => {
    expect([...FOLLOW_TASK_TYPES]).toEqual(['competitor_stakeholders']);
  });
});

describe('expand of a persona', () => {
  it('a run of the follow task is served label and type of a persona that holds internal knowledge, and none of its text', () => {
    const t = setup();
    for (const p of [t.own, t.gone, t.parked]) {
      const out = t.read(t.follow, 'expand', { id: p.id });
      expect(out, p.slug).not.toMatch(MARKS);
      expect(out, p.slug).not.toContain('profile.');
      expect(out, p.slug).toContain(p.segment);
      expect(out, p.slug).toContain('"field":"stakeholder_type","value":"leader"');
      expect(out, p.slug).toContain('"field":"withheld","value":"internal"');
    }
  });

  it('a reviewer run of the follow task is served no more than its worker', () => {
    const t = setup();
    // The review slice holds what the task saved; a persona named in it is still served without its text.
    t.store.personas.update(t.gone.id, { taskId: t.follow.id, taskRound: 1 });
    const out = t.read(t.follow, 'expand', { id: t.gone.id }, 'reviewer');
    expect(out).not.toMatch(MARKS);
    expect(out).toContain('"field":"withheld","value":"internal"');
  });

  it('a competitor\'s stakeholder that never worked here is served whole to the follow task: its profile is public research', () => {
    const t = setup();
    const out = t.read(t.follow, 'expand', { id: t.rival.id });
    expect(out).toContain('PROFILEMARK role_mandate of Chief executive');
    expect(out).not.toContain('withheld');
    expect(out.match(/"field":"profile\./g)).toHaveLength(STAKEHOLDER_FIELDS.length);
  });

  it('a run of another task, and a read without a task, are served as before', () => {
    const t = setup();
    for (const task of [t.other, undefined]) {
      for (const p of [t.own, t.gone, t.parked, t.rival]) {
        const out = t.read(task, 'expand', { id: p.id });
        expect(out, p.slug).toContain(`PROFILEMARK role_mandate of ${p.segment}`);
        expect(out, p.slug).not.toContain('withheld');
      }
    }
  });

  it('a hidden stakeholder stays hidden for every reader', () => {
    const t = setup();
    t.store.personas.update(t.own.id, { disclosure: 'hidden' });
    for (const task of [t.follow, t.other]) {
      const out = t.read(task, 'expand', { id: t.own.id });
      expect(out).not.toMatch(MARKS);
      expect(out).toContain('"field":"disclosure","value":"hidden"');
    }
  });
});

describe('the card of a persona\'s entity', () => {
  it('lists no profile field of a persona that holds internal knowledge for the follow task; as before for another task', () => {
    const t = setup();
    for (const p of [t.own, t.gone, t.parked]) {
      const input = { entity_id: t.store.personas.get(p.id)!.entityId! };
      for (const tool of ['get_card', 'expand'] as const) {
        const args = tool === 'get_card' ? input : { id: input.entity_id };
        const withheld = t.read(t.follow, tool, args);
        expect(withheld, `${tool} ${p.slug}`).not.toMatch(MARKS);
        expect(withheld, `${tool} ${p.slug}`).toContain(`persona [${p.id}] segment`);
        expect(t.read(t.other, tool, args), `${tool} ${p.slug}`).toContain('PROFILEMARK');
      }
    }
    const rival = t.read(t.follow, 'get_card', { entity_id: t.store.personas.get(t.rival.id)!.entityId! });
    expect(rival).toContain('PROFILEMARK');
  });
});

describe('search', () => {
  it('a hit on a persona is its label only, and no profile text is searchable, for the follow task and for any other', () => {
    const t = setup();
    for (const task of [t.follow, t.other]) {
      const byLabel = t.read(task, 'search', { query: 'Head of sales' });
      expect(byLabel).toContain(t.gone.id);
      expect(byLabel).not.toMatch(MARKS);
      for (const query of ['PROFILEMARK', 'RELATIONMARK', 'ADJUSTMARK', 'TITLEMARK']) {
        const out = t.read(task, 'search', { query, scope: 'tree', include_unverified: true });
        for (const p of [t.own, t.gone, t.parked, t.rival]) expect(out, query).not.toContain(p.id);
        expect(out.replaceAll(query, ''), query).not.toMatch(MARKS);
      }
    }
  });
});

describe('the work prompt of the follow task', () => {
  it('a subject naming a persona that holds internal knowledge brings its card without profile fields; another task type gets the card as before', () => {
    const t = setup();
    for (const p of [t.own, t.gone, t.parked]) {
      const follow = addTask(t.store, { phase: 'stakeholders', type: 'competitor_stakeholders', brief: `follow ${p.id}`, subject: p.segment });
      const prompt = workPrompt(t.deps, follow);
      expect(prompt, p.slug).toContain(`persona [${p.id}] segment`);
      expect(prompt, p.slug).not.toMatch(MARKS);
      const scan = addTask(t.store, { type: 'news_scan', brief: `scan ${p.id}`, subject: p.segment });
      expect(workPrompt(t.deps, scan), p.slug).toContain('PROFILEMARK');
    }
  });
});
