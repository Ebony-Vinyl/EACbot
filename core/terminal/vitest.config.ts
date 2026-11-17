import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The root suite's include list does not cover core/; this config runs the
// terminal layer's own suite, with a temporary home so nothing reads the
// developer's real state.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["core/terminal/**/*.test.ts"],
    setupFiles: ["server/testing/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
