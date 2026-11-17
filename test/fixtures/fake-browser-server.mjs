#!/usr/bin/env node
// Stand-in for a shared browser MCP server: answers any HTTP request on --port.
// FAKE_BROWSER_LOG: appends one JSON line per launch ({ pid, args, cwd, runAsNode, noAsar }; the last
// two are the values of ELECTRON_RUN_AS_NODE and ELECTRON_NO_ASAR it was started with, absent when unset).
// --exit-now: exits with code 3 before listening (start failure).
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (process.env.FAKE_BROWSER_LOG) appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE, noAsar: process.env.ELECTRON_NO_ASAR }) + '\n');
if (args.includes('--exit-now')) process.exit(3);
const port = Number(args[args.indexOf('--port') + 1]);
createServer((_req, res) => {
  res.writeHead(405);
  res.end();
}).listen(port, '127.0.0.1');
