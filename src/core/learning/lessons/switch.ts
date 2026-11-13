/**
 * Lessons kill switch (orchestrator ruling R1, wave 2). `lessons.enabled: false` leaves the accepted
 * rules out of every prompt (`calibrationScope` reads it), not only new proposals and the retro. The
 * switch changes the prompt text, so the version of every role with active rules changes too; this
 * records each such role's current prompt version (text included) in the prompt store, so the hash
 * that later runs carry always resolves and the version change is visible in the prompt history.
 * Idempotent (the prompt store keeps the first write); called at boot and by `PUT /api/config` when
 * the switch changes.
 */
import type { BifConfig } from '../../config/schema.js';
import { recordRolePromptVersion } from '../../feedback/actions.js';
import { calibrationScope } from '../../scoring/calibration.js';
import type { Store } from '../../store/db.js';
import type { Role } from '../../types.js';
import { lessonRepos } from './store.js';

export type LessonsPromptVersion = { rootWorkspaceId: string; role: Role; promptVersion: string };

export function recordLessonsPromptVersions(store: Store, config: BifConfig): LessonsPromptVersion[] {
  const pairs = new Map<string, { rootWorkspaceId: string; role: Role }>();
  for (const r of lessonRepos(store).rules.list({ status: 'active' })) {
    if (store.workspaces.get(r.rootWorkspaceId)) pairs.set(`${r.rootWorkspaceId}\u0000${r.role}`, { rootWorkspaceId: r.rootWorkspaceId, role: r.role });
  }
  return [...pairs.values()]
    .sort((a, b) => a.rootWorkspaceId.localeCompare(b.rootWorkspaceId) || a.role.localeCompare(b.role))
    .map((p) => ({ ...p, promptVersion: recordRolePromptVersion(store, config, p.role, calibrationScope(store, config, p.rootWorkspaceId)) }));
}
