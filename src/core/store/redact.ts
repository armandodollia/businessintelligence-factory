import type { Identity } from '../types.js';

export const REDACTED = '[redacted]';

/** Anything that can list a workspace's identities (the store or its repos). */
export type IdentitySource = { identities: { list(filter: { workspaceId: string }): Identity[] } };

/** Replaces every identity secret (site and inbox passwords) of the workspace found anywhere in `value`. */
export function redactSecrets<T>(source: IdentitySource, workspaceId: string, value: T): T {
  const secrets = source.identities
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
