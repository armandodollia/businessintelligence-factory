import { randomBytes } from 'node:crypto';
import type { Store } from '../store/db.js';
import type { ModelRef, Role } from '../types.js';

/** Identity of one agent run, bound to its MCP URL token. */
export type RunContext = {
  agentRunId: string;
  workspaceId: string;
  taskId?: string;
  role: Role;
  model: ModelRef;
  promptVersion: string;
};

/**
 * Issues unguessable per-run tokens. Tokens are persisted on `AgentRun.token` (with the run's
 * prompt version), so they keep resolving after a restart as long as the run is `running`.
 */
export class TokenRegistry {
  private readonly live = new Map<string, RunContext>();
  private readonly revoked = new Set<string>();

  constructor(private readonly store: Store) {}

  /**
   * Returns a fresh token for `ctx`. Creates the `AgentRun` row (status `running`) if it does not
   * exist yet, otherwise sets its token.
   */
  issue(ctx: RunContext): string {
    const token = `tok_${randomBytes(24).toString('base64url')}`;
    const existing = this.store.agentRuns.get(ctx.agentRunId);
    if (existing) {
      this.store.agentRuns.update(ctx.agentRunId, { token, promptVersion: ctx.promptVersion });
    } else {
      const row: Parameters<Store['agentRuns']['insert']>[0] = {
        id: ctx.agentRunId,
        workspaceId: ctx.workspaceId,
        role: ctx.role,
        model: ctx.model,
        token,
        status: 'running',
        startedAt: new Date().toISOString(),
        promptVersion: ctx.promptVersion,
      };
      if (ctx.taskId !== undefined) row.taskId = ctx.taskId;
      this.store.agentRuns.insert(row);
    }
    this.live.set(token, { ...ctx });
    return token;
  }

  /** The run's context, or null for unknown / revoked tokens and runs no longer `running`. */
  resolve(token: string): RunContext | null {
    if (!token || this.revoked.has(token)) return null;
    const run = this.store.agentRuns.list({ token })[0];
    if (!run || run.status !== 'running') return null;
    const cached = this.live.get(token);
    if (cached) return { ...cached };
    const ctx: RunContext = {
      agentRunId: run.id,
      workspaceId: run.workspaceId,
      role: run.role,
      model: run.model,
      promptVersion: run.promptVersion ?? '',
    };
    if (run.taskId !== undefined) ctx.taskId = run.taskId;
    this.live.set(token, ctx);
    return { ...ctx };
  }

  revoke(token: string): void {
    this.live.delete(token);
    this.revoked.add(token);
  }
}
