import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a **real** Postgres, not a mock.
 *
 * Almost every correctness guarantee in this system lives in the database —
 * `SKIP LOCKED`, partial unique indexes, advisory locks, `make_interval`. A
 * mocked driver would assert that the mock behaves as written rather than that
 * Postgres does, which is precisely the thing worth checking.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // The DB-backed suites share one database; running files in parallel would
    // have them truncating each other's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
