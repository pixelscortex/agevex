// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { MockEmbeddingModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { componentsGeneric, createFunctionHandle } from "convex/server";
import { LIMITS, authorizeAttached, type ExtractOptions } from "../../src/extract/index.js";
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

/** The index record of the default test namespace; claim is the stale-writer fence token. */
const indexRow = (h: ReturnType<typeof setup>, artifactId: string, namespace = scope.namespace) =>
  h.t.query(component.indexing.lookup, { artifactId, namespace });

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

  expect(await indexRow(h, job.artifactId)).toMatchObject({
    entryId: previousId,
    status: "failed",
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

  expect(await indexRow(h, job.artifactId)).toMatchObject({
    entryId: inFlight.page[0]!.entryId,
    status: "running",
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

  expect(await indexRow(h, job.artifactId)).toMatchObject({
    entryId: ready.entryId,
    status: "ready",
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

it("release fences indexing before a late embedding can publish", async () => {
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
    rag: { component: ragComponent, embedding, embeddingDimension: LIMITS.embeddingDimensions[0] },
  });

  await registerRag(h);
  const fileId = await h.upload();
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));

  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const args = { ...scope, artifactId: job.artifactId, key: "fenced-file" };
  const indexing = h.action((ctx) => h.extract.index(ctx, args));

  await started;
  await h.action((ctx) => h.extract.release(ctx, args));
  release();
  await expect(indexing).rejects.toThrow("EXTRACT_INDEX_FENCED");
  // Released: the fenced record is dropped and its native entry deleted by
  // exact id, so the late embedding leaves nothing behind.
  expect(await indexRow(h, job.artifactId)).toBeNull();
  expect(embedding.doEmbedCalls).toHaveLength(1);
});

it("a paid index is published when the file is detached mid-embedding; search re-authorizes and a re-attach needs no second embedding", async () => {
  let release!: () => void;
  let entered!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const embedding = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: LIMITS.ragBatch,
    doEmbed: async ({ values }) => {
      entered();
      await gate;

      return {
        embeddings: values.map(() => Array.from({ length: dimension }, () => 1)),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  });

  const h = await threads({
    rag: { component: ragComponent, embedding, embeddingDimension: dimension },
  });

  const fileId = await h.upload("detached while embedding");

  h.attach("a", fileId);
  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

  await h.drain();
  const args = { threadId: "a", artifactId: job.artifactId, namespace: "a", key: "k" };
  const indexing = h.action((ctx) => h.extract.index(ctx, args));

  await started;
  // The message is deleted while the paid embedding is in flight.
  h.attached.get("a")!.clear();
  release();
  const published = await indexing;

  expect(published.status).toBe("ready");
  expect(await indexRow(h, job.artifactId, "a")).toMatchObject({ status: "ready" });
  expect(embedding.doEmbedCalls).toHaveLength(1);

  const search = () =>
    h.action((ctx) => h.extract.search(ctx, { threadId: "a", namespace: "a", query: "detached" }));

  // Detached: nothing leaks, because search re-authorizes every hit.
  expect(await search()).toMatchObject({ text: "", references: [] });
  // Re-attached: the same index is searchable and nothing is embedded again.
  h.attach("a", fileId);
  expect((await search()).references).toEqual([{ fileId, artifactId: job.artifactId }]);
  // (Each search embeds its query; only the re-index below must add nothing.)
  const beforeReindex = embedding.doEmbedCalls.length;

  expect(await h.action((ctx) => h.extract.index(ctx, args))).toMatchObject({
    status: "ready",
    entryId: published.entryId,
  });

  expect(embedding.doEmbedCalls).toHaveLength(beforeReindex);
});

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
  const get = () => indexRow(h, job.artifactId);
  const index = (key = args.key) => h.action((ctx) => h.extract.index(ctx, { ...args, key }));

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
    namespace: h.args.namespace,
    key: "abandoned",
  });

  const calls = h.embedding.doEmbedCalls.length;

  expect(await h.index("different")).toMatchObject({ status: "pending" });
  await h.expire();
  expect(await h.get()).toMatchObject({ status: "unknown", entryId: original.entryId });
  expect(h.embedding.doEmbedCalls).toHaveLength(calls);
  const recovered = await h.index("different");

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

  expect(dead?.status).toBe("running");
  await h.expire();
  expect(await h.get()).toMatchObject({ status: "unknown", entryId: dead!.entryId });
  const recovered = await h.index("different");

  expect(recovered.status).toBe("ready");
  expect(await h.t.query(ragComponent.entries.get, { entryId: dead!.entryId! })).toBeNull();
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
  const fence = { indexId: dead!.indexId, claim: dead!.claim };

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
  expect(await h.get()).toMatchObject({ status: "ready", entryId: recovered.entryId });
  await h.expectOnlyEntry(recovered.entryId!);
});

