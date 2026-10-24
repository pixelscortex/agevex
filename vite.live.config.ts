import { defineConfig } from "vite-plus";
export default defineConfig({
  cacheDir: ".vite-plus/live-vite",
  test: {
    include: ["tests/live/**/*.live.ts"],
    setupFiles: [],
    fsModuleCachePath: ".vite-plus/live-vitest",
  },
});
