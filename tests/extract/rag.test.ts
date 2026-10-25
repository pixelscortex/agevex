// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { MockEmbeddingModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { componentsGeneric, createFunctionHandle } from "convex/server";
import { LIMITS, type ExtractOptions } from "../../src/extract/index.js";
import { setup, component } from "./setup.js";
const ragComponent = componentsGeneric().rag as unknown as NonNullable<
  ExtractOptions["rag"]
>["component"];
const scope = { threadId: "owner", namespace: "owner" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function registerRag(h: ReturnType<typeof setup>) {
  // The package's source-only /test export has a non-type import incompatible
  // with verbatimModuleSyntax. Load its runtime harness dynamically so its own
  // source is not mistaken for this project's typechecked implementation.
  const testEntry = "@convex-dev/rag/test";
  const { default: rag } = await import(/* @vite-ignore */ testEntry);
  rag.register(h.t);
}
it("indexes and searches through native RAG with maximum chunk, vector, and search bounds", async () => {
  const embedding = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: LIMITS.ragBatch,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => Array.from({ length: LIMITS.embeddingDimension }, () => 1)),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });
  const h = setup({
    rag: {
      component: componentsGeneric().rag as unknown as NonNullable<
        ExtractOptions["rag"]
      >["component"],
      embedding,
      embeddingDimension: LIMITS.embeddingDimension,
    },
  });
  await registerRag(h);
  const fileId = await h.upload("x".repeat(LIMITS.indexBytes));
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const indexed = await h.action((ctx) =>
    h.extract.index(ctx, { ...scope, artifactId: job.artifactId, key: "large-file" }),
  );
  expect(indexed.status).toBe("ready");
  const result = await h.action((ctx) =>
    h.extract.search(ctx, { ...scope, query: "x", limit: LIMITS.searchResults }),
  );
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.text.length).toBeLessThanOrEqual(LIMITS.toolBytes);
  expect(result.references).toContainEqual({ fileId, artifactId: job.artifactId });
  await h.action((ctx) => h.extract.release(ctx, { ...scope, artifactId: job.artifactId }));
  const released = await h.action((ctx) => h.extract.search(ctx, { ...scope, query: "x" }));
  expect(released).toMatchObject({ text: "", references: [] });
});
it("never retries a failed paid embedding request inside RAG", async () => {
  const embedding = new MockEmbeddingModelV4({
    doEmbed: async () => {
      throw new APICallError({
        message: "SECRET_PROVIDER_BODY",
        url: "https://fake.invalid",
        requestBodyValues: {},
        isRetryable: true,
      });
    },
  });
  const h = setup({
    rag: {
      component: componentsGeneric().rag as unknown as NonNullable<
        ExtractOptions["rag"]
      >["component"],
      embedding,
      embeddingDimension: LIMITS.embeddingDimensions[0],
    },
  });
  await registerRag(h);
  await expect(
    h.action((ctx) => h.extract.search(ctx, { ...scope, query: "hello" })),
  ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  expect(embedding.doEmbedCalls).toHaveLength(1);
});
it("repeated failed and concurrent indexing keeps one pending entry then succeeds under transaction limits", async () => {
  let fail = true;
  let gate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const embedding = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: LIMITS.ragBatch,
    doEmbed: async ({ values }) => {
      entered?.();
      await gate;
      // Fail after one full batch has been committed: cleanup must remove
      // native content/chunks/vectors as well as the pending entry itself.
      if (fail && values.length < LIMITS.ragBatch) throw new Error("SECRET_PROVIDER_BODY");
      return {
        embeddings: values.map(() => Array.from({ length: LIMITS.embeddingDimension }, () => 1)),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  });
  const h = setup({
    rag: { component: ragComponent, embedding, embeddingDimension: LIMITS.embeddingDimension },
  });
  await registerRag(h);
  const fileId = await h.upload("x".repeat(LIMITS.indexBytes));
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const args = { ...scope, artifactId: job.artifactId, key: "retry-file" };
  const pending = () =>
    h.t.query(ragComponent.entries.list, {
      status: "pending",
      paginationOpts: { cursor: null, numItems: 2 },
    });
  let previousId: string | undefined;
  for (let attempt = 0; attempt < LIMITS.backends; attempt++) {
    await expect(h.action((ctx) => h.extract.index(ctx, args))).rejects.toThrow(
      "PROVIDER_UNAVAILABLE",
    );
    const entries = await pending();
    expect(entries.page).toHaveLength(1);
    expect(entries.isDone).toBe(true);
    const entryId = entries.page[0]!.entryId;
    if (previousId) {
      expect(await h.t.query(ragComponent.entries.get, { entryId: previousId })).toBeNull();
      expect(
        (
          await h.t.query(ragComponent.chunks.list, {
            entryId: previousId,
            order: "asc",
            paginationOpts: { cursor: null, numItems: 1 },
          })
        ).page,
      ).toHaveLength(0);
    }
    previousId = entryId;
  }
  expect(await h.t.query(component.artifacts.get, { artifactId: job.artifactId })).toMatchObject({
    indexEntryId: previousId,
    indexStatus: "failed",
  });
  fail = false;
  let release!: () => void;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const indexing = h.action((ctx) => h.extract.index(ctx, args));
  await started;
  const inFlight = await pending();
  expect(inFlight.page).toHaveLength(1);
  expect(await h.t.query(component.artifacts.get, { artifactId: job.artifactId })).toMatchObject({
    indexEntryId: inFlight.page[0]!.entryId,
    indexStatus: "running",
  });
  const callsBefore = embedding.doEmbedCalls.length;
  const concurrent = await Promise.all(
    Array.from({ length: LIMITS.backends }, () => h.action((ctx) => h.extract.index(ctx, args))),
  );
  expect(concurrent.every((result) => result.status === "pending")).toBe(true);
  expect(embedding.doEmbedCalls).toHaveLength(callsBefore);
  expect((await pending()).page).toHaveLength(1);
  release();
  const ready = await indexing;
  expect(ready.status).toBe("ready");
  expect((await pending()).page).toHaveLength(0);
  expect(await h.t.query(component.artifacts.get, { artifactId: job.artifactId })).toMatchObject({
    indexEntryId: ready.entryId,
    indexStatus: "ready",
  });
  const callsAfter = embedding.doEmbedCalls.length;
  expect(await h.action((ctx) => h.extract.index(ctx, args))).toMatchObject({
    entryId: ready.entryId,
    status: "ready",
  });
  expect(embedding.doEmbedCalls).toHaveLength(callsAfter);
  expect(
    (await h.action((ctx) => h.extract.search(ctx, { ...scope, query: "x" }))).references,
  ).toContainEqual({ fileId, artifactId: job.artifactId });
}, 30_000);
it.each(["release", "ownership"] as const)(
  "%s fences indexing before a late embedding can publish",
  async (change) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const embedding = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => {
        entered();
        await gate;
        return {
          embeddings: values.map(() =>
            Array.from({ length: LIMITS.embeddingDimensions[0] }, () => 1),
          ),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    });
    const h = setup({
      rag: {
        component: ragComponent,
        embedding,
        embeddingDimension: LIMITS.embeddingDimensions[0],
      },
    });
    await registerRag(h);
    const fileId = await h.upload();
    const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
    await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
    const args = { ...scope, artifactId: job.artifactId, key: "fenced-file" };
    const indexing = h.action((ctx) => h.extract.index(ctx, args));
    await started;
    if (change === "release") await h.action((ctx) => h.extract.release(ctx, args));
    else h.state.attachments.delete(fileId);
    release();
    await expect(indexing).rejects.toThrow(
      change === "release" ? "EXTRACT_INDEX_FENCED" : "FORBIDDEN",
    );
    const row = await h.t.query(component.artifacts.get, { artifactId: job.artifactId });
    expect(row?.indexStatus).toBe("failed");
    expect(
      (await h.t.query(ragComponent.entries.get, { entryId: row!.indexEntryId! }))?.status,
    ).toBe("pending");
    expect(embedding.doEmbedCalls).toHaveLength(1);
  },
);

