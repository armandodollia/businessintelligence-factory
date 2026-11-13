import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** `<dataDir>/<workspaceId>/runs/<agentRunId>`: events, logs and the CLI's working directory. */
export function runDirOf(dataDir: string, workspaceId: string, agentRunId: string): string {
  return join(resolve(dataDir), workspaceId, 'runs', agentRunId);
}

/** Working directory a run's CLI is spawned in. */
export function runCwdOf(dataDir: string, workspaceId: string, agentRunId: string): string {
  return join(runDirOf(dataDir, workspaceId, agentRunId), 'cwd');
}

/** Real path of `p`; for a missing path, the real path of its nearest existing ancestor plus the rest. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

function inside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * True when `filePath` (after resolving symlinks) is inside the run's cwd, or inside the OS temp
 * dir but outside the data dir (other runs' files and the database are never readable this way).
 */
export function isAllowedRunFile(filePath: string, dataDir: string, workspaceId: string, agentRunId: string): boolean {
  const file = real(resolve(filePath));
  if (inside(file, real(runCwdOf(dataDir, workspaceId, agentRunId)))) return true;
  return inside(file, real(tmpdir())) && !inside(file, real(resolve(dataDir)));
}
