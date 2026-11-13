/**
 * KS-3 fixture: tree A (root ws_a "Acme" → children ws_c "Acme Payments" and ws_d "Acme Labs") and
 * tree B (ws_b "Beta"), plus row helpers that insert records directly (no tool calls).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../../src/core/store/db.js';
import type { Artifact, Competitor, Finding, OutputStatus, Persona, Symptom, SymptomHypothesis } from '../../../src/core/types.js';

export const T0 = '2026-11-13T10:00:00.000Z';

export function ks3Store(opened: Store[]): Store {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'bif-ks3-')), 'bif.db'));
  opened.push(s);
  const ws = (id: string, name: string, parent?: string, level = 'company') =>
    s.workspaces.insert({
      id, name, sector: 'saas', createdAt: T0, scope: { level, name, description: '' } as never,
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('ws_a', 'Acme');
  ws('ws_c', 'Acme Payments', 'ws_a', 'division');
  ws('ws_d', 'Acme Labs', 'ws_a', 'division');
  ws('ws_b', 'Beta');
  return s;
}

export function art(s: Store, id: string, ws: string, kind: Artifact['kind'] = 'text', extra: Partial<Artifact> = {}): Artifact {
  return s.artifacts.insert({ id, workspaceId: ws, kind, path: `p/${id}`, sha256: `h_${id}`, mime: 'text/plain', capturedAt: T0, ...extra });
}

export function fact(
  s: Store,
  id: string,
  ws: string,
  opts: { entityId?: string; evidence?: string[]; status?: OutputStatus; subject?: string; extra?: Partial<Finding> } = {},
): Finding {
  return s.findings.insert({
    id, workspaceId: ws, runId: 'rrun_1', taskId: 'tsk_1', subject: opts.subject ?? 'Subject', claim: `claim ${id}`, criteria: {},
    evidence: opts.evidence ?? [], status: opts.status ?? 'verified', createdAt: T0,
    ...(opts.entityId ? { entityId: opts.entityId } : {}), ...opts.extra,
  });
}

export function competitor(s: Store, id: string, ws: string, name: string, opts: { evidence?: string[]; status?: OutputStatus; entityId?: string } = {}): Competitor {
  return s.competitors.insert({
    id, workspaceId: ws, name, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
    evidence: opts.evidence ?? [], createdAt: T0, updatedAt: T0, status: opts.status ?? 'verified',
    ...(opts.entityId ? { entityId: opts.entityId } : {}),
  });
}

export function persona(s: Store, id: string, ws: string, segment: string, opts: { evidence?: string[]; status?: OutputStatus } = {}): Persona {
  const field = { value: 'v', confidence: 0.5, evidence: opts.evidence ?? [] };
  return s.personas.insert({
    id, workspaceId: ws, slug: id, segment, profile: { goals: field }, agentMdPath: `${id}.md`, version: 1, status: opts.status ?? 'verified',
  });
}

export function symptom(s: Store, id: string, ws: string, title: string, opts: { kind?: Symptom['kind']; evidence?: string[] } = {}): Symptom {
  return s.symptoms.insert({ id, workspaceId: ws, kind: opts.kind ?? 'symptom', title, detail: 'd', criteria: {}, evidence: opts.evidence ?? [] });
}

export function hypothesis(
  s: Store,
  id: string,
  ws: string,
  symptomId: string,
  text: string,
  opts: { evidence?: string[]; status?: OutputStatus } = {},
): SymptomHypothesis {
  return s.symptomHypotheses.insert({
    id, workspaceId: ws, symptomId, hypothesis: text, confidence: 60, evidence: opts.evidence ?? [], createdAt: T0, status: opts.status ?? 'verified',
  });
}
