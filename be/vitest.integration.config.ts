import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Repository integration tests truncate shared real tables; API and migration tests
    // insert into those same tables. Running files concurrently races their setup/cleanup.
    fileParallelism: false,
    // The default 5s can flake when the shared local Postgres instance is also serving a live
    // indexer writer (found during a whole-branch review: 2-3 spurious "Test timed out" failures).
    testTimeout: 30_000,
    // Runs the Drizzle migration exactly once, before any test file's own beforeAll — see the file
    // for why (concurrent migrate() calls from multiple files race on a fresh database).
    globalSetup: ['./vitest.integration.globalSetup.ts'],
  },
});
