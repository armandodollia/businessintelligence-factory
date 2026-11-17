/**
 * Opens a folder in the system's file manager (design §4.2: the "Open folder" button of the Settings
 * page). The folder is always one of the server's own (`setupRoutes.ts`), never text from a request.
 */
import { spawn } from 'node:child_process';

/** The command that shows `dir` in the file manager of `platform`. The folder is one argument: no shell reads it. */
export function openFolderCommand(dir: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

/** Shows `dir` in the file manager and does not wait for it. A file manager that cannot be started is reported, not thrown. */
export function openFolder(dir: string): void {
  const { cmd, args } = openFolderCommand(dir);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.once('error', (e) => console.warn(`[bif] warning: could not open ${dir}: ${e.message}`));
  child.unref();
}
