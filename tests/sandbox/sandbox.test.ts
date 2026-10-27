import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { componentsGeneric, createFunctionHandle, makeFunctionReference } from "convex/server";
import { getFile } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
import type { AgentComponent } from "@convex-dev/agent";
import { defineSandbox, HARD_LIMITS, LIMITS } from "../../src/modules/sandbox/client/index.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import type { SandboxFacts } from "../../src/modules/sandbox/client/types.js";
import { setup, api, state, EXPORT_TEST_TIMEOUT_MS } from "./setup.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
type Setup = ReturnType<typeof setup>;

const invoke = (t: Setup["t"], op: string, input: unknown = {}, extra = {}) =>
  t.action(api.host.invoke, { op, input, ...extra });

const keyFor = (facts: SandboxFacts = { subject: "owner", threadId: "thread", runId: "run" }) =>
  state.instance!.scopeKey(facts);

async function row(s: Setup) {
  return s.t.query(s.component.state.get, { scopeKey: await keyFor() });
}
/** convex-test runs `runAfter(0)` one millisecond after the scheduling mutation. */
const WAKE_TO_POLL_MS = 1;

async function advance(t: Setup["t"], ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await t.finishInProgressScheduledFunctions();
  // A wake (mutation) schedules its poll action one tick later; let it run.
  await vi.advanceTimersByTimeAsync(WAKE_TO_POLL_MS);
  await t.finishInProgressScheduledFunctions();
}

it.each(["thread", "run", "subject"] as const)(
  "%s scope binds only the corresponding trusted facts and isolates subjects",
  async (scope) => {
    const s = setup(scope);
    const first = await invoke(s.t, "prepare");

    expect(await invoke(s.t, "prepare")).toEqual(first);
    const otherThread = await invoke(s.t, "prepare", {}, { threadId: "other" });

    expect(otherThread).toEqual(
      scope === "thread" ? expect.not.objectContaining(first as object) : first,
    );

    const otherRun = await invoke(s.t, "prepare", {}, { runId: "other" });

    expect(otherRun).toEqual(
      scope === "run" ? expect.not.objectContaining(first as object) : first,
    );

    expect(await invoke(s.t, "prepare", {}, { subject: "other" })).not.toEqual(first);
    expect(s.fake.calls.create).toBe(scope === "subject" ? 2 : 3);
  },
);

it("persists the provider id before cold-start readiness completes and admits one create", async () => {
  let release!: () => void;
  let reached!: () => void;

  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fake = fakeSandboxProvider({
    beforeReady: async () => {
      reached();
      await gate;
    },
  });

  const s = setup("thread", {}, fake);
  const pending = invoke(s.t, "prepare");

  await waiting;
  const persisted = await row(s);

  expect(persisted).toMatchObject({ sandboxId: "fake-sandbox-1", state: "creating" });
  expect(fake.sandboxes.get(persisted!.sandboxId!)!.state).toBe("creating");
  const second = invoke(s.t, "prepare");

  release();
  expect(await second).toEqual(await pending);
  expect(fake.calls.create).toBe(1);
});

it("a lost create response is unknown and never silently creates another sandbox", async () => {
  const fake = fakeSandboxProvider({
    create: async () => {
      throw new Error("lost response");
    },
  });

  const s = setup("thread", {}, fake);

  await expect(invoke(s.t, "prepare")).rejects.toThrow("lost response");
  await expect(invoke(s.t, "prepare")).rejects.toThrow("SANDBOX_UNKNOWN");
  await advance(s.t, LIMITS.actionBudgetMs);
  await expect(invoke(s.t, "prepare")).rejects.toThrow("SANDBOX_UNKNOWN");
  expect(fake.calls.create).toBe(1);
  expect(await row(s)).toMatchObject({ state: "unknown" });
});

it.each(["stopped", "archived", "error"] as const)(
  "resumes a %s sandbox with its original files and identity",
  async (remoteState) => {
    const s = setup();

    await invoke(s.t, "sandbox_write_file", { path: "/file", content: "kept" });
    const id = (await row(s))!.sandboxId!;

    if (remoteState === "stopped") await invoke(s.t, "stop");
    else s.fake.sandboxes.get(id)!.state = remoteState;

    expect(await invoke(s.t, "sandbox_read_file", { path: "/file" })).toEqual({ content: "kept" });
    expect((await row(s))!.sandboxId).toBe(id);
    expect(s.fake.calls.create).toBe(1);
    expect(s.fake.sandboxes.get(id)!.state).toBe("ready");
  },
);

it("a lost stop response records unknown and the next use reconciles the original filesystem", async () => {
  const s = setup();

  await invoke(s.t, "sandbox_write_file", { path: "/file", content: "kept" });
  const stop = s.fake.provider.stop;

  s.fake.provider.stop = async (ctx, id) => {
    await stop(ctx, id);
    throw new Error("lost stop");
  };

  await expect(invoke(s.t, "stop")).rejects.toThrow("lost stop");
  expect(await row(s)).toMatchObject({ state: "unknown" });

  expect(state.usage).toContainEqual(
    expect.objectContaining({ operation: "stop", outcome: "unknown" }),
  );

  expect(await invoke(s.t, "sandbox_read_file", { path: "/file" })).toEqual({ content: "kept" });
  expect(s.fake.calls.stop).toBe(1);
  expect(s.fake.calls.create).toBe(1);
});

