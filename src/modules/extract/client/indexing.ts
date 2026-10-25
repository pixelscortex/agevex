/**
 * Explicit RAG admission, cleanup, embedding, and fenced publication.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import type { EntryId } from "@convex-dev/rag";
import { embedMany } from "ai";
import { createFunctionHandle } from "convex/server";
import { fingerprint } from "../../../client/once.js";
import { LIMITS, bounded, utf8 } from "../shared/limits.js";
import { authorize } from "./access.js";
import { ExtractError } from "./backends.js";
import { subjectOf, type ArtifactArgs, type RuntimeContext } from "./context.js";
import { textWindow } from "./payload.js";
import { payloadRef, readPayload } from "./reads.js";
import type { ActionCtx } from "./types.js";
/**
 * Index a ready artifact's text into `namespace`. `automatic: true` (the
 * slot and the worker) only creates a missing record: it never re-runs a
 * failed, unknown, released or key-changed index, because that repeats paid
 * embedding; only an explicit call (without it) recovers those.
 */
export async function index(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  args: ArtifactArgs & { namespace: string; key: string; automatic?: boolean },
) {
  if (!runtime.rag || !runtime.options.rag) throw new Error("EXTRACT_RAG_DISABLED");

  bounded(args.key);

  await authorize(runtime, ctx, {
    operation: "index",
    threadId: args.threadId,
    namespace: args.namespace,
    ...subjectOf(args),
  });

  const ref = await payloadRef(runtime, ctx, args);
  const row = ref.row;

  // Decide from the index record BEFORE loading or chunking the payload: an
  // already-ready (or live) index must not cost a payload read, and an
  // automatic caller never re-embeds. The admit mutation re-checks all of
  // this atomically; this read only avoids the wasted load.
  const existing = await ctx.runQuery(runtime.component.indexing.lookup, {
    artifactId: row._id,
    namespace: args.namespace,
  });

  const reused = reusableIndex(existing, args);

  if (reused) return reused;

  const chunks = await indexChunks(runtime, ctx, ref);

  const admitted = await ctx.runMutation(runtime.component.indexing.admit, {
    artifactId: row._id,
    namespace: args.namespace,
    key: args.key,
    leaseMs: runtime.limits.indexLeaseMs,
    ...(args.automatic ? { automatic: true } : {}),
  });

  if (admitted.action !== "run")
    return {
      entryId: admitted.entryId,
      status:
        admitted.action === "reuse"
          ? ("ready" as const)
          : admitted.action === "skip"
            ? ("skipped" as const)
            : ("pending" as const),
      created: false,
      replacedEntry: null,
      usage: { tokens: 0 },
    };

  return populateIndex(runtime, ctx, args, row, admitted, chunks);
}

type IndexArgs = ArtifactArgs & { namespace: string; key: string; automatic?: boolean };
type IndexRow = Awaited<ReturnType<typeof payloadRef>>["row"];
type Admission = import("convex/server").FunctionReturnType<
  RuntimeContext["component"]["indexing"]["admit"]
>;
type RunningAdmission = Extract<Admission, { action: "run" }>;
type IndexFence = { indexId: string; claim: string };

/** Resolve the preflight state without loading bytes; automatic calls never repeat paid indexing. */
function reusableIndex(
  existing: import("convex/server").FunctionReturnType<
    RuntimeContext["component"]["indexing"]["lookup"]
  >,
  args: IndexArgs,
) {
  if (existing) {
    const live =
      (existing.status === "cleaning" || existing.status === "running") &&
      existing.leaseUntil > Date.now();

    const state =
      existing.status === "ready" && existing.key === args.key
        ? ("ready" as const)
        : live
          ? ("pending" as const)
          : args.automatic
            ? ("skipped" as const)
            : undefined;

    if (state)
      return {
        entryId: existing.entryId,
        status: state,
        created: false,
        replacedEntry: null,
        usage: { tokens: 0 },
      };
  }
}

/** Check summary before reading, then encode once and cap both chunk count and bytes. */
async function indexChunks(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  ref: Awaited<ReturnType<typeof payloadRef>>,
) {
  const row = ref.row;

  // Decide from the stored summary BEFORE reading the payload: an artifact
  // whose text exceeds the index ceiling must not cost a full payload load.
  if ((row.summary?.textBytes ?? 0) > LIMITS.indexBytes) throw new ExtractError("TOO_LARGE");

  const doc = await readPayload(runtime, ctx, ref);
  // Encode once and window over the bytes; re-encoding the text per chunk
  // would cost up to 1,024 full encodings of a 1 MiB text.
  const bytes = utf8(doc.text);

  if (bytes.length > LIMITS.indexBytes) throw new ExtractError("TOO_LARGE");

  const chunks: { text: string }[] = [];
  let cursor: number | null = 0;

  do {
    const window = textWindow(
      bytes,
      cursor,
      runtime.options.rag?.chunk?.maxBytes ?? LIMITS.chunkBytes,
    );

    chunks.push({ text: window.text });
    cursor = window.cursor;

    if (chunks.length > LIMITS.indexChunks) throw new ExtractError("TOO_LARGE");
  } while (cursor !== null);

  return chunks;
}