async function recoveryHarness(indexLeaseMs: number = LIMITS.indexLeaseMs) {
  let pause = false;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const embedding = new MockEmbeddingModelV4({
    doEmbed: async ({ values }) => {
      if (pause) {
        pause = false;
        entered();
        await gate;
      }
      return {
        embeddings: values.map(() =>
          Array.from({ length: LIMITS.embeddingDimensions[0] }, () => 1),
        ),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  });
  const h = setup({
    limits: { indexLeaseMs },
    rag: { component: ragComponent, embedding, embeddingDimension: LIMITS.embeddingDimensions[0] },
  });
  await registerRag(h);
  const fileId = await h.upload();
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const args = { ...scope, artifactId: job.artifactId, key: "recover-file" };
  const get = () => h.t.query(component.artifacts.get, { artifactId: job.artifactId });
  const index = (key = args.key, namespace = args.namespace) =>
    h.action((ctx) => h.extract.index(ctx, { ...args, key, namespace }));
  const expire = async () => {
    await vi.advanceTimersByTimeAsync(indexLeaseMs);
    await h.t.finishInProgressScheduledFunctions();
  };
  const expectOnlyEntry = async (entryId: string) => {
    for (const status of ["pending", "ready"] as const) {
      const entries = await h.t.query(ragComponent.entries.list, {
        status,
        paginationOpts: { cursor: null, numItems: 2 },
      });
      expect(entries.page.map((entry) => entry.entryId)).toEqual(
        status === "ready" ? [entryId] : [],
      );
      expect(entries.isDone).toBe(true);
    }
  };
  return {
    ...h,
    embedding,
    args,
    get,
    index,
    expire,
    expectOnlyEntry,
    pause: () => {
      pause = true;
    },
    started,
    release,
  };
}
it("recovers a crash during cleaning after lease expiry and cleans the exact recorded entry", async () => {
  const h = await recoveryHarness();
  const original = await h.index();
  // Simulate process death immediately after durable admission: no catch runs.
  await h.t.mutation(component.indexing.admit, {
    artifactId: h.args.artifactId,
    namespace: "abandoned",
    key: "abandoned",
  });
  const calls = h.embedding.doEmbedCalls.length;
  expect(await h.index("different", "different")).toMatchObject({ status: "pending" });
  await h.expire();
  expect(await h.get()).toMatchObject({ indexStatus: "unknown", indexEntryId: original.entryId });
  expect(h.embedding.doEmbedCalls).toHaveLength(calls);
  const recovered = await h.index("different", "different");
  expect(recovered.status).toBe("ready");
  expect(await h.t.query(ragComponent.entries.get, { entryId: original.entryId! })).toBeNull();
  await h.expectOnlyEntry(recovered.entryId!);
});
it("recovers a crash during embedding after lease expiry with one replacement entry", async () => {
  const h = await recoveryHarness();
  h.pause();
  const abandoned = h.index();
  await h.started;
  const dead = await h.get();
  expect(dead?.indexStatus).toBe("running");
  await h.expire();
  expect(await h.get()).toMatchObject({ indexStatus: "unknown", indexEntryId: dead!.indexEntryId });
  const recovered = await h.index("different", "different");
  expect(recovered.status).toBe("ready");
  expect(await h.t.query(ragComponent.entries.get, { entryId: dead!.indexEntryId! })).toBeNull();
  h.release();
  await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  await h.expectOnlyEntry(recovered.entryId!);
});
it("rejects stale chunk writes and promotion after explicit recovery claims an expired attempt", async () => {
  const h = await recoveryHarness();
  h.pause();
  const abandoned = h.index();
  await h.started;
  const dead = await h.get();
  // Advance the clock without running the expiry timer: admission must detect
  // expiry lazily too, even when the scheduler has not delivered its check.
  vi.setSystemTime(Date.now() + LIMITS.indexLeaseMs);
  const recovered = await h.index("replacement");
  expect(recovered.status).toBe("ready");
  const fence = { artifactId: h.args.artifactId, claim: dead!.indexClaim! };
  const handles = await h.action(async () => ({
    insert: await createFunctionHandle(ragComponent.chunks.insert),
    promote: await createFunctionHandle(ragComponent.entries.promoteToReady),
  }));
  expect(
    await h.t.mutation(component.indexing.insert, {
      ...fence,
      insert: handles.insert,
      startOrder: 0,
      chunks: [
        {
          content: { text: "stale" },
          searchableText: "stale",
          embedding: Array.from({ length: LIMITS.embeddingDimensions[0] }, () => 1),
        },
      ],
    }),
  ).toBe(false);
  expect(
    await h.t.mutation(component.indexing.complete, { ...fence, promote: handles.promote }),
  ).toBe(false);
  h.release();
  await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  expect(await h.get()).toMatchObject({ indexStatus: "ready", indexEntryId: recovered.entryId });
  await h.expectOnlyEntry(recovered.entryId!);
});
it("expiry alone records unknown, retains the entry and never starts embedding or another timer", async () => {
  const h = await recoveryHarness(LIMITS.providerMs);
  h.pause();
  const abandoned = h.index();
  await h.started;
  const dead = await h.get();
  await h.expire();
  expect(await h.get()).toMatchObject({ indexStatus: "unknown", indexEntryId: dead!.indexEntryId });
  expect(h.embedding.doEmbedCalls).toHaveLength(1);
  // Draining several lease windows must terminate without any scheduled retry.
  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(LIMITS.indexLeaseMs));
  expect(h.embedding.doEmbedCalls).toHaveLength(1);
  expect(
    await h.t.query(ragComponent.entries.get, { entryId: dead!.indexEntryId! }),
  ).not.toBeNull();
  h.release();
  await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  expect(await h.get()).toMatchObject({ indexStatus: "unknown" });
});
it("validates indexing lease overrides against a positive integer hard maximum at registration", () => {
  for (const indexLeaseMs of [NaN, Infinity, -1, 0, 1.5, LIMITS.indexLeaseMs + 1])
    expect(() => setup({ limits: { indexLeaseMs } })).toThrow("INVALID_EXTRACT_ARGUMENT");
});

it.each(["chunks", "promotion"] as const)(
  "rejects %s at lease expiry before the scheduled check runs",
  async (write) => {
    const h = await recoveryHarness();
    h.pause();
    const abandoned = h.index();
    await h.started;
    const dead = await h.get();
    vi.setSystemTime(Date.now() + LIMITS.indexLeaseMs);
    const fence = { artifactId: h.args.artifactId, claim: dead!.indexClaim! };
    const handles = await h.action(async () => ({
      insert: await createFunctionHandle(ragComponent.chunks.insert),
      promote: await createFunctionHandle(ragComponent.entries.promoteToReady),
    }));
    const accepted =
      write === "chunks"
        ? await h.t.mutation(component.indexing.insert, {
            ...fence,
            insert: handles.insert,
            startOrder: 0,
            chunks: [
              {
                content: { text: "expired" },
                searchableText: "expired",
                embedding: Array.from({ length: LIMITS.embeddingDimensions[0] }, () => 1),
              },
            ],
          })
        : await h.t.mutation(component.indexing.complete, { ...fence, promote: handles.promote });
    expect(accepted).toBe(false);
    expect(await h.get()).toMatchObject({
      indexStatus: "unknown",
      indexEntryId: dead!.indexEntryId,
    });
    expect(
      (await h.t.query(ragComponent.entries.get, { entryId: dead!.indexEntryId! }))?.status,
    ).toBe("pending");
    expect(
      (
        await h.t.query(ragComponent.chunks.list, {
          entryId: dead!.indexEntryId!,
          order: "asc",
          paginationOpts: { cursor: null, numItems: 1 },
        })
      ).page,
    ).toHaveLength(0);
    h.release();
    await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  },
);