it("exec retains the output tail within a shared stdout/stderr allowance and reuses the real ledger receipt", async () => {
  const fake = fakeSandboxProvider({
    exec: () => ({ exitCode: 7, stdout: "a very long prefix:end", stderr: "bad" }),
  });

  const s = setup("thread", { outputChars: 8 }, fake);
  const input = { command: "one effect" };
  const result = await invoke(s.t, "sandbox_exec", input, { key: "same" });

  expect(result).toEqual({
    status: "done",
    exitCode: 7,
    stdout: "x:end",
    stderr: "bad",
    truncated: true,
    timedOut: false,
  });

  expect(await invoke(s.t, "sandbox_exec", input, { key: "same" })).toEqual(result);

  expect(await invoke(s.t, "sandbox_exec", { command: "different" }, { key: "same" })).toEqual({
    status: "denied",
    code: "KEY_CONFLICT",
  });

  expect(fake.calls.exec).toEqual([input.command]);
});

it("uncertain exec outcomes remain unknown on replay without rerunning the command", async () => {
  const fake = fakeSandboxProvider({
    exec: async () => {
      throw new Error("response lost after effect");
    },
  });

  const s = setup("thread", {}, fake);

  expect(await invoke(s.t, "sandbox_exec", { command: "billable" }, { key: "lost" })).toEqual({
    status: "unknown",
  });

  expect(await invoke(s.t, "sandbox_exec", { command: "billable" }, { key: "lost" })).toEqual({
    status: "unknown",
  });

  expect(fake.calls.exec).toHaveLength(1);
});

it("four-byte exec output at the hard maximum fits the core receipt without replaying effects", async () => {
  const text = "𐍈".repeat(HARD_LIMITS.outputChars);

  const s = setup(
    "thread",
    { outputChars: HARD_LIMITS.outputChars },
    fakeSandboxProvider({ exec: () => ({ exitCode: 0, stdout: text, stderr: text }) }),
  );

  const result = await invoke(s.t, "sandbox_exec", { command: "unicode" }, { key: "max" });

  expect(result).toMatchObject({
    status: "done",
    stdout: "",
    stderr: text.slice(-HARD_LIMITS.outputChars),
  });

  expect(getConvexSize(result)).toBeLessThan(64 * 1024);
  expect(await invoke(s.t, "sandbox_exec", { command: "unicode" }, { key: "max" })).toEqual(result);
  expect(s.fake.calls.exec).toHaveLength(1);
});

it("file reads, writes and listings enforce their registered bounds without putting file text in receipts", async () => {
  const s = setup("thread", { fileReadChars: 4, writeChars: 16, listEntries: 1 });

  await invoke(
    s.t,
    "sandbox_write_file",
    { path: "/dir/a", content: "prefix tail" },
    { key: "write" },
  );

  await invoke(
    s.t,
    "sandbox_write_file",
    { path: "/dir/a", content: "prefix tail" },
    { key: "write" },
  );

  expect(await invoke(s.t, "sandbox_read_file", { path: "/dir/a" })).toEqual({ content: "tail" });
  await invoke(s.t, "sandbox_write_file", { path: "/dir/b", content: "b" });

  expect(await invoke(s.t, "sandbox_list", { path: "/dir" })).toEqual({
    entries: [{ name: "a", isDir: false, size: 11 }],
  });

  expect(
    await invoke(s.t, "sandbox_write_file", { path: "/dir/a", content: "x".repeat(17) }),
  ).toEqual({ status: "failed", code: "TOOL_FAILED" });

  expect(await invoke(s.t, "sandbox_read_file", { path: "/dir/a" })).toEqual({ content: "tail" });
});

it.each(["done", "failed", "unknown"] as const)(
  "background polling delivers one atomic %s event and stops without replaying launch",
  async (outcome) => {
    const s = setup(
      "thread",
      { pollMinMs: 100, pollMaxMs: 400 },
      fakeSandboxProvider({
        background: () => [
          { state: "running" },
          {
            state: outcome,
            ...(outcome === "unknown" ? {} : { exitCode: outcome === "done" ? 0 : 1 }),
            logTail: "terminal",
          },
        ],
      }),
    );

    const result = (await invoke(
      s.t,
      "sandbox_run_background",
      { command: "work" },
      { key: "job" },
    )) as { jobId: string };

    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      providerJobId: expect.any(String),
      state: "running",
    });

    expect(
      await invoke(s.t, "sandbox_run_background", { command: "work" }, { key: "job" }),
    ).toEqual(result);

    await advance(s.t, 100);
    expect(s.fake.calls.poll).toHaveLength(1);
    await advance(s.t, 199);
    expect(s.fake.calls.poll).toHaveLength(1);
    await advance(s.t, 1);
    const events = await s.t.query(api.host.events, {});

    expect(events).toHaveLength(1);

    expect(events[0].value).toMatchObject({
      type: "sandbox.job.completed",
      jobId: result.jobId,
      state: outcome,
      subject: "owner",
      threadId: "thread",
      runId: "run",
      logTail: "terminal",
    });

    await advance(s.t, LIMITS.actionBudgetMs);
    expect(s.fake.calls.background).toEqual(["work"]);
    expect(s.fake.calls.poll).toHaveLength(2);
    expect(await s.t.query(api.host.events, {})).toHaveLength(1);
  },
);

it("a lost background launch response is persisted as unknown and cannot launch twice", async () => {
  const fake = fakeSandboxProvider();

  fake.provider.startBackground = async () => {
    fake.calls.background.push("uncertain");
    throw new Error("lost");
  };

  const s = setup("thread", {}, fake);

  const result = (await invoke(
    s.t,
    "sandbox_run_background",
    { command: "work" },
    { key: "launch" },
  )) as { jobId: string };

  expect(result).toMatchObject({ status: "unknown" });

  expect(
    await invoke(s.t, "sandbox_run_background", { command: "work" }, { key: "launch" }),
  ).toEqual(result);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "unknown",
  });

  expect((await s.t.query(api.host.events, {}))[0].value.state).toBe("unknown");
  expect(fake.calls.background).toHaveLength(1);
});

