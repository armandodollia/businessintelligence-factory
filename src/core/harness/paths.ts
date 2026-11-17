import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { basename, dirname, join, resolve } from 'node:path';

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
    // Windows: the native form also expands 8.3 short names (a TEMP of `C:\Users\LONGNA~1\…`).
    return process.platform === 'win32' ? realpathSync.native(p) : realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

/** The path functions of a platform (`node:path`, or its `win32` / `posix` for a test of the other platform). */
export type PathRules = Pick<typeof nodePath, 'relative' | 'isAbsolute'>;

function inside(child: string, root: string, p: PathRules): boolean {
  const rel = p.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * The rule of `isAllowedRunFile` on paths that are already whole and real: `file` is inside the
 * run's `cwd`, or inside the temp folder `tmp` but outside `dataDir`. `p`: the path functions of the
 * platform the paths are of. On Windows that means back-slashes and drive letters: a file on
 * another drive, on a network share or in a folder that merely begins like an allowed one is outside,
 * and the case of a name does not matter.
 */
export function allowedRunPath(file: string, where: { cwd: string; tmp: string; dataDir: string }, p: PathRules = nodePath): boolean {
  if (inside(file, where.cwd, p)) return true;
  return inside(file, where.tmp, p) && !inside(file, where.dataDir, p);
}

/**
 * True when `filePath` (after resolving symlinks) is inside the run's cwd, or inside the OS temp
 * dir but outside the data dir (other runs' files and the database are never readable this way).
 */
export function isAllowedRunFile(filePath: string, dataDir: string, workspaceId: string, agentRunId: string): boolean {
  return allowedRunPath(real(resolve(filePath)), { cwd: real(runCwdOf(dataDir, workspaceId, agentRunId)), tmp: real(tmpdir()), dataDir: real(resolve(dataDir)) });
}
