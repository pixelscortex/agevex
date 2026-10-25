// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { MockEmbeddingModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { componentsGeneric } from "convex/server";
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