it("an interrupted launch is detected by its persisted watchdog and becomes unknown without launching work", async () => {
  const s = setup();

  await invoke(s.t, "prepare");

  const pollHandle = await s.t.run(() =>
    createFunctionHandle(makeFunctionReference<"mutation">("host:wake")),
  );

  const admitted = await s.t.mutation(s.component.state.reserveJob, {
    scopeKey: await keyFor(),
    subject: "owner",
    threadId: "thread",
    runId: "run",
    pollHandle,
    pollMinMs: LIMITS.pollMinMs,
    pollMaxMs: LIMITS.pollMaxMs,
    jobTimeoutMs: LIMITS.jobTimeoutMs,
    maximum: LIMITS.jobsPerSandbox,
  });

  // No attach follows: this is the committed state left by an action that
  // died after reserving its launch, before its provider response was saved.
  await advance(s.t, LIMITS.actionBudgetMs);

  expect(await s.t.query(s.component.state.getJob, { jobId: admitted.jobId })).toMatchObject({
    state: "unknown",
  });

  expect((await s.t.query(api.host.events, {}))[0].value.state).toBe("unknown");
  expect(s.fake.calls.background).toHaveLength(0);
  expect(s.fake.calls.poll).toHaveLength(0);
});

it("a lost launch and throwing callback retain the unknown receipt and job id until the watchdog notifies", async () => {
  const fake = fakeSandboxProvider();

  fake.provider.startBackground = async () => {
    fake.calls.background.push("lost");
    throw new Error("lost launch response");
  };

  const s = setup("thread", {}, fake);

  state.callbackFails = true;

  const result = await invoke(
    s.t,
    "sandbox_run_background",
    { command: "work" },
    { key: "lost-callback" },
  );

  expect(result).toMatchObject({ status: "unknown", jobId: expect.any(String) });

  expect(
    await invoke(s.t, "sandbox_run_background", { command: "work" }, { key: "lost-callback" }),
  ).toEqual(result);

  expect(await s.t.query(api.host.events, {})).toHaveLength(0);
  state.callbackFails = false;
  await advance(s.t, LIMITS.actionBudgetMs);

  expect(await s.t.query(api.host.events, {})).toMatchObject([
    { value: { jobId: (result as { jobId: string }).jobId, state: "unknown" } },
  ]);

  expect(fake.calls.background).toHaveLength(1);
});

// Moves ~1.5 MiB through four windows and hashes it: ~14 s on a loaded machine, so the
// default 5 s limit is too tight. The fixture stays three full windows plus a partial one.
it(
  "exports a binary across three full windows and a partial window with an exact incremental hash and stores nothing on interruption",
  async () => {
    const s = setup();

    await invoke(s.t, "prepare");
    const bytes = Uint8Array.from({ length: 3 * 512 * 1024 + 17 }, (_, i) => i % 251);

    s.fake.sandboxes.get((await row(s))!.sandboxId!)!.files.set("/large.bin", bytes);
    const download = s.fake.provider.download;
    const windows: number[] = [];

    s.fake.provider.download = async (ctx, id, path, opts) => {
      windows.push(opts.maxBytes);

      return download(ctx, id, path, opts);
    };

    const result = (await invoke(s.t, "export", { path: "/large.bin" })) as {
      storageId: string;
      bytes: number;
      sha256: string;
    };

    expect(result.bytes).toBe(bytes.length);

    expect(result.sha256).toBe(
      Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
    );

    expect(
      new Uint8Array(
        await s.t.run(async (ctx) =>
          (await ctx.storage.get(result.storageId as never))!.arrayBuffer(),
        ),
      ),
    ).toEqual(bytes);

    expect(windows.length).toBeGreaterThan(1);
    expect(Math.max(...windows)).toBeLessThanOrEqual(512 * 1024);
    const before = await s.t.run((ctx) => ctx.db.system.query("_storage").collect());
    let reads = 0;

    s.fake.provider.download = async (ctx, id, path, opts) => {
      if (++reads === 2) throw new Error("interrupted transfer");

      return download(ctx, id, path, opts);
    };

    await expect(invoke(s.t, "export", { path: "/large.bin" })).rejects.toThrow(
      "interrupted transfer",
    );

    expect(await s.t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual(before);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it("persistent polling errors retain deadline enforcement without retrying paid work", async () => {
  const s = setup("thread", { pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 30 });

  s.fake.provider.poll = async () => {
    throw new Error("unavailable");
  };

  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  await advance(s.t, 10);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "running",
  });

  await advance(s.t, 20);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "unknown",
    code: "SANDBOX_JOB_DEADLINE",
  });

  expect(s.fake.calls.cancel).toHaveLength(1);
  expect(s.fake.calls.background).toHaveLength(1);
});

it.each([10, 100])(
  "job deadlines stop polling and report unknown for work that never completes (poll interval %i)",
  async (pollMinMs) => {
    const s = setup(
      "thread",
      { pollMinMs, pollMaxMs: Math.max(pollMinMs, 20), jobTimeoutMs: 30 },
      fakeSandboxProvider({ background: () => [{ state: "running" }] }),
    );

    const result = (await invoke(s.t, "sandbox_run_background", { command: "forever" })) as {
      jobId: string;
    };

    await advance(s.t, 10);
    await advance(s.t, 20);

    expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });

    expect(s.fake.calls.cancel).toHaveLength(1);
    const polls = s.fake.calls.poll.length;

    await advance(s.t, LIMITS.actionBudgetMs);
    expect(s.fake.calls.poll).toHaveLength(polls);
    expect(s.fake.calls.background).toHaveLength(1);
  },
);

