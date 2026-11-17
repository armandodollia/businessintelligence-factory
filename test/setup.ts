/**
 * Runs before every test file (`setupFiles` in `vitest.config.ts`).
 *
 * No test starts a real research browser server (`test/realBrowserGuard.ts`): starting one throws,
 * and a test during which one was tried fails with its own name, also when the harness turned the
 * throw into a failed run.
 *
 * No test reads or removes anything in the person's own Claude folder or Claude Code's temp root (the removal of
 * a run's leftovers, `src/core/harness/cliLeftovers.ts`): each test file gets empty ones of its own
 * (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`; a test may point them elsewhere with `vi.stubEnv`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { installRealBrowserGuard, setGuardedTest, takeRealBrowserAttempts } from './realBrowserGuard.js';

installRealBrowserGuard();

const claudeHome = mkdtempSync(join(tmpdir(), 'bif-test-claude-'));
process.env.CLAUDE_CONFIG_DIR = join(claudeHome, 'config');
process.env.CLAUDE_CODE_TMPDIR = join(claudeHome, 'tmp');

function failOnAttempts(where: string): void {
  const attempts = takeRealBrowserAttempts();
  if (attempts.length) {
    throw new Error(`${where} tried to start a real research browser server ${attempts.length} time(s): ${attempts.join(' | ')}. See test/realBrowserGuard.ts.`);
  }
}

beforeEach((ctx) => {
  setGuardedTest(`${ctx.task.file.name} > ${ctx.task.fullTestName ?? ctx.task.name}`);
});

afterEach((ctx) => {
  setGuardedTest(undefined);
  failOnAttempts(`test "${ctx.task.file.name} > ${ctx.task.fullTestName ?? ctx.task.name}"`);
});

// An attempt outside a test (a hook of the file, or work a test left running).
afterAll(() => failOnAttempts('this test file, outside its tests,'));
