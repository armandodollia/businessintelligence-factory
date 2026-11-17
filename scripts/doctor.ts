/**
 * The setup check as a command (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.3).
 *
 *   npm run doctor [-- --json]
 *
 * Says for each agent CLI (Claude Code, Codex, OpenCode) whether it is installed, its version and
 * whether it is signed in, and whether Chrome is there for the research browser. It reads the
 * commands from the configuration the server would use (`BIF_CONFIG`, else `./bif.config.json` when
 * it exists, else the defaults). No model is called and nothing is written. `--json` prints the
 * report as JSON. The exit code is 0 when research can start and 1 when it cannot.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/core/config/load.js';
import { runtimePaths } from '../src/core/runtime/paths.js';
import { doctor, formatReport } from '../src/core/setup/doctor.js';

const configPath = resolve(process.env.BIF_CONFIG ?? runtimePaths().configPath);
const config = loadConfig(existsSync(configPath) ? configPath : undefined);
const report = await doctor(config);
process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
process.exitCode = report.canResearch ? 0 : 1;