it("a failed host completion callback rolls back settlement and its watchdog delivers the event later", async () => {
  const s = setup(
    "thread",
    { pollMinMs: 10 },
    fakeSandboxProvider({ background: () => [{ state: "done", exitCode: 0 }] }),
  );

  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  state.callbackFails = true;
  await advance(s.t, 10);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "running",
  });

  expect(await s.t.query(api.host.events, {})).toHaveLength(0);
  state.callbackFails = false;
  await advance(s.t, LIMITS.actionBudgetMs);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "done",
  });

  expect(await s.t.query(api.host.events, {})).toHaveLength(1);
  expect(s.fake.calls.background).toHaveLength(1);
});

it("a permanently failing host callback stops scheduling at the deadline and leaves a readable unknown job", async () => {
  const s = setup(
    "thread",
    { pollMinMs: 10, jobTimeoutMs: 20 },
    fakeSandboxProvider({ background: () => [{ state: "done", exitCode: 0 }] }),
  );

  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  state.callbackFails = true;
  await advance(s.t, 10);
  await advance(s.t, LIMITS.actionBudgetMs);

  expect(await invoke(s.t, "job", { jobId: result.jobId })).toMatchObject({
    state: "unknown",
    providerJobId: expect.any(String),
  });

  const polls = s.fake.calls.poll.length;

  await advance(s.t, LIMITS.actionBudgetMs);
  expect(s.fake.calls.poll).toHaveLength(polls);
  expect(s.fake.calls.background).toHaveLength(1);
  expect(await s.t.query(api.host.events, {})).toHaveLength(0);
});

it("exports exact binary bytes through Agent storeFile with a SHA-256 and native dedupe", async () => {
  const s = setup();

  await invoke(s.t, "prepare");
  const bytes = new Uint8Array([0, 255, 128, 1, 2, 3]);

  s.fake.sandboxes.get((await row(s))!.sandboxId!)!.files.set("/image.bin", bytes);

  const exported = (await invoke(s.t, "export", { path: "/image.bin" })) as {
    fileId: string;
    storageId: string;
    bytes: number;
    sha256: string;
  };

  expect(exported).toMatchObject({
    bytes: bytes.byteLength,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  expect(await invoke(s.t, "export", { path: "/image.bin" })).toEqual(exported);
  const native = componentsGeneric()["agent"] as unknown as AgentComponent;
  const file = await s.t.run(async (ctx) => (await getFile(ctx, native, exported.fileId)).file);

  expect(file.hash).toBe(exported.sha256);

  const stored = await s.t.run(async (ctx) =>
    (await ctx.storage.get(exported.storageId as never))!.arrayBuffer(),
  );

  expect(new Uint8Array(stored)).toEqual(bytes);
});

it("run-scoped export resolves the run from host state and rejects cross-subject resolution", async () => {
  const s = setup("run");

  await invoke(s.t, "sandbox_write_file", { path: "/file", content: "run file" });
  expect(await invoke(s.t, "export", { path: "/file" })).toMatchObject({ bytes: 8 });
  state.resolver = { subject: "other", threadId: "thread", runId: "run" };
  await expect(invoke(s.t, "export", { path: "/file" })).rejects.toThrow("SANDBOX_FORBIDDEN");
});

it("hard-maximum file text and binary exports fit enforced transactions without storing payloads on module rows", async () => {
  const s = setup("thread", {
    fileReadChars: HARD_LIMITS.fileReadChars,
    writeChars: HARD_LIMITS.writeChars,
    exportBytes: HARD_LIMITS.exportBytes,
  });

  const content = "界".repeat(HARD_LIMITS.writeChars);

  expect(await invoke(s.t, "sandbox_write_file", { path: "/max.txt", content })).toEqual({
    status: "done",
  });

  expect(await invoke(s.t, "sandbox_read_file", { path: "/max.txt" })).toEqual({ content });
  const binding = (await row(s))!;

  s.fake.sandboxes
    .get(binding.sandboxId!)!
    .files.set("/max.bin", new Uint8Array(HARD_LIMITS.exportBytes));

  expect(await invoke(s.t, "export", { path: "/max.bin" })).toMatchObject({
    bytes: HARD_LIMITS.exportBytes,
  });

  s.fake.sandboxes
    .get(binding.sandboxId!)!
    .files.set("/too-big.bin", new Uint8Array(HARD_LIMITS.exportBytes + 1));

  await expect(invoke(s.t, "export", { path: "/too-big.bin" })).rejects.toThrow(
    "SANDBOX_EXPORT_TOO_LARGE",
  );

  expect(getConvexSize(await row(s))).toBeLessThan(LIMITS.sandboxRowBytes);
});

it("TTL cleanup runs only on demand and never retries an uncertain delete", async () => {
  const s = setup(
    "thread",
    { ttl: 1, pollMinMs: 100, pollMaxMs: 100 },
    fakeSandboxProvider({ background: () => [{ state: "running" }] }),
  );

  await invoke(s.t, "prepare");
  await advance(s.t, LIMITS.actionBudgetMs + 1);
  expect(s.fake.calls.delete).toBe(0);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(1);
  expect(await row(s)).toMatchObject({ state: "deleted" });

  const second = setup("thread", { ttl: 1 }, fakeSandboxProvider());

  await invoke(second.t, "prepare");

  second.fake.provider.delete = async () => {
    second.fake.calls.delete++;
    throw new Error("unknown");
  };

  await advance(second.t, LIMITS.actionBudgetMs + 1);
  await invoke(second.t, "cleanup");
  await advance(second.t, 0);
  await invoke(second.t, "cleanup");
  await advance(second.t, 0);
  expect(second.fake.calls.delete).toBe(1);
  expect(await row(second)).toMatchObject({ state: "unknown" });
});

it("TTL cleanup cannot delete the filesystem while a background job is active", async () => {
  const s = setup(
    "thread",
    { ttl: 1, pollMinMs: 60_000, pollMaxMs: 60_000 },
    fakeSandboxProvider({ background: () => [{ state: "running" }] }),
  );

  const result = (await invoke(s.t, "sandbox_run_background", { command: "long" })) as {
    jobId: string;
  };

  await advance(s.t, LIMITS.actionBudgetMs + 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(0);
  s.fake.jobs.set([...s.fake.jobs.keys()][0], [{ state: "done", exitCode: 0 }]);
  await advance(s.t, 60_000);

  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "done",
  });

  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(1);
});

it("host authorization gates tools, exports, lifecycle and scheduled cleanup before provider work", async () => {
  const s = setup();

  await invoke(s.t, "prepare");
  const before = { ...s.fake.calls };

  state.authorized = false;

  for (const op of ["prepare", "export", "stop", "delete", "cleanup"])
    await expect(invoke(s.t, op, { path: "/x" })).rejects.toThrow("HOST_DENIED");

  expect(await invoke(s.t, "sandbox_exec", { command: "denied" })).toEqual({
    status: "failed",
    code: "TOOL_FAILED",
  });

  expect(s.fake.calls.create).toBe(before.create);
  expect(s.fake.calls.resume).toBe(before.resume);
  expect(s.fake.calls.exec).toHaveLength(0);
});

it("revoked background authority records unknown and stops before provider polling", async () => {
  const s = setup("thread", { pollMinMs: 10 });

  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  state.authorized = false;
  state.deniedWith = "FORBIDDEN";
  await advance(s.t, 10);
  state.authorized = true;
  expect(await invoke(s.t, "job", { jobId: result.jobId })).toMatchObject({ state: "unknown" });
  await advance(s.t, LIMITS.actionBudgetMs);
  expect(s.fake.calls.poll).toHaveLength(0);
  expect(s.fake.calls.background).toHaveLength(1);
  expect(await s.t.query(api.host.events, {})).toHaveLength(0);
});

it("usage observations carry attribution and estimate-only provenance without changing effects on hook failure", async () => {
  const s = setup();

  await invoke(s.t, "sandbox_exec", { command: "hello" });

  expect(state.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "exec",
        source: "estimate",
        subject: "owner",
        threadId: "thread",
        runId: "run",
        outcome: "observed",
      }),
    ]),
  );

  state.usageFails = true;

  expect(await invoke(s.t, "sandbox_exec", { command: "still works" })).toMatchObject({
    status: "done",
  });
});

