import { exec } from "node:child_process";
import { promisify } from "node:util";
import { rm, readFile, unlink, mkdtemp, writeFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { ComponentApi } from "@daytona/convex";
import { daytona } from "../../src/sandbox/daytona.js";
import { HARD_LIMITS, LIMITS } from "../../src/sandbox/limits.js";
import type { SandboxContext } from "../../src/sandbox/types.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import { setup, api, state, EXPORT_TEST_TIMEOUT_MS } from "./setup.js";

// Mock the component boundary, not the adapter: execute its exact shell/Python
// commands locally so quoting, detachment and source-side byte bounds are real.
function harness(env?: Record<string, string>) {
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
      env: { ...process.env, ...env },
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

/** A wake (mutation) schedules its poll action one tick later; run that too. */
async function flush(t: ReturnType<typeof setup>["t"]) {
  await t.finishInProgressScheduledFunctions();
  await vi.advanceTimersByTimeAsync(1);
  await t.finishInProgressScheduledFunctions();
}

function adapterSetup(limits = {}, env?: Record<string, string>) {
  const h = harness(env);
  const fake = fakeSandboxProvider();
  fake.provider.startBackground = (_ctx, ...args) => h.provider.startBackground(h.ctx, ...args);
  fake.provider.poll = (_ctx, ...args) => h.provider.poll(h.ctx, ...args);
  fake.provider.cancelBackground = (_ctx, ...args) => h.provider.cancelBackground(h.ctx, ...args);
  fake.provider.download = (_ctx, ...args) => h.provider.download(h.ctx, ...args);
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
    await flush(s.t);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    const count = s.actions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await flush(s.t);
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
    await flush(s.t);
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

it("Daytona control-file cancellation terminates the original process group without reading a saved PGID", async () => {
  const { ctx, provider } = harness();
  const jobId = crypto.randomUUID();
  const directory = `${LIMITS.backgroundRoot}/${jobId}`;
  const launched = await provider.startBackground(
    ctx,
    "local",
    `trap '' TERM; (sleep 0.3; touch ${directory}/survived) & wait`,
    { jobId, directory, sandboxId: "local" },
  );
  try {
    expect(await provider.poll(ctx, launched.jobId, launched)).toMatchObject({ state: "running" });
    // Removing the saved identity proves the live supervisor owns this kill;
    // the cancellation action cannot signal a persisted integer directly.
    await unlink(`${directory}/group.pid`);
    await provider.cancelBackground(ctx, launched.jobId, launched);
    expect(await readFile(`${directory}/cancel.request`, "utf8")).toBe("deadline\n");
    expect(await provider.poll(ctx, launched.jobId, launched)).toMatchObject({ state: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(access(`${directory}/survived`)).rejects.toThrow();
  } finally {
    await provider.cancelBackground(ctx, launched.jobId, launched);
    await rm(launched.directory, { recursive: true, force: true });
  }
});

// Moves ~1.5 MiB through four windows and hashes it: ~14 s on a loaded machine, so the
// default 5 s limit is too tight. The fixture stays three full windows plus a partial one.
it(
  "Daytona transfers a binary across three full windows and a partial window without recording bytes in execution rows or args",
  async () => {
    const { ctx, provider, actions, replies } = harness();
    const directory = await mkdtemp(join(tmpdir(), "agevex-export-"));
    const path = join(directory, "quote's binary.bin");
    const bytes = Uint8Array.from({ length: 3 * 512 * 1024 + 17 }, (_, i) => i % 251);
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
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it("default exports reject files above 8 MiB with the Node action option before storing bytes", async () => {
  const s = adapterSetup();
  const directory = await mkdtemp(join(tmpdir(), "agevex-cap-"));
  const path = join(directory, "large.bin");
  try {
    await writeFile(path, new Uint8Array(8 * 1024 * 1024 + 1));
    await s.t.action(api.host.invoke, { op: "prepare", input: {} });
    await expect(s.t.action(api.host.invoke, { op: "export", input: { path } })).rejects.toThrow(
      "SANDBOX_EXPORT_TOO_LARGE: register sandboxNodeExport() in a use node file via nodeExport",
    );
    expect(await s.t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
    expect(s.actions.mock.calls.some(([ref]) => ref === "read")).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("a transient Daytona status failure keeps polling with backoff and kills the original group at its deadline", async () => {
  vi.useFakeTimers();
  const s = adapterSetup({ pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 50 });
  const poll = s.fake.provider.poll;
  let attempts = 0;
  s.fake.provider.poll = async (...args) => {
    if (++attempts === 1) throw new Error("transient status failure");
    return poll(...args);
  };
  let directory: string | undefined;
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "sleep 120 & wait" },
    })) as { jobId: string };
    directory = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!.directory;
    await vi.advanceTimersByTimeAsync(10);
    await flush(s.t);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "running",
    });
    await vi.advanceTimersByTimeAsync(40);
    await flush(s.t);
    expect(attempts).toBeGreaterThan(1);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    expect(await readFile(directory + "/cancelled", "utf8")).toBe("deadline");
    const count = s.actions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await flush(s.t);
    expect(s.actions).toHaveBeenCalledTimes(count);
    expect(s.fake.calls.background).toHaveLength(0);
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

it("Daytona completion terminates descendants still in the original process group before reporting done", async () => {
  const { ctx, provider } = harness();
  const jobId = crypto.randomUUID();
  const directory = LIMITS.backgroundRoot + "/" + jobId;
  const job = await provider.startBackground(
    ctx,
    "local",
    "(trap '' TERM; sleep 1; touch " + directory + "/marker) &",
    { jobId, directory, sandboxId: "local" },
  );
  try {
    await expect
      .poll(() => provider.poll(ctx, jobId, job))
      .toMatchObject({ state: "done", exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(access(directory + "/marker")).rejects.toThrow();
  } finally {
    await provider.cancelBackground(ctx, jobId, job);
    await rm(directory, { recursive: true, force: true });
  }
});

it("Daytona reserves the marked leader PID until both completion group signals finish", async () => {
  const patchDirectory = await mkdtemp(join(tmpdir(), "agevex-unreaped-"));
  const jobId = crypto.randomUUID();
  const directory = `${LIMITS.backgroundRoot}/${jobId}`;
  // Audit the real supervisor's OS calls. A reaped leader can release its PGID
  // for reuse; every signal must precede wait() and target the marked child.
  await writeFile(
    join(patchDirectory, "sitecustomize.py"),
    `import os,subprocess
original_init=subprocess.Popen.__init__
original_wait=subprocess.Popen.wait
original_killpg=os.killpg
children={}
reaped=set()
def audit(value):
 with open(${JSON.stringify(directory + "/kill.audit")},'a') as f: f.write(value+'\\n')
def init(self,*args,**kwargs):
 original_init(self,*args,**kwargs)
 if kwargs.get('env',{}).get('AGEVEX_JOB')==${JSON.stringify(jobId)}: children[self.pid]=True
def wait(self,*args,**kwargs):
 result=original_wait(self,*args,**kwargs)
 if self.pid in children:
  reaped.add(self.pid)
  audit('reaped')
 return result
def killpg(pid,sig):
 assert pid in children,'unmarked process group'
 assert pid not in reaped,'leader already reaped; PGID may be reused'
 audit(str(int(sig)))
 return original_killpg(pid,sig)
subprocess.Popen.__init__=init
subprocess.Popen.wait=wait
os.killpg=killpg
`,
  );
  const { ctx, provider } = harness({ PYTHONPATH: patchDirectory });
  const job = { jobId, directory, sandboxId: "local" };
  try {
    await provider.startBackground(ctx, "local", "sleep 120 & exit 7", job);
    await expect
      .poll(() => provider.poll(ctx, jobId, job))
      .toMatchObject({
        state: "failed",
        exitCode: 7,
      });
    expect(await readFile(`${directory}/kill.audit`, "utf8")).toBe("15\n9\nreaped\n");
  } finally {
    await provider.cancelBackground(ctx, jobId, job);
    await rm(directory, { recursive: true, force: true });
    await rm(patchDirectory, { recursive: true, force: true });
  }
});

it.each(["owned", "unmarked", "wrong-job", "unreadable"])(
  "Daytona supervisor-dead fallback verifies every member marker before signaling (%s)",
  async (ownership) => {
    const patchDirectory = await mkdtemp(join(tmpdir(), "agevex-ownership-"));
    const procDirectory = join(patchDirectory, "proc");
    const jobId = crypto.randomUUID();
    const directory = `${LIMITS.backgroundRoot}/${jobId}`;
    // macOS has no /proc. Supply only that filesystem view while retaining
    // real getpgid(), real killpg(), and the unmodified adapter commands. The
    // live test separately verifies Linux's actual inherited environments.
    await writeFile(
      join(patchDirectory, "sitecustomize.py"),
      `import os,builtins
original_scandir=os.scandir
original_open=builtins.open
original_killpg=os.killpg
def scandir(path):
 return original_scandir(${JSON.stringify(procDirectory)} if path=='/proc' else path)
def open_file(path,*args,**kwargs):
 if str(path).startswith('/proc/'): path=${JSON.stringify(procDirectory)}+str(path)[5:]
 return original_open(path,*args,**kwargs)
def killpg(pid,sig):
 with original_open(${JSON.stringify(directory + "/fallback.audit")},'a') as f: f.write(str(pid)+'\\n')
 return original_killpg(pid,sig)
os.scandir=scandir
builtins.open=open_file
os.killpg=killpg
`,
    );
    const { ctx, provider } = harness({ PYTHONPATH: patchDirectory });
    const job = { jobId, directory, sandboxId: "local" };
    let pgid: number | undefined;
    let child: number | undefined;
    try {
      await provider.startBackground(
        ctx,
        "local",
        `sleep 120 & echo $! > ${directory}/child.pid; wait`,
        job,
      );
      pgid = Number(await readFile(`${directory}/group.pid`, "utf8"));
      await expect.poll(() => readFile(`${directory}/child.pid`, "utf8")).toMatch(/^\d+\n$/);
      child = Number(await readFile(`${directory}/child.pid`, "utf8"));
      const supervisor = Number(await readFile(`${directory}/supervisor.pid`, "utf8"));
      process.kill(supervisor, "SIGKILL");
      for (const pid of [pgid, child]) {
        await mkdir(`${procDirectory}/${pid}`, { recursive: true });
        await writeFile(`${procDirectory}/${pid}/environ`, `AGEVEX_JOB=${jobId}\0`);
      }
      if (ownership === "unreadable") await unlink(`${procDirectory}/${child}/environ`);
      else if (ownership !== "owned")
        await writeFile(
          `${procDirectory}/${child}/environ`,
          ownership === "unmarked" ? "PATH=/bin\0" : `AGEVEX_JOB=${jobId}-other\0`,
        );
      await provider.cancelBackground(ctx, jobId, job);
      expect(await readFile(`${directory}/cancel.request`, "utf8")).toBe("deadline\n");
      expect(await provider.poll(ctx, jobId, job)).toMatchObject({ state: "unknown" });
      expect(await readFile(`${directory}/cancelled`, "utf8")).toBe(
        ownership === "owned" ? "deadline" : "unknown",
      );
      if (ownership === "owned")
        expect(await readFile(`${directory}/fallback.audit`, "utf8")).toBe(`${pgid}\n`);
      else {
        await expect(access(`${directory}/fallback.audit`)).rejects.toThrow();
        // The unverified group survives; no signal was sent to its saved PGID.
        expect(() => process.kill(child!, 0)).not.toThrow();
      }
    } finally {
      // These exact children were created by this test; cleanup does not rely
      // on a provider-supplied or potentially reused process-group identity.
      for (const pid of [child, pgid]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
      await rm(patchDirectory, { recursive: true, force: true });
    }
  },
);

it("Daytona publishes group identity and exit status atomically while empty and partial writes stay running", async () => {
  const patchDirectory = await mkdtemp(join(tmpdir(), "agevex-publication-"));
  // Slow every publication write in the actual adapter Python processes. The
  // component mock still executes the complete adapter command unchanged.
  await writeFile(
    join(patchDirectory, "sitecustomize.py"),
    `import builtins,time,os
original=builtins.open
class SlowFile:
 def __init__(self,f): self.f=f
 def __enter__(self): return self
 def __exit__(self,*args): return self.f.__exit__(*args)
 def write(self,value):
  self.f.flush()
  time.sleep(0.3)
  half=max(1,len(value)//2)
  self.f.write(value[:half]); self.f.flush()
  time.sleep(0.3)
  self.f.write(value[half:]); self.f.flush()
def slow_open(path,mode="r",*args,**kwargs):
 f=original(path,mode,*args,**kwargs)
 if "w" in mode and ("group.pid" in str(path) or "status.exit" in str(path)): return SlowFile(f)
 return f
builtins.open=slow_open
`,
  );
  // The pre-fix wrapper writes status with shell printf. Slow that writer as
  // well, so its empty/truncated published file is deterministically visible.
  await writeFile(
    join(patchDirectory, "sh"),
    `#!/bin/sh
exec /bin/sh -c 'printf() { sleep 0.3; command printf "%s" "$2" | head -c 1; sleep 0.3; command printf "%s" "$2" | tail -c +2; }; eval "$1"' sh "$2"
`,
    { mode: 0o755 },
  );
  const { ctx, provider } = harness({
    PYTHONPATH: patchDirectory,
    PATH: `${patchDirectory}:${process.env.PATH}`,
  });
  const jobId = crypto.randomUUID();
  const directory = LIMITS.backgroundRoot + "/" + jobId;
  let launch: Promise<unknown> | undefined;
  const job = { jobId, directory, sandboxId: "local" };
  try {
    launch = provider.startBackground(ctx, "local", "sleep 0.8; exit 17", job);
    await expect
      .poll(async () => {
        await access(directory);
        return true;
      })
      .toBe(true);
    let outcome = await provider.poll(ctx, jobId, job);
    expect(outcome.state).toBe("running");
    const seen = [outcome.state];
    const deadline = Date.now() + 6000;
    while (outcome.state === "running" && Date.now() < deadline) {
      // Cancellation reads group.pid too: whenever its published name exists,
      // it must already contain the complete positive process-group identity.
      for (const name of ["group.pid", "status.exit"]) {
        const published = await readFile(`${directory}/${name}`, "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (published !== undefined) {
          expect(published).toMatch(/^-?\d+\n$/);
          if (name === "group.pid") expect(Number(published)).toBeGreaterThan(1);
          else expect(Number(published)).toBe(17);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      outcome = await provider.poll(ctx, jobId, job);
      seen.push(outcome.state);
      if (outcome.state !== "running")
        expect(outcome).toMatchObject({ state: "failed", exitCode: 17 });
    }
    expect(outcome).toMatchObject({ state: "failed", exitCode: 17 });
    expect(seen).not.toContain("unknown");
    await launch;
  } finally {
    await launch;
    await provider.cancelBackground(ctx, jobId, job);
    await rm(directory, { recursive: true, force: true });
    await rm(patchDirectory, { recursive: true, force: true });
  }
});

it("registered Node exports accept the 64 MiB hard maximum through bounded Daytona windows and reject overflow", async () => {
  const s = adapterSetup();
  state.nodeExport = true;
  const directory = await mkdtemp(join(tmpdir(), "agevex-node-export-"));
  const path = join(directory, "maximum.bin");
  const maximum = 64 * 1024 * 1024;
  const download = s.fake.provider.download;
  const windows: { maxBytes: number; totalSizeLimit?: number }[] = [];
  s.fake.provider.download = async (...args) => {
    windows.push(args[3]);
    return download(...args);
  };
  try {
    await writeFile(path, new Uint8Array(maximum));
    await s.t.action(api.host.invoke, { op: "prepare", input: {} });
    const result = (await s.t.action(api.host.invoke, { op: "export", input: { path } })) as {
      bytes: number;
      sha256: string;
      storageId: string;
    };
    expect(result.bytes).toBe(maximum);
    expect(result.sha256).toBe(
      Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(maximum))).toString("hex"),
    );
    expect(
      await s.t.run(async (ctx) => (await ctx.storage.get(result.storageId as never))!.size),
    ).toBe(maximum);
    expect(windows[0].totalSizeLimit).toBe(8 * 1024 * 1024);
    expect(
      windows
        .slice(1)
        .every(
          (window) =>
            window.totalSizeLimit === maximum && window.maxBytes <= LIMITS.exportChunkBytes,
        ),
    ).toBe(true);
    await writeFile(path, new Uint8Array(maximum + 1));
    await expect(s.t.action(api.host.invoke, { op: "export", input: { path } })).rejects.toThrow(
      "SANDBOX_EXPORT_TOO_LARGE: exceeds exportBytesNode",
    );
    expect(await s.t.run((ctx) => ctx.db.system.query("_storage").collect())).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("an uncertain group kill retries safely until the finite deadline without relaunching Daytona work", async () => {
  vi.useFakeTimers();
  const s = adapterSetup({ pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 50 });
  const cancel = s.fake.provider.cancelBackground;
  let kills = 0;
  s.fake.provider.poll = async () => ({ state: "unknown" });
  s.fake.provider.cancelBackground = async (...args) => {
    await cancel(...args);
    kills++;
    throw new Error("kill acknowledgement lost");
  };
  let directory: string | undefined;
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "sleep 120 & wait" },
    })) as { jobId: string };
    directory = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!.directory;
    await vi.advanceTimersByTimeAsync(10);
    await flush(s.t);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "running",
    });
    await vi.advanceTimersByTimeAsync(40);
    await flush(s.t);
    expect(kills).toBeGreaterThan(1);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    const count = s.actions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await flush(s.t);
    expect(s.actions).toHaveBeenCalledTimes(count);
    expect(await readFile(directory + "/cancelled", "utf8")).toBe("deadline");
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

it("a hung cancellation remains bounded after the poll deadline and leaves no scheduler chain", async () => {
  vi.useFakeTimers();
  const s = adapterSetup({ pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 50 });
  const cancel = s.fake.provider.cancelBackground;
  let kills = 0;
  let acknowledgeKill: () => void;
  const killed = new Promise<void>((resolve) => {
    acknowledgeKill = resolve;
  });
  s.fake.provider.poll = async () => ({ state: "unknown" });
  s.fake.provider.cancelBackground = async (...args) => {
    kills++;
    await cancel(...args);
    acknowledgeKill!();
    return new Promise<never>(() => {});
  };
  let directory: string | undefined;
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "sleep 120 & wait" },
    })) as { jobId: string };
    directory = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!.directory;
    // Wake at 10 ms; its poll action runs one tick later.
    await vi.advanceTimersByTimeAsync(11);
    await killed;
    await vi.advanceTimersByTimeAsync(LIMITS.backgroundKillBudgetMs);
    await flush(s.t);
    expect(kills).toBe(1);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    const count = s.actions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIMITS.actionBudgetMs);
    await flush(s.t);
    expect(s.actions).toHaveBeenCalledTimes(count);
    expect(await readFile(directory + "/cancelled", "utf8")).toBe("deadline");
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

it("a hung status read cannot outlive the job deadline or prevent the Daytona group kill", async () => {
  vi.useFakeTimers();
  const s = adapterSetup({ pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 50 });
  const poll = s.fake.provider.poll;
  s.fake.provider.poll = async (...args) => {
    await poll(...args);
    return new Promise<never>(() => {});
  };
  let directory: string | undefined;
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "sleep 120 & wait" },
    })) as { jobId: string };
    directory = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!.directory;
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(40);
    await flush(s.t);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });
    expect(await readFile(directory + "/cancelled", "utf8")).toBe("deadline");
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

it("a timed-out Daytona exec returns a timeout result and kills the command's process group", async () => {
  const { ctx, provider } = harness();
  const directory = await mkdtemp(join(tmpdir(), "agevex-exec-"));
  const pidFile = join(directory, "pid");
  let pid = 0;
  try {
    // The harness kills the wrapper at Daytona's timeoutSeconds, like the real
    // service. The wrapper must therefore enforce the command timeout earlier.
    const result = await provider.exec(ctx, "local", `echo $$ > '${pidFile}'; exec sleep 30`, {
      timeoutS: 1,
      signal: new AbortController().signal,
    });
    pid = Number(await readFile(pidFile, "utf8"));
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.stderr).toContain("timed out after 1s");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    if (pid)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("a job that deletes its own directory is killed through the environment marker and settles once as unknown", async () => {
  vi.useFakeTimers();
  const patchDirectory = await mkdtemp(join(tmpdir(), "agevex-selfdelete-"));
  const procDirectory = join(patchDirectory, "proc");
  // macOS has no /proc: supply only that view, as the ownership tests do.
  await writeFile(
    join(patchDirectory, "sitecustomize.py"),
    `import os,builtins
original_scandir=os.scandir
original_open=builtins.open
def scandir(path):
 return original_scandir(${JSON.stringify(procDirectory)} if path=='/proc' else path)
def open_file(path,*args,**kwargs):
 if str(path).startswith('/proc/'): path=${JSON.stringify(procDirectory)}+str(path)[5:]
 return original_open(path,*args,**kwargs)
original_kill=os.kill
def kill(pid,sig):
 original_kill(pid,sig)
 try: os.remove(${JSON.stringify(procDirectory)}+'/'+str(pid)+'/environ')  # the process left /proc
 except FileNotFoundError: pass
os.scandir=scandir
builtins.open=open_file
os.kill=kill
`,
  );
  const s = adapterSetup(
    { pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 60_000 },
    {
      PYTHONPATH: patchDirectory,
    },
  );
  let pid = 0;
  try {
    const result = (await s.t.action(api.host.invoke, {
      op: "sandbox_run_background",
      input: { command: "exec sleep 120" },
    })) as { jobId: string };
    const job = (await s.t.query(s.component.state.getJob, { jobId: result.jobId }))!;
    pid = Number(await readFile(`${job.directory}/group.pid`, "utf8"));
    // The command (here: the test) removes the directory while the group lives.
    await rm(job.directory, { recursive: true, force: true });
    await mkdir(`${procDirectory}/${pid}`, { recursive: true });
    await writeFile(`${procDirectory}/${pid}/environ`, `AGEVEX_JOB=${job.providerJobId}\0`);
    await vi.advanceTimersByTimeAsync(11);
    await flush(s.t);
    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
    });
    const events = await s.t.query(api.host.events, {});
    expect(events).toHaveLength(1);
    expect(events[0].value).toMatchObject({ jobId: result.jobId, state: "unknown" });
    // The group did not run on unwatched: it is gone (a zombie may linger a moment).
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 3000 });
  } finally {
    vi.useRealTimers();
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    await rm(patchDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("the marker kill repeats until a pass finds nothing, so a child forked mid-kill does not survive", async () => {
  const patchDirectory = await mkdtemp(join(tmpdir(), "agevex-passes-"));
  const procDirectory = join(patchDirectory, "proc");
  // macOS has no /proc: supply only that view. Killing a pid whose
  // `after-<pid>` file exists makes the named child appear marked, as if it
  // had been forked while the first pass was running.
  await writeFile(
    join(patchDirectory, "sitecustomize.py"),
    `import os,builtins
original_scandir=os.scandir
original_open=builtins.open
original_kill=os.kill
def scandir(path):
 return original_scandir(${JSON.stringify(procDirectory)} if path=='/proc' else path)
def open_file(path,*args,**kwargs):
 if str(path).startswith('/proc/'): path=${JSON.stringify(procDirectory)}+str(path)[5:]
 return original_open(path,*args,**kwargs)
def kill(pid,sig):
 original_kill(pid,sig)
 try: os.remove(${JSON.stringify(procDirectory)}+'/'+str(pid)+'/environ')  # the process left /proc
 except FileNotFoundError: pass
 later=${JSON.stringify(procDirectory)}+'/after-'+str(pid)
 if os.path.exists(later):
  child=original_open(later).read().strip()
  os.makedirs(${JSON.stringify(procDirectory)}+'/'+child,exist_ok=True)
  with original_open(${JSON.stringify(procDirectory)}+'/'+child+'/environ','w') as f: f.write(open_marker)
os.scandir=scandir
builtins.open=open_file
os.kill=kill
open_marker='AGEVEX_JOB='+os.environ['TEST_JOB']+'\\0'
`,
  );
  const jobId = crypto.randomUUID();
  const { ctx, provider } = harness({ PYTHONPATH: patchDirectory, TEST_JOB: jobId });
  const spawn = (await import("node:child_process")).spawn;
  const parent = spawn("sleep", ["120"], { stdio: "ignore" });
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await mkdir(`${procDirectory}/${parent.pid}`, { recursive: true });
    await writeFile(`${procDirectory}/${parent.pid}/environ`, `AGEVEX_JOB=${jobId}\0`);
    await writeFile(`${procDirectory}/after-${parent.pid}`, String(child.pid));
    await provider.cancelBackground(ctx, jobId, {
      sandboxId: "local",
      directory: join(patchDirectory, "missing-job-dir"),
    });
    await vi.waitFor(
      () => expect([alive(parent.pid!), alive(child.pid!)]).toEqual([false, false]),
      {
        timeout: 3000,
      },
    );
  } finally {
    parent.kill("SIGKILL");
    child.kill("SIGKILL");
    await rm(patchDirectory, { recursive: true, force: true });
  }
}, 30_000);