/** Populate only after admission: delete the exact predecessor, record the new entry, embed, then promote. */
async function populateIndex(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  args: IndexArgs,
  row: IndexRow,
  admitted: RunningAdmission,
  chunks: { text: string }[],
) {
  const fence = { indexId: admitted.indexId, claim: admitted.claim };

  try {
    if (admitted.entryId) {
      // RAG 0.7.8 src/client/index.ts:768-786 deletes by exact entry id;
      // entries.ts:511-529 pages chunk deletion before deleting that entry.
      // Await it before creating a replacement; even a partially failed
      // deletion remains addressable on our row for the next explicit retry.
      // The id is this namespace's own record: other namespaces' entries
      // of the same shared extraction are never touched.
      const previous = { entryId: admitted.entryId as EntryId };

      if (await runtime.rag!.getEntry(ctx, previous)) await runtime.rag!.delete(ctx, previous);
    }

    const { namespaceId } = await runtime.rag!.getOrCreateNamespace(ctx, {
      namespace: args.namespace,
      status: "ready",
    });

    const entryId = await ctx.runMutation(runtime.component.indexing.start, {
      ...fence,
      add: await createFunctionHandle(runtime.options.rag!.component.entries.add),
      namespaceId,
      // Caller keys are scoped to the artifact: otherwise independent
      // artifacts using one key could rebuild the same unbounded pending
      // history despite each index record's own admission fence.
      key: await fingerprint({ artifactId: row._id, key: args.key }),
      contentHash: await fingerprint({ artifactId: row._id, claim: row.claim }),
    });

    const tokens = await embedChunks(runtime, ctx, fence, chunks);

    // No authorization re-check after the paid embedding (the check before
    // it already ran, and `index` is refused up front for an unattached
    // file). Discarding the index here would pay again on the next attach;
    // publishing leaks nothing because `search` re-authorizes every hit
    // against the then-current attachment and skips detached files.
    if (
      !(await ctx.runMutation(runtime.component.indexing.complete, {
        ...fence,
        promote: await createFunctionHandle(runtime.options.rag!.component.entries.promoteToReady),
      }))
    )
      throw new Error("EXTRACT_INDEX_FENCED");

    return {
      entryId,
      status: "ready" as const,
      created: true,
      replacedEntry: null,
      usage: { tokens },
    };
  } catch (error) {
    await ctx.runMutation(runtime.component.indexing.complete, fence);
    throw error;
  }
}

/** Embed batches without retries and insert each batch under the component claim fence. */
async function embedChunks(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  fence: IndexFence,
  chunks: { text: string }[],
) {
  let tokens = 0;

  // Native RAG add cannot attach to an entry created in our admission
  // transaction (src/client/index.ts:194). Use its public entry/chunk
  // mutations, keeping all durable content/vectors inside RAG instead.
  // Each batch writes 100 content + 100 chunk + 100 vector rows. Text
  // appears in content AND searchableText; Convex numbers cost 9 bytes:
  // 100*(2*8192+4096*9+1024) = 5,427,200 bytes (~5.2 MiB), 300 rows,
  // below 16 MiB/16000. The 1 KiB allowance covers fields/ids per triplet.
  for (let startOrder = 0; startOrder < chunks.length; startOrder += LIMITS.ragBatch) {
    const batch = chunks.slice(startOrder, startOrder + LIMITS.ragBatch);

    const result = await embedMany({
      model: runtime.rag!.options.textEmbeddingModel,
      values: batch.map(({ text }) => text.trim() || "<empty>"),
      maxRetries: 0,
    });

    tokens += result.usage.tokens;

    const inserted = await ctx.runMutation(runtime.component.indexing.insert, {
      ...fence,
      insert: await createFunctionHandle(runtime.options.rag!.component.chunks.insert),
      startOrder,
      chunks: batch.map(({ text }, index) => ({
        content: { text },
        searchableText: text,
        embedding: result.embeddings[index]!,
      })),
    });

    if (!inserted) throw new Error("EXTRACT_INDEX_FENCED");
  }

  return tokens;
}
