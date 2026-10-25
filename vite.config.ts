import { defineConfig } from "vite-plus";

const TEST_LIMITS = { workers: 2 } as const;

export default defineConfig({
  // Managed worktrees may share this checkout's node_modules, so every cache
  // Vite+/Vitest writes stays inside the checkout instead of node_modules.
  cacheDir: ".vite-plus/vite",
  lint: { extends: ["./.oxlintrc.json"] },
  // Shared read-only dependencies mean a cached task result could be replayed
  // for inputs another checkout changed: never cache tasks or scripts, and
  // never write node_modules/.vite/task-cache.
  run: { cache: false },
  resolve: {
    alias: [
      { find: /^agevex$/, replacement: new URL("./src/client/index.ts", import.meta.url).pathname },
      {
        find: "agevex/tools",
        replacement: new URL("./src/modules/tools/client/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Hard-maximum fixtures build hundreds of real Workflow-backed threads.
    // Bound their independent Convex stores to two workers so parallel files
    // do not starve scheduler gates or exhaust the default per-test timeout
    // on shared development machines. Transaction limits remain enforced.
    maxWorkers: TEST_LIMITS.workers,
    // Runs before every test file, so no test can reach the network even if it
    // restores mocks or `process.env`.
    setupFiles: ["./tests/unit-setup.ts"],
    fsModuleCachePath: ".vite-plus/vitest-fs",
  },
});
