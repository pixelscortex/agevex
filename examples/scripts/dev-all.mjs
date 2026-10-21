import { mkdirSync } from "node:fs";

const root = process.cwd();
const convexTmpDir = process.env.CONVEX_TMPDIR ?? `${root}/.convex-tmp`;
mkdirSync(convexTmpDir, { recursive: true });
const environment = {
  ...process.env,
  CONVEX_TMPDIR: convexTmpDir,
};
const children = [
  Bun.spawn(["bun", "run", "dev"], {
    cwd: root,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "dev:playground"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const results = await Promise.all(children.map((child) => child.exited));
stop();
process.exitCode = results.every((code) => code === 0) ? 0 : 1;
