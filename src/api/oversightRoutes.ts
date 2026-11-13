import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '../core/config/schema.js';
import { answerEscalation, EscalationError } from '../core/escalation/escalation.js';
import type { EventBus } from '../core/events.js';
import { listPolicyEvents, POLICY_EVENT_KINDS, type PolicyEventFilter } from '../core/policy/policyEvents.js';
import type { Store } from '../core/store/db.js';
import { listBusEvents, PERSISTED_BUS_EVENT_TYPES, type BusEventQuery } from '../core/telemetry/busEvents.js';

/**
 * WP-D routes: answering structured escalation questions, and the action-policy and bus-event
 * history. Mounted by `createApp` before its `/api/*` 404 fallback.
 *
 * - `POST /api/requests/:id/escalation-answer` `{ choice, note? }` → the resolved request
 *   (dismiss an escalation with `POST /api/requests/:id { status: 'denied' }`)
 * - `GET /api/workspaces/:id/policy-events?scope=tree|workspace&role=&kind=&limit=`
 * - `GET /api/workspaces/:id/bus-events?type=&agentRunId=&taskId=&after=&limit=`
 */
export function mountOversightRoutes(app: Hono, deps: { store: Store; events: EventBus }): void {
  const { store, events } = deps;
  const err = (c: Context, status: 400 | 404 | 409, error: string) => c.json({ error }, status);
  const workspaceOr404 = (c: Context) => {
    const id = c.req.param('id') ?? '';
    return store.workspaces.get(id) ? id : undefined;
  };

  const answerSchema = z.object({ choice: z.number().int().min(0), note: z.string().max(2000).optional() });
  app.post('/api/requests/:id/escalation-answer', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, 'request body must be JSON');
    }
    const input = answerSchema.safeParse(raw);
    if (!input.success) return err(c, 400, input.error.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`).join('; '));
    try {
      const answer: { choice: number; note?: string } = { choice: input.data.choice };
      if (input.data.note !== undefined) answer.note = input.data.note;
      return c.json(answerEscalation({ store, events }, c.req.param('id'), answer));
    } catch (e) {
      if (e instanceof EscalationError) return err(c, e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, e.message);
      throw e;
    }
  });

  const limitOf = (v: string | undefined): number | undefined | null => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get('/api/workspaces/:id/policy-events', (c) => {
    const id = workspaceOr404(c);
    if (!id) return err(c, 404, `workspace '${c.req.param('id')}' not found`);
    const filter: PolicyEventFilter = { workspaceId: id };
    const scope = c.req.query('scope');
    if (scope && scope !== 'tree' && scope !== 'workspace') return err(c, 400, `unknown scope '${scope}'`);
    if (scope) filter.scope = scope as 'tree' | 'workspace';
    const role = c.req.query('role');
    if (role) {
      if (!(ROLES as readonly string[]).includes(role)) return err(c, 400, `unknown role '${role}'`);
      filter.role = role as (typeof ROLES)[number];
    }
    const kind = c.req.query('kind');
    if (kind) {
      if (!(POLICY_EVENT_KINDS as readonly string[]).includes(kind)) return err(c, 400, `unknown policy event kind '${kind}'`);
      filter.kinds = [kind as (typeof POLICY_EVENT_KINDS)[number]];
    }
    const limit = limitOf(c.req.query('limit'));
    if (limit === null) return err(c, 400, 'limit must be a positive integer');
    if (limit !== undefined) filter.limit = limit;
    return c.json(listPolicyEvents(store, filter));
  });

  app.get('/api/workspaces/:id/bus-events', (c) => {
    const id = workspaceOr404(c);
    if (!id) return err(c, 404, `workspace '${c.req.param('id')}' not found`);
    const q: BusEventQuery = { workspaceId: id };
    const type = c.req.query('type');
    if (type) {
      if (!(PERSISTED_BUS_EVENT_TYPES as readonly string[]).includes(type)) return err(c, 400, `bus event type '${type}' is not persisted`);
      q.type = type as BusEventQuery['type'] & string;
    }
    const agentRunId = c.req.query('agentRunId');
    if (agentRunId) q.agentRunId = agentRunId;
    const taskId = c.req.query('taskId');
    if (taskId) q.taskId = taskId;
    const after = c.req.query('after');
    if (after !== undefined) {
      const n = Number(after);
      if (!Number.isInteger(n) || n < 0) return err(c, 400, 'after must be a sequence number');
      q.afterSeq = n;
    }
    const limit = limitOf(c.req.query('limit'));
    if (limit === null) return err(c, 400, 'limit must be a positive integer');
    if (limit !== undefined) q.limit = limit;
    return c.json(listBusEvents(store, q));
  });
}
