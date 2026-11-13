/**
 * Versioned calibration (learning loop WP-B). The live appendix stays at
 * `<dataDir>/<root>/calibration/<role>.md` (what `loadPrompt` appends); every version it ever had is
 * kept in `calibration_versions` (per business tree root and role), so an approved patch never
 * overwrites history and any earlier version can be restored.
 *
 * Public API:
 * - `applyPromptPatchVersioned` — `applyPromptPatch` + history (use instead of `applyPromptPatch`).
 * - `calibrationHistory(store, scope, role?)` — versions, oldest first (the last per role is current).
 * - `revertCalibration(store, scope, versionId, actor)` — restores a version (recorded as a new `revert` version).
 * - `setCalibrationDecision` — links a version to the Decision that recorded the user's approval.
 * - `actorOf(config)` — re-export of the one actor helper (`src/core/feedback/events.ts`).
 *
 * The user-facing actions (apply with a Decision + `prompt_patch_apply` feedback event, revert with a
 * Decision + `prompt_patch_revert` event) are `applyPromptPatchAsUser` / `revertCalibrationAsUser`
 * in `src/core/feedback/actions.ts`; call those from routes, not these primitives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../config/schema.js';
import { DEFAULT_ACTOR } from '../feedback/events.js';
import { calibrationDir, type CalibrationScope } from '../prompts/index.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { usageRepos } from '../store/usageRepos.js';
import type { CalibrationVersion, Role } from '../types.js';
import { applyPromptPatch, type PromptPatch } from './calibration.js';

/** One actor helper for the whole app: WP-A's (`config.user.id`, default `local-user`). */
export { actorOf, DEFAULT_ACTOR } from '../feedback/events.js';

const fileOf = (scope: CalibrationScope, role: Role) => join(calibrationDir(scope), `${role}.md`);
const readLive = (scope: CalibrationScope, role: Role) => {
  const f = fileOf(scope, role);
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
};

function checkRole(role: string): asserts role is Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`unknown role '${role}'`);
}

function insertVersion(
  store: Store,
  scope: CalibrationScope,
  role: Role,
  text: string,
  meta: { source: CalibrationVersion['source']; actor: string; revertedFrom?: string },
): CalibrationVersion {
  const v: CalibrationVersion = {
    id: newId('cal'),
    rootWorkspaceId: scope.rootWorkspaceId,
    role,
    text,
    source: meta.source,
    actor: meta.actor,
    createdAt: new Date().toISOString(),
  };
  if (meta.revertedFrom) v.revertedFrom = meta.revertedFrom;
  usageRepos(store).calibrationVersions.insert(v);
  return v;
}

function versionsOf(store: Store, scope: CalibrationScope, role?: Role): CalibrationVersion[] {
  const filter: { rootWorkspaceId: string; role?: Role } = { rootWorkspaceId: scope.rootWorkspaceId };
  if (role) filter.role = role;
  return usageRepos(store).calibrationVersions.list(filter);
}

/**
 * Records the live file as an `import` version when history does not match it (written before
 * migration 15, or edited by hand; a deleted file imports as ''). With `baseline`, an empty `import`
 * is recorded when there is neither history nor a file, so the first patch can be reverted.
 */
export function syncCalibrationFile(
  store: Store,
  scope: CalibrationScope,
  role: Role,
  opts: { actor?: string; baseline?: boolean } = {},
): CalibrationVersion | undefined {
  checkRole(role);
  const live = readLive(scope, role);
  const latest = versionsOf(store, scope, role).at(-1);
  const actor = opts.actor ?? DEFAULT_ACTOR;
  if (latest) {
    const current = live ?? '';
    return current === latest.text ? undefined : insertVersion(store, scope, role, current, { source: 'import', actor });
  }
  if (live !== undefined) return insertVersion(store, scope, role, live, { source: 'import', actor });
  return opts.baseline ? insertVersion(store, scope, role, '', { source: 'import', actor }) : undefined;
}

/** Every calibration version of the tree (one role or all), oldest first, after syncing the live files. */
export function calibrationHistory(store: Store, scope: CalibrationScope, role?: Role): CalibrationVersion[] {
  for (const r of role ? [role] : ROLES) syncCalibrationFile(store, scope, r);
  return versionsOf(store, scope, role);
}

/**
 * `applyPromptPatch` with history: syncs the live file (baseline included), merges the patch, and
 * records the result as an `apply` version. Call only on explicit user approval.
 */
export function applyPromptPatchVersioned(
  store: Store,
  patch: PromptPatch,
  scope: CalibrationScope,
  actor: string = DEFAULT_ACTOR,
): { path: string; text: string; version: CalibrationVersion } {
  checkRole(patch.role);
  syncCalibrationFile(store, scope, patch.role, { actor, baseline: true });
  const { path, text } = applyPromptPatch(patch, scope);
  return { path, text, version: insertVersion(store, scope, patch.role, text, { source: 'apply', actor }) };
}

/**
 * Restores calibration version `versionId` of this business tree: its text becomes the live
 * appendix (so the role's prompt version returns to that version's), recorded as a new `revert`
 * version. Throws for a version of another tree or an unknown id.
 */
export function revertCalibration(
  store: Store,
  scope: CalibrationScope,
  versionId: string,
  actor: string = DEFAULT_ACTOR,
): { path: string; text: string; version: CalibrationVersion } {
  const target = usageRepos(store).calibrationVersions.get(versionId);
  if (!target || target.rootWorkspaceId !== scope.rootWorkspaceId) throw new Error(`calibration version '${versionId}' not found`);
  syncCalibrationFile(store, scope, target.role, { actor });
  const dir = calibrationDir(scope);
  mkdirSync(dir, { recursive: true });
  const path = fileOf(scope, target.role);
  writeFileSync(path, target.text);
  const version = insertVersion(store, scope, target.role, target.text, { source: 'revert', actor, revertedFrom: target.id });
  return { path, text: target.text, version };
}

export function setCalibrationDecision(store: Store, versionId: string, decisionId: string): CalibrationVersion {
  return usageRepos(store).calibrationVersions.update(versionId, { decisionId });
}
