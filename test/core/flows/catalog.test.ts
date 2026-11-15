import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_CHECKLISTS, BUILTIN_FLOW_TYPES } from '../../../src/core/flows/builtinChecklists.js';
import {
  activeChecklists,
  coverageOf,
  decideChecklist,
  decideFlowType,
  editChecklist,
  ensureCatalog,
  flowTypeByKey,
  listFlowTypes,
  proposeChecklist,
  proposeFlowType,
} from '../../../src/core/flows/catalog.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import type { ChecklistItem, Flow } from '../../../src/core/flows/types.js';
import { openStore, type Store } from '../../../src/core/store/db.js';

const NOW = '2026-11-14T10:00:00.000Z';

const flowRow = (id: string, flowTypeId: string): Flow => ({
  id, workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', subjectEntityId: 'ent_acme', flowTypeId, variant: id, variantKey: id,
  isPrimary: true, name: 'Acme log in', goal: 'Get in', reachedGoal: true, stepsHash: 'h', lineageId: id, version: 1,
  lifecycle: 'current', status: 'pending', firstSeenAt: NOW, confirmCount: 0, createdAt: NOW,
});

const ITEMS: ChecklistItem[] = [
  { key: 'invite_by_link', question: 'A teammate can be invited by a shareable link', kind: 'yes_no', pass: { answer: 'yes' }, weight: 1, scored: true, answeredBy: 'walkthrough' },
  { key: 'seats_shown', question: 'Seat cost shown before inviting', kind: 'recorded', weight: 1, scored: false, answeredBy: 'walkthrough' },
];

