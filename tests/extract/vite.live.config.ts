import { defineConfig, loadEnv } from "vite-plus";
const keys = loadEnv("development", "/Volumes/mypixel/pxc/agevex", "");
for (const name of ["FIRECRAWL_API_KEY", "OPENROUTER_API_KEY"])
  if (process.env[name] === undefined && keys[name]) process.env[name] = keys[name];
export default defineConfig({
  cacheDir: ".vite-plus/extract-live-vite",
  test: {
    include: ["tests/extract/**/*.live.ts"],
    setupFiles: [],
    fsModuleCachePath: ".vite-plus/extract-live-vitest",
  },
});
