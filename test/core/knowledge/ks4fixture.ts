/**
 * KS-4 fixture: tree A — ws_a "Acme" → ws_c "Acme Payments" → ws_g "Acme Cards", and ws_d "Acme Labs"
 * (sibling of ws_c) — and tree B, ws_b "Beta", with overlapping names and text. Artifacts are saved
 * through the real `ArtifactStore` and ingested (chunks, FTS); facts and records are inserted
 * directly; read tools are called through the real dispatcher (`createToolHandlers`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../../src/core/events.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { createToolHandlers, type ToolResult } from '../../../src/core/harness/tools/handlers.js';
import type { ToolName } from '../../../src/core/harness/tools/registry.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { ingestArtifact } from '../../../src/core/knowledge/ingest.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Artifact, Finding, RetrievalEvent, Role } from '../../../src/core/types.js';

export const T0 = '2026-11-01T10:00:00.000Z';

export function ks4(opened: Store[], tweak?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ks4-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  config.dataDir = dir;
  tweak?.(config);
  const ws = (id: string, name: string, parent?: string, level = 'company') =>
    store.workspaces.insert({
      id, name, sector: 'saas', createdAt: T0, scope: { level, name, description: '' } as never,
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('ws_a', 'Acme');
  ws('ws_c', 'Acme Payments', 'ws_a', 'division');
  ws('ws_g', 'Acme Cards', 'ws_c', 'slice');
  ws('ws_d', 'Acme Labs', 'ws_a', 'division');
  ws('ws_b', 'Beta');
  const artifacts = new ArtifactStore(store, join(dir, 'data'));
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const handle = createToolHandlers({ store, artifacts, config, events });

  /** Saves and ingests a text artifact. */
  async function page(workspaceId: string, content: string, extra: Partial<Parameters<ArtifactStore['save']>[0]> = {}): Promise<Artifact> {
    const a = artifacts.save({ workspaceId, kind: 'text', mime: 'text/plain', bytes: content, ...extra } as Parameters<ArtifactStore['save']>[0]);
    await ingestArtifact({ store, artifacts, config }, a.id);
    return store.artifacts.get(a.id)!;
  }

  /** Inserts a verified current fact (real ULID id). */
  function fact(workspaceId: string, claim: string, extra: Partial<Finding> = {}): Finding {
    return store.findings.insert({
      id: newId('fnd'), workspaceId, runId: 'rrun_x', taskId: 'tsk_x', subject: 'Acme', claim, criteria: {}, evidence: [],
      status: 'verified', createdAt: T0, lastConfirmedAt: T0, ...extra,
    });
  }

  function ctx(workspaceId: string, role: Role = 'worker', extra: Partial<RunContext> = {}): RunContext {
    return { agentRunId: newId('arun'), workspaceId, role, model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv_ks4', ...extra };
  }

  async function call<T = Record<string, unknown>>(c: RunContext, tool: ToolName, input: unknown): Promise<T> {
    const r: ToolResult = await handle(c, tool, input);
    if (!r.ok) throw new Error(r.error);
    return r.data as T;
  }

  function rows(agentRunId: string): RetrievalEvent[] {
    return knowledgeRepos(store).retrievalEvents.list({ agentRunId });
  }

  return { dir, store, config, artifacts, events, seen, handle, page, fact, ctx, call, rows };
}

export type Ks4 = ReturnType<typeof ks4>;
