import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // The default 5s can flake when the shared local Postgres instance is also serving a live
    // indexer writer (found during a whole-branch review: 2-3 spurious "Test timed out" failures).
    testTimeout: 30_000,
  },
});
