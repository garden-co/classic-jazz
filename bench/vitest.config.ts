import { defineConfig } from "vitest/config";

// Local config for the benchmark package's correctness spot-checks. Kept
// separate from the repo-root project config (which does not include `bench`)
// so `vitest --config bench/vitest.config.ts` runs standalone.
export default defineConfig({
  root: __dirname,
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 60000,
  },
});