describe('flow type catalog and checklists', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
    store.workspaces.insert({ id: 'ws_a_child', name: 'Acme EU', sector: 'saas', createdAt: 'now', parentWorkspaceId: 'ws_a' });
    store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: 'now' });
  });
  afterEach(() => store.close());

  it('ensureCatalog seeds nine active flow types and five active checklists once', () => {
    ensureCatalog(store, 'ws_a_child');
    ensureCatalog(store, 'ws_a');
    const r = flowRepos(store);
    const types = r.flowTypes.list({ rootWorkspaceId: 'ws_a' });
    expect(types.map((t) => t.key)).toEqual([
      'sign_up', 'sign_in', 'account_recovery', 'onboarding', 'pricing', 'checkout', 'cancel_or_downgrade', 'invite_teammate', 'get_support',
    ]);
    expect(types.every((t) => t.status === 'active' && t.id.startsWith('fty_'))).toBe(true);
    const lists = r.checklists.list({ rootWorkspaceId: 'ws_a' });
    expect(lists).toHaveLength(5);
    expect(lists.every((c) => c.status === 'active' && c.origin === 'builtin' && c.version === 1 && c.id.startsWith('ckl_') && c.acceptedAt)).toBe(true);
    expect(lists.filter((c) => c.flowTypeId === undefined)).toHaveLength(1);
    const byType = new Map(types.map((t) => [t.id, t.key]));
    expect(lists.filter((c) => c.flowTypeId).map((c) => byType.get(c.flowTypeId!)).sort()).toEqual(['account_recovery', 'checkout', 'sign_in', 'sign_up']);
    expect(listFlowTypes(store, 'ws_a_child')).toHaveLength(9);
  });

  it("a second tree gets its own catalog and sees none of the first tree's proposals", () => {
    const { flowType: proposed } = proposeFlowType(store, 'ws_a_child', { key: 'export_data', name: 'Export data', definition: 'Get your data out', agentRunId: 'run_1' });
    expect(proposed).toMatchObject({ rootWorkspaceId: 'ws_a', status: 'proposed', proposedByRun: 'run_1' });
    const signInA = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    proposeChecklist(store, 'ws_a', { flowTypeId: signInA.id, coverage: 0.5, items: ITEMS, origin: 'agent' });

    const typesB = listFlowTypes(store, 'ws_b');
    expect(typesB).toHaveLength(9);
    expect(typesB.every((t) => t.rootWorkspaceId === 'ws_b')).toBe(true);
    expect(flowTypeByKey(store, 'ws_b', 'export_data')).toBeUndefined();
    const signInB = flowTypeByKey(store, 'ws_b', 'sign_in')!;
    expect(signInB.id).not.toBe(signInA.id);
    expect(activeChecklists(store, 'ws_b', signInB.id).specific?.rootWorkspaceId).toBe('ws_b');
    expect(flowRepos(store).checklists.list({ rootWorkspaceId: 'ws_b', status: 'proposed' })).toHaveLength(0);
    // A type of another tree has no checklist here.
    expect(activeChecklists(store, 'ws_b', signInA.id).specific).toBeUndefined();
  });

  it('a proposed flow type is not active until accepted; reject and merge work; flowTypeByKey follows a merge', () => {
    const { flowType: exp, created } = proposeFlowType(store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'Get your data out' });
    expect(created).toBe(true);
    expect(exp.id.startsWith('fty_')).toBe(true);
    expect(listFlowTypes(store, 'ws_a', { status: 'active' }).map((t) => t.key)).not.toContain('export_data');
    expect(listFlowTypes(store, 'ws_a', { status: 'proposed' }).map((t) => t.key)).toEqual(['export_data']);

    const edited = decideFlowType(store, exp.id, { action: 'edit', name: 'Export your data' });
    expect(edited).toMatchObject({ name: 'Export your data', definition: 'Get your data out', status: 'proposed', key: 'export_data' });
    expect(decideFlowType(store, exp.id, { action: 'accept' }).status).toBe('active');
    expect(listFlowTypes(store, 'ws_a', { status: 'active' }).map((t) => t.key)).toContain('export_data');
    expect(() => decideFlowType(store, exp.id, { action: 'accept' })).toThrow(/proposed/);

    const { flowType: junk } = proposeFlowType(store, 'ws_a', { key: 'junk', name: 'Junk', definition: 'Not a flow' });
    expect(decideFlowType(store, junk.id, { action: 'reject' }).status).toBe('rejected');

    const { flowType: login } = proposeFlowType(store, 'ws_a', { key: 'log_in', name: 'Log in', definition: 'Get into an account' });
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const merged = decideFlowType(store, login.id, { action: 'merge', intoId: signIn.id });
    expect(merged).toMatchObject({ status: 'merged', mergedIntoId: signIn.id });
    expect(flowTypeByKey(store, 'ws_a', 'log_in')?.id).toBe(signIn.id);
    expect(flowTypeByKey(store, 'ws_a', 'Log In')?.id).toBe(signIn.id);
    expect(() => decideFlowType(store, 'fty_missing', { action: 'accept' })).toThrow(/not found/);
  });

  it('a rejected flow type is kept: a re-proposal returns it unreopened, and the user can accept it later', () => {
    const { flowType: junk } = proposeFlowType(store, 'ws_a', { key: 'junk', name: 'Junk', definition: 'Not a flow' });
    const draft = proposeChecklist(store, 'ws_a', { flowTypeId: junk.id, coverage: 0.5, items: ITEMS, origin: 'agent' });
    const rejected = decideFlowType(store, junk.id, { action: 'reject' });
    expect(rejected).toMatchObject({ id: junk.id, status: 'rejected' });
    expect(flowRepos(store).checklists.get(draft.id)?.status).toBe('retired');

    const again = proposeFlowType(store, 'ws_a', { key: 'Junk', name: 'Junk again', definition: 'Still not a flow' });
    expect(again.created).toBe(false);
    expect(again.flowType).toMatchObject({ id: junk.id, status: 'rejected', name: 'Junk' });
    expect(flowTypeByKey(store, 'ws_a', 'junk')).toMatchObject({ id: junk.id, status: 'rejected' });
    expect(listFlowTypes(store, 'ws_a').map((t) => t.key)).not.toContain('junk');
    expect(listFlowTypes(store, 'ws_a', { status: 'rejected' }).map((t) => t.id)).toEqual([junk.id]);
    expect(() => decideFlowType(store, junk.id, { action: 'reject' })).toThrow(/not proposed/);
    expect(() => proposeChecklist(store, 'ws_a', { flowTypeId: junk.id, coverage: 0.5, items: ITEMS, origin: 'agent' })).toThrow(/rejected/);

    expect(decideFlowType(store, junk.id, { action: 'accept' }).status).toBe('active');
    expect(listFlowTypes(store, 'ws_a', { status: 'active' }).map((t) => t.key)).toContain('junk');
  });

  it('a proposed flow type with flows cannot be rejected', () => {
    const { flowType: exp } = proposeFlowType(store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'x' });
    flowRepos(store).flows.insert(flowRow('flw_1', exp.id));
    expect(() => decideFlowType(store, exp.id, { action: 'reject' })).toThrow(/merge/);
    expect(flowRepos(store).flowTypes.get(exp.id)?.status).toBe('proposed');
  });

  it("merging moves the type's flows, mentions, verdicts and overrides to the target and retires its checklists", () => {
    const r = flowRepos(store);
    const { flowType: login } = proposeFlowType(store, 'ws_a', { key: 'log_in', name: 'Log in', definition: 'Get into an account' });
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const signInList = activeChecklists(store, 'ws_a', signIn.id).specific!;
    const proposedList = proposeChecklist(store, 'ws_a', { flowTypeId: login.id, coverage: 0.5, items: ITEMS, origin: 'agent' });
    const activeList = proposeChecklist(store, 'ws_a', { flowTypeId: login.id, coverage: 0.4, items: ITEMS, origin: 'agent' });
    decideChecklist(store, activeList.id, { action: 'accept' });

    r.flows.insert(flowRow('flw_1', login.id));
    r.flows.insert(flowRow('flw_2', login.id));
    r.reviewMentions.insert({
      id: 'rvm_1', workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', subjectEntityId: 'ent_acme', sourceType: 'app_store', artifactId: 'art_1',
      quote: 'Login loops', quoteHash: 'q1', polarity: 'negative', flowTypeId: login.id, attributionConfidence: 0.9, createdAt: NOW,
    });
    r.flowVerdicts.insert({
      id: 'fvd_1', workspaceId: 'ws_a', flowTypeId: login.id, flowAId: 'flw_1', flowBId: 'flw_2', personaId: 'per_1', personaVersion: 1,
      stage: 'broad', winner: 'a', strength: 2, confidence: 0.7, reason: 'Fewer steps', createdAt: NOW,
    });
    r.flowOverrides.insert({
      id: 'fov_1', workspaceId: 'ws_a', flowTypeId: login.id, winnerFlowId: 'flw_1', loserFlowId: 'flw_2', actor: 'local-user',
      needsConfirm: false, createdAt: NOW,
    });

    const merged = decideFlowType(store, login.id, { action: 'merge', intoId: signIn.id });
    expect(merged).toMatchObject({ status: 'merged', mergedIntoId: signIn.id });
    expect(r.flows.list({ flowTypeId: login.id })).toHaveLength(0);
    expect(r.flows.list({ flowTypeId: signIn.id }).map((f) => f.id)).toEqual(['flw_1', 'flw_2']);
    expect(r.reviewMentions.get('rvm_1')?.flowTypeId).toBe(signIn.id);
    expect(r.flowVerdicts.get('fvd_1')?.flowTypeId).toBe(signIn.id);
    expect(r.flowOverrides.get('fov_1')?.flowTypeId).toBe(signIn.id);
    expect(r.checklists.get(proposedList.id)?.status).toBe('retired');
    expect(r.checklists.get(activeList.id)?.status).toBe('retired');
    expect(r.checklists.get(signInList.id)?.status).toBe('active');
    // Given the merged id anyway, checklists and coverage resolve to the target.
    expect(activeChecklists(store, 'ws_a', login.id).specific?.id).toBe(signInList.id);
    expect(coverageOf(store, 'ws_a', login.id)).toBe(0.7);
    expect(() => decideFlowType(store, login.id, { action: 'accept' })).toThrow(/merged/);
  });

  it('merging reconciles each moved subject: one current version per variant and one primary per subject (F1)', () => {
    const r = flowRepos(store);
    const { flowType: login } = proposeFlowType(store, 'ws_a', { key: 'log_in', name: 'Log in', definition: 'Get into an account' });
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const LATER = '2026-11-14T11:00:00.000Z';
    // Acme has an "email" flow in both types (both current, both primary) and a "google" flow in the merged type.
    r.flows.insert({ ...flowRow('flw_old', signIn.id), variant: 'Email', variantKey: 'email' });
    r.flows.insert({ ...flowRow('flw_new', login.id), variant: 'Email', variantKey: 'email', firstSeenAt: LATER });
    r.flows.insert({ ...flowRow('flw_g', login.id), variant: 'Google', variantKey: 'google', isPrimary: false });
    // Another subject only in the target type is left as it is.
    r.flows.insert({ ...flowRow('flw_other', signIn.id), subjectEntityId: 'ent_globex' });

    decideFlowType(store, login.id, { action: 'merge', intoId: signIn.id });
    const current = r.flows.list({ flowTypeId: signIn.id, subjectEntityId: 'ent_acme', lifecycle: 'current' });
    expect(current.map((f) => f.id).sort()).toEqual(['flw_g', 'flw_new']);
    expect(current.filter((f) => f.isPrimary).map((f) => f.id)).toEqual(['flw_new']);
    expect(r.flows.get('flw_old')?.lifecycle).toBe('replaced');
    expect(r.flows.get('flw_other')).toMatchObject({ lifecycle: 'current', isPrimary: true });
  });

  it('merging into itself, into another tree, or into a merged or rejected type is refused', () => {
    const { flowType: other } = proposeFlowType(store, 'ws_a', { key: 'other', name: 'Other', definition: 'x' });
    const { flowType: login } = proposeFlowType(store, 'ws_a', { key: 'log_in', name: 'Log in', definition: 'x' });
    decideFlowType(store, login.id, { action: 'merge', intoId: flowTypeByKey(store, 'ws_a', 'sign_in')!.id });
    const { flowType: junk } = proposeFlowType(store, 'ws_a', { key: 'junk', name: 'Junk', definition: 'x' });
    decideFlowType(store, junk.id, { action: 'reject' });
    const signInB = flowTypeByKey(store, 'ws_b', 'sign_in')!;

    expect(() => decideFlowType(store, other.id, { action: 'merge', intoId: other.id })).toThrow(/itself/);
    expect(() => decideFlowType(store, other.id, { action: 'merge', intoId: signInB.id })).toThrow(/not found/);
    expect(() => decideFlowType(store, other.id, { action: 'merge', intoId: login.id })).toThrow(/merged/);
    expect(() => decideFlowType(store, other.id, { action: 'merge', intoId: junk.id })).toThrow(/rejected/);
    expect(flowRepos(store).flowTypes.get(other.id)?.status).toBe('proposed');
  });

  it('proposing an existing key returns it with created false', () => {
    const signUp = flowTypeByKey(store, 'ws_a', 'sign_up')!;
    const again = proposeFlowType(store, 'ws_a', { key: '  Sign Up ', name: 'Register', definition: 'x' });
    expect(again).toEqual({ flowType: signUp, created: false });
    const first = proposeFlowType(store, 'ws_a', { key: 'Export  Data', name: 'Export data', definition: 'x' });
    expect(first.flowType.key).toBe('export_data');
    const second = proposeFlowType(store, 'ws_a', { key: 'export data', name: 'Export', definition: 'y' });
    expect(second).toEqual({ flowType: first.flowType, created: false });
    expect(listFlowTypes(store, 'ws_a')).toHaveLength(10);
  });

  it('a proposed checklist does not change activeChecklists until accepted, then the old one is retired', () => {
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const before = activeChecklists(store, 'ws_a', signIn.id);
    expect(before.general.flowTypeId).toBeUndefined();
    expect(before.specific).toMatchObject({ version: 1, status: 'active', coverage: 0.7 });

    const draft = proposeChecklist(store, 'ws_a', { flowTypeId: signIn.id, coverage: 0.5, items: ITEMS, origin: 'agent' });
    expect(draft).toMatchObject({ status: 'proposed', version: 2, origin: 'agent', rootWorkspaceId: 'ws_a', flowTypeId: signIn.id });
    expect(draft.id.startsWith('ckl_')).toBe(true);
    expect(activeChecklists(store, 'ws_a', signIn.id).specific?.id).toBe(before.specific!.id);

    const accepted = decideChecklist(store, draft.id, { action: 'accept', coverage: 0.8 });
    expect(accepted).toMatchObject({ status: 'active', coverage: 0.8 });
    expect(accepted.acceptedAt).toBeTruthy();
    expect(activeChecklists(store, 'ws_a', signIn.id).specific?.id).toBe(draft.id);
    expect(flowRepos(store).checklists.get(before.specific!.id)?.status).toBe('retired');
    expect(activeChecklists(store, 'ws_a', signIn.id).general.id).toBe(before.general.id);

    const rejected = proposeChecklist(store, 'ws_a', { flowTypeId: signIn.id, coverage: 0.4, items: ITEMS, origin: 'user' });
    expect(rejected.version).toBe(3);
    expect(decideChecklist(store, rejected.id, { action: 'reject' }).status).toBe('retired');
    expect(activeChecklists(store, 'ws_a', signIn.id).specific?.id).toBe(draft.id);
    expect(() => decideChecklist(store, draft.id, { action: 'accept' })).toThrow(/proposed/);

    // A type with no specific checklist gets one on accept.
    const pricing = flowTypeByKey(store, 'ws_a', 'pricing')!;
    expect(activeChecklists(store, 'ws_a', pricing.id).specific).toBeUndefined();
    const p = proposeChecklist(store, 'ws_a', { flowTypeId: pricing.id, coverage: 0.5, items: ITEMS, origin: 'agent' });
    expect(p.version).toBe(1);
    decideChecklist(store, p.id, { action: 'accept' });
    expect(activeChecklists(store, 'ws_a', pricing.id).specific).toMatchObject({ id: p.id, coverage: 0.5 });
  });

  it('a proposed checklist is validated', () => {
    const pricing = flowTypeByKey(store, 'ws_a', 'pricing')!;
    const propose = (over: { coverage?: number; items?: ChecklistItem[]; flowTypeId?: string }) =>
      proposeChecklist(store, 'ws_a', { flowTypeId: over.flowTypeId ?? pricing.id, coverage: over.coverage ?? 0.5, items: over.items ?? ITEMS, origin: 'agent' });
    expect(() => propose({ items: [ITEMS[0]!, ITEMS[0]!] })).toThrow(/unique/);
    expect(() => propose({ coverage: 1.2 })).toThrow(/coverage/);
    expect(() => propose({ coverage: -0.1 })).toThrow(/coverage/);
    expect(() => propose({ items: [{ ...ITEMS[0]!, pass: undefined }] })).toThrow(/pass/);
    const many = Array.from({ length: 41 }, (_, i) => ({ ...ITEMS[0]!, key: `k${i}` }));
    expect(() => propose({ items: many })).toThrow(/40/);
    expect(() => propose({ items: [] })).toThrow();
    expect(() => propose({ flowTypeId: flowTypeByKey(store, 'ws_b', 'pricing')!.id })).toThrow(/not found/);
    expect(() => decideChecklist(store, propose({}).id, { action: 'accept', coverage: 2 })).toThrow(/coverage/);
  });

  it('the general checklist can be proposed and accepted as a new version (F4)', () => {
    const general = activeChecklists(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'sign_in')!.id).general;
    const draft = proposeChecklist(store, 'ws_a', { coverage: 0.35, items: general.items, origin: 'user' });
    expect(draft).toMatchObject({ status: 'proposed', version: 2, rootWorkspaceId: 'ws_a' });
    expect(draft.flowTypeId).toBeUndefined();
    decideChecklist(store, draft.id, { action: 'accept' });
    expect(activeChecklists(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'pricing')!.id).general.id).toBe(draft.id);
    expect(flowRepos(store).checklists.get(general.id)?.status).toBe('retired');
    // The specific checklists are untouched.
    expect(activeChecklists(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'sign_in')!.id).specific?.version).toBe(1);
  });

  it("editChecklist: the user's edit of coverage, weights, questions and removals is a new active version of origin user, answers carried (F4)", () => {
    const r = flowRepos(store);
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const before = activeChecklists(store, 'ws_a', signIn.id);
    const [first, second, third] = before.specific!.items;
    r.flows.insert(flowRow('flw_1', signIn.id));
    for (const item of [first!, second!]) {
      r.flowChecks.insert({ flowId: 'flw_1', checklistId: before.specific!.id, itemKey: item.key, answer: 'pass', stepRefs: [1], mentionRefs: [], origin: 'walkthrough', updatedAt: NOW });
    }
    const out = editChecklist(store, 'ws_a_child', {
      checklistId: before.specific!.id,
      coverage: 0.8,
      items: [
        { key: first!.key, weight: 3, question: '  Is it quick to sign in?  ' },
        { key: third!.key, remove: true },
      ],
    });
    expect(out.checklist).toMatchObject({ status: 'active', origin: 'user', version: 2, coverage: 0.8, flowTypeId: signIn.id });
    expect(out.checklist.items.map((i) => i.key)).toEqual(before.specific!.items.filter((i) => i.key !== third!.key).map((i) => i.key));
    expect(out.checklist.items[0]).toEqual({ ...first!, weight: 3, question: 'Is it quick to sign in?' });
    expect(out.previous.id).toBe(before.specific!.id);
    expect(r.checklists.get(before.specific!.id)?.status).toBe('retired');
    expect(activeChecklists(store, 'ws_a', signIn.id).specific?.id).toBe(out.checklist.id);
    expect(coverageOf(store, 'ws_a', signIn.id)).toBe(0.8);
    // The answers carry to the new version (the kind and pass rule are unchanged); the flow still misses others.
    expect(r.flowChecks.list({ flowId: 'flw_1', checklistId: out.checklist.id }).map((c) => c.itemKey).sort()).toEqual([first!.key, second!.key].sort());
    expect(out.needRewalk).toEqual(['flw_1']);

    // The general checklist too: its coverage and an item's weight.
    const g = editChecklist(store, 'ws_a', { checklistId: before.general.id, coverage: 0.4, items: [{ key: before.general.items[0]!.key, weight: 2 }] });
    expect(g.checklist).toMatchObject({ version: 2, origin: 'user', coverage: 0.4 });
    expect(g.checklist.flowTypeId).toBeUndefined();
    expect(activeChecklists(store, 'ws_a', signIn.id).general.id).toBe(g.checklist.id);
  });

  it('editChecklist refuses what this editor does not do: new items, kind or pass rule changes, bad values, no change, a retired or foreign checklist (F4)', () => {
    const signIn = flowTypeByKey(store, 'ws_a', 'sign_in')!;
    const c = activeChecklists(store, 'ws_a', signIn.id).specific!;
    const key = c.items[0]!.key;
    const edit = (items: unknown[], extra: { coverage?: number; checklistId?: string; ws?: string } = {}) =>
      editChecklist(store, extra.ws ?? 'ws_a', { checklistId: extra.checklistId ?? c.id, items: items as never, ...(extra.coverage !== undefined ? { coverage: extra.coverage } : {}) });
    expect(() => edit([{ key: 'brand_new', question: 'New?' }])).toThrow(/adding items/);
    expect(() => edit([{ key, kind: 'count' }])).toThrow(/kind or pass rule/);
    expect(() => edit([{ key, pass: { answer: 'no' } }])).toThrow(/kind or pass rule/);
    expect(() => edit([{ key, weight: 0 }])).toThrow(/weight/);
    expect(() => edit([{ key, weight: Number.NaN }])).toThrow(/weight/);
    expect(() => edit([{ key, question: '   ' }])).toThrow(/question/);
    expect(() => edit([{ key, weight: 1 }, { key, weight: 2 }])).toThrow(/twice/);
    expect(() => edit(c.items.map((i) => ({ key: i.key, remove: true })))).toThrow(/at least one item/);
    expect(() => edit([], { coverage: 1.5 })).toThrow(/coverage/);
    expect(() => edit([])).toThrow(/nothing to change/);
    expect(() => edit([{ key, weight: c.items[0]!.weight }], { coverage: c.coverage })).toThrow(/nothing to change/);
    expect(() => edit([{ key, weight: 2 }], { ws: 'ws_b' })).toThrow(/not found/);
    const done = edit([{ key, weight: 2 }]);
    expect(() => edit([{ key, weight: 3 }])).toThrow(/active/); // the edited version was retired
    expect(flowRepos(store).checklists.list({ rootWorkspaceId: 'ws_a', flowTypeId: signIn.id }).map((x) => [x.version, x.status])).toEqual([[1, 'retired'], [2, 'active']]);
    expect(done.checklist.version).toBe(2);
  });

  it('coverageOf is 0.7 for sign_in and generalCoverage for a type with no specific checklist', () => {
    expect(coverageOf(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'sign_in')!.id)).toBe(0.7);
    expect(coverageOf(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'sign_up')!.id)).toBe(0.6);
    expect(coverageOf(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'account_recovery')!.id)).toBe(0.6);
    expect(coverageOf(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'checkout')!.id)).toBe(0.6);
    expect(coverageOf(store, 'ws_a', flowTypeByKey(store, 'ws_a', 'onboarding')!.id)).toBe(0.3);
  });

  it('every built-in item has a unique key and scored items have a pass rule', () => {
    expect(BUILTIN_FLOW_TYPES).toHaveLength(9);
    expect(new Set(BUILTIN_FLOW_TYPES.map((t) => t.key)).size).toBe(9);
    expect(BUILTIN_CHECKLISTS).toHaveLength(5);
    const counts = BUILTIN_CHECKLISTS.map((c) => [c.flowTypeKey ?? 'general', c.items.length, c.items.filter((i) => i.scored).length]);
    // Rows and objective rows of spec Appendix A.1–A.5.
    expect(counts).toEqual([['general', 14, 11], ['sign_up', 13, 10], ['sign_in', 13, 10], ['account_recovery', 7, 6], ['checkout', 10, 7]]);
    for (const c of BUILTIN_CHECKLISTS) {
      if (c.flowTypeKey) expect(BUILTIN_FLOW_TYPES.map((t) => t.key)).toContain(c.flowTypeKey);
      expect(new Set(c.items.map((i) => i.key)).size).toBe(c.items.length);
      for (const i of c.items) {
        expect(i.key).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
        expect(i.weight).toBe(1);
        if (i.scored) expect(i.pass, i.key).toBeDefined();
        if (i.kind === 'recorded') expect(i.scored).toBe(false);
      }
    }
  });
});
