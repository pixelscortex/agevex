import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { componentsGeneric, createFunctionHandle, makeFunctionReference } from "convex/server";
import { getFile } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
import type { AgentComponent } from "@convex-dev/agent";
import { defineSandbox, HARD_LIMITS, LIMITS } from "../../src/sandbox/index.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import type { SandboxFacts } from "../../src/sandbox/types.js";
import { setup, api, state } from "./setup.js";

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
async function advance(t: Setup["t"], ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
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
      providerJobId: "fake-job-1",
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
    createFunctionHandle(makeFunctionReference<"action">("host:poll")),
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

it("a polling exception settles unknown without retrying paid work", async () => {
  const s = setup("thread", { pollMinMs: 10 });
  s.fake.provider.poll = async () => {
    throw new Error("unavailable");
  };
  const result = (await invoke(s.t, "sandbox_run_background", { command: "work" })) as {
    jobId: string;
  };
  await advance(s.t, 10);
  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "unknown",
  });
  expect(s.fake.calls.background).toHaveLength(1);
});

it("job deadlines stop polling and report unknown for work that never completes", async () => {
  const s = setup(
    "thread",
    { pollMinMs: 10, pollMaxMs: 20, jobTimeoutMs: 30 },
    fakeSandboxProvider({ background: () => [{ state: "running" }] }),
  );
  const result = (await invoke(s.t, "sandbox_run_background", { command: "forever" })) as {
    jobId: string;
  };
  await advance(s.t, 10);
  await advance(s.t, 20);
  expect(await s.t.query(s.component.state.getJob, { jobId: result.jobId })).toMatchObject({
    state: "unknown",
  });
  const polls = s.fake.calls.poll.length;
  await advance(s.t, LIMITS.actionBudgetMs);
  expect(s.fake.calls.poll).toHaveLength(polls);
  expect(s.fake.calls.background).toHaveLength(1);
});

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
    providerJobId: "fake-job-1",
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
  await expect(invoke(s.t, "prepare")).rejects.toThrow("SANDBOX_DELETED");

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
  s.fake.jobs.set("fake-job-1", [{ state: "done", exitCode: 0 }]);
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
    createFunctionHandle(makeFunctionReference<"action">("host:poll")),
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
