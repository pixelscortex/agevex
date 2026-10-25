import { defineConfig } from "vite-plus";
export default defineConfig({
  cacheDir: ".vite-plus/meter-live-vite",
  test: {
    include: ["tests/meter/**/*.live.ts"],
    setupFiles: [],
    fsModuleCachePath: ".vite-plus/meter-live-vitest",
  },
});