it("registration rejects invalid and excessive host bounds before provider calls", async () => {
  const s = setup();

  await invoke(s.t, "prepare");

  for (const value of [NaN, Infinity, -1, 0, 1.5, HARD_LIMITS.commandTimeoutS + 1])
    expect(() =>
      defineSandbox({
        component: s.component,
        provider: s.fake.provider,
        scope: "thread",
        authorize: async () => ({ subject: "owner" }),
        limits: { commandTimeoutS: value },
      }),
    ).toThrow("SANDBOX_INVALID");

  for (const name of ["exportBytes", "exportBytesNode"] as const)
    expect(() =>
      defineSandbox({
        component: s.component,
        provider: s.fake.provider,
        scope: "thread",
        authorize: async () => ({ subject: "owner" }),
        limits: { [name]: HARD_LIMITS[name] + 1 },
      }),
    ).toThrow(`SANDBOX_INVALID_${name}`);

  await expect(
    invoke(s.t, "prepare", {}, { subject: "x".repeat(LIMITS.identityChars + 1) }),
  ).rejects.toThrow("SANDBOX_INVALID");

  expect(s.fake.calls.create).toBe(1);
});

it("hard-maximum active job admission stays within enforced transaction limits", async () => {
  const s = setup("thread", { ...HARD_LIMITS, pollMinMs: HARD_LIMITS.pollMinMs });

  await invoke(s.t, "prepare");
  const key = await keyFor();

  const pollHandle = await s.t.run(() =>
    createFunctionHandle(makeFunctionReference<"mutation">("host:wake")),
  );

  // Seed through the same public component admission path the tool uses.
  // Max-size attribution tests row byte bounds as well as document counts.
  for (let i = 0; i < HARD_LIMITS.jobsPerSandbox; i++)
    await s.t.mutation(s.component.state.reserveJob, {
      scopeKey: key,
      subject: "𐍈".repeat(LIMITS.identityChars / 2),
      threadId: "𐍈".repeat(LIMITS.identityChars / 2),
      runId: "𐍈".repeat(LIMITS.identityChars / 2),
      pollHandle,
      pollMinMs: HARD_LIMITS.pollMinMs,
      pollMaxMs: HARD_LIMITS.pollMaxMs,
      jobTimeoutMs: HARD_LIMITS.jobTimeoutMs,
      maximum: HARD_LIMITS.jobsPerSandbox,
    });

  await expect(
    s.t.mutation(s.component.state.reserveJob, {
      scopeKey: key,
      subject: "owner",
      threadId: "thread",
      runId: "run",
      pollHandle,
      pollMinMs: HARD_LIMITS.pollMinMs,
      pollMaxMs: HARD_LIMITS.pollMaxMs,
      jobTimeoutMs: HARD_LIMITS.jobTimeoutMs,
      maximum: HARD_LIMITS.jobsPerSandbox,
    }),
  ).rejects.toThrow("SANDBOX_JOB_LIMIT");
});

