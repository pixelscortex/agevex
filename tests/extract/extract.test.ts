// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, component, worker, storageMetadata } from "./setup.js";
import { LIMITS, directText, defineExtract, type ExtractFailure } from "../../src/extract/index.js";
import { agentComponent } from "./setup.js";
import { utf8 } from "../../src/extract/limits.js";

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
it("release wins over late completion and keeps paid usage without publishing output", async () => {
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
  await h.action((ctx) => h.extract.release(ctx, args));
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
it.each<ExtractFailure>([
  "UNSUPPORTED_TYPE",
  "UNREADABLE",
  "EMPTY",
  "INVALID_OUTPUT",
  "TOO_LARGE",
  "PROVIDER_UNAVAILABLE",
  "OBJECT_UNAVAILABLE",
  "CHECKSUM_FAILED",
])("returns sanitized %s failures with paid usage and no automatic retry", async (failure) => {
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
it("rechecks the exact attachment after paid work before publishing output", async () => {
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
  h.state.attachments.clear();
  release();
  await drain(h);
  // Direct component read is the host's test inspection, not a public bypass.
  const row = await h.t.query(component.artifacts.get, { artifactId: job.artifactId });
  expect(row).toMatchObject({ status: "unknown", usage: { credits: 1 } });
  expect(row?.payloadStorageId).toBeUndefined();
});
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
