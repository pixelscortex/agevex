/** Real, provider-free crash probe on an isolated LOCAL anonymous backend.
 * Private package copies hold the test-only scheduler cancellation endpoint;
 * neither installed dependencies nor any cloud deployment are modified.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_LIMITS = { startupMs: 120_000, detectionMs: 8 * 60_000, observationMs: 2_000 };
const repo = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };

for (const key of Object.keys(env))
  if (key.startsWith("CONVEX_") && key !== "CONVEX_AGENT_MODE") delete env[key];

/** Commands run only inside our private local host, with cloud credentials removed. */
async function command(cwd: string, args: string[]) {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });

  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code) throw new Error(`${args.slice(0, 3).join(" ")} failed: ${error}`);

  return out;
}

/** Copy only packages that need local fault injection; all other dependencies are read-only. */
async function prepare(host: string) {
  const modules = join(host, "node_modules");

  await mkdir(join(modules, "@convex-dev"), { recursive: true });

  for (const name of await readdir(join(repo, "node_modules"))) {
    if (name === "@convex-dev" || name === ".bin" || name.startsWith(".cache")) continue;

    await symlink(join(repo, "node_modules", name), join(modules, name));
  }

  for (const name of await readdir(join(repo, "node_modules/@convex-dev"))) {
    const source = join(repo, "node_modules/@convex-dev", name);
    const target = join(modules, "@convex-dev", name);

    if (name === "workflow" || name === "workpool")
      await cp(source, target, { recursive: true, dereference: true });
    else await symlink(source, target);
  }

  await mkdir(join(modules, "agevex"));
  await cp(join(repo, "dist"), join(modules, "agevex/dist"), { recursive: true });
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));

  pkg.exports["./dist/component/limits.js"] = "./dist/component/limits.js";
  await writeFile(join(modules, "agevex/package.json"), JSON.stringify(pkg));
  await mkdir(join(host, "convex"));

  await writeFile(
    join(host, "package.json"),
    JSON.stringify({
      name: "local-crash-probe",
      private: true,
      type: "module",
      dependencies: { convex: "*", agevex: "*", "@convex-dev/agent": "*" },
    }),
  );

  await writeFile(
    join(host, "convex/convex.config.ts"),
    `import { defineApp } from "convex/server";\nimport agent from "@convex-dev/agent/convex.config";\nimport agevex from "agevex/convex.config";\nconst app = defineApp(); app.use(agent); app.use(agevex); export default app;\n`,
  );

  await cp(join(repo, "scripts/fixtures/crash_host.ts.txt"), join(host, "convex/probe.ts"));

  await cp(
    join(repo, "scripts/fixtures/crash_workpool.js.txt"),
    join(modules, "@convex-dev/workpool/dist/component/crash_probe.js"),
  );

  await cp(
    join(repo, "scripts/fixtures/crash_agevex.js.txt"),
    join(modules, "agevex/dist/component/crash_probe.js"),
  );

  // Log only when the real upstream callback records the paid step failure.
  // This private-copy observation changes neither execution nor recovery.
  const poolPath = join(modules, "@convex-dev/workflow/dist/component/pool.js");
  const pool = await readFile(poolPath, "utf8");
  const marker = "journalEntry.step.runResult = runResult;";

  if (!pool.includes(marker)) throw new Error("Unsupported Workflow probe instrumentation");

  await writeFile(
    poolPath,
    pool.replace(
      marker,
      marker +
        `
    if (journalEntry.step.name === "agentStep" && runResult.kind !== "success") globalThis.console.log("AGEVEX_CRASH_PROBE_WORKFLOW_FAILURE", Date.now());`,
    ),
  );
}

/** Refuse a non-loopback URL before invoking any function on the generated host. */
async function run(host: string, name: string, args = {}, component?: string) {
  const config = await readFile(join(host, ".env.local"), "utf8");

  if (
    !/^CONVEX_URL=http:\/\/(127\.0\.0\.1|localhost):\d+$/m.test(config) ||
    !/CONVEX_DEPLOYMENT=anonymous:/.test(config)
  )
    throw new Error("Probe refuses a non-local-anonymous deployment");

  const output = await command(host, [
    "bun",
    "node_modules/convex/bin/main.js",
    "run",
    ...(component ? ["--component", component] : []),
    name,
    JSON.stringify(args),
  ]);

  return output.trim() ? JSON.parse(output) : null;
}

