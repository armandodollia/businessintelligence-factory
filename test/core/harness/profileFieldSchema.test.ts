import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SHARED_FIELD_SCHEMA_PROVIDERS, toolInputSchemas, toolJsonSchema, type ToolName } from '../../../src/core/harness/tools/registry.js';

/** The JSON schema as zod writes it, every field inline (what the tools advertised before). */
const inline = (name: ToolName) => {
  const s = z.toJSONSchema(toolInputSchemas[name], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
};

/** Replaces every local `$ref` by what it points to, and drops `$defs`. */
function resolveRefs(schema: Record<string, unknown>): unknown {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$ref === 'string') {
      expect(Object.keys(o)).toEqual(['$ref']); // nothing beside the reference
      return walk(defs[o.$ref.replace('#/$defs/', '')]);
    }
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== '$defs').map(([k, x]) => [k, walk(x)]));
  };
  return walk(schema);
}

const PROFILE_TOOLS: ToolName[] = ['save_persona', 'save_stakeholder', 'submit_combined_profile'];

describe('profile tools: the per-field schema is written once for the CLIs it was verified with', () => {
  it('verified with Claude Code and Codex only', () => {
    expect([...SHARED_FIELD_SCHEMA_PROVIDERS].sort()).toEqual(['claude', 'codex']);
  });

  it.each(PROFILE_TOOLS.flatMap((n) => [[n, 'claude'], [n, 'codex']] as const))('%s for %s: every profile field refers to $defs.profile_field; resolved, it is the inline schema', (name, provider) => {
    const schema = toolJsonSchema(name, provider);
    const profile = (schema.properties as Record<string, { properties: Record<string, unknown> }>).profile!;
    const fields = Object.values(profile.properties);
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) expect(f).toEqual({ $ref: '#/$defs/profile_field' });
    expect(Object.keys(schema.$defs as object)).toEqual(['profile_field']);
    expect(resolveRefs(schema)).toEqual(inline(name));
    expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify(inline(name)).length * 0.6);
  });

  it.each(PROFILE_TOOLS)('%s for OpenCode (not verified) and with no provider named: inline, as before', (name) => {
    for (const schema of [toolJsonSchema(name, 'opencode'), toolJsonSchema(name)]) {
      expect(schema.$defs).toBeUndefined();
      expect(schema).toEqual({ ...inline(name), type: 'object' });
    }
  });

  it('every other tool is advertised as before (no $defs), for every provider', () => {
    for (const name of Object.keys(toolInputSchemas) as ToolName[]) {
      if (PROFILE_TOOLS.includes(name)) continue;
      for (const schema of [toolJsonSchema(name), toolJsonSchema(name, 'claude'), toolJsonSchema(name, 'codex'), toolJsonSchema(name, 'opencode')]) {
        expect(schema.$defs).toBeUndefined();
        expect(schema).toEqual({ ...inline(name), type: 'object' });
      }
    }
  });
});
