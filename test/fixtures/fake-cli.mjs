#!/usr/bin/env node
// Scripted stand-in for an agent CLI. The script is the JSON prompt (the arg after `-p`):
// { lines?: string[], delayMs?: number, exitCode?: number, sleepForever?: boolean,
//   ignoreSigterm?: boolean, counterFile?: string, attempts?: Array<{ lines, exitCode }> }
// With `counterFile`, invocation N (1-based) uses attempts[N-1] (last one repeats).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
writeFileSync('argv.json', JSON.stringify(args));
const script = JSON.parse(args[args.indexOf('-p') + 1]);

let plan = script;
if (script.counterFile) {
  const n = (existsSync(script.counterFile) ? Number(readFileSync(script.counterFile, 'utf8')) : 0) + 1;
  writeFileSync(script.counterFile, String(n));
  plan = { ...script, ...script.attempts[Math.min(n, script.attempts.length) - 1] };
}
if (plan.ignoreSigterm) process.on('SIGTERM', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const line of plan.lines ?? []) {
  process.stdout.write(line + '\n');
  if (plan.delayMs) await sleep(plan.delayMs);
}
if (plan.sleepForever) setInterval(() => {}, 1 << 30);
else process.exitCode = plan.exitCode ?? 0;