it("expiry alone records unknown, retains the entry and never starts embedding or another timer", async () => {
  const h = await recoveryHarness(LIMITS.providerMs);

  h.pause();
  const abandoned = h.index();

  await h.started;
  const dead = await h.get();

  await h.expire();
  expect(await h.get()).toMatchObject({ status: "unknown", entryId: dead!.entryId });
  expect(h.embedding.doEmbedCalls).toHaveLength(1);
  // Draining several lease windows must terminate without any scheduled retry.
  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(LIMITS.indexLeaseMs));
  expect(h.embedding.doEmbedCalls).toHaveLength(1);
  expect(await h.t.query(ragComponent.entries.get, { entryId: dead!.entryId! })).not.toBeNull();
  h.release();
  await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  expect(await h.get()).toMatchObject({ status: "unknown" });
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
    const fence = { indexId: dead!.indexId, claim: dead!.claim };

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
      status: "unknown",
      entryId: dead!.entryId,
    });

    expect((await h.t.query(ragComponent.entries.get, { entryId: dead!.entryId! }))?.status).toBe(
      "pending",
    );

    expect(
      (
        await h.t.query(ragComponent.chunks.list, {
          entryId: dead!.entryId!,
          order: "asc",
          paginationOpts: { cursor: null, numItems: 1 },
        })
      ).page,
    ).toHaveLength(0);

    h.release();
    await expect(abandoned).rejects.toThrow("EXTRACT_INDEX_FENCED");
  },
);

const dimension = LIMITS.embeddingDimensions[0];

const vectors = () =>
  new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: LIMITS.ragBatch,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => Array.from({ length: dimension }, () => 1)),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });

/** Several threads, each with its own attached files, over one shared extraction store. */
async function threads(extra: Partial<Parameters<typeof setup>[0]> = {}) {
  const attached = new Map<string, Set<string>>();

  const h = setup({
    rag: { component: ragComponent, embedding: vectors(), embeddingDimension: dimension },
    authorize: async (_ctx, scope) => {
      if (!attached.has(scope.threadId)) throw new Error("FORBIDDEN");

      if (scope.fileId && !attached.get(scope.threadId)!.has(scope.fileId))
        throw new Error("FORBIDDEN");
    },
    ...extra,
  });

  await registerRag(h);

  const attach = (threadId: string, fileId: string) =>
    attached.set(threadId, (attached.get(threadId) ?? new Set()).add(fileId));

  const drain = () => h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

  const ready = async (status: "pending" | "ready") =>
    (
      await h.t.query(ragComponent.entries.list, {
        status,
        paginationOpts: { cursor: null, numItems: 100 },
      })
    ).page;

  return { ...h, attached, attach, drain, ready };
}

