import { defineConfig } from "vite-plus";

// Keep this optional module's live tests in its own directory and run them through
// the package's test:live entry without changing the core test configuration.
export default defineConfig({
  cacheDir: ".vite-plus/telemetry-live-vite",
  test: {
    include: ["tests/telemetry/live/**/*.live.ts"],
    setupFiles: [],
    fsModuleCachePath: ".vite-plus/telemetry-live-vitest",
  },
});