it("a full batch of lost-create reservations leaves the TTL sweep instead of scheduling forever", async () => {
  const s = setup(
    "thread",
    { cleanupBatch: HARD_LIMITS.cleanupBatch, ttl: 1 },
    fakeSandboxProvider({
      create: async () => {
        throw new Error("unknown create");
      },
    }),
  );

  for (let i = 0; i < HARD_LIMITS.cleanupBatch; i++)
    await expect(invoke(s.t, "prepare", {}, { threadId: `lost-${i}` })).rejects.toThrow(
      "unknown create",
    );

  await advance(s.t, LIMITS.actionBudgetMs + 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  await advance(s.t, 1);

  expect(
    await s.t.query(s.component.state.expired, { limit: HARD_LIMITS.cleanupBatch }),
  ).toHaveLength(0);

  expect(s.fake.calls.create).toBe(HARD_LIMITS.cleanupBatch);
  expect(s.fake.calls.delete).toBe(0);
});

it("hard-maximum cleanup batches stay within enforced transaction limits and drain completely", async () => {
  const s = setup("thread", { cleanupBatch: HARD_LIMITS.cleanupBatch, ttl: 1 });

  // Max-sized scopes force cleanup across its hard batch boundary.
  for (let i = 0; i <= HARD_LIMITS.cleanupBatch; i++)
    await invoke(s.t, "prepare", {}, { threadId: `victim-${i}-${"𐍈".repeat(110)}` });

  await advance(s.t, LIMITS.actionBudgetMs + 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 1);
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(HARD_LIMITS.cleanupBatch + 1);
});

it("a scope whose sandbox TTL cleanup deleted gets a fresh sandbox on next use", async () => {
  const s = setup("thread", { ttl: 1 });

  await invoke(s.t, "prepare");
  const first = (await row(s))!;

  await advance(s.t, LIMITS.actionBudgetMs + 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(await row(s)).toMatchObject({ state: "deleted" });
  await invoke(s.t, "sandbox_write_file", { path: "/again", content: "new" });
  const second = (await row(s))!;

  expect(second).toMatchObject({ state: "ready", sandboxId: "fake-sandbox-2" });
  expect(second.claim).not.toBe(first.claim);
  expect(s.fake.calls.create).toBe(2);
  expect(await invoke(s.t, "sandbox_read_file", { path: "/again" })).toEqual({ content: "new" });
});

it("a final watchdog claimed past the deadline notifies the host once as unknown and then schedules nothing", async () => {
  const fake = fakeSandboxProvider({ background: () => [{ state: "running" }] });

  fake.provider.cancelBackground = async (_ctx, id) => {
    fake.calls.cancel.push(id);

    return new Promise<never>(() => {});
  };

  const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400, jobTimeoutMs: 1_000 }, fake);

  const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "forever" })) as {
    jobId: string;
  };

  // This attempt takes the claim and dies without ever settling it. Its lease
  // runs to the deadline plus the kill budget and margin: the last wake.
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).not.toBeNull();

  await vi.advanceTimersByTimeAsync(
    1_000 + LIMITS.backgroundKillBudgetMs + LIMITS.backgroundLeaseMarginMs + 1,
  );

  // That wake finds the deadline long gone. Its kill hangs, but is bounded.
  await vi.advanceTimersByTimeAsync(LIMITS.backgroundKillBudgetMs + 1);
  await s.t.finishInProgressScheduledFunctions();

  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({
    state: "unknown",
    code: "SANDBOX_JOB_DEADLINE",
  });

  // The host callback ran exactly once, atomically with the terminal state.
  const events = await s.t.query(api.host.events, {});

  expect(events).toHaveLength(1);

  expect(events[0].value).toMatchObject({
    type: "sandbox.job.completed",
    jobId,
    state: "unknown",
    code: "SANDBOX_JOB_DEADLINE",
  });

  const work = [fake.calls.poll.length, fake.calls.cancel.length];

  expect(work[1]).toBe(1);
  await advance(s.t, LIMITS.actionBudgetMs);
  expect([fake.calls.poll.length, fake.calls.cancel.length]).toEqual(work);
  expect(await s.t.query(api.host.events, {})).toHaveLength(1);

  const live = await s.t.run((ctx) =>
    ctx.db.system
      .query("_scheduled_functions")
      .collect()
      .then((rows) => rows.filter((row) => ["pending", "inProgress"].includes(row.state.kind))),
  );

  expect(live).toHaveLength(0);
});

it("a final attempt that also never settles ends the job directly instead of claiming forever", async () => {
  const fake = fakeSandboxProvider({ background: () => [{ state: "running" }] });
  const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400, jobTimeoutMs: 1_000 }, fake);

  const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "forever" })) as {
    jobId: string;
  };

  const stages = LIMITS.backgroundKillBudgetMs + LIMITS.backgroundLeaseMarginMs;

  // Two attempts claimed at or after the deadline die unsettled; the next ends it.
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).not.toBeNull();
  vi.setSystemTime(Date.now() + 1_000 + stages + 1);
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).not.toBeNull();
  vi.setSystemTime(Date.now() + stages + 1);
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).not.toBeNull();
  vi.setSystemTime(Date.now() + stages + 1);
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).toBeNull();

  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({
    state: "unknown",
    code: "SANDBOX_JOB_DEADLINE",
  });
});

