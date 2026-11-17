import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The root suite's include list predates core/; this config runs only the new
 * server's HTTP, identity, event and bootstrap suites. `root` is the repository
 * so the `packages/agent-protocol` imports resolve as they do at runtime. */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["core/http/**/*.test.ts", "core/identity/**/*.test.ts", "core/events/**/*.test.ts", "core/bootstrap/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
