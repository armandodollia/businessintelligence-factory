import type { Workspace } from '../types.js';

export type ScopeLevel = 'company' | 'division' | 'slice';
export type Audience = 'external' | 'internal';
export type ScopeInfo = { level: ScopeLevel; name: string; description: string; audiences: Audience[] };

const LEVELS: readonly ScopeLevel[] = ['company', 'division', 'slice'];

/**
 * Reads a workspace's scope + audiences (Section C adds these fields; older rows may lack them).
 * Defaults: level `company`, name = workspace name, description `''`, audiences `['external']`.
 */
export function scopeOf(ws: Workspace): ScopeInfo {
  const w = ws as Workspace & { scope?: unknown; audiences?: unknown };
  const s = (w.scope && typeof w.scope === 'object' ? w.scope : {}) as Record<string, unknown>;
  const level = LEVELS.includes(s.level as ScopeLevel) ? (s.level as ScopeLevel) : 'company';
  const name = typeof s.name === 'string' && s.name ? s.name : ws.name;
  const description = typeof s.description === 'string' ? s.description : '';
  const audiences = Array.isArray(w.audiences)
    ? (w.audiences.filter((a) => a === 'external' || a === 'internal') as Audience[])
    : [];
  return { level, name, description, audiences: audiences.length ? audiences : ['external'] };
}
