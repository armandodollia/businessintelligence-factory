import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { redactSecrets } from '../store/redact.js';
import { newId } from '../store/repos.js';
import type {
  CrossCuttingGroup,
  Decision,
  Rating,
  Rollup,
  Sourced,
  Symptom,
  UnitProposal,
  Workspace,
} from '../types.js';
import { ancestors, audiencesOf, children, createWorkspace, descendants, scopeOf, siblings } from './tree.js';
import type { BriefLine } from '../knowledge/briefing.js'; // KS-5
import { servedLine } from '../knowledge/texts.js'; // KS-5

// ---------------------------------------------------------------------------
// reading across the tree

// `read_workspace` is a knowledge read tool since KS-4 (node card + counts: knowledge/cards.ts).

// --- knowledge store KS-5: tree context as briefing lines (design §11 "Tree context") ---------------
// One line per related node (ancestors, children, siblings): name and scope, redacted then cut — no
// findings and no profile values (KS-5 replaces the pre-KS `relatedSection`, which listed every finding
// of every ancestor and sibling and never redacted). Their knowledge is one call away: `get_card` /
// `read_workspace` with the node id, or `search` with `scope: "tree"`.

function describeScope(store: Store, viewer: string, ws: Workspace): string {
  const s = scopeOf(ws);
  return `${s.level} "${servedLine(store, viewer, s.name, 120)}"${s.description ? `: ${servedLine(store, viewer, s.description, 200)}` : ''}`;
}

/** Tree context lines for `ws`'s briefing (parents first, then children, then siblings); none for a one-node tree. */
export function treeLines(store: Store, ws: Workspace, max = 12): BriefLine[] {
  const line = (label: string, n: Workspace): BriefLine => {
    const keys = Object.keys(store.profiles.get(n.id)?.data ?? {});
    const profile = label === 'Sibling' || !keys.length ? '' : `; profile keys: ${keys.slice(0, 12).map((k) => servedLine(store, ws.id, k, 40)).join(', ')}`;
    return {
      text: `- ${label}: [${n.id}] ${servedLine(store, ws.id, n.name, 120)} (${describeScope(store, ws.id, n)}; audiences: ${audiencesOf(n).join(', ')}${profile})`,
      refs: [], upload: false,
    };
  };
  const nodes = [
    ...ancestors(store, ws.id).map((a, i) => line(i === 0 ? 'Parent' : `Ancestor (${i + 1} up)`, a)),
    ...children(store, ws.id).map((c) => line('Child', c)),
    ...siblings(store, ws.id).map((s) => line('Sibling', s)),
  ];
  if (!nodes.length) return [];
  const shown = nodes.slice(0, max);
  return [
    { text: 'Business tree (other nodes: get_card / read_workspace with their id, or search with scope "tree"):', refs: [], upload: false, heading: true },
    ...shown,
    ...(nodes.length > shown.length ? [{ text: `- … ${nodes.length - shown.length} more node(s): read_workspace`, refs: [], upload: false }] : []),
  ];
}

/**
 * Orchestrator context for the business tree: this node's scope and audiences. The related nodes are
 * part of the knowledge briefing (`treeLines`, KS-5).
 */
export function treeContext(store: Store, ws: Workspace): string[] {
  return [
    `## Scope\n${describeScope(store, ws.id, ws)}\nAudiences: ${audiencesOf(ws).join(', ')}\nFrame every task to this scope and these audiences.`,
  ];
}
// --- end KS-5 ------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mapping

/**
 * `propose_business_unit` (worker role, `map_business_units` tasks): stores a `UnitProposal` and logs
 * a Decision (ratable). Evidence must be artifacts of this business tree.
 */
