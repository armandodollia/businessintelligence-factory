#!/usr/bin/env node
// Scripted stand-in for an agent CLI. The script is the first line of the prompt (the arg after `-p`);
// each invocation also writes the full prompt to prompt.<ts>.<pid>.txt:
// { lines?: string[], delayMs?: number, exitCode?: number, sleepForever?: boolean,
//   ignoreSigterm?: boolean, counterFile?: string, attempts?: Array<{ lines, exitCode }>,
//   stubbornChild?: boolean }
// `stubbornChild` spawns a grandchild that ignores SIGTERM, writes its pid to child.pid and, once its handler
// is installed, child.ready (the CLI waits for that file).
// With `counterFile`, invocation N (1-based) uses attempts[N-1] (last one repeats).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
writeFileSync('argv.json', JSON.stringify(args));
const prompt = args[args.indexOf('-p') + 1];
writeFileSync(`prompt.${Date.now()}.${process.pid}.txt`, prompt);
// The script is the first line; the supervisor may append sections (e.g. on rate-limit retries).
const script = JSON.parse(prompt.split('\n')[0]);

let plan = script;
if (script.counterFile) {
  const n = (existsSync(script.counterFile) ? Number(readFileSync(script.counterFile, 'utf8')) : 0) + 1;
  writeFileSync(script.counterFile, String(n));
  plan = { ...script, ...script.attempts[Math.min(n, script.attempts.length) - 1] };
}
if (plan.ignoreSigterm) process.on('SIGTERM', () => {});
if (plan.stubbornChild) {
  // The grandchild writes child.ready once its SIGTERM handler is installed; the CLI waits for it (a fixed
  // sleep was not enough under load: a grandchild still starting died on SIGTERM and the reap ended early).
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('child.ready', '1'); setInterval(() => {}, 1 << 30);"],
    // Windows: a non-detached child sits in its parent's job object and dies with it; detached, it
    // outlives the CLI like a real CLI's helper processes do, so the reap is what has to stop it.
    { stdio: 'ignore', ...(process.platform === 'win32' ? { detached: true, windowsHide: true } : {}) },
  );
  writeFileSync('child.pid', String(child.pid));
  child.unref(); // the CLI may exit and leave it behind
  for (let waited = 0; !existsSync('child.ready') && waited < 30_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const line of plan.lines ?? []) {
  process.stdout.write(line + '\n');
  if (plan.delayMs) await sleep(plan.delayMs);
}
if (plan.sleepForever) setInterval(() => {}, 1 << 30);
else process.exitCode = plan.exitCode ?? 0;
