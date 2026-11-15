import { defineConfig } from "vitest/config";

/** core/environments is its own area; the root suite's include list predates
 * it, and editing that shared config is outside this area. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["core/environments/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