export const proposeBusinessUnitHandler: ExtraToolHandler = async (ctx, rawInput, deps) => {
  const input = rawInput as ToolInput<'propose_business_unit'>;
  const { store, artifacts, events } = deps;
  const missing = artifacts.exists(ctx.workspaceId, input.evidence);
  if (missing.length) return { ok: false, error: `evidence references unknown artifacts: ${missing.join(', ')}` };
  // Agent-written text is shown in the UI and logged: strip identity secrets first.
  const text = redactSecrets(store, ctx.workspaceId, { name: input.name, description: input.description, reasoning: input.reasoning });
  // Idempotent per (task, unit name). A still-pending proposal is revised in place when the agent
  // changed its description, level, audiences, evidence or reasoning (the revision is logged);
  // accepted / rejected proposals are never mutated.
  const replay = findReplay(store, ctx, 'propose_business_unit', 'task', (p) => titleKey(String(p.name)) === titleKey(text.name));
  if (replay) {
    const proposalId = (replay.payload as { proposalId: string }).proposalId;
    const existing = store.unitProposals.get(proposalId);
    if (!existing || existing.status !== 'proposed') {
      return { ok: true, data: { proposalId, duplicate: true, status: existing?.status } };
    }
    const next = {
      description: text.description,
      level: input.level,
      audiences: [...new Set(input.audiences)],
      evidence: [...new Set([...existing.evidence, ...input.evidence])],
      reasoning: text.reasoning,
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (k) => JSON.stringify(existing[k]) !== JSON.stringify(next[k]),
    );
    if (!changed.length) return { ok: true, data: { proposalId, duplicate: true } };
    const revision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'decision',
      payload: redactSecrets(store, ctx.workspaceId, {
        tool: 'propose_business_unit',
        proposalId,
        name: existing.name,
        revision: true,
        changed,
        previous: Object.fromEntries(changed.map((k) => [k, existing[k]])),
        level: next.level,
        audiences: next.audiences,
        reasoning: next.reasoning,
      }),
      refs: [proposalId, ...next.evidence, ...(ctx.taskId ? [ctx.taskId] : [])],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    store.transaction(() => {
      store.unitProposals.update(proposalId, { ...next, decisionId: revision.id });
      store.decisions.insert(revision);
    });
    events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: revision });
    return { ok: true, data: { proposalId, duplicate: true, updated: changed } };
  }
  const proposal: UnitProposal = {
    id: newId('unit'),
    workspaceId: ctx.workspaceId,
    name: text.name,
    description: text.description,
    level: input.level,
    audiences: [...new Set(input.audiences)],
    evidence: input.evidence,
    reasoning: text.reasoning,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind: 'decision',
    payload: redactSecrets(store, ctx.workspaceId, {
      tool: 'propose_business_unit',
      proposalId: proposal.id,
      name: proposal.name,
      level: proposal.level,
      audiences: proposal.audiences,
      reasoning: proposal.reasoning,
    }),
    refs: [proposal.id, ...proposal.evidence, ...(ctx.taskId ? [ctx.taskId] : [])],
    promptVersion: ctx.promptVersion,
    createdAt: proposal.createdAt,
  };
  proposal.decisionId = decision.id;
  store.transaction(() => {
    store.unitProposals.insert(proposal);
    store.decisions.insert(decision);
  });
  events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
  return { ok: true, data: { proposalId: proposal.id } };
};

export type UnitProposalEdits = Partial<Pick<UnitProposal, 'name' | 'description' | 'level' | 'audiences'>>;

function pendingProposal(store: Store, id: string): UnitProposal {
  const p = store.unitProposals.get(id);
  if (!p) throw new Error(`unit proposal '${id}' not found`);
  if (p.status !== 'proposed') throw new Error(`unit proposal '${id}' is already ${p.status}`);
  return p;
}

/** Accepts a proposal (optionally edited): creates the child workspace linked to the proposing one. */
export function acceptUnitProposal(store: Store, id: string, edits: UnitProposalEdits = {}): Workspace {
  return store.transaction(() => {
    const p = pendingProposal(store, id);
    const parent = store.workspaces.get(p.workspaceId);
    if (!parent) throw new Error(`workspace '${p.workspaceId}' not found`);
    const merged = { ...p, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)) };
    const child = createWorkspace(store, {
      name: merged.name,
      sector: parent.sector,
      scope: { level: merged.level, name: merged.name, description: merged.description },
      audiences: merged.audiences,
      parentWorkspaceId: parent.id,
    });
    store.unitProposals.update(id, {
      name: merged.name,
      description: merged.description,
      level: merged.level,
      audiences: merged.audiences,
      status: 'accepted',
      childWorkspaceId: child.id,
    });
    return child;
  });
}

