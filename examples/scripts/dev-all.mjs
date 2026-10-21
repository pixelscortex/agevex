const root = process.cwd();
const children = [
  Bun.spawn(["bun", "run", "dev"], {
    cwd: root,
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
