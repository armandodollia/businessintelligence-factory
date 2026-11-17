// The server entry as `npm start` runs it, with the two waits of its shutdown shortened so a test of
// the forced stop is fast: `TEST_KILL_GRACE_MS` (how long an agent gets between the polite stop and
// the forced one) and `TEST_SHUTDOWN_LIMIT_MS` (how long the whole shutdown may take). Everything
// else is the real entry (`runEntry`).
import { runEntry, type EntryTimings } from '../../src/api/main.js';

const timings: EntryTimings = {};
if (process.env.TEST_KILL_GRACE_MS) timings.killGraceMs = Number(process.env.TEST_KILL_GRACE_MS);
if (process.env.TEST_SHUTDOWN_LIMIT_MS) timings.shutdownLimitMs = Number(process.env.TEST_SHUTDOWN_LIMIT_MS);
runEntry(timings);
