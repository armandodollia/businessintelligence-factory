import { randomInt } from 'node:crypto';
import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolInput } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Identity } from '../types.js';
import { randomPassword, type EmailProvider } from './email.js';

/** Generic names for disposable identities. */
export const IDENTITY_NAMES: readonly string[] = [
  'Alex Morgan', 'Jordan Lee', 'Taylor Reed', 'Casey Brooks', 'Riley Hayes', 'Jamie Parker',
  'Morgan Ellis', 'Drew Collins', 'Avery Quinn', 'Sam Carter', 'Robin Hart', 'Charlie Shaw',
];

export const REDACTED = '[redacted]';

/** Normalizes a site to its lowercase host without `www.` (`https://www.Acme.com/x` → `acme.com`). */
export function normalizeSite(site: string): string {
  let s = site.trim().toLowerCase();
  try {
    s = new URL(s.includes('://') ? s : `https://${s}`).hostname;
  } catch {
    // keep as typed
  }
  return s.replace(/^www\./, '');
}

/**
 * Returns the workspace's identity for `site`, creating one (generic name, fresh inbox, random site
 * password) on first use. One identity per workspace + site.
 */
export async function getOrCreateIdentity(
  store: Store,
  provider: EmailProvider,
  workspaceId: string,
  site: string,
): Promise<{ identity: Identity; created: boolean }> {
  const host = normalizeSite(site);
  const existing = store.identities.list({ workspaceId, site: host })[0];
  if (existing) return { identity: existing, created: false };
  const inbox = await provider.createInbox();
  const identity: Identity = {
    id: newId('idn'),
    workspaceId,
    site: host,
    name: IDENTITY_NAMES[randomInt(IDENTITY_NAMES.length)]!,
    email: inbox.address,
    password: randomPassword(),
    createdAt: new Date().toISOString(),
  };
  if (inbox.password !== undefined) identity.emailPassword = inbox.password;
  try {
    store.identities.insert(identity);
    return { identity, created: true };
  } catch (e) {
    // Lost a race on (workspace_id, site): use the winner.
    const winner = store.identities.list({ workspaceId, site: host })[0];
    if (winner) return { identity: winner, created: false };
    throw e;
  }
}

/** Replaces every identity secret (site and inbox passwords) of the workspace found in `value`. */
export function redactIdentitySecrets<T>(store: Store, workspaceId: string, value: T): T {
  const secrets = store.identities
    .list({ workspaceId })
    .flatMap((i) => [i.password, i.emailPassword])
    .filter((s): s is string => typeof s === 'string' && s.length >= 4);
  if (!secrets.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return secrets.reduce((acc, s) => acc.split(s).join(REDACTED), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * `get_identity({ site })` handler (worker role). Returns name, email and password for signing up;
 * logs a Decision with the password redacted.
 */
export function getIdentityHandler(provider: EmailProvider): ExtraToolHandler {
  return async (ctx, rawInput, deps) => {
    const input = rawInput as ToolInput<'get_identity'>;
    const { identity, created } = await getOrCreateIdentity(deps.store, provider, ctx.workspaceId, input.site);
    const decision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'decision',
      payload: {
        tool: 'get_identity',
        identityId: identity.id,
        site: identity.site,
        name: identity.name,
        email: identity.email,
        password: REDACTED,
        created,
      },
      refs: ctx.taskId ? [ctx.taskId] : [],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    deps.store.decisions.insert(decision);
    deps.events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
    return {
      ok: true,
      data: { site: identity.site, name: identity.name, email: identity.email, password: identity.password, created },
    };
  };
}
