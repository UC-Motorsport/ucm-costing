import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL integration files each create and migrate an isolated
    // database. Bound concurrency so local and CI Postgres instances are not
    // saturated by every file at once, and allow catalogue/migration fixtures
    // enough time under a cold container cache.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
