#!/usr/bin/env node
// Stand-in for a shared browser MCP server: answers any HTTP request on --port.
// FAKE_BROWSER_LOG: appends one JSON line per launch ({ pid, args }).
// --exit-now: exits with code 3 before listening (start failure).
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (process.env.FAKE_BROWSER_LOG) appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({ pid: process.pid, args, cwd: process.cwd() }) + '\n');
if (args.includes('--exit-now')) process.exit(3);
const port = Number(args[args.indexOf('--port') + 1]);
createServer((_req, res) => {
  res.writeHead(405);
  res.end();
}).listen(port, '127.0.0.1');
