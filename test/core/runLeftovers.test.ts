/**
 * A Claude Code run's leftovers outside the data folder (its project folder with oversized tool results, its
 * session-env folder, its temp folder) are removed on every way a run ends: a timeout kill, a shutdown, and a
 * crash followed by a start (`resumeInterrupted`). Nothing else in those folders is touched.
 *
 * The agent CLI here is `test/fixtures/fake-cli.mjs` (`leaveClaudeFiles`): no model is called. The Claude
 * folder and the temp root are temporary folders (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../src/core/config/schema.js';
import { claudeProjectDirName, cliSessionId } from '../../src/core/harness/cliLeftovers.js';
import type { RunOutcome } from '../../src/core/harness/supervisor.js';
import { resumeInterrupted } from '../../src/core/research/orchestrator.js';
import type { Store } from '../../src/core/store/db.js';
import type { AgentRun } from '../../src/core/types.js';
import { addTask, researchSetup, type SetupOptions } from './helpers/research.js';

const FAKE_CLI = join(import.meta.dirname, '../fixtures/fake-cli.mjs');
const NOW = '2026-11-16T10:00:00.000Z';

const opened: Store[] = [];
const startedPids: number[] = [];
let claudeDir: string;
let tmpRoot: string;
/** The person's own files beside the run's: they must all stay. */
let own: string[];

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bif-leftovers-')));
  claudeDir = join(base, 'claude');
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
  vi.stubEnv('CLAUDE_CODE_TMPDIR', join(base, 'tmp'));
  tmpRoot = join(base, 'tmp', `claude-${process.getuid?.() ?? ''}`);
  own = [
    join(claudeDir, 'projects', '-Users-someone-code-app', 'session.jsonl'),
    join(claudeDir, 'session-env', '11111111-2222-4333-8444-555555555555', 'env'),
    join(claudeDir, 'shell-snapshots', 'snapshot-zsh-1-abc.sh'),
    join(claudeDir, 'history.jsonl'),
    join(tmpRoot, '-Users-someone-code-app', '11111111-2222-4333-8444-555555555555', 'tasks', 'x.output'),
  ];
  for (const p of own) {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'theirs');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of startedPids.splice(0)) {
    for (const target of process.platform === 'win32' ? [pid] : [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
  }
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // closed by the test
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, read: () => T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function setup(opts: SetupOptions & { idleTimeoutMs?: number } = {}) {
  const s = researchSetup(opened, {
    ...opts,
    config: (c: BifConfig) => {
      c.providers.claude.command = FAKE_CLI;
      c.limits.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    },
  });
  if (!s.store.workspaces.get('ws_a')) s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW });
  return s;
}

