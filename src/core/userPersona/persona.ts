/**
 * The user persona row (user persona design §5, §9, §16): one `personas` row of `kind: 'user'` per
 * person per business tree, at the tree root, with `subjectId` = the person's actor id (as the feedback
 * log records it; the only place the id is kept). Its slug is `user-<first 8 hex of sha256(actor)>`, so
 * the id never appears in clear in the slug or the label. It has no profile values and no agent.md:
 * its content is its active adjustments ("lines"), each tagged with one of `USER_FIELDS`.
 *
 * It is never a segment or stakeholder persona (`segmentPersonas` / `stakeholderPersonas` never return
 * it), so it takes part in no panel, round, read, question or persona learning run.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_ACTOR } from '../feedback/events.js';
import { activeAdjustments } from '../personas/store.js';
import type { PersonaAdjustment } from '../personas/types.js';
import { USER_FIELDS } from '../scoring/criteria.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Persona, Role } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import type { UserPersonaSettings } from './settings.js';

/** The user persona's label: never a name or an identifier of the person. */
export const USER_PERSONA_LABEL = 'The person you work for';

/** `user-` plus the first 8 hex characters of the sha256 of the actor id. */
export function userPersonaSlug(actor: string): string {
  return `user-${createHash('sha256').update(actor).digest('hex').slice(0, 8)}`;
}

/** The person's user persona of the business tree of `workspaceId` (any node of it), if it exists. */
export function userPersonaOf(store: Store, workspaceId: string, actor: string): Persona | undefined {
  const root = rootOf(store, workspaceId);
  return store.personas.list({ workspaceId: root, kind: 'user', subjectId: actor })[0];
}

/** The person's user persona of the tree, created at the root when missing (one row per tree and person). */
export function ensureUserPersona(store: Store, rootWorkspaceId: string, actor: string): Persona {
  return store.transaction(() => {
    const existing = userPersonaOf(store, rootWorkspaceId, actor);
    if (existing) return existing;
    return store.personas.insert({
      id: newId('per'),
      workspaceId: rootOf(store, rootWorkspaceId),
      slug: userPersonaSlug(actor),
      segment: USER_PERSONA_LABEL,
      profile: {},
      // No agent.md: `writeAgentMd` writes nothing for a user persona.
      agentMdPath: '',
      version: 1,
      kind: 'user',
      subjectId: actor,
      status: 'verified',
      disclosure: 'open',
    });
  });
}

/** The person's active lines in the tree, grouped by field in `USER_FIELDS` order (oldest first within a field); fields without lines are left out. */
export function userLines(store: Store, rootWorkspaceId: string, actor: string): Array<{ field: string; lines: PersonaAdjustment[] }> {
  const persona = userPersonaOf(store, rootWorkspaceId, actor);
  if (!persona) return [];
  const active = activeAdjustments(store, persona.id);
  return USER_FIELDS.flatMap((field) => {
    const lines = active.filter((a) => a.field === field);
    return lines.length ? [{ field, lines }] : [];
  });
}

/**
 * The brief of the person's user persona (design §9): its active lines under "## The person you work
 * for", or undefined when it has none. The actor is a parameter (the caller says who acts); this never
 * reads config.
 */
export function userBrief(store: Store, rootWorkspaceId: string, actor: string): string | undefined {
  const groups = userLines(store, rootWorkspaceId, actor);
  if (!groups.length) return undefined;
  return [
    `## ${USER_PERSONA_LABEL}`,
    '',
    'Learned from their decisions in this tool. Follow it where it does not conflict with the evidence.',
    '',
    ...groups.flatMap(({ field, lines }) => lines.map((a) => `- [${a.marker}.v${a.version}] (${field}) ${a.text}`)),
  ].join('\n');
}

/** The roles whose system prompts carry the brief (design §9); never workers, reviewers, personas, escalation or the retro. */
export const USER_BRIEF_ROLES: ReadonlyArray<Role> = ['orchestrator', 'synthesizer', 'interviewer'];

/**
 * The brief appended to the system prompt `name` (a role) in the business tree of `rootWorkspaceId`:
 * the person's `userBrief` for `USER_BRIEF_ROLES` when the user persona is on and `useInPrompts`, else ''.
 * The actor is the caller's (the person the run works for).
 */
export function promptUserBrief(
  store: Store,
  settings: Pick<UserPersonaSettings, 'enabled' | 'useInPrompts'>,
  rootWorkspaceId: string,
  actor: string,
  name: string,
): string {
  if (!settings.enabled || !settings.useInPrompts || !(USER_BRIEF_ROLES as readonly string[]).includes(name)) return '';
  return userBrief(store, rootWorkspaceId, actor) ?? '';
}

// ---------------------------------------------------------------------------
// the identifier rule (design §13): no identifier of the person in a line or a prompt

const TOKEN_CHAR = '[\\p{L}\\p{N}_-]';
const EMAIL = '[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+';
const REDACTED = '(redacted)';

/**
 * Identifiers of the given actors as one pattern: each actor id as a literal (regex-special characters
 * escaped), case-insensitive, as a whole token (not inside a longer word), plus any email-like string.
 * The default actor id (`DEFAULT_ACTOR`, used when no user is configured) is not an identifier of
 * anybody: it is left out, so ordinary text that happens to contain it stays possible.
 */
function identifierPattern(actors: readonly string[]): RegExp {
  const ids = [...new Set(actors.map((a) => a.trim()).filter((a) => a && a !== DEFAULT_ACTOR))]
    .sort((a, b) => b.length - a.length)
    .map((a) => `(?<!${TOKEN_CHAR})${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${TOKEN_CHAR})`);
  return new RegExp([EMAIL, ...ids].join('|'), 'giu');
}

/** Whether `text` contains one of the actors' ids (whole token, any case) or an email-like string. */
export function containsIdentifier(text: string, actors: readonly string[]): boolean {
  return identifierPattern(actors).test(text);
}

/** `text` with the actors' ids (whole token, any case) and email-like strings replaced by `(redacted)`. */
export function redactIdentifiers(text: string, actors: readonly string[]): string {
  return text.replace(identifierPattern(actors), REDACTED);
}
