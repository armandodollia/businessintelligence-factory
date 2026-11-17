/**
 * Process identity for crash recovery. The implementations, with their Windows forms, live in
 * `platform.ts`; these names are kept for existing callers.
 */
export { groupAlive, isOurProcess as isOurProcessGroup, processStartTime } from './platform.js';
