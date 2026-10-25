import { exec } from "node:child_process";
import { promisify } from "node:util";
import { rm, readFile, unlink, mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { ComponentApi } from "@daytona/convex";
import { daytona } from "../../src/sandbox/daytona.js";
import { HARD_LIMITS, LIMITS } from "../../src/sandbox/limits.js";
import type { SandboxContext } from "../../src/sandbox/types.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import { setup, api, state } from "./setup.js";

// Mock the component boundary, not the adapter: execute its exact shell/Python
// commands locally so quoting, detachment and source-side byte bounds are real.
function harness() {
  const replies: number[] = [];
  const actions = vi.fn(async (ref, args) => {
    if (ref === "read") {
      const data = await readFile(args.path);
      return new Uint8Array(data).buffer;
    }
    if (ref === "delete") {
      await unlink(args.path);
      return null;
    }
    if (ref !== "run") throw new Error("unexpected component background scheduler");
    expect(args.timeoutSeconds).toBeGreaterThan(0);
    expect(args.autoStart).toBe(false);
    const result = await promisify(exec)(args.command, {
      timeout: args.timeoutSeconds * 1000,
      maxBuffer: 1024 * 1024,
    });
    replies.push(Buffer.byteLength(result.stdout));
    return { exitCode: 0, result: result.stdout };
  });
  const ctx = {
    runAction: actions,
    runQuery: vi.fn(() => {
      throw new Error("unexpected execution lookup");
    }),
  } as unknown as SandboxContext;
  const provider = daytona(
    {
      process: { run: "run", runBackground: "background" },
      files: { readFileBytes: "read", deleteFile: "delete" },
    } as unknown as ComponentApi,
    { apiKey: "test-only" },
  );
  return { ctx, provider, actions, replies };
}

function adapterSetup(limits = {}) {
  const h = harness();
  const fake = fakeSandboxProvider();
  fake.provider.startBackground = (_ctx, ...args) => h.provider.startBackground(h.ctx, ...args);
  fake.provider.poll = (_ctx, ...args) => h.provider.poll(h.ctx, ...args);
  fake.provider.cancelBackground = (_ctx, ...args) => h.provider.cancelBackground(h.ctx, ...args);
  return { ...h, ...setup("thread", limits, fake) };
}

it("the fenced poller kills a never-ending Daytona group at its deadline and schedules no further provider work", async () => {
  vi.useFakeTimers();
  const s = adapterSetup({ pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 30 });
  let directory: string | undefined;
  const start = s.fake.provider.startBackground;
  s.fake.provider.startBackground = async (...args) => {
    directory = args[3]!.directory;
    return start(...args);
  };
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "sleep 120 & wait" },
    })) as { jobId: string };
    const job = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!;
    directory = job.directory;
    expect(job).toMatchObject({
      providerJobId: expect.any(String),
      sandboxId: "fake-sandbox-1",
      directory: expect.stringContaining(LIMITS.backgroundRoot),
    });
    await vi.advanceTimersByTimeAsync(30);
    await s.t.finishInProgressScheduledFunctions();
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    const count = s.actions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await s.t.finishInProgressScheduledFunctions();
    expect(s.actions).toHaveBeenCalledTimes(count);
    expect(await readFile(`${directory}/cancelled`, "utf8")).toBe("deadline");
  } finally {
    vi.useRealTimers();
    if (directory) {
      await s.provider.cancelBackground(s.ctx, "cleanup", {
        sandboxId: "fake-sandbox-1",
        directory,
      });
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it("a lost Daytona launch and throwing callback preserve the unknown receipt and notify later without relaunch", async () => {
  vi.useFakeTimers();
  const s = adapterSetup();
  const start = s.fake.provider.startBackground;
  let directory: string | undefined;
  s.fake.provider.startBackground = async (...args) => {
    const launched = await start(...args);
    directory = launched.directory;
    throw new Error("launch response lost after real detachment");
  };
  try {
    state.callbackFails = true;
    const args = {
      op: "sandbox_run_background",
      input: { command: "echo uncertain" },
      key: "real-lost-launch",
    };
    const result = await s.t.action(api.host.invoke, args);
    expect(result).toMatchObject({ status: "unknown", jobId: expect.any(String) });
    expect(await s.t.action(api.host.invoke, args)).toEqual(result);
    state.callbackFails = false;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await s.t.finishInProgressScheduledFunctions();
    expect(await s.t.query(api.host.events, {})).toMatchObject([
      { value: { state: "unknown", jobId: (result as { jobId: string }).jobId } },
    ]);
    expect(
      s.actions.mock.calls.filter(
        ([ref, args]) => ref === "run" && args.command.includes("subprocess.Popen"),
      ),
    ).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it("Daytona detaches without a provider poll chain and reads the actual bounded tail after 70000 output characters", async () => {
  const { ctx, provider, actions, replies } = harness();
  const launched = await provider.startBackground(
    ctx,
    "local",
    `python3 -c 'print("x" * 70000); print("FINAL distinctive error")'; exit 7`,
  );
  try {
    let outcome = await provider.poll(ctx, launched.jobId, launched);
    for (let i = 0; outcome.state === "running" && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outcome = await provider.poll(ctx, launched.jobId, launched);
    }
    expect(outcome).toMatchObject({ state: "failed", exitCode: 7 });
    expect(outcome.logTail).toContain("FINAL distinctive error");
    expect(outcome.logTail!.length).toBeLessThanOrEqual(HARD_LIMITS.outputChars);
    expect(Math.max(...replies)).toBeLessThan(HARD_LIMITS.outputChars * 4 + 1024);
    expect(actions.mock.calls.every(([ref]) => ref === "run")).toBe(true);
  } finally {
    await provider.cancelBackground(ctx, launched.jobId, launched);
    await rm(launched.directory, { recursive: true, force: true });
  }
});

it("Daytona deadline cancellation kills the detached process group with bounded execs", async () => {
  const { ctx, provider } = harness();
  const jobId = crypto.randomUUID();
  const directory = `${LIMITS.backgroundRoot}/${jobId}`;
  const launched = await provider.startBackground(
    ctx,
    "local",
    `(sleep 0.3; touch ${directory}/survived) & wait`,
    { jobId, directory, sandboxId: "local" },
  );
  try {
    expect(await provider.poll(ctx, launched.jobId, launched)).toMatchObject({ state: "running" });
    await provider.cancelBackground(ctx, launched.jobId, launched);
    // A killed group can no longer finish its wrapper and publish an exit file.
    expect(await provider.poll(ctx, launched.jobId, launched)).toMatchObject({ state: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(access(`${directory}/survived`)).rejects.toThrow();
  } finally {
    await provider.cancelBackground(ctx, launched.jobId, launched);
    await rm(launched.directory, { recursive: true, force: true });
  }
});

it("Daytona transfers multi-MiB files through bounded file windows without recording bytes in execution rows or args", async () => {
  const { ctx, provider, actions, replies } = harness();
  const directory = await mkdtemp(join(tmpdir(), "agevex-export-"));
  const path = join(directory, "quote's binary.bin");
  const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 251);
  await writeFile(path, bytes);
  const chunks: Uint8Array[] = [];
  try {
    let offset = 0;
    for (;;) {
      const chunk = await provider.download(ctx, "local", path, {
        maxBytes: LIMITS.exportChunkBytes,
        offset,
        totalSizeLimit: LIMITS.exportBytes,
      });
      expect(chunk.length).toBeLessThanOrEqual(LIMITS.exportChunkBytes);
      chunks.push(chunk);
      offset += chunk.length;
      if (chunk.length < LIMITS.exportChunkBytes) break;
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    expect(Math.max(...replies)).toBeLessThan(LIMITS.pathChars);
    for (const [ref, args] of actions.mock.calls) {
      expect(
        Object.values(args).some(
          (value) => value instanceof ArrayBuffer || value instanceof Uint8Array,
        ),
      ).toBe(false);
      if (ref === "read") await expect(access(args.path)).rejects.toThrow();
    }
    await expect(
      provider.download(ctx, "local", path, {
        maxBytes: LIMITS.exportChunkBytes,
        totalSizeLimit: bytes.length - 1,
      }),
    ).rejects.toThrow("SANDBOX_EXPORT_TOO_LARGE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
