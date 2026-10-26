// Generate route types directly, so CI checks a clean checkout without a build.
// Router Generator's generator.d.ts exposes Generator.run(); getConfig resolves
// the same src/routes and src/routeTree.gen.ts defaults used by the Vite plugin.
import { Generator, getConfig } from "@tanstack/router-generator";

const root = new URL("..", import.meta.url).pathname;
const generator = new Generator({ config: getConfig({}, root), root });

await generator.run();

const task = Bun.spawn(["bunx", "--no-install", "tsc", "--noEmit"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

await task.exited;

if (task.exitCode !== 0) process.exit(task.exitCode);
