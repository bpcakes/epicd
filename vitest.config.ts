import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test files own isolated temporary Git repositories, SQLite databases and
    // subprocess trees. Bound parallelism so those independent fixtures do not
    // turn the sum of every integration test into wall-clock time.
    fileParallelism: true,
    maxWorkers: 6,
    // Keep a finite runner deadline separate from the production deadlines the
    // process-lifetime integration cases exercise.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
