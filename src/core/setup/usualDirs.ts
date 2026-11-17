/**
 * The folders agent CLIs are usually installed in (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.3). One list, used twice: the setup check
 * looks in them for a command that is not on `PATH` (`doctor.ts`), and the desktop shell adds those
 * that exist to the `PATH` of the server when it cannot read the terminal's own (`desktop/environment.ts`).
 *
 * This module imports nothing but `node:path`, so the shell can use it without loading the
 * configuration.
 */
import { posix, win32 } from 'node:path';

/** What the list needs to know about the machine. */
export type UsualDirsSystem = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** The names in a folder; empty when it cannot be read. */
  listDir(path: string): string[];
};

/** The folders agent CLIs are usually installed in, per platform, beyond `PATH`. */
export function usualDirs(sys: UsualDirsSystem): string[] {
  const p = sys.platform === 'win32' ? win32 : posix;
  const home = sys.home;
  if (sys.platform === 'win32') {
    const appData = sys.env.APPDATA || p.join(home, 'AppData', 'Roaming');
    const local = sys.env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    return [
      p.join(home, '.local', 'bin'), // Claude Code's installer
      p.join(appData, 'npm'), // npm install -g
      p.join(home, '.opencode', 'bin'),
      p.join(home, '.bun', 'bin'),
      p.join(home, 'scoop', 'shims'),
      p.join(local, 'Microsoft', 'WinGet', 'Links'),
    ];
  }
  const nvm = p.join(home, '.nvm', 'versions', 'node');
  const byVersion = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
  return [
    p.join(home, '.local', 'bin'), // Claude Code's and Codex's installers
    p.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    p.join(home, '.opencode', 'bin'),
    p.join(home, '.npm-global', 'bin'),
    p.join(home, '.bun', 'bin'),
    p.join(home, '.volta', 'bin'),
    // Node versions installed with nvm, newest first: `npm install -g` puts commands there.
    ...sys.listDir(nvm).sort(byVersion).map((v) => p.join(nvm, v, 'bin')),
  ];
}