/** Rejects a proposal and records a negative rating on its Decision (a learning signal). */
export function rejectUnitProposal(store: Store, id: string, reason: string): { proposal: UnitProposal; rating: Rating } {
  return store.transaction(() => {
    const p = pendingProposal(store, id);
    const proposal = store.unitProposals.update(id, { status: 'rejected' });
    const rating: Rating = {
      id: newId('rat'),
      workspaceId: p.workspaceId,
      targetType: 'decision',
      targetId: p.decisionId ?? p.id,
      criterion: 'unit_proposal',
      agentValue: 'proposed',
      verdict: 'disagree',
      userValue: 'rejected',
      createdAt: new Date().toISOString(),
    };
    if (reason) rating.reason = reason;
    store.ratings.insert(rating);
    return { proposal, rating };
  });
}

// ---------------------------------------------------------------------------
// roll-up

const tag = <T extends { workspaceId: string }>(items: T[]): Sourced<T>[] =>
  items.map((i) => ({ ...i, sourceWorkspaceId: i.workspaceId }));

/**
 * Own + descendants' symptoms/strengths, recommendations and findings, tagged by source workspace.
 * Superseded outputs (replaced in a later review round) are left out.
 */
export function rollup(store: Store, wsId: string): Rollup {
  const ids = [wsId, ...descendants(store, wsId).map((w) => w.id)];
  const live = <T extends { status?: string | undefined }>(xs: T[]) => xs.filter((x) => x.status !== 'superseded');
  return {
    symptoms: ids.flatMap((id) => tag(store.symptoms.list({ workspaceId: id }))),
    recommendations: ids.flatMap((id) => tag(live(store.recommendations.list({ workspaceId: id })))),
    findings: ids.flatMap((id) => tag(live(store.findings.list({ workspaceId: id })))),
  };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with', 'by', 'at', 'from', 'is', 'are',
  'was', 'were', 'be', 'too', 'very', 'our', 'their', 'its', 'it', 'this', 'that', 'as', 'not', 'no',
]);

/** Lowercase, punctuation stripped, stopwords removed. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

/**
 * Descendant symptoms grouped by normalized title. Each descendant is attributed to its top-level
 * child of `wsId` (the branch it sits in); only groups present under ≥ 2 distinct top-level children
 * are returned (possible company-wide issues). `sourceWorkspaceIds` lists the actual source nodes,
 * `childWorkspaceIds` the top-level children they roll up to.
 */
export function crossCuttingSymptoms(store: Store, wsId: string): CrossCuttingGroup[] {
  const groups = new Map<string, { symptoms: Sourced<Symptom>[]; branches: Set<string> }>();
  const visit = (branch: string) => {
    for (const ws of [store.workspaces.get(branch)!, ...descendants(store, branch)]) {
      for (const s of store.symptoms.list({ workspaceId: ws.id, kind: 'symptom' })) {
        const key = normalizeTitle(s.title);
        if (!key) continue;
        const g = groups.get(key) ?? { symptoms: [], branches: new Set<string>() };
        g.symptoms.push({ ...s, sourceWorkspaceId: ws.id });
        g.branches.add(branch);
        groups.set(key, g);
      }
    }
  };
  for (const child of children(store, wsId)) visit(child.id);
  const out: CrossCuttingGroup[] = [];
  for (const [key, g] of groups) {
    if (g.branches.size < 2) continue;
    out.push({
      key,
      title: g.symptoms[0]!.title,
      sourceWorkspaceIds: [...new Set(g.symptoms.map((s) => s.sourceWorkspaceId))],
      childWorkspaceIds: [...g.branches],
      symptoms: g.symptoms,
    });
  }
  return out;
}