it("cleanup defers a delete the remaining action budget cannot finish instead of recording it unknown", async () => {
  const fake = fakeSandboxProvider();
  const s = setup("thread", { ttl: 1 }, fake);

  await invoke(s.t, "prepare", {}, { threadId: "a" });
  await invoke(s.t, "prepare", {}, { threadId: "b" });
  await advance(s.t, LIMITS.actionBudgetMs + 1);
  const remove = fake.provider.delete;
  let calls = 0;

  fake.provider.delete = async (ctx, id) => {
    // The first delete eats nearly the whole 540 s action budget; the second
    // one then takes 5 s, far more than the 1 s left.
    if (++calls === 1) vi.setSystemTime(Date.now() + LIMITS.actionBudgetMs - 1_000);
    else await new Promise((resolve) => setTimeout(resolve, 5_000));

    await remove(ctx, id);
  };

  await invoke(s.t, "cleanup");
  // First sweep: deletes one row, defers the other and reschedules itself.
  await vi.advanceTimersByTimeAsync(0);
  await s.t.finishInProgressScheduledFunctions();
  // Second sweep: its delete waits on a fake 5 s timer, so advance concurrently.
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(10_000);
  await s.t.finishInProgressScheduledFunctions();

  const rows = await Promise.all(
    ["a", "b"].map(async (threadId) =>
      s.t.query(s.component.state.get, {
        scopeKey: await keyFor({ subject: "owner", threadId, runId: "run" }),
      }),
    ),
  );

  expect(rows.map((entry) => entry!.state)).toEqual(["deleted", "deleted"]);
  expect(fake.calls.delete).toBe(2);
});

it("forget clears a lost create so the scope can create again, but never a known sandbox", async () => {
  let lose = true;

  const fake = fakeSandboxProvider({
    create: async () => {
      if (lose) throw new Error("lost response");
    },
  });

  const s = setup("thread", {}, fake);
  const facts = { subject: "owner", threadId: "thread", runId: "run" };

  await expect(invoke(s.t, "prepare")).rejects.toThrow("lost response");
  await expect(invoke(s.t, "prepare")).rejects.toThrow("SANDBOX_UNKNOWN");
  expect(await invoke(s.t, "forget", facts)).toBe(true);
  expect(await row(s)).toBeNull();
  lose = false;
  await invoke(s.t, "prepare");
  expect(fake.calls.create).toBe(2);
  expect(await invoke(s.t, "forget", facts)).toBe(false);
  expect(await row(s)).toMatchObject({ sandboxId: "fake-sandbox-1", state: "ready" });
});

it("a poll action that dies right after its wake is retried by the lease backstop and notifies once", async () => {
  const fake = fakeSandboxProvider({
    background: () => [{ state: "done", exitCode: 0, logTail: "ok" }],
  });

  const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400 }, fake);

  const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  // The scheduled wake (a mutation) commits its claim and the backstop; the
  // action it schedules then dies before doing any work.
  state.crashPolls = 1;
  await advance(s.t, 100);
  expect(fake.calls.poll).toHaveLength(0);
  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({ state: "running" });
  await advance(s.t, LIMITS.actionBudgetMs + LIMITS.backgroundKillBudgetMs);
  await advance(s.t, LIMITS.backgroundLeaseMarginMs);
  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({ state: "done" });
  expect(await s.t.query(api.host.events, {})).toHaveLength(1);
  expect(fake.calls.background).toHaveLength(1);
});

it("a transient authorization failure at wake time is retried within the poll backoff, while only FORBIDDEN revokes", async () => {
  const fake = fakeSandboxProvider({
    background: () => [{ state: "done", exitCode: 0, logTail: "ok" }],
  });

  const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400 }, fake);

  const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  state.authorized = false;
  state.deniedWith = "HOST_POLICY_OUTAGE";
  await advance(s.t, 100);
  state.authorized = true;
  // Not revoked: still running, and woken again after the normal backoff
  // (2 * pollMinMs), not after the ~555 s lease of the failed claim.
  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({ state: "running" });
  await advance(s.t, 200);
  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({ state: "done" });
  expect(await s.t.query(api.host.events, {})).toHaveLength(1);
});

it.each(["plain", "convex-error"])(
  "a persistent %s non-FORBIDDEN authorization error ends the job unknown after the late-attempt limit without a kill",
  async (kind) => {
    const fake = fakeSandboxProvider({ background: () => [{ state: "running" }] });
    const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400, jobTimeoutMs: 1_000 }, fake);

    const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "x" })) as {
      jobId: string;
    };

    state.authorized = false;
    state.deniedWith = "HOST_POLICY_OUTAGE";
    state.deniedAsConvexError = kind === "convex-error";
    await advance(s.t, 1_000 + 2_000);

    expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({
      state: "unknown",
      code: "SANDBOX_JOB_DEADLINE",
    });

    expect(fake.calls.cancel).toHaveLength(0);
    expect(fake.calls.poll).toHaveLength(0);
  },
);

it.each([
  ["Error", false, "FORBIDDEN"],
  ["Error", false, "SANDBOX_FORBIDDEN"],
  ["ConvexError", true, "FORBIDDEN"],
])("revoked authority is recognized from a %s denial (%s %s)", async (_name, convex, message) => {
  const s = setup("thread", { pollMinMs: 10 });

  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };

  state.authorized = false;
  state.deniedWith = message;
  state.deniedAsConvexError = convex;
  await advance(s.t, 10);
  state.authorized = true;
  expect(await invoke(s.t, "job", { jobId: result.jobId })).toMatchObject({ state: "unknown" });
  expect(s.fake.calls.poll).toHaveLength(0);
  expect(await s.t.query(api.host.events, {})).toHaveLength(0);
});

