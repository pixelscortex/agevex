// Keep the formatter's existing defaults explicit, avoiding unrelated source churn.
import { defineConfig, type FormatConfig } from "oxfmt";
export const formatterOptions = {
  singleQuote: false,
  semi: true,
  trailingComma: "all",
  printWidth: 100,
  sortImports: false,
  sortPackageJson: true,
} satisfies FormatConfig;
export default defineConfig({
  ...formatterOptions,
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    ".vite-plus/**",
    "**/_generated/**",
    "docs/spec/**",
    ".repo/**",
    ".codegraph/**",
    ".agents/**",
    ".claude/**",
    "docs/site/.source/**",
    "docs/site/.output/**",
    "docs/site/.nitro/**",
    "docs/site/.tanstack/**",
    "docs/site/src/routeTree.gen.ts",
    "docs/site/public/r/**",
    "docs/site/registry.json",
  ],
});