it("indexing completes after paying when the policy needs the thread owner on every check", async () => {
  // A policy like authorizeAttached refuses any file check without a subject.
  // The re-check after the paid embedding used to omit it and discarded the index.
  const h = setup({
    rag: { component: ragComponent, embedding: vectors(), embeddingDimension: dimension },
    authorize: authorizeAttached(() => ({
      fileAttached: async (_ctx, args) =>
        args.subject === "alice" &&
        args.threadId === "owner" &&
        h.state.attachments.get(args.fileId) === args.threadId,
    })),
  });

  await registerRag(h);
  const fileId = await h.upload();
  const owner = { threadId: "owner", subject: "alice" };
  const job = await h.action((ctx) => h.extract.run(ctx, { ...owner, fileId }));

  await h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

  expect(await h.action((ctx) => h.extract.get(ctx, { ...owner, fileId }))).toMatchObject({
    status: "ready",
  });

  const indexed = await h.action((ctx) =>
    h.extract.index(ctx, { ...owner, artifactId: job.artifactId, namespace: "owner", key: "k" }),
  );

  expect(indexed).toMatchObject({ status: "ready", created: true });

  expect(
    (await h.action((ctx) => h.extract.search(ctx, { ...owner, namespace: "owner", query: "x" })))
      .references,
  ).toContainEqual({ fileId, artifactId: job.artifactId });

  // The policy confines a thread to its own namespace: it cannot release another's.
  await expect(
    h.action((ctx) =>
      h.extract.release(ctx, { ...owner, artifactId: job.artifactId, namespace: "other" }),
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("threads sharing one extraction keep separate indexes: re-indexing or releasing one never touches the other", async () => {
  const h = await threads();
  const fileId = await h.upload("shared by two threads");

  h.attach("a", fileId);
  h.attach("b", fileId);
  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

  await h.drain();
  const twin = await h.action((ctx) => h.extract.run(ctx, { threadId: "b", fileId }));

  expect(twin).toEqual({ artifactId: job.artifactId, action: "reuse" });

  const index = (threadId: string, key: string) =>
    h.action((ctx) =>
      h.extract.index(ctx, { threadId, artifactId: job.artifactId, namespace: threadId, key }),
    );

  const search = (threadId: string) =>
    h.action((ctx) => h.extract.search(ctx, { threadId, namespace: threadId, query: "shared" }));

  const a = await index("a", "k");
  const b = await index("b", "k");

  expect(a.entryId).not.toBe(b.entryId);

  expect((await h.ready("ready")).map((entry) => entry.entryId).sort()).toEqual(
    [a.entryId, b.entryId].sort(),
  );

  // Thread b replaces its own entry; a's entry survives untouched.
  const b2 = await index("b", "k2");

  expect(b2.entryId).not.toBe(b.entryId);
  expect(await h.t.query(ragComponent.entries.get, { entryId: b.entryId! })).toBeNull();

  expect((await h.ready("ready")).map((entry) => entry.entryId).sort()).toEqual(
    [a.entryId, b2.entryId].sort(),
  );

  expect((await search("a")).references).toHaveLength(1);

  // Releasing b removes only b's index; the extraction and a's index remain.
  await h.action((ctx) =>
    h.extract.release(ctx, { threadId: "b", artifactId: job.artifactId, namespace: "b" }),
  );

  expect(await h.t.query(ragComponent.entries.get, { entryId: b2.entryId! })).toBeNull();
  expect((await h.ready("ready")).map((entry) => entry.entryId)).toEqual([a.entryId]);
  expect((await search("b")).references).toEqual([]);
  expect((await search("a")).references).toHaveLength(1);

  expect(await h.action((ctx) => h.extract.get(ctx, { threadId: "a", fileId }))).toMatchObject({
    status: "ready",
  });

  expect(
    await h.action((ctx) =>
      h.extract.readText(ctx, { threadId: "b", artifactId: job.artifactId, maxBytes: 6 }),
    ),
  ).toMatchObject({ text: "shared" });

  // Only the admin purge tombstones the shared extraction, for every thread.
  await h.action((ctx) => h.extract.purge(ctx, { fileId }));

  await expect(
    h.action((ctx) => h.extract.readText(ctx, { threadId: "a", artifactId: job.artifactId })),
  ).rejects.toThrow("EXTRACT_NOT_READY");

  expect((await search("a")).references).toEqual([]);
});

it("search skips a hit whose file is no longer attached instead of failing", async () => {
  const h = await threads();
  const kept = await h.upload("kept document");
  const dropped = await h.upload("dropped document");

  h.attach("a", kept);
  h.attach("a", dropped);

  for (const fileId of [kept, dropped]) {
    const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

    await h.drain();

    await h.action((ctx) =>
      h.extract.index(ctx, {
        threadId: "a",
        artifactId: job.artifactId,
        namespace: "a",
        key: "k",
      }),
    );
  }

  h.attached.get("a")!.delete(dropped);

  const found = await h.action((ctx) =>
    h.extract.search(ctx, { threadId: "a", namespace: "a", query: "document" }),
  );

  expect(found.references.map((reference) => reference.fileId)).toEqual([kept]);
  expect(found.text).toContain("kept document");
  expect(found.text).not.toContain("dropped");
});

it("index rejects an over-ceiling text from the stored summary before loading the payload", async () => {
  const h = await threads();
  const fileId = await h.upload("seed");

  h.attach("a", fileId);
  h.state.result = { ok: true, doc: { kind: "text", text: "x".repeat(LIMITS.indexBytes + 1) } };
  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

  await h.drain();
  const load = vi.spyOn(Blob.prototype, "text");

  await expect(
    h.action((ctx) =>
      h.extract.index(ctx, {
        threadId: "a",
        artifactId: job.artifactId,
        namespace: "a",
        key: "k",
      }),
    ),
  ).rejects.toThrow("TOO_LARGE");

  expect(load).not.toHaveBeenCalled();
  load.mockRestore();
});

it("index encodes the text once instead of once per chunk", async () => {
  const h = await threads({
    rag: {
      component: ragComponent,
      embedding: vectors(),
      embeddingDimension: dimension,
      chunk: { maxBytes: LIMITS.minChunkBytes },
    },
  });

  const fileId = await h.upload("seed");

  h.attach("a", fileId);
  h.state.result = { ok: true, doc: { kind: "text", text: "x".repeat(LIMITS.indexBytes) } };
  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

  await h.drain();
  const encode = vi.spyOn(TextEncoder.prototype, "encode");

  await h.action((ctx) =>
    h.extract.index(ctx, { threadId: "a", artifactId: job.artifactId, namespace: "a", key: "k" }),
  );

  // 1,024 chunks of 1 KiB: re-encoding the whole text per chunk would be 1,024
  // encodings of 1 MiB; one encoding of the whole text is enough.
  const whole = encode.mock.calls.filter(([text]) => (text?.length ?? 0) >= LIMITS.indexBytes / 2);

  expect(whole.length).toBeLessThanOrEqual(1);
  encode.mockRestore();
}, 30_000);

it("an already-ready index returns without loading the payload", async () => {
  const h = await threads();
  const fileId = await h.upload("indexed once");

  h.attach("a", fileId);
  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: "a", fileId }));

  await h.drain();
  const args = { threadId: "a", artifactId: job.artifactId, namespace: "a", key: "k" };
  const first = await h.action((ctx) => h.extract.index(ctx, args));

  expect(first.status).toBe("ready");
  const load = vi.spyOn(Blob.prototype, "text");

  for (const automatic of [false, true])
    expect(await h.action((ctx) => h.extract.index(ctx, { ...args, automatic }))).toMatchObject({
      status: "ready",
      entryId: first.entryId,
      created: false,
    });

  expect(load).not.toHaveBeenCalled();
  load.mockRestore();
});

it("purge removes every namespace's RAG content for the file and leaves other files searchable", async () => {
  const h = await threads();
  const doomed = await h.upload("doomed shared document");
  const live = await h.upload("live document");

  h.attach("a", doomed);
  h.attach("b", doomed);
  h.attach("a", live);
  const artifacts: Record<string, string> = {};

  for (const [threadId, fileId] of [
    ["a", doomed],
    ["a", live],
  ] as const) {
    const job = await h.action((ctx) => h.extract.run(ctx, { threadId, fileId }));

    await h.drain();
    artifacts[fileId] = job.artifactId;
  }

  const index = (threadId: string, fileId: string) =>
    h.action((ctx) =>
      h.extract.index(ctx, {
        threadId,
        artifactId: artifacts[fileId]!,
        namespace: threadId,
        key: "k",
      }),
    );

  const live1 = await index("a", live);

  await index("a", doomed);
  await index("b", doomed);
  expect(await h.ready("ready")).toHaveLength(3);
  let result = await h.action((ctx) => h.extract.purge(ctx, { fileId: doomed }));

  expect(result).toEqual({ more: false });
  // No orphaned chunks: only the live file's entry remains, and its index record.
  expect((await h.ready("ready")).map((entry) => entry.entryId)).toEqual([live1.entryId]);
  expect(await h.ready("pending")).toHaveLength(0);

  for (const namespace of ["a", "b"])
    expect(
      await h.t.query(component.indexing.lookup, {
        artifactId: artifacts[doomed]!,
        namespace,
      }),
    ).toBeNull();

  const found = await h.action((ctx) =>
    h.extract.search(ctx, { threadId: "a", namespace: "a", query: "document" }),
  );

  expect(found.references).toEqual([{ fileId: live, artifactId: artifacts[live] }]);
  expect(found.text).toContain("live document");
  expect(found.text).not.toContain("doomed");
  result = await h.action((ctx) => h.extract.purge(ctx, { fileId: doomed }));
  expect(result).toEqual({ more: false });
}, 30_000);

it("purge works in bounded batches and reports more until every namespace is cleaned", async () => {
  const h = await threads();
  const fileId = await h.upload("shared by many threads");
  const count = LIMITS.purgeBatch + 1;
  const names = Array.from({ length: count }, (_, index) => `t${index}`);

  for (const name of names) h.attach(name, fileId);

  const job = await h.action((ctx) => h.extract.run(ctx, { threadId: names[0]!, fileId }));

  await h.drain();

  for (const name of names)
    await h.action((ctx) =>
      h.extract.index(ctx, {
        threadId: name,
        artifactId: job.artifactId,
        namespace: name,
        key: "k",
      }),
    );

  expect(await h.ready("ready")).toHaveLength(count);
  const first = await h.action((ctx) => h.extract.purge(ctx, { fileId }));

  expect(first).toEqual({ more: true });
  expect(await h.ready("ready")).toHaveLength(count - LIMITS.purgeBatch);
  const second = await h.action((ctx) => h.extract.purge(ctx, { fileId }));

  expect(second).toEqual({ more: false });
  expect(await h.ready("ready")).toHaveLength(0);
}, 60_000);
