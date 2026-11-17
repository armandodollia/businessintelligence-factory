/**
 * Changes of an agent CLI that BIF noticed while it ran (for example a built-in tool a new Claude Code release
 * added or renamed). Each notice is written to the server log once per server start and kept for the setup
 * check (`GET /api/setup`, `cliNotices`). A notice never fails a run.
 */
const notices: string[] = [];

/** Records `text` once per server start: the first time it is written to the server log. */
export function noteCliChange(text: string): void {
  if (notices.includes(text)) return;
  notices.push(text);
  console.warn(`[bif] warning: ${text}`);
}

/** The notices of this server start, oldest first. */
export function cliNotices(): string[] {
  return [...notices];
}
