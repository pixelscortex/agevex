// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, component, worker, storageMetadata } from "./setup.js";
import { LIMITS, directText, defineExtract, type ExtractFailure } from "../../src/extract/index.js";
import { agentComponent } from "./setup.js";
import { utf8 } from "../../src/extract/limits.js";
import { makeFunctionReference, type FunctionReference } from "convex/server";

const reference = (name: string) =>
  makeFunctionReference<"mutation", { artifactId: string }, null>(
    `host:${name}`,
  ) as unknown as FunctionReference<"mutation", "internal", { artifactId: string }, null>;
const callback = reference("onComplete");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const scope = { threadId: "owner" };
const drain = (h: ReturnType<typeof setup>) =>
  h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
async function run(h: ReturnType<typeof setup>, fileId: string) {
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await drain(h);
  return { ...scope, artifactId: job.artifactId };
}
it("reuses an extraction identity without paying twice, including concurrent admission", async () => {
  const h = setup();
  const fileId = await h.upload();
  const jobs = await Promise.all(
    Array.from({ length: LIMITS.backends }, () =>
      h.action((ctx) => h.extract.run(ctx, { ...scope, fileId })),
    ),
  );
  expect(jobs.filter((job) => job.action === "run")).toHaveLength(1);
  expect(new Set(jobs.map((job) => job.artifactId)).size).toBe(1);
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }))).toMatchObject({
    action: "reuse",
  });
  expect(await h.action((ctx) => h.extract.get(ctx, { ...scope, fileId }))).toMatchObject({
    status: "ready",
  });
  await drain(h);
  expect(h.state.calls).toBe(1);
});
it("keeps options hash in artifact identity", async () => {
  const h = setup();
  const fileId = await h.upload();
  const a = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId, optionsHash: "a".repeat(LIMITS.hashBytes) }),
  );
  const b = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId, optionsHash: "b".repeat(LIMITS.hashBytes) }),
  );
  expect(a.artifactId).not.toBe(b.artifactId);
  await drain(h);
  expect(h.state.calls).toBe(2);
});
it("purge wins over late completion and keeps paid usage without publishing output", async () => {
  const h = setup();
  const fileId = await h.upload();
  let release!: () => void;
  h.state.gate = new Promise((resolve) => {
    release = resolve;
  });
  h.state.result = { ok: true, doc: { kind: "image", text: "paid result" }, usage: { credits: 1 } };
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  for (let i = 0; i < LIMITS.backends && !h.state.calls; i++)
    await vi.advanceTimersByTimeAsync(100);
  expect(h.state.calls).toBe(1);
  const args = { ...scope, artifactId: job.artifactId };
  await h.action((ctx) => h.extract.purge(ctx, { fileId }));
  release();
  await drain(h);
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
    status: "released",
    usage: { credits: 1 },
  });
  await expect(h.action((ctx) => h.extract.readText(ctx, args))).rejects.toThrow(
    "EXTRACT_NOT_READY",
  );
  await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(h.state.events).toHaveLength(1);
});
it("marks a lost provider outcome unknown and never retries it after lease expiry", async () => {
  const h = setup();
  h.state.thrown = true;
  const fileId = await h.upload();
  const args = await run(h, fileId);
  const artifact = await h.action((ctx) => h.extract.get(ctx, args));
  expect(artifact).toMatchObject({ status: "unknown" });
  expect(JSON.stringify(artifact)).not.toContain("SECRET");
  await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await drain(h);
  expect(h.state.calls).toBe(1);
});
it.each<ExtractFailure>(["UNSUPPORTED_TYPE", "UNREADABLE", "EMPTY", "INVALID_OUTPUT", "TOO_LARGE"])(
  "returns sanitized final %s failures with paid usage and never reruns them",
  async (failure) => {
    const h = setup();
    h.state.result = { ok: false, failure, usage: { credits: 1 } };
    const fileId = await h.upload();
    const args = await run(h, fileId);
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
      status: "failed",
      failure: { code: failure },
      usage: { credits: 1 },
    });
    await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
    await drain(h);
    expect(h.state.calls).toBe(1);
    expect(h.state.events).toHaveLength(1);
  },
);
it.each<ExtractFailure>(["PROVIDER_UNAVAILABLE", "OBJECT_UNAVAILABLE", "CHECKSUM_FAILED"])(
  "admits a retryable %s failure again as the next attempt, bounded by LIMITS.maxAttempts",
  async (failure) => {
    const h = setup();
    h.state.result = { ok: false, failure, usage: { credits: 1 } };
    const fileId = await h.upload();
    const args = await run(h, fileId);
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
      status: "failed",
      attempt: 1,
      failure: { code: failure, retryable: true },
    });
    // Nothing reruns by itself: only an explicit admission starts the next attempt.
    await drain(h);
    expect(h.state.calls).toBe(1);
    for (let attempt = 2; attempt <= LIMITS.maxAttempts; attempt++) {
      const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
      expect(job.action).toBe("run");
      await drain(h);
      expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
        status: "failed",
        attempt,
      });
    }
    expect(h.state.calls).toBe(LIMITS.maxAttempts);
    // The last allowed attempt is final: it is reused, never run again.
    expect(await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }))).toMatchObject({
      action: "reuse",
    });
    await drain(h);
    expect(h.state.calls).toBe(LIMITS.maxAttempts);
    // Paid usage of every failed attempt accumulates on the row and in the hook.
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
      usage: { credits: LIMITS.maxAttempts },
    });
    expect(h.state.events).toHaveLength(LIMITS.maxAttempts);
  },
);
it("a queued job does not expire before it starts and is dispatched again only after its queue deadline", async () => {
  const h = setup();
  const fileId = await h.upload();
  const first = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  // The job waited in the queue longer than a running lease. It has done no
  // paid work, so starting it must still succeed (the lease starts at `start`).
  vi.setSystemTime(Date.now() + LIMITS.leaseMs + 1000);
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(
    await h.action((ctx) => h.extract.get(ctx, { ...scope, artifactId: first.artifactId })),
  ).toMatchObject({
    status: "ready",
  });
  // A never-started row past its queue deadline is dispatched again (new
  // claim); the stale dispatch cannot start, so the provider is paid once.
  const other = await h.upload("second file");
  const queued = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId: other, onComplete: callback }),
  );
  const stale = await h.t.query(component.artifacts.get, { artifactId: queued.artifactId });
  vi.setSystemTime(Date.now() + LIMITS.queueMs + 1000);
  const again = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId: other, onComplete: callback }),
  );
  expect(again).toEqual({ artifactId: queued.artifactId, action: "run", callback: "stored" });
  // The stale dispatch's start is fenced out: it cannot begin, so it cannot pay.
  expect(
    await h.t.mutation(component.artifacts.start, {
      artifactId: queued.artifactId,
      attempt: stale!.attempt,
      claim: stale!.claim,
    }),
  ).toBe(false);
  expect(await h.t.query(component.artifacts.get, { artifactId: queued.artifactId })).toMatchObject(
    { status: "pending" },
  );
  await drain(h);
  expect(h.state.calls).toBe(2);
  expect(
    await h.action((ctx) => h.extract.get(ctx, { ...scope, artifactId: queued.artifactId })),
  ).toMatchObject({
    status: "ready",
  });
  // Both dispatches registered a callback, but only the one owning the row's
  // claim reports: the stale dispatch finishing late must not fire a second one.
  expect(h.state.completions).toEqual(["ready"]);
});
it("a run caller superseded by a re-dispatch and a wait caller each get exactly one callback", async () => {
  const h = setup();
  const fileId = await h.upload();
  // Caller A starts the job with a callback, then the queue deadline passes.
  const a = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId, onComplete: callback }));
  expect(a).toMatchObject({ action: "run", callback: "stored" });
  vi.setSystemTime(Date.now() + LIMITS.queueMs + 1000);
  // Caller B (no callback) re-admits the stale queued job: a new dispatch now
  // owns the row. A's callback must survive the supersession.
  const b = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  expect(b).toEqual({ artifactId: a.artifactId, action: "run" });
  // Caller W waits on the live dispatch and registers its own callback.
  const w = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId, onComplete: reference("onCompleteWaiter") }),
  );
  expect(w).toMatchObject({ action: "wait", callback: "stored" });
  // The same caller repeating itself does not take a second slot or fire twice.
  expect(
    await h.action((ctx) =>
      h.extract.run(ctx, { ...scope, fileId, onComplete: reference("onCompleteWaiter") }),
    ),
  ).toMatchObject({ action: "wait", callback: "stored" });
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect([...h.state.completions].sort()).toEqual(["ready", "waiter:ready"]);
  // A terminal artifact fires nothing more; reuse stores no callback.
  expect(
    await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId, onComplete: callback })),
  ).toEqual({ artifactId: a.artifactId, action: "reuse" });
  await drain(h);
  expect([...h.state.completions].sort()).toEqual(["ready", "waiter:ready"]);
});
it("a failing callback does not cancel the other callers' callbacks or the row's final state", async () => {
  const h = setup();
  const fileId = await h.upload();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const first = await h.action((ctx) =>
      h.extract.run(ctx, { ...scope, fileId, onComplete: reference("onCompleteFails") }),
    );
    await h.action((ctx) =>
      h.extract.run(ctx, { ...scope, fileId, onComplete: reference("onCompleteWaiter") }),
    );
    await drain(h);
    // The second callback still fired exactly once, and the row and its list are final.
    expect(h.state.completions).toEqual(["waiter:ready"]);
    const row = await h.t.query(component.artifacts.get, { artifactId: first.artifactId });
    expect(row).toMatchObject({ status: "ready" });
    expect(row?.callbacks).toBeUndefined();
    // Only a count is logged.
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("1 of 2 completion callbacks"));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("HOST_CALLBACK_FAILED");
  } finally {
    errors.mockRestore();
  }
});
it("a caller admitted after an owner that ended without starting re-dispatches instead of waiting forever", async () => {
  const h = setup();
  const fileId = await h.upload();
  h.state.brokenWorker = true;
  const owner = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await drain(h);
  // The workflow ended without `start`: the row is still queued, its deadline over.
  expect(h.state.calls).toBe(0);
  expect(await h.t.query(component.artifacts.get, { artifactId: owner.artifactId })).toMatchObject({
    status: "pending",
  });
  h.state.brokenWorker = false;
  const later = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId, onComplete: callback }),
  );
  expect(later).toMatchObject({ artifactId: owner.artifactId, action: "run", callback: "stored" });
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(h.state.completions).toEqual(["ready"]);
});
it("a fifth distinct callback is dropped and the admission says so", async () => {
  const h = setup();
  const fileId = await h.upload();
  const outcomes: (string | undefined)[] = [];
  for (let n = 0; n <= LIMITS.callbacksPerArtifact; n++) {
    const job = await h.action((ctx) =>
      h.extract.run(ctx, { ...scope, fileId, onComplete: reference(`caller${n}`) }),
    );
    outcomes.push((job as { callback?: string }).callback);
  }
  expect(outcomes).toEqual([...Array(LIMITS.callbacksPerArtifact).fill("stored"), "dropped"]);
  // A handle over the byte bound is refused outright.
  await expect(
    h.action((ctx) =>
      h.extract.run(ctx, {
        ...scope,
        fileId,
        onComplete: reference("c".repeat(LIMITS.callbackBytes)),
      }),
    ),
  ).rejects.toThrow("INVALID_EXTRACT_ARGUMENT");
});
it("a host refusal in the worker is a retryable failure, never an unknown outcome", async () => {
  const h = setup();
  const fileId = await h.upload();
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  // The file is detached after admission and before the worker authorizes.
  h.state.attachments.clear();
  await drain(h);
  expect(h.state.calls).toBe(0);
  const row = await h.t.query(component.artifacts.get, { artifactId: job.artifactId });
  expect(row).toMatchObject({ status: "failed", failure: "OBJECT_UNAVAILABLE" });
  // Reattached, an explicit admission runs it as attempt 2.
  h.state.attachments.set(fileId, "owner");
  expect(await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }))).toMatchObject({
    action: "run",
  });
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(
    await h.action((ctx) => h.extract.get(ctx, { ...scope, artifactId: job.artifactId })),
  ).toMatchObject({
    status: "ready",
    attempt: 2,
  });
});
it("hashes stored files in streamed chunks rather than one whole-file digest", async () => {
  const h = setup();
  const content = "streamed checksum ".repeat(1000);
  const fileId = await h.upload(content);
  const digest = vi.spyOn(crypto.subtle, "digest");
  const args = await run(h, fileId);
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({ status: "ready" });
  // Small option objects (and the test harness's own blob store) still use the
  // one-shot digest; the stored file's bytes must never be handed to it, which
  // would cost another full-size copy next to the Blob.
  const sizes = digest.mock.calls.map(([, data]) => (data as ArrayBufferView).byteLength);
  expect(sizes).not.toContain(content.length);
  digest.mockRestore();
});
it("files above the default ceiling need the Node worker and larger payloads read through the Node reader", async () => {
  const size = LIMITS.maxBytes.document + 1;
  const without = setup();
  const big = await without.upload("x".repeat(size), "application/pdf");
  const refused = await run(without, big);
  expect(await without.action((ctx) => without.extract.get(ctx, refused))).toMatchObject({
    status: "failed",
    failure: { code: "TOO_LARGE" },
  });
  expect(without.state.calls).toBe(0);
  // Raising limits past the default maxima is only allowed with the Node actions.
  expect(() => setup({ limits: { maxBytes: { document: size } } })).toThrow(
    "INVALID_EXTRACT_ARGUMENT",
  );
  const h = setup({ node: true, limits: { maxBytes: { document: size } } });
  const fileId = await h.upload("x".repeat(size), "application/pdf");
  h.state.result = {
    ok: true,
    doc: { kind: "document", text: "y".repeat(LIMITS.payloadBytes + 1) },
  };
  const args = await run(h, fileId);
  expect(h.state.calls).toBe(1);
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({ status: "ready" });
  // The payload exceeds the default runtime's read ceiling: the default API
  // delegates to the Node reader, which returns the same bounded window.
  const window = await h.action((ctx) => h.extract.readText(ctx, { ...args, maxBytes: 5 }));
  expect(window).toEqual({ text: "yyyyy", cursor: 5, done: false });
}, 60_000);
it("fromUrl maps a malformed URL to INVALID_EXTRACT_ARGUMENT", async () => {
  const h = setup();
  for (const url of ["not a url", "http://", "https://[::1"])
    await expect(h.action((ctx) => h.extract.fromUrl(ctx, { ...scope, url }))).rejects.toThrow(
      "INVALID_EXTRACT_ARGUMENT",
    );
});
it("stores maximum-size payload JSON outside a small artifact row under transaction limits", async () => {
  const h = setup();
  const overhead = utf8(JSON.stringify({ kind: "text", text: "" })).length;
  const text = "x".repeat(LIMITS.payloadBytes - overhead);
  h.state.result = { ok: true, doc: { kind: "text", text } };
  const args = await run(h, await h.upload());
  const row = await h.t.query(component.artifacts.get, { artifactId: args.artifactId });
  expect(row?.status).toBe("ready");
  expect(utf8(JSON.stringify(row)).length).toBeLessThan(LIMITS.optionsBytes);
  const size = await h.t.run(
    async (ctx) => (await ctx.storage.get(row!.payloadStorageId as never))?.size,
  );
  expect(size).toBe(LIMITS.payloadBytes);
  const window = await h.action((ctx) =>
    h.extract.readText(ctx, { ...args, maxBytes: LIMITS.readBytes }),
  );
  expect(utf8(window.text).length).toBe(LIMITS.readBytes);
  expect(window.done).toBe(false);
});
it("bounds UTF-8 text windows by bytes and resumes without splitting characters", async () => {
  const h = setup();
  const text = "A😀é界Z";
  const args = await run(h, await h.upload(text));
  let cursor: number | null = 0;
  let result = "";
  do {
    const window = await h.action((ctx) =>
      h.extract.readText(ctx, { ...args, cursor: cursor!, maxBytes: 4 }),
    );
    expect(utf8(window.text).length).toBeLessThanOrEqual(4);
    result += window.text;
    cursor = window.cursor;
  } while (cursor !== null);
  expect(result).toBe(text);
  await expect(h.action((ctx) => h.extract.readText(ctx, { ...args, cursor: 2 }))).rejects.toThrow(
    "INVALID_EXTRACT_CURSOR",
  );
  for (const maxBytes of [NaN, Infinity, -1, 0, 1.5, LIMITS.readBytes + 1])
    await expect(h.action((ctx) => h.extract.readText(ctx, { ...args, maxBytes }))).rejects.toThrow(
      "INVALID_EXTRACT_ARGUMENT",
    );
});
it("bounds page windows by both count and bytes and resumes a huge page", async () => {
  const h = setup();
  h.state.result = {
    ok: true,
    doc: {
      kind: "document",
      text: "body",
      pages: Array.from({ length: LIMITS.totalPages }, (_, index) => ({
        number: index + 1,
        text: index === 0 ? "x".repeat(LIMITS.readBytes + 1) : "page",
      })),
    },
  };
  const args = await run(h, await h.upload());
  const first = await h.action((ctx) =>
    h.extract.readPages(ctx, { ...args, from: 1, count: LIMITS.pages }),
  );
  expect(first.pages).toHaveLength(1);
  expect(utf8(first.pages[0].text).length).toBe(LIMITS.readBytes);
  expect(first.next).toEqual({ from: 1, cursor: LIMITS.readBytes });
  const next = await h.action((ctx) =>
    h.extract.readPages(ctx, { ...args, ...first.next!, count: LIMITS.pages }),
  );
  expect(next.pages).toHaveLength(LIMITS.pages);
  expect(next.pages[0].text).toBe("x");
  for (const count of [NaN, Infinity, -1, 0, 1.5, LIMITS.pages + 1])
    await expect(h.action((ctx) => h.extract.readPages(ctx, { ...args, count }))).rejects.toThrow(
      "INVALID_EXTRACT_ARGUMENT",
    );
});
it("read_file returns bounded text and references and checks the owning attachment", async () => {
  const h = setup();
  const fileId = await h.upload("x".repeat(LIMITS.toolBytes + 1));
  await run(h, fileId);
  const result = await h.action(async (ctx) => {
    const tools = h.extract.tools({ ctx, ...scope });
    return tools.read_file.execute!({ fileId }, { toolCallId: "read", messages: [] } as never);
  });
  expect(result).toMatchObject({ text: "x".repeat(LIMITS.toolBytes), references: [{ fileId }] });
  const tail = await h.action(async (ctx) =>
    h.extract.tools({ ctx, ...scope }).read_file.execute!({ fileId, cursor: LIMITS.toolBytes }, {
      toolCallId: "next",
      messages: [],
    } as never),
  );
  expect(tail).toMatchObject({ text: "x", done: true, next: null });
  await expect(
    h.action(async (ctx) =>
      h.extract.tools({ ctx, threadId: "intruder" }).read_file.execute!({ fileId }, {
        toolCallId: "read",
        messages: [],
      } as never),
    ),
  ).rejects.toThrow("FORBIDDEN");
  h.state.attachments.clear();
  await expect(h.action((ctx) => h.extract.get(ctx, { fileId, ...scope }))).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("keeps RAG opt-in and refuses index and search when unconfigured", async () => {
  const h = setup();
  const args = await run(h, await h.upload());
  await expect(
    h.action((ctx) => h.extract.index(ctx, { ...args, namespace: "owner", key: "file" })),
  ).rejects.toThrow("EXTRACT_RAG_DISABLED");
  await expect(
    h.action((ctx) => h.extract.search(ctx, { ...scope, namespace: "owner", query: "hello" })),
  ).rejects.toThrow("EXTRACT_RAG_DISABLED");
  expect(await h.action(async (ctx) => "search_files" in h.extract.tools({ ctx, ...scope }))).toBe(
    false,
  );
});
it("directText decodes local text and rejects unreadable or empty bytes without network", async () => {
  const h = setup({ backends: [directText()] });
  const args = await run(h, await h.upload("local text"));
  expect(await h.action((ctx) => h.extract.readText(ctx, args))).toMatchObject({
    text: "local text",
    done: true,
  });
  const empty = await run(h, await h.upload(" "));
  expect(await h.action((ctx) => h.extract.get(ctx, empty))).toMatchObject({
    failure: { code: "EMPTY" },
  });
});
it("rejects oversized registration limits and duplicate backend ids", () => {
  for (const payloadBytes of [Infinity, NaN, -1, 0, 1.5, LIMITS.payloadBytes + 1])
    expect(() =>
      defineExtract(component, {
        agent: agentComponent,
        worker,
        storageMetadata,
        backends: [directText()],
        authorize: async () => {},
        limits: { payloadBytes },
      }),
    ).toThrow("INVALID_EXTRACT_ARGUMENT");
  expect(() =>
    defineExtract(component, {
      agent: agentComponent,
      worker,
      storageMetadata,
      backends: [directText(), directText()],
      authorize: async () => {},
    }),
  ).toThrow("DUPLICATE_EXTRACT_BACKEND");
});
it("rejects oversized payloads without persisting provider fields and retains paid usage", async () => {
  const h = setup({ limits: { payloadBytes: LIMITS.summaryBytes } });
  h.state.result = {
    ok: true,
    doc: { kind: "text", text: "x".repeat(LIMITS.summaryBytes) },
    usage: { credits: 1 },
  };
  const args = await run(h, await h.upload());
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
    status: "failed",
    failure: { code: "TOO_LARGE" },
    usage: { credits: 1 },
  });
  expect(h.state.events).toHaveLength(1);
});
it("does not invoke a provider when native file bytes exceed the registered admission ceiling", async () => {
  const h = setup({ limits: { maxBytes: { text: LIMITS.summaryBytes } } });
  const args = await run(h, await h.upload("x".repeat(LIMITS.summaryBytes + 1)));
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
    failure: { code: "TOO_LARGE" },
  });
  expect(h.state.calls).toBe(0);
});
it.each([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "text/xml",
  "text/javascript",
  "text/x-custom",
  "application/json",
  "application/xml",
  "application/csv",
  "application/javascript",
])("enforces the configured text ceiling for accepted %s files", async (mimeType) => {
  const h = setup({
    backends: [directText()],
    limits: { maxBytes: { text: LIMITS.summaryBytes } },
  });
  const admitted = await run(h, await h.upload("x".repeat(LIMITS.summaryBytes), mimeType));
  expect(await h.action((ctx) => h.extract.get(ctx, admitted))).toMatchObject({ status: "ready" });
  const oversized = await run(h, await h.upload("x".repeat(LIMITS.summaryBytes + 1), mimeType));
  expect(await h.action((ctx) => h.extract.get(ctx, oversized))).toMatchObject({
    status: "failed",
    failure: { code: "TOO_LARGE" },
  });
});
it("a duplicate worker dispatch cannot repeat a paid extraction", async () => {
  const h = setup();
  const fileId = await h.upload();
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  const row = await h.t.query(component.artifacts.get, { artifactId: job.artifactId });
  await Promise.all(
    Array.from({ length: LIMITS.backends }, () =>
      h.t.action(worker, {
        ...scope,
        artifactId: job.artifactId,
        attempt: row!.attempt,
        claim: row!.claim,
      }),
    ),
  );
  await drain(h);
  expect(h.state.calls).toBe(1);
});
it("changing a backend version creates a new artifact identity", async () => {
  let calls = 0;
  const backend = {
    id: "versioned",
    version: "1",
    accepts: () => true,
    run: async () => {
      calls++;
      return { ok: true as const, doc: { kind: "text" as const, text: "result" } };
    },
  };
  const h = setup({ backends: [backend] });
  const fileId = await h.upload();
  const a = await run(h, fileId);
  backend.version = "2";
  const b = await run(h, fileId);
  expect(a.artifactId).not.toBe(b.artifactId);
  expect(calls).toBe(2);
});
it("lease expiry fences a late paid completion and preserves its usage without retry", async () => {
  const h = setup();
  const fileId = await h.upload();
  let release!: () => void;
  h.state.gate = new Promise((resolve) => {
    release = resolve;
  });
  h.state.result = { ok: true, doc: { kind: "text", text: "late text" }, usage: { credits: 1 } };
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  for (let i = 0; i < LIMITS.backends && !h.state.calls; i++)
    await vi.advanceTimersByTimeAsync(100);
  expect(h.state.calls).toBe(1);
  await h.action(async () => {
    await vi.advanceTimersByTimeAsync(LIMITS.leaseMs);
    return null;
  });
  const args = { ...scope, artifactId: job.artifactId };
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({ status: "unknown" });
  release();
  await drain(h);
  expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
    status: "unknown",
    usage: { credits: 1 },
  });
  await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await drain(h);
  expect(h.state.calls).toBe(1);
});
it("publishes a paid result when the file is detached mid-run and a later attach reuses it without paying again", async () => {
  const h = setup();
  const fileId = await h.upload();
  let release!: () => void;
  h.state.gate = new Promise((resolve) => {
    release = resolve;
  });
  h.state.result = { ok: true, doc: { kind: "text", text: "private" }, usage: { credits: 1 } };
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  for (let i = 0; i < LIMITS.backends && !h.state.calls; i++)
    await vi.advanceTimersByTimeAsync(100);
  expect(h.state.calls).toBe(1);
  // The message is deleted while the provider call is in flight.
  h.state.attachments.clear();
  // Release inside an open action context: convex-test only accepts the
  // worker's blob write while some action transaction is active.
  await h.action(async () => {
    release();
    await vi.advanceTimersByTimeAsync(1000);
    return null;
  });
  await drain(h);
  // The paid result was published, not discarded...
  const args = { ...scope, artifactId: job.artifactId };
  expect(await h.t.query(component.artifacts.get, { artifactId: job.artifactId })).toMatchObject({
    status: "ready",
    usage: { credits: 1 },
  });
  // ...yet leaks nothing: every read re-authorizes against the current attachment.
  await expect(h.action((ctx) => h.extract.readText(ctx, args))).rejects.toThrow("FORBIDDEN");
  // A later attach reuses it: no second provider call.
  h.state.attachments.set(fileId, "owner");
  expect(await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }))).toMatchObject({
    action: "reuse",
  });
  await drain(h);
  expect(h.state.calls).toBe(1);
  expect(h.state.events).toHaveLength(1);
  expect((await h.action((ctx) => h.extract.readText(ctx, args))).text).toBe("private");
});
it("a mostly-control-character text with one wide character is rejected before JSON.stringify allocates", async () => {
  const h = setup({ backends: [directText()] });
  // 4 MiB of U+0001 plus one euro sign: every U+0001 escapes to six characters
  // and the euro makes the whole serialization a two-byte string (48 MiB).
  const text = "\u0001".repeat(LIMITS.maxBytes.text - 3) + "\u20ac";
  const fileId = await h.upload(text);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const args = await run(h, fileId);
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
      status: "failed",
      failure: { code: "TOO_LARGE" },
    });
    const serializedDocs = stringify.mock.calls.filter(
      ([value]) =>
        typeof (value as { text?: unknown })?.text === "string" &&
        (value as { text: string }).text.length > 1_000_000,
    );
    expect(serializedDocs).toHaveLength(0);
  } finally {
    stringify.mockRestore();
  }
}, 30_000);
it("a control-character text near the limit is TOO_LARGE before any oversized Blob is built", async () => {
  const h = setup({ backends: [directText()] });
  // Each U+0001 serializes to the six characters \u0001: a text within the 4 MiB
  // input ceiling becomes a 24 MiB JSON string, far over the 6 MiB payload ceiling.
  const fileId = await h.upload("\u0001".repeat(LIMITS.maxBytes.text));
  const RealBlob = Blob;
  const stringParts: number[] = [];
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        for (const part of parts ?? []) if (typeof part === "string") stringParts.push(part.length);
      }
    },
  );
  try {
    const args = await run(h, fileId);
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({
      status: "failed",
      failure: { code: "TOO_LARGE" },
    });
  } finally {
    vi.unstubAllGlobals();
  }
  // The serialized string is rejected by length; it is never copied into a Blob.
  expect(Math.max(0, ...stringParts)).toBeLessThanOrEqual(LIMITS.payloadBytes);
}, 30_000);
it.each([
  ["application/pdf", LIMITS.maxBytes.document],
  ["image/png", LIMITS.maxBytes.image],
  ["text/plain", LIMITS.maxBytes.text],
] as const)(
  "admits %s at its hard byte maximum with bounded transaction reads",
  async (mimeType, maxBytes) => {
    const h = setup({
      backends: [
        {
          id: "maximum",
          version: "1",
          accepts: () => true,
          run: async ({ bytes }) => {
            const blob = await bytes();
            expect(blob.size).toBe(maxBytes);
            return { ok: true, doc: { kind: "text", text: "bounded output" } };
          },
        },
      ],
    });
    const fileId = await h.uploadBlob(new Blob([new Uint8Array(maxBytes)], { type: mimeType }));
    const args = await run(h, fileId);
    expect(await h.action((ctx) => h.extract.get(ctx, args))).toMatchObject({ status: "ready" });
  },
);
it("runs the completion callback after durable extraction without repeating it on reuse", async () => {
  const { makeFunctionReference } = await import("convex/server");
  const callback = makeFunctionReference<"mutation", { artifactId: string }, null>(
    "host:onComplete",
  ) as unknown as import("convex/server").FunctionReference<
    "mutation",
    "internal",
    { artifactId: string },
    null
  >;
  const h = setup();
  const fileId = await h.upload();
  await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId, onComplete: callback }));
  await drain(h);
  expect(h.state.completions).toEqual(["ready"]);
  await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId, onComplete: callback }));
  await drain(h);
  expect(h.state.completions).toEqual(["ready"]);
});
it("completion callbacks observe saved results even when the host usage hook fails", async () => {
  const { makeFunctionReference } = await import("convex/server");
  const callback = makeFunctionReference<"mutation", { artifactId: string }, null>(
    "host:onComplete",
  ) as unknown as import("convex/server").FunctionReference<
    "mutation",
    "internal",
    { artifactId: string },
    null
  >;
  const h = setup();
  h.state.usageFails = true;
  h.state.result = { ok: true, doc: { kind: "text", text: "paid text" }, usage: { credits: 1 } };
  const fileId = await h.upload();
  const job = await h.action((ctx) =>
    h.extract.run(ctx, { ...scope, fileId, onComplete: callback }),
  );
  await drain(h);
  expect(h.state.completions).toEqual(["ready"]);
  expect(h.state.calls).toBe(1);
  expect(
    await h.action((ctx) => h.extract.get(ctx, { ...scope, artifactId: job.artifactId })),
  ).toMatchObject({ status: "ready", usage: { credits: 1 } });
});
