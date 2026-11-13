/**
 * Paging rework, binding acceptance test (design §9 "Paging"), shard D: every read tool swept over budgets
 * from 1 upward across the reviewer's request shapes — scope, around, later-page cursors, keys full of
 * escape characters, long records, quotes across chunk boundaries, nodes with many keys — with every
 * pointer followed. The shapes and what fails the sweep: `sweepHelpers.ts` (`SWEEP_SPECS`, `sweepRequest`).
 */
import { sweepShard } from './sweepHelpers.js';

sweepShard('D');
