import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // node:sqlite emits an ExperimentalWarning on some Node versions; keep test output clean.
    env: { NODE_NO_WARNINGS: '1' },
  },
});
