import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import { redactIdentitySecrets } from '../identity/identities.js';
import { loadPrompt } from '../prompts/index.js';
import { PERSONA_FIELDS } from '../scoring/criteria.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Persona, PersonaProfileField } from '../types.js';
import { audiencesOf, scopeOf } from '../workspace/tree.js';
import { compileAgentMd } from './agentMd.js';
// knowledge store KS-3
import { linkPersona } from '../knowledge/entityLinks.js';

export type MarketToolOptions = {
  /** Data root (`data/`); agent.md files go to `<dataDir>/<workspaceId>/personas/<slug>.md`. */
  dataDir: string;
};

const fail = (error: string): ToolResult => ({ ok: false, error });

/** Lowercase, dash-separated slug; empty when nothing usable remains. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** Absolute agent.md path of a persona (always the latest version). */
export function agentMdPath(dataDir: string, workspaceId: string, slug: string): string {
  return join(resolve(dataDir), workspaceId, 'personas', `${slug}.md`);
}

/** Versioned agent.md path next to the latest one: `<slug>.v<N>.md`. */
export function versionedAgentMdPath(latestPath: string, version: number): string {
  return latestPath.replace(/\.md$/, '') + `.v${version}.md`;
}

/**
 * Compiles the persona's agent.md (framed to its workspace scope) and writes it as
 * `<slug>.v<version>.md` (kept per version, spec §8b.3) and as `persona.agentMdPath` (`<slug>.md`,
 * a copy of the latest version, so CLIs always load one stable path).
 */
export function writeAgentMd(store: Store, persona: Persona): string {
  const ws = store.workspaces.get(persona.workspaceId);
  const md = compileAgentMd(persona, ws ? { scopeName: scopeOf(ws).name } : {});
  mkdirSync(dirname(persona.agentMdPath), { recursive: true });
  writeFileSync(versionedAgentMdPath(persona.agentMdPath, persona.version), md);
  writeFileSync(persona.agentMdPath, md);
  return md;
}

/**
 * Worker instructions for `persona_profile` tasks (`prompts/persona_profile.md`). Meant to be
 * appended to the worker system prompt for that task type.
 */
export function personaProfileInstructions(): { text: string; version: string } {
  return loadPrompt('persona_profile');
}

/**
 * `save_persona` handler (market research workers). The dispatcher's zod schema already requires
 * `audience` and every `PERSONA_FIELDS` entry with `{value, confidence 0–1, evidence ≥ 1}`; fields may
 * cite the same artifacts (typical for `personality_values` and `voice`, drawn from the same reviews).
 * Here: every evidence id must exist in the workspace's business tree. Upserts by `(workspace, slug)`,
 * bumps `version`, rewrites `data/<ws>/personas/<slug>.md`, and logs a `score` Decision with the
 * per-field confidences (each ratable), refs = persona + evidence.
 */
export function savePersonaHandler(opts: MarketToolOptions): ExtraToolHandler {
  return async (ctx, raw, deps) => {
    const input = raw as ToolInput<'save_persona'>;
    const { store, artifacts, events } = deps;
    const slug = slugify(input.slug ?? input.segment);
    if (!slug) return fail('slug: cannot derive a slug (use letters or digits)');
    const ws = store.workspaces.get(ctx.workspaceId);
    const audiences = ws ? audiencesOf(ws) : [];
    if (!audiences.includes(input.audience)) {
      return fail(`audience '${input.audience}' is not an audience of this workspace (audiences: ${audiences.join(', ') || 'none'})`);
    }

    const profile: Record<string, PersonaProfileField> = {};
    for (const f of PERSONA_FIELDS) {
      const v = input.profile[f];
      profile[f] = { value: v.value, confidence: v.confidence, evidence: [...new Set(v.evidence)] };
    }
    const allEvidence = [...new Set(PERSONA_FIELDS.flatMap((f) => profile[f]!.evidence))];
    const missing = artifacts.exists(ctx.workspaceId, allEvidence);
    if (missing.length) {
      return fail(`evidence references unknown artifacts (not in this workspace's business tree): ${missing.join(', ')}`);
    }

    const { persona, decision } = store.transaction(() => {
      const existing = store.personas.list({ workspaceId: ctx.workspaceId, slug })[0];
      const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
      const owner = task && task.workspaceId === ctx.workspaceId ? task : undefined;
      const persona: Persona = {
        id: existing?.id ?? newId('per'),
        workspaceId: ctx.workspaceId,
        slug,
        segment: input.segment,
        profile,
        agentMdPath: agentMdPath(opts.dataDir, ctx.workspaceId, slug),
        version: (existing?.version ?? 0) + 1,
        audience: input.audience,
        // Review tracking (migration 11): this save is pending until its task's review loop ends.
        status: 'pending',
        taskId: owner?.id,
        taskRound: owner?.round,
      };
      if (existing) store.personas.update(persona.id, persona);
      else store.personas.insert(persona);
      linkPersona(store, { ...persona, entityId: existing?.entityId }, { agentRunId: ctx.agentRunId }); // knowledge store KS-3

      const decision: Decision = {
        id: newId('dec'),
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        role: ctx.role,
        model: ctx.model,
        kind: 'score',
        payload: redactIdentitySecrets(store, ctx.workspaceId, {
          tool: 'save_persona',
          personaId: persona.id,
          slug,
          segment: input.segment,
          audience: input.audience,
          version: persona.version,
          confidence: Object.fromEntries(PERSONA_FIELDS.map((f) => [f, profile[f]!.confidence])),
        }),
        refs: [persona.id, ...allEvidence],
        promptVersion: ctx.promptVersion,
        createdAt: new Date().toISOString(),
      };
      store.decisions.insert(decision);
      // Written inside the transaction: a failed write rolls the row and decision back.
      writeAgentMd(store, persona);
      return { persona, decision };
    });
    events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
    return {
      ok: true,
      data: { personaId: persona.id, slug, version: persona.version, agentMdPath: persona.agentMdPath },
    };
  };
}

/**
 * `submit_persona_feedback` handler (persona panel runs). Only validates that the recommendation
 * belongs to this workspace; the dispatcher writes the `persona_feedback` Decision on success and
 * `runPersonaPanel` attaches the feedback to the recommendation (it knows which persona ran).
 */
export const submitPersonaFeedbackHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'submit_persona_feedback'>;
  const rec = deps.store.recommendations.get(input.recommendation_id);
  if (!rec || rec.workspaceId !== ctx.workspaceId) {
    return fail(`recommendation '${input.recommendation_id}' not found in this workspace`);
  }
  return { ok: true, data: { recorded: true, recommendationId: rec.id, simulated: true } };
};

/**
 * Task 12 tool handlers, to pass as (part of) `createToolHandlers({ extraHandlers })`:
 * `save_persona`, `submit_persona_feedback`.
 */
export function marketToolHandlers(opts: MarketToolOptions): Partial<Record<ToolName, ExtraToolHandler>> {
  return {
    save_persona: savePersonaHandler(opts),
    submit_persona_feedback: submitPersonaFeedbackHandler,
  };
}
