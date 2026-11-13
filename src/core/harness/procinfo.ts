import { execFileSync } from 'node:child_process';
import { uptime } from 'node:os';

/**
 * Start time of a live process as printed by `ps -o lstart=` (e.g. `Thu Nov 12 22:00:36 2026`), or
 * `undefined` when the process does not exist or `ps` is unavailable (Windows).
 */
export function processStartTime(pid: number): string | undefined {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      // Fixed locale: the recorded and the re-read start time must use the same format.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out ? out.replace(/\s+/g, ' ') : undefined;
  } catch {
    return undefined;
  }
}

/** True while any process in group `pgid` exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Decides whether process group `pid` is still the CLI we spawned (started at `startedAt`):
 * - the start time must be known and after the last boot (a reboot recycles pids);
 * - if the group leader is alive, its start time must match;
 * - if the leader is gone but the group lives on, the pgid cannot have been reused (a pid is not
 *   reassigned while a process group with that id exists), so the group is ours.
 */
export function isOurProcessGroup(pid: number, startedAt: string | undefined): { ours: boolean; reason: string } {
  if (!startedAt) return { ours: false, reason: 'no recorded start time' };
  const started = Date.parse(startedAt);
  const bootedAt = Date.now() - uptime() * 1000;
  if (!Number.isFinite(started)) return { ours: false, reason: `unparseable start time '${startedAt}'` };
  // lstart has 1 s resolution; allow a little slack against the boot estimate.
  if (started < bootedAt - 5000) return { ours: false, reason: 'process started before the last boot' };
  if (!groupAlive(pid)) return { ours: false, reason: 'process group is gone' };
  const leader = processStartTime(pid);
  if (leader !== undefined && leader !== startedAt) {
    return { ours: false, reason: `pid ${pid} now belongs to another process (started ${leader})` };
  }
  return { ours: true, reason: leader ? 'leader start time matches' : 'leader gone, group still alive' };
}