/** Bounded observation lives in this external probe, never in agevex. */
async function until<T>(timeout: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = await check();

    if (value) return value;

    await Bun.sleep(PROBE_LIMITS.observationMs);
  }

  throw new Error("Local crash probe timed out");
}

/** Measure upstream failure and exact native cleanup without changing recovery. */
async function observe(
  host: string,
  threadId: string,
  killed: { startedAt: number; canceledAt: number },
  nativeIds: { messageId: string; streamId: string },
  log: { text(): Promise<string> },
) {
  const outcome = await until(PROBE_LIMITS.detectionMs, async () => {
    const value = await run(host, "probe:outcome", { threadId: threadId });

    return value?.turnStatus === "recovery_required" ? value : null;
  });

  const workflowReportedAt = await until(PROBE_LIMITS.startupMs, async () => {
    const match = (await log.text()).match(/AGEVEX_CRASH_PROBE_WORKFLOW_FAILURE['"]?[, ]+(\d+)/);

    return match ? Number(match[1]) : null;
  });

  const nativeClosure = await run(host, "probe:nativeClosed", nativeIds);

  const report = {
    target: "local-anonymous",
    startedAt: killed.startedAt,
    canceledAt: killed.canceledAt,
    workflowReportedAt,
    finalizedAt: outcome.finalizedAt,
    observedAt: Date.now(),
    workflowLatencyMs: workflowReportedAt - killed.canceledAt,
    finalizationLatencyMs: outcome.finalizedAt - killed.canceledAt,
    nativeClosure,
    outcome,
  };

  console.log(JSON.stringify(report, null, 2));
  await writeFile(join(repo, ".events-crash-probe.json"), JSON.stringify(report, null, 2) + "\n");

  if (
    outcome.errorCode !== "EXECUTION_AMBIGUOUS" ||
    outcome.pendingGeneration ||
    outcome.modelSteps !== 1 ||
    nativeClosure.messageStatus !== "failed" ||
    nativeClosure.streamWasOpen
  )
    throw new Error("Unexpected crash outcome or native cleanup");
}

/** Keep the local backend alive until its unchanged Workpool recovery reports failure. */
async function main() {
  await command(repo, ["bun", "run", "build"]);
  await mkdir(join(repo, ".vite-plus"), { recursive: true });
  const host = await mkdtemp(join(repo, ".vite-plus/crash-probe-"));

  let dev:
    | { kill: (signal: "SIGINT") => void; exited: Promise<number>; exitCode: number | null }
    | undefined;

  try {
    await prepare(host);
    const log = Bun.file(join(host, "backend.log"));

    dev = Bun.spawn(
      [
        "bun",
        "node_modules/convex/bin/main.js",
        "dev",
        "--typecheck",
        "disable",
        "--tail-logs",
        "always",
      ],
      { cwd: host, env, stdout: log, stderr: log },
    );

    await until(PROBE_LIMITS.startupMs, async () => {
      if (dev?.exitCode !== null) throw new Error(await log.text());

      return (await log.text()).includes("Convex functions ready") || null;
    });

    const receipt = await run(host, "probe:start");

    const nativeIds = await until(
      PROBE_LIMITS.startupMs,
      async () =>
        (await run(host, "probe:outcome", { threadId: receipt.threadId }))?.nativeIds ?? null,
    );

    const killed = await until(PROBE_LIMITS.startupMs, () =>
      run(host, "crash_probe:cancel", {}, "agevex/rootWorkflow/workpool"),
    );

    console.log(
      `Cancelled local scheduler step; waiting for Workpool recovery (no accelerated recovery).`,
    );

    await observe(host, receipt.threadId, killed, nativeIds, log);
  } finally {
    dev?.kill("SIGINT");

    if (dev) await dev.exited;

    await rm(host, { recursive: true, force: true });
  }
}

await main();
