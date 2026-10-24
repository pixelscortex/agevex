// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { MockEmbeddingModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { componentsGeneric } from "convex/server";
import { LIMITS, type ExtractOptions } from "../../src/extract/index.js";
import { setup } from "./setup.js";
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
