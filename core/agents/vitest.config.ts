import { defineConfig } from "vitest/config";

/** core/ is the new server; the repository's root vite.config.ts include list predates it, and
 * changing that shared config is out of this area's scope. This config runs only core/agents. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["core/agents/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
