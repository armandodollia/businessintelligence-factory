#!/usr/bin/env node
// Stand-in for an agent CLI that never finishes, whatever it is asked: for tests that stop a running
// agent from outside (a server shutdown, "Stop research"). It writes its process id to `cli.pid` and
// the names of its environment variables to `cli.env.json`, both in its working directory (the run's
// own folder), then waits for ever. No model is called.
import { writeFileSync } from 'node:fs';

writeFileSync('cli.env.json', JSON.stringify(Object.keys(process.env).sort()));
writeFileSync('cli.pid', String(process.pid));
setInterval(() => {}, 1 << 30);
