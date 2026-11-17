import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // No test starts a real research browser server (test/realBrowserGuard.ts).
    setupFiles: ['test/setup.ts'],
    // Windows: file I/O (SQLite in WAL mode, temp dirs) is several times slower, and store-heavy tests
    // take 1-2 s alone, past the 5 s default when the whole suite runs in parallel. Elsewhere unchanged.
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
    // node:sqlite emits an ExperimentalWarning on some Node versions; keep test output clean.
    env: { NODE_NO_WARNINGS: '1' },
  },
});
