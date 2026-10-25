import { defineConfig } from "vite-plus";
export default defineConfig({
  cacheDir: ".vite-plus/sandbox-live-vite",
  test: {
    include: ["tests/sandbox/**/*.live.ts"],
    setupFiles: [],
    fsModuleCachePath: ".vite-plus/sandbox-live-vitest",
  },
});
