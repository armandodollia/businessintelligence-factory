/**
 * Runs before every test file (`setupFiles` in `vitest.config.ts`).
 *
 * No test starts a real research browser server (`test/realBrowserGuard.ts`): starting one throws,
 * and a test during which one was tried fails with its own name, also when the harness turned the
 * throw into a failed run.
 */
import { afterAll, afterEach, beforeEach } from 'vitest';
import { installRealBrowserGuard, setGuardedTest, takeRealBrowserAttempts } from './realBrowserGuard.js';

installRealBrowserGuard();

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