/** A fake Claude run that leaves the files and then never ends on its own (`ignoreSigterm`: only a forced stop ends it). */
function leavingRun(s: ReturnType<typeof setup>, taskId: string, script: Record<string, unknown> = {}): Promise<RunOutcome> {
  return s.supervisor.run({
    ctx: { workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv_1', taskId },
    prompt: JSON.stringify({ lines: [], sleepForever: true, leaveClaudeFiles: true, ...script }),
    systemPrompt: 'sys',
    needsBrowser: false,
  });
}

/** The run once its CLI has written its leftovers. */
async function leftOver(s: ReturnType<typeof setup>, taskId: string): Promise<AgentRun> {
  const run = await until('the CLI to leave its files', () => {
    const r = s.store.agentRuns.list({ workspaceId: 'ws_a' }).find((x) => x.taskId === taskId);
    return r?.pid !== undefined && existsSync(join(s.dir, 'ws_a', 'runs', r.id, 'cwd', 'leftovers.ready')) ? r : undefined;
  });
  if (!startedPids.includes(run.pid!)) startedPids.push(run.pid!);
  return run;
}

/** Where the run's leftovers are; each one exists while the run lasts. */
function leftoversOf(s: ReturnType<typeof setup>, run: AgentRun): string[] {
  const cwd = join(s.dir, 'ws_a', 'runs', run.id, 'cwd');
  const sid = readFileSync(join(cwd, 'leftovers.ready'), 'utf8');
  expect(sid).toBe(cliSessionId(run.id, 1));
  const name = claudeProjectDirName(realpathSync(cwd))!;
  return [
    join(claudeDir, 'projects', name, 'f00dfeed-0000-4000-8000-000000000001', 'tool-results', 'b1.txt'),
    join(claudeDir, 'session-env', sid),
    ...(process.getuid ? [join(tmpRoot, name, sid, 'tasks', 'b2.output')] : []),
  ];
}

function expectOnlyTheRunsGone(paths: string[]) {
  for (const p of paths) expect(existsSync(p), p).toBe(false);
  for (const p of own) expect(existsSync(p), p).toBe(true);
}

describe("a Claude run's leftovers outside the data folder are removed however the run ends", () => {
  it('the CLI is started with the session id the leftovers are found by', async () => {
    const s = setup();
    const task = addTask(s.store, { status: 'running' });
    void leavingRun(s, task.id);
    const run = await leftOver(s, task.id);
    const argv = JSON.parse(readFileSync(join(s.dir, 'ws_a', 'runs', run.id, 'cwd', 'argv.json'), 'utf8')) as string[];
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(cliSessionId(run.id, 1));
    await s.supervisor.close();
  }, 30_000);

  it('a run whose record cannot be read is skipped with a warning: removal never throws (recovery of the other runs goes on)', async () => {
    const s = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A workspace id that cannot be a folder name makes the run's working directory impossible to derive.
    const bad = { id: 'arun_bad', workspaceId: null as unknown as string, model: { provider: 'claude' as const, model: 'haiku' }, attempts: 1 };
    expect(() => s.supervisor.removeRunLeftovers(bad)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    for (const f of own) expect(existsSync(f)).toBe(true);
    warn.mockRestore();
    await s.supervisor.close();
  });

  it('a timeout kill (a polite stop it ignores, then by force)', async () => {
    const s = setup({ idleTimeoutMs: 400 });
    const task = addTask(s.store, { status: 'running' });
    const pending = leavingRun(s, task.id, { ignoreSigterm: true });
    const run = await leftOver(s, task.id);
    const paths = leftoversOf(s, run);
    for (const p of paths) expect(existsSync(p), p).toBe(true);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'failed', reason: expect.stringContaining('idle timeout') });
    expectOnlyTheRunsGone(paths);
  }, 30_000);

  it('a shutdown: gone when close() resolves', async () => {
    const s = setup();
    const task = addTask(s.store, { status: 'running' });
    void leavingRun(s, task.id, { ignoreSigterm: true });
    const run = await leftOver(s, task.id);
    const paths = leftoversOf(s, run);
    await s.supervisor.close();
    expectOnlyTheRunsGone(paths);
  }, 30_000);

  it('a shutdown that ran out of time (killRunsNow): gone at once', async () => {
    const s = setup();
    const task = addTask(s.store, { status: 'running' });
    void leavingRun(s, task.id, { ignoreSigterm: true });
    const run = await leftOver(s, task.id);
    const paths = leftoversOf(s, run);
    s.supervisor.killRunsNow();
    expectOnlyTheRunsGone(paths);
  }, 30_000);

  it('a crash: the next start (resumeInterrupted) stops the orphaned CLI and removes what it left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-leftovers-crash-'));
    // --- process 1: a worker runs; the server dies without stopping it (its CLI is orphaned).
    const s1 = setup({ dir });
    const task = addTask(s1.store, { status: 'running' });
    void leavingRun(s1, task.id);
    const run = await leftOver(s1, task.id);
    const paths = leftoversOf(s1, run);

    // --- process 2: the same data folder. Checked synchronously after recovery: process 1's own end-of-run
    // handling (still alive in this test process) cannot have run yet.
    const s2 = setup({ dir });
    const report = resumeInterrupted(s2.deps);
    expect(report.failedRuns).toEqual([run.id]);
    expectOnlyTheRunsGone(paths);
    await report.done;
    await s2.supervisor.close();
    await s1.supervisor.close();
  }, 30_000);
});
