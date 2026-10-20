import convexPlugin from "@convex-dev/eslint-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Managed worktrees may share this checkout's node_modules, so every cache
  // Vite+/Vitest writes stays inside the checkout instead of node_modules.
  cacheDir: ".vite-plus/vite",
  lint: {
    // Loaded as an Oxlint JavaScript plugin; the ESLint runner is never invoked.
    jsPlugins: ["@convex-dev/eslint-plugin"],
    ignorePatterns: ["node_modules/**", "dist/**", ".vite-plus/**", "**/_generated/**"],
    overrides: [
      {
        // Covers this package's own component sources and the deterministic
        // fixture host registration. Installing apps add "**\/convex\/**\/*.ts"
        // for their own functions.
        files: ["src/component/**/*.ts", "tests/host.ts", "tests/fixture/**/*.ts"],
        rules: convexPlugin.configs.recommended[0].rules,
      },
    ],
  },
  // Shared read-only dependencies mean a cached task result could be replayed
  // for inputs another checkout changed: never cache tasks or scripts, and
  // never write node_modules/.vite/task-cache.
  run: { cache: false },
  test: {
    include: ["tests/**/*.test.ts"],
    // Runs before every test file, so no test can reach the network even if it
    // restores mocks or `process.env`.
    setupFiles: ["./tests/unit-setup.ts"],
    fsModuleCachePath: ".vite-plus/vitest-fs",
  },
});
