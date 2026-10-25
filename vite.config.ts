import convexPlugin from "@convex-dev/eslint-plugin";
import { defineConfig } from "vite-plus";

const TEST_LIMITS = { workers: 2 } as const;

export default defineConfig({
  // Managed worktrees may share this checkout's node_modules, so every cache
  // Vite+/Vitest writes stays inside the checkout instead of node_modules.
  cacheDir: ".vite-plus/vite",
  lint: {
    // Loaded as Oxlint JavaScript plugins; the ESLint runner is never invoked.
    jsPlugins: ["@convex-dev/eslint-plugin", "@stylistic/eslint-plugin"],
    rules: {
      // Readable step-by-step functions: a blank line after every declaration
      // block and around every multi-line statement, and before each return,
      // so each step of a handler reads as its own paragraph. Autofixable
      // (`vp lint --fix`) and it only ever inserts blank lines.
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["const", "let"], next: "*" },
        {
          blankLine: "any",
          prev: ["singleline-const", "singleline-let"],
          next: ["singleline-const", "singleline-let"],
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["if", "for", "while", "try", "multiline-expression", "multiline-const"],
        },
        {
          blankLine: "always",
          prev: ["if", "for", "while", "try", "multiline-expression", "multiline-const"],
          next: "*",
        },
      ],
    },
    ignorePatterns: [
      "node_modules/**",
      "dist/**",
      ".vite-plus/**",
      "**/_generated/**",
      "docs/site/**",
    ],
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
