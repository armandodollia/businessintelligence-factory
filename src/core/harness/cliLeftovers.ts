/**
 * What an agent CLI leaves of a run outside BIF's data folder, and its removal when the run ends, whatever ended
 * it (docs/data-storage.md, "What the agent CLIs keep outside the data folder").
 *
 * Only paths derived from the run itself are removed (its working directory, its session ids), each checked to
 * lie directly inside the folder it belongs in after resolving that folder; never by pattern, and never a file
 * the person's own sessions share.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The CLI session id of one attempt of a run (Claude Code: `--session-id`, which must be a UUID): derived from
 * the run id and the attempt, so the recovery of the next start finds it again without storing it.
 */
export function cliSessionId(agentRunId: string, attempt: number): string {
  const h = createHash('sha256').update(`bif-cli-session:${agentRunId}:${attempt}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest folder name Claude Code writes as is; a longer one gets a hash suffix BIF does not reproduce. */
const CLAUDE_NAME_MAX = 200;

/**
 * The name of the folder Claude Code keeps for a working directory (under `projects/` of its folder and under its
 * temp root): every character but ASCII letters and digits becomes `-` (2.1.325). Undefined when the name is
 * longer than 200 characters: Claude Code then shortens it and adds a hash, which is not guessed here.
 */
export function claudeProjectDirName(path: string): string | undefined {
  const name = path.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= CLAUDE_NAME_MAX ? name : undefined;
}

/** Where Claude Code keeps its files: its folder, and its temp root (none on Windows, where it was not checked). */
export type ClaudeFolders = { configDir: string; tmpRoot?: string };

/**
 * Claude Code's folders as it finds them: `CLAUDE_CONFIG_DIR`, else `~/.claude`; the temp root
 * `<CLAUDE_CODE_TMPDIR, else /tmp>/claude-<uid>` (POSIX only: it is named after the user id; `uid` null: none).
 */
export function claudeFolders(env: NodeJS.ProcessEnv = process.env, home = homedir(), uid: number | null = process.getuid?.() ?? null): ClaudeFolders {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  if (uid === null) return { configDir };
  return { configDir, tmpRoot: join(env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${uid}`) };
}

/** Real path of `p`, or `p` made absolute when it does not exist (any more). */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Removes `<parent>/<name>` (a link as a link) when `name` is one plain path segment and the path lies directly
 * inside the real `parent`. Returns the removed path, or undefined.
 */
function removeChild(parent: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(name)) return undefined;
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    return undefined; // no such folder: nothing was left there
  }
  const target = join(realParent, name);
  if (dirname(target) !== realParent || basename(target) !== name) return undefined;
  try {
    lstatSync(target);
  } catch {
    return undefined;
  }
  rmSync(target, { recursive: true, force: true });
  return existsSync(target) ? undefined : target;
}

/** What identifies a run's leftovers: its working directory and the session ids of its attempts. */
export type RunTrace = { cwd: string; sessionIds: readonly string[] };

/**
 * Claude Code (2.1.325, `--no-session-persistence`): removes what a run leaves in the person's Claude folder and
 * in the temp root, found by probes (normal end and a killed run):
 * - `projects/<project folder of its cwd>/`: an empty `memory/`, and while the run lasts (or after a kill) the
 *   results too large to return inline (`<id>/tool-results/`);
 * - `session-env/<session id>/` (empty);
 * - `<temp root>/<project folder of its cwd>/`: per session a `tasks/` folder with the output of shell commands
 *   (left with content when the run is killed while a command runs).
 * The project folder is named after the working directory as Claude Code saw it (its real path) and as BIF
 * named it; both are tried. Returns the removed paths.
 */
export function removeClaudeRunLeftovers(run: RunTrace, where: ClaudeFolders = claudeFolders()): string[] {
  const removed: string[] = [];
  const names = new Set([realOrResolved(run.cwd), resolve(run.cwd)].map(claudeProjectDirName).filter((n): n is string => n !== undefined));
  if (!names.size) {
    console.warn(
      `[bif] warning: the folder Claude Code keeps for ${run.cwd} is not removed: its name is longer than 200 characters, ` +
        'so Claude Code shortened it with a hash BIF does not reproduce (a shorter data folder path avoids this)',
    );
  }
  for (const name of names) {
    for (const parent of [join(where.configDir, 'projects'), ...(where.tmpRoot ? [where.tmpRoot] : [])]) {
      const r = removeChild(parent, name);
      if (r) removed.push(r);
    }
  }
  for (const sid of new Set(run.sessionIds)) {
    if (!UUID.test(sid)) continue;
    const r = removeChild(join(where.configDir, 'session-env'), sid);
    if (r) removed.push(r);
  }
  return removed;
}