it("one dead post-deadline attempt still gets the kill and the host notification", async () => {
  const fake = fakeSandboxProvider({ background: () => [{ state: "running" }] });
  const s = setup("thread", { pollMinMs: 100, pollMaxMs: 400, jobTimeoutMs: 1_000 }, fake);

  const { jobId } = (await invoke(s.t, "sandbox_run_background", { command: "forever" })) as {
    jobId: string;
  };

  // An early attempt dies; the first wake after the deadline is the first
  // late attempt and its action dies too (one dead post-deadline attempt).
  expect(await s.t.mutation(s.component.state.claimPoll, { jobId })).not.toBeNull();
  state.crashPolls = 1;
  const stages = LIMITS.backgroundKillBudgetMs + LIMITS.backgroundLeaseMarginMs;

  await advance(s.t, 1_000 + stages + 1);
  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({ state: "running" });
  // The next wake must still run the normal path, not end the job silently.
  await advance(s.t, stages + 1);

  expect(await s.t.query(s.component.state.getJob, { jobId })).toMatchObject({
    state: "unknown",
    code: "SANDBOX_JOB_DEADLINE",
  });

  const events = await s.t.query(api.host.events, {});

  expect(events).toHaveLength(1);
  expect(events[0].value).toMatchObject({ state: "unknown", code: "SANDBOX_JOB_DEADLINE" });
  expect(fake.calls.cancel).toHaveLength(1);
});

it("export of a TTL-deleted scope is not found and never revives or pays for a sandbox", async () => {
  const s = setup("thread", { ttl: 1 });

  await invoke(s.t, "sandbox_write_file", { path: "/f", content: "x" });
  await advance(s.t, LIMITS.actionBudgetMs + 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(await row(s)).toMatchObject({ state: "deleted" });
  await expect(invoke(s.t, "export", { path: "/f" })).rejects.toThrow("SANDBOX_NOT_FOUND");
  expect(s.fake.calls.create).toBe(1);
  expect(await row(s)).toMatchObject({ state: "deleted" });
});

it("exec leaves the provider time to kill the command inside the shared action budget", async () => {
  let shifted = false;

  const fake = fakeSandboxProvider({
    // The cold start eats all but 20.5 s of the 540 s action budget.
    beforeReady: async () => {
      if (shifted) return;

      shifted = true;
      vi.setSystemTime(Date.now() + LIMITS.actionBudgetMs - 20_500);
    },
  });

  const seen: number[] = [];
  const exec = fake.provider.exec;

  fake.provider.exec = (ctx, id, command, opts) => {
    seen.push(opts.timeoutS);

    return exec(ctx, id, command, opts);
  };

  const s = setup("thread", {}, fake);

  await invoke(s.t, "sandbox_exec", { command: "echo" });
  // 20.5 s remain; 5 are reserved for the kill, so the command gets at most 15.
  expect(seen).toEqual([15]);
});

it("exec reports timedOut from the provider, so a real exit 124 is not mistaken for a timeout", async () => {
  let timedOut = true;

  const fake = fakeSandboxProvider({
    exec: () => ({ exitCode: 124, stdout: "", stderr: "", timedOut }),
  });

  const s = setup("thread", {}, fake);

  expect(await invoke(s.t, "sandbox_exec", { command: "a" }, { key: "a" })).toMatchObject({
    exitCode: 124,
    timedOut: true,
  });

  timedOut = false;

  expect(await invoke(s.t, "sandbox_exec", { command: "b" }, { key: "b" })).toMatchObject({
    exitCode: 124,
    timedOut: false,
  });
});

it("an export racing a delete that lands just before its reservation is not found and revives nothing", async () => {
  const s = setup("thread", { ttl: 1 });

  await invoke(s.t, "sandbox_write_file", { path: "/f", content: "x" });
  await advance(s.t, LIMITS.actionBudgetMs + 1);

  // The row is live when export checks it; the delete completes inside the
  // host authorization that runs right before prepare's reserve.
  state.beforeUse = async (ctx) => {
    const key = await keyFor();

    const binding = await ctx.runMutation(s.component.state.claimDelete, {
      scopeKey: key,
      expiredOnly: false,
    });

    await ctx.runMutation(s.component.state.save, { scopeKey: key, ...binding!, state: "deleted" });
  };

  await expect(invoke(s.t, "export", { path: "/f" })).rejects.toThrow("SANDBOX_NOT_FOUND");
  expect(state.beforeUse).toBeUndefined();
  expect(s.fake.calls.create).toBe(1);
  expect(await row(s)).toMatchObject({ state: "deleted" });
});

it("use extends the idle deadline while an unused sandbox is deleted exactly on expiry", async () => {
  const ttl = 2 * LIMITS.actionBudgetMs;
  const s = setup("thread", { ttl });

  await invoke(s.t, "prepare");
  await invoke(s.t, "prepare", {}, { threadId: "idle" });
  const first = (await row(s))!;

  await vi.advanceTimersByTimeAsync(ttl / 2);
  await invoke(s.t, "prepare");
  const used = (await row(s))!;

  expect(used.idleExpiresAt).toBe(first.idleExpiresAt + ttl / 2);
  expect(used.cleanupAt).toBe(Math.max(used.idleExpiresAt, used.leaseUntil));

  await vi.advanceTimersByTimeAsync(first.idleExpiresAt - Date.now());
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(1);
  expect(await row(s)).toMatchObject({ state: "ready" });

  const idleKey = await keyFor({ subject: "owner", threadId: "idle", runId: "run" });

  expect(await s.t.query(s.component.state.get, { scopeKey: idleKey })).toMatchObject({
    state: "deleted",
  });

  await vi.advanceTimersByTimeAsync(used.idleExpiresAt - Date.now() - 1);
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(1);

  await advance(s.t, Math.max(0, used.idleExpiresAt - Date.now()));
  await invoke(s.t, "cleanup");
  await advance(s.t, 0);
  expect(s.fake.calls.delete).toBe(2);
  expect(await row(s)).toMatchObject({ state: "deleted" });
});
