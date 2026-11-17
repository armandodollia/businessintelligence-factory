#!/usr/bin/env node
// Stand-in for an agent CLI that never finishes and ignores the polite stop (SIGTERM, SIGINT, SIGHUP):
// for tests of the forced stop. Like `hanging-cli.mjs` it writes its process id to `cli.pid` in its
// working directory (the run's own folder), then waits for ever. Only a forced stop ends it. No model
// is called.
import { writeFileSync } from 'node:fs';

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
writeFileSync('cli.env.json', JSON.stringify(Object.keys(process.env).sort()));
writeFileSync('cli.pid', String(process.pid));
setInterval(() => {}, 1 << 30);
